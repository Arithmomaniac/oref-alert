"""
Azure Function: Pikud HaOref Alert Poller

Polls the Israeli Home Front Command (oref.org.il) real-time alert and history
APIs every 5 seconds, combines the results, and writes a state.json snapshot
to the $web blob container for static-site consumption.

API quirks handled here:
  - Alerts.json may return a JSON array, a JSON object, or an empty string.
  - AlertsHistory.json returns a JSON array.
  - Responses are encoded with BOM (utf-8-sig) and may contain null bytes.
  - SSL certificates occasionally fail verification.
"""

import csv
import io
import json
import logging
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import azure.functions as func
import httpx
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobLeaseClient, BlobServiceClient, ContentSettings

app = func.FunctionApp()

# Shared headers required by oref.org.il to accept the request
OREF_HEADERS = {
    "Referer": "https://www.oref.org.il/",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "Mozilla/5.0",
}

ALERTS_URL = "https://www.oref.org.il/warningMessages/alert/Alerts.json"
HISTORY_URL = "https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json"

# Last-known-good values so a single failed fetch doesn't wipe the state
_last_alerts: list | dict = []
_last_history: list = []


def _clean_response_text(raw: bytes) -> str:
    """Decode a response that may have a UTF-8 BOM and/or embedded null bytes."""
    text = raw.decode("utf-8-sig")
    return text.replace("\x00", "")


def _parse_alerts(text: str) -> list | dict:
    """Parse the Alerts.json payload.

    Returns the parsed JSON (array or object) or an empty list when the
    endpoint returns an empty body (which is normal when there are no alerts).
    """
    text = text.strip()
    if not text:
        return []
    return json.loads(text)


def _parse_history(text: str) -> list:
    """Parse the AlertsHistory.json payload (always a JSON array)."""
    text = text.strip()
    if not text:
        return []
    return json.loads(text)


def _fetch_oref_data() -> tuple[list | dict, list]:
    """Fetch both oref endpoints synchronously.

    Returns (alerts, history). On per-endpoint failure the last known good
    value is returned so the caller always gets usable data.
    """
    global _last_alerts, _last_history

    alerts = _last_alerts
    history = _last_history

    # SSL verification relaxed — oref.org.il occasionally has cert issues
    with httpx.Client(headers=OREF_HEADERS, verify=False, timeout=10.0) as client:
        # --- Alerts ---
        try:
            resp = client.get(ALERTS_URL)
            resp.raise_for_status()
            alerts = _parse_alerts(_clean_response_text(resp.content))
            _last_alerts = alerts
        except Exception:
            logging.exception("Failed to fetch Alerts.json — using last known value")

        # --- History ---
        try:
            resp = client.get(HISTORY_URL)
            resp.raise_for_status()
            history = _parse_history(_clean_response_text(resp.content))
            _last_history = history
        except Exception:
            logging.exception("Failed to fetch AlertsHistory.json — using last known value")

    return alerts, history


def _upload_state(state: dict) -> None:
    """Write the combined state JSON to $web/api/state.json in blob storage."""
    account_name = os.environ["STORAGE_ACCOUNT_NAME"]
    account_url = f"https://{account_name}.blob.core.windows.net"

    credential = DefaultAzureCredential()
    blob_service = BlobServiceClient(account_url=account_url, credential=credential)

    container = blob_service.get_container_client("$web")
    blob = container.get_blob_client("api/state.json")

    content_settings = ContentSettings(
        content_type="application/json; charset=utf-8",
        cache_control="max-age=4, must-revalidate",
    )

    blob.upload_blob(
        json.dumps(state, ensure_ascii=False),
        overwrite=True,
        content_settings=content_settings,
    )
    logging.info("Uploaded state.json to $web/api/state.json")


@app.timer_trigger(schedule="*/5 * * * * *", arg_name="timer", run_on_startup=False)
def poll_oref(timer: func.TimerRequest) -> None:
    """Timer-triggered function that polls oref.org.il and writes state.json."""
    if timer.past_due:
        logging.warning("Timer is past due — executing anyway")

    alerts, history = _fetch_oref_data()

    state = {
        "alerts": alerts,
        "history": history,
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    try:
        _upload_state(state)
    except Exception:
        logging.exception("Failed to upload state.json to blob storage")


# ---------------------------------------------------------------------------
# Blob helpers
# ---------------------------------------------------------------------------

def _get_container_client():
    """Return a ContainerClient for the $web container."""
    account_name = os.environ["STORAGE_ACCOUNT_NAME"]
    account_url = f"https://{account_name}.blob.core.windows.net"
    credential = DefaultAzureCredential()
    blob_service = BlobServiceClient(account_url=account_url, credential=credential)
    return blob_service.get_container_client("$web")


def _read_json_blob(container_client, blob_path, default=None):
    """Read and parse a JSON blob, returning default if not found."""
    try:
        data = container_client.get_blob_client(blob_path).download_blob().readall()
        return json.loads(data)
    except Exception:
        return default if default is not None else {}


def _write_json_blob(container_client, blob_path, data, cache_control="no-cache"):
    """Write JSON data to a blob."""
    content_settings = ContentSettings(
        content_type="application/json; charset=utf-8",
        cache_control=cache_control,
    )
    container_client.get_blob_client(blob_path).upload_blob(
        json.dumps(data, ensure_ascii=False),
        overwrite=True,
        content_settings=content_settings,
    )


LOCK_BLOB = "api/_compute.lock"
LOCK_LEASE_SECONDS = 300  # 5 min max hold


class _ComputeLock:
    """Blob lease-based lock to prevent concurrent threshold computation."""

    def __init__(self, container_client):
        self._container = container_client
        self._lease = None

    def __enter__(self):
        blob = self._container.get_blob_client(LOCK_BLOB)
        # Ensure lock blob exists
        try:
            blob.upload_blob(b"lock", overwrite=False)
        except Exception:
            pass  # already exists
        self._lease = BlobLeaseClient(blob)
        self._lease.acquire(lease_duration=LOCK_LEASE_SECONDS)
        return self

    def __exit__(self, *args):
        if self._lease:
            try:
                self._lease.release()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 1. HTTP-triggered /api/register endpoint
# ---------------------------------------------------------------------------

@app.function_name("register_city")
@app.route(route="register", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def register_city(req: func.HttpRequest) -> func.HttpResponse:
    """Legacy registration endpoint — now a no-op since all cities are precomputed."""
    city = req.params.get("city", "")
    return func.HttpResponse(
        json.dumps({"ok": True, "city": city, "status": "all_cities_precomputed"}, ensure_ascii=False),
        status_code=200,
        mimetype="application/json",
        headers={"Access-Control-Allow-Origin": "*"},
    )


@app.function_name("compute_city")
@app.route(route="compute", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def compute_city(req: func.HttpRequest) -> func.HttpResponse:
    """Legacy on-demand compute endpoint — now returns precomputed threshold."""
    city = req.params.get("city", "")
    container = _get_container_client()
    thresholds = _read_json_blob(container, "api/thresholds.json", default={})
    city_data = thresholds.get("cities", {}).get(city)
    if city_data:
        return func.HttpResponse(
            json.dumps({"ok": True, "city": city, "status": "precomputed",
                        "threshold": city_data}, ensure_ascii=False),
            status_code=200, mimetype="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
        )
    return func.HttpResponse(
        json.dumps({"ok": True, "city": city, "status": "not_found"}, ensure_ascii=False),
        status_code=200, mimetype="application/json",
        headers={"Access-Control-Allow-Origin": "*"},
    )


# ---------------------------------------------------------------------------
# 2. Daily timer-triggered compute_thresholds
# ---------------------------------------------------------------------------

HIST_ALERT_CATEGORIES = {1, 2, 3, 4, 7, 8, 9, 10, 11, 12}
END_CATEGORY = 13
PRE_ALERT_CATEGORY = 14
EVENT_WINDOW_MIN = 20
CSV_URL = "https://raw.githubusercontent.com/dleshem/israel-alerts-data/refs/heads/main/israel-alerts.csv"
CITIES_MIX_URL = "https://alerts-history.oref.org.il/Shared/Ajax/GetCitiesMix.aspx"

MIN_EVENTS_FOR_THRESHOLD = 5


def _parse_date_time(date_str: str, time_str: str) -> datetime:
    """Parse DD.MM.YYYY + HH:MM:SS to datetime."""
    return datetime.strptime(f"{date_str} {time_str}", "%d.%m.%Y %H:%M:%S")


def _city_matches(area: str, city: str) -> bool:
    """Substring match: 'בית שמש 188' matches 'בית שמש'."""
    return city in area


def _load_csv_rows(csv_text: str, cutoff_dt: datetime):
    """Parse CSV text, return rows from 2026+ before cutoff_dt.

    Each row is (datetime, category, areas_list, alertDate_str).
    Also builds pre_alerts_by_date: alertDate -> set of area names.
    """
    pre_alerts_by_date = defaultdict(set)
    all_rows = []

    reader = csv.reader(io.StringIO(csv_text))
    next(reader)  # skip header
    for row in reader:
        alert_date_str = row[3]
        if not alert_date_str.startswith("202") or alert_date_str < "2026":
            continue
        try:
            dt = _parse_date_time(row[1], row[2])
        except (ValueError, IndexError):
            continue
        if dt >= cutoff_dt:
            continue
        cat = int(row[4])
        areas = [a.strip() for a in row[0].split(",")]
        all_rows.append((dt, cat, areas, alert_date_str))
        if cat == PRE_ALERT_CATEGORY:
            for area in areas:
                pre_alerts_by_date[alert_date_str].add(area)

    all_rows.sort(key=lambda r: r[0])
    return all_rows, pre_alerts_by_date


def _find_end_time(all_rows, target_city, start_dt):
    """Find the first END event (cat 13) for target_city after start_dt,
    capped at start_dt + EVENT_WINDOW_MIN minutes."""
    max_dt = start_dt + timedelta(minutes=EVENT_WINDOW_MIN)
    for dt, cat, areas, _ad in all_rows:
        if dt <= start_dt:
            continue
        if dt > max_dt:
            break
        if cat == END_CATEGORY and any(_city_matches(a, target_city) for a in areas):
            return dt
    return max_dt


def _find_sirens_in_window(all_rows, start_dt, end_dt):
    """Return siren rows within [start_dt, end_dt)."""
    results = []
    for dt, cat, areas, _ad in all_rows:
        if dt < start_dt:
            continue
        if dt >= end_dt:
            break
        if cat in HIST_ALERT_CATEGORIES:
            results.append((dt, areas))
    return results


def _compute_gap(target_city, cohort_cities, sirens):
    """Compute gap analysis for a single pre-alert event.

    Returns (gap_seconds, outcome, cohort_sirens_count).
      gap_seconds: 0 (immediate), positive (first-siren-to-target gap), or None (miss)
      outcome: "immediate", "hit_after_gap", "miss"
      cohort_sirens_count: how many cohort cities got sirens
    """
    seen_cohort = set()
    first_cohort_time = None
    city_siren_time = None

    for dt, areas in sirens:
        if city_siren_time is None and any(_city_matches(a, target_city) for a in areas):
            city_siren_time = dt
        for cohort_city in cohort_cities:
            if cohort_city not in seen_cohort and any(_city_matches(a, cohort_city) for a in areas):
                seen_cohort.add(cohort_city)
                if first_cohort_time is None:
                    first_cohort_time = dt

    if city_siren_time is None:
        return None, "miss", len(seen_cohort)

    if first_cohort_time is None or first_cohort_time >= city_siren_time:
        return 0, "immediate", len(seen_cohort)

    gap = (city_siren_time - first_cohort_time).total_seconds()
    return gap, "hit_after_gap", len(seen_cohort)


def _analyze_all_cities(all_rows, pre_alerts_by_date, watermark_dt):
    """Run gap analysis for ALL cities across all pre-alert events in a single pass.

    For each pre-alert event, finds first siren time for each city in a single
    pass, then computes gaps for all cities simultaneously.

    Returns dict[city_name, list[event_dict]].
    """
    city_events = defaultdict(list)

    for alert_date_str, cities_in_blast in sorted(pre_alerts_by_date.items()):
        if len(cities_in_blast) < 2:
            continue  # need at least 2 cities for cohort analysis

        # Find per-second timestamp for this pre-alert (use any city)
        pre_alert_dt = None
        for dt, cat, areas, ad in all_rows:
            if ad == alert_date_str and cat == PRE_ALERT_CATEGORY:
                pre_alert_dt = dt
                break
        if pre_alert_dt is None:
            pre_alert_dt = datetime.fromisoformat(alert_date_str)

        if watermark_dt and pre_alert_dt <= watermark_dt:
            continue

        window_end = pre_alert_dt + timedelta(minutes=EVENT_WINDOW_MIN)

        # Single pass: find first siren time for each blast city
        city_first_siren = {}
        blast_list = list(cities_in_blast)

        for dt, cat, areas, _ad in all_rows:
            if dt < pre_alert_dt:
                continue
            if dt >= window_end:
                break
            if cat not in HIST_ALERT_CATEGORIES:
                continue
            for area in areas:
                area_s = area.strip()
                for blast_city in blast_list:
                    if blast_city in area_s and blast_city not in city_first_siren:
                        city_first_siren[blast_city] = dt

        # Compute gap for each city using precomputed first-siren times
        for target_city in blast_list:
            target_siren = city_first_siren.get(target_city)
            cohort_with_sirens = 0
            first_cohort_siren = None

            for c in blast_list:
                if c == target_city:
                    continue
                ct = city_first_siren.get(c)
                if ct is not None:
                    cohort_with_sirens += 1
                    if target_siren is None or ct < target_siren:
                        if first_cohort_siren is None or ct < first_cohort_siren:
                            first_cohort_siren = ct

            if target_siren is None:
                outcome, gap = "miss", None
            elif first_cohort_siren is None:
                outcome, gap = "immediate", 0
            else:
                gap = (target_siren - first_cohort_siren).total_seconds()
                outcome = "hit_after_gap" if gap > 0 else "immediate"

            city_events[target_city].append({
                "outcome": outcome,
                "gap": gap,
                "alert_date": alert_date_str,
                "cohort_size": len(blast_list) - 1,
                "cohort_sirens": cohort_with_sirens,
            })

    return dict(city_events)


def _compute_threshold(events, target_fn_rate=0.05):
    """Find the lowest threshold (30s increments, 30-1200s) where FN rate ≤ target.

    FN = outcome is hit_after_gap with gap > threshold.
    FN rate = FN / (misses_with_sirens + FN).
    Only misses where cohort had sirens count (otherwise missed-us wouldn't trigger).
    """
    if not events:
        return 300, 0, 0.0

    miss_with_sirens = sum(
        1 for e in events
        if e["outcome"] == "miss" and e.get("cohort_sirens", 0) > 0
    )

    for threshold in range(30, 1201, 30):
        fn = sum(
            1 for e in events
            if e["outcome"] == "hit_after_gap" and e["gap"] is not None and e["gap"] > threshold
        )
        denom = miss_with_sirens + fn
        fn_rate = fn / denom if denom > 0 else 0.0
        if fn_rate <= target_fn_rate:
            return threshold, len(events), fn_rate

    return 1200, len(events), 0.0


@app.function_name("compute_thresholds")
@app.timer_trigger(schedule="0 0 3 * * *", arg_name="timer", run_on_startup=False)
def compute_thresholds(timer: func.TimerRequest) -> None:
    """Daily job: compute per-city alert gap thresholds for ALL cities."""
    container = _get_container_client()

    with _ComputeLock(container):
        gap_data = _read_json_blob(
            container, "api/gap_data.json",
            default={"watermark": None, "csv_byte_offset": 0, "cities": {}},
        )

        # Download CSV — use Range header to skip already-processed bytes
        byte_offset = gap_data.get("csv_byte_offset", 0)
        headers = {}
        if byte_offset > 0:
            headers["Range"] = f"bytes={byte_offset}-"
            logging.info("Downloading israel-alerts.csv from byte %d …", byte_offset)
        else:
            logging.info("Downloading full israel-alerts.csv …")

        resp = httpx.get(CSV_URL, timeout=120.0, verify=True, headers=headers)
        resp.raise_for_status()
        raw_bytes = resp.content

        if byte_offset > 0:
            csv_text = "data,date,time,alertDate,category,category_desc,matrix_id,rid\n" + raw_bytes.decode("utf-8")
            new_total_bytes = byte_offset + len(raw_bytes)
        else:
            csv_text = raw_bytes.decode("utf-8")
            new_total_bytes = len(raw_bytes)

        logging.info("Downloaded %d bytes (total offset: %d)", len(raw_bytes), new_total_bytes)

        now = datetime.now(timezone.utc)
        cutoff_dt = (now - timedelta(hours=6)).replace(tzinfo=None)

        all_rows, pre_alerts_by_date = _load_csv_rows(csv_text, cutoff_dt)
        logging.info("Parsed %d rows (2026+, before 6h lag)", len(all_rows))

        watermark_dt = None
        if gap_data.get("watermark"):
            watermark_dt = datetime.fromisoformat(gap_data["watermark"])

        # Single-pass analysis for ALL cities
        new_city_events = _analyze_all_cities(all_rows, pre_alerts_by_date, watermark_dt)
        for city_name, new_events in new_city_events.items():
            existing = gap_data["cities"].get(city_name, [])
            existing.extend(new_events)
            gap_data["cities"][city_name] = existing

        logging.info("Analyzed %d cities (%d new events total)",
                     len(new_city_events),
                     sum(len(v) for v in new_city_events.values()))

        # Update watermark and byte offset for next incremental download
        if all_rows:
            latest_dt = max(dt for dt, *_ in all_rows)
            gap_data["watermark"] = (latest_dt - timedelta(hours=6)).isoformat()
        gap_data["csv_byte_offset"] = new_total_bytes

        # Compute thresholds per city
        target_fn_rate = 0.05
        thresholds = {
            "updated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "default_stable_seconds": 300,
            "target_fn_rate": target_fn_rate,
            "cities": {},
        }

        for city_name, events in gap_data["cities"].items():
            if len(events) < MIN_EVENTS_FOR_THRESHOLD:
                continue
            stable_sec, event_count, fn_rate = _compute_threshold(events, target_fn_rate)
            thresholds["cities"][city_name] = {
                "stable_seconds": stable_sec,
                "events": event_count,
                "fn_rate": round(fn_rate, 4),
            }

        _write_json_blob(container, "api/gap_data.json", gap_data)
        _write_json_blob(container, "api/thresholds.json", thresholds)
        logging.info("Wrote thresholds for %d cities", len(thresholds["cities"]))

    # Refresh the cached city list from oref
    try:
        resp = httpx.get(CITIES_MIX_URL, timeout=30.0)
        resp.raise_for_status()
        raw = resp.json()
        labels = sorted({entry.get("label_he", entry.get("label", "")) for entry in raw} - {""})
        _write_json_blob(container, "api/cities.json", labels)
        logging.info("Refreshed cities.json: %d cities", len(labels))
    except Exception:
        logging.exception("Failed to refresh cities.json — keeping previous version")

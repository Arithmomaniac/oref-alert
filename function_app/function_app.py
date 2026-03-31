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
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import azure.functions as func
import httpx
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContentSettings

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


# ---------------------------------------------------------------------------
# 1. HTTP-triggered /api/register endpoint
# ---------------------------------------------------------------------------

@app.function_name("register_city")
@app.route(route="register", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def register_city(req: func.HttpRequest) -> func.HttpResponse:
    """City registration heartbeat — records which cities are active."""
    city = req.params.get("city")
    if not city:
        return func.HttpResponse("Missing 'city' query parameter", status_code=400)

    container = _get_container_client()
    blob_path = "api/active_cities.json"

    cities = _read_json_blob(container, blob_path, default={})
    now = datetime.now(timezone.utc)
    cities[city] = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    cutoff = now - timedelta(days=7)
    cities = {
        c: ts for c, ts in cities.items()
        if datetime.fromisoformat(ts.replace("Z", "+00:00")) > cutoff
    }

    _write_json_blob(container, blob_path, cities)

    return func.HttpResponse(
        json.dumps({"ok": True, "city": city}, ensure_ascii=False),
        status_code=200,
        mimetype="application/json",
        headers={"Access-Control-Allow-Origin": "*"},
    )


@app.function_name("compute_city")
@app.route(route="compute", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def compute_city(req: func.HttpRequest) -> func.HttpResponse:
    """On-demand threshold computation for a single city."""
    city = req.params.get("city")
    if not city:
        return func.HttpResponse("Missing 'city' query parameter", status_code=400)

    container = _get_container_client()

    # Check if city already has a threshold
    thresholds = _read_json_blob(container, "api/thresholds.json", default={})
    if thresholds.get("cities", {}).get(city):
        return func.HttpResponse(
            json.dumps({"ok": True, "city": city, "status": "already_computed",
                        "threshold": thresholds["cities"][city]}, ensure_ascii=False),
            status_code=200, mimetype="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
        )

    logging.info("On-demand compute for city: %s", city)

    gap_data = _read_json_blob(
        container, "api/gap_data.json",
        default={"watermark": None, "csv_byte_offset": 0, "cities": {}},
    )

    # Download CSV (incremental if possible)
    byte_offset = gap_data.get("csv_byte_offset", 0)
    headers = {}
    if byte_offset > 0:
        headers["Range"] = f"bytes={byte_offset}-"

    resp = httpx.get(CSV_URL, timeout=120.0, verify=True, headers=headers)
    resp.raise_for_status()
    raw_bytes = resp.content

    if byte_offset > 0 and resp.status_code == 206:
        csv_text = "data,date,time,alertDate,category,category_desc,matrix_id,rid\n" + raw_bytes.decode("utf-8")
        new_total_bytes = byte_offset + len(raw_bytes)
    else:
        csv_text = raw_bytes.decode("utf-8")
        new_total_bytes = len(raw_bytes)

    now = datetime.now(timezone.utc)
    cutoff_dt = (now - timedelta(hours=6)).replace(tzinfo=None)
    all_rows, pre_alerts_by_date = _load_csv_rows(csv_text, cutoff_dt)

    # For a new city we need to scan all data (watermark doesn't apply)
    new_events = _analyze_city(city, all_rows, pre_alerts_by_date, watermark_dt=None)

    # Update gap_data for this city
    gap_data["cities"][city] = new_events
    gap_data["csv_byte_offset"] = new_total_bytes
    if all_rows:
        latest_dt = max(dt for dt, *_ in all_rows)
        gap_data["watermark"] = (latest_dt - timedelta(hours=6)).isoformat()

    # Compute threshold
    stable_sec, event_count, fn_rate = _compute_threshold(new_events)
    city_threshold = {
        "stable_seconds": stable_sec,
        "events": event_count,
        "fn_rate": round(fn_rate, 4),
    }

    # Update thresholds.json
    if "cities" not in thresholds:
        thresholds["cities"] = {}
    thresholds["cities"][city] = city_threshold
    thresholds["updated"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    _write_json_blob(container, "api/gap_data.json", gap_data)
    _write_json_blob(container, "api/thresholds.json", thresholds)
    logging.info("Computed threshold for %s: %ds (%d events, %.1f%% FN)",
                 city, stable_sec, event_count, fn_rate * 100)

    return func.HttpResponse(
        json.dumps({"ok": True, "city": city, "status": "computed",
                    "threshold": city_threshold}, ensure_ascii=False),
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

# These cities always get thresholds computed, regardless of registration
ALWAYS_ACTIVE_CITIES = ["כרמיאל", "בית שמש", "חריש"]


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
      gap_seconds: 0 (immediate), positive (max gap), or None (miss)
      outcome: "immediate", "hit_after_gap", "miss"
      cohort_sirens_count: how many cohort cities got sirens
    """
    seen_cohort = set()
    new_cohort_times = []
    city_siren_time = None

    for dt, areas in sirens:
        if city_siren_time is None and any(_city_matches(a, target_city) for a in areas):
            city_siren_time = dt
        for cohort_city in cohort_cities:
            if cohort_city not in seen_cohort and any(_city_matches(a, cohort_city) for a in areas):
                seen_cohort.add(cohort_city)
                new_cohort_times.append(dt)

    if city_siren_time is None:
        return None, "miss", len(seen_cohort)

    cohort_times_before = [t for t in new_cohort_times if t < city_siren_time]
    if not cohort_times_before:
        return 0, "immediate", len(seen_cohort)

    timestamps = cohort_times_before + [city_siren_time]
    gaps = [(timestamps[i] - timestamps[i - 1]).total_seconds() for i in range(1, len(timestamps))]
    return max(gaps), "hit_after_gap", len(seen_cohort)


def _analyze_city(target_city, all_rows, pre_alerts_by_date, watermark_dt):
    """Run gap analysis for every pre-alert event for a single city.

    Returns list of {"outcome": str, "gap": float|None, "alert_date": str}.
    """
    events = []
    for alert_date_str, cities_in_blast in sorted(pre_alerts_by_date.items()):
        if not any(_city_matches(c, target_city) for c in cities_in_blast):
            continue

        # Find per-second timestamp for this pre-alert
        pre_alert_dt = None
        for dt, cat, areas, ad in all_rows:
            if ad == alert_date_str and cat == PRE_ALERT_CATEGORY:
                if any(_city_matches(a, target_city) for a in areas):
                    pre_alert_dt = dt
                    break
        if pre_alert_dt is None:
            pre_alert_dt = datetime.fromisoformat(alert_date_str)

        if watermark_dt and pre_alert_dt <= watermark_dt:
            continue

        cohort_cities = {
            c for c in cities_in_blast if not _city_matches(c, target_city)
        }
        window_end = _find_end_time(all_rows, target_city, pre_alert_dt)
        sirens = _find_sirens_in_window(all_rows, pre_alert_dt, window_end)
        gap, outcome, cohort_sirens = _compute_gap(target_city, cohort_cities, sirens)

        events.append({
            "outcome": outcome,
            "gap": gap,
            "alert_date": alert_date_str,
            "cohort_size": len(cohort_cities),
            "cohort_sirens": cohort_sirens,
        })
    return events


def _compute_threshold(events, target_fn_rate=0.05):
    """Find the lowest threshold (30s increments, 30-600s) where FN rate ≤ target.

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

    for threshold in range(30, 601, 30):
        fn = sum(
            1 for e in events
            if e["outcome"] == "hit_after_gap" and e["gap"] is not None and e["gap"] > threshold
        )
        denom = miss_with_sirens + fn
        fn_rate = fn / denom if denom > 0 else 0.0
        if fn_rate <= target_fn_rate:
            return threshold, len(events), fn_rate

    return 600, len(events), 0.0


@app.function_name("compute_thresholds")
@app.timer_trigger(schedule="0 0 3 * * *", arg_name="timer", run_on_startup=False)
def compute_thresholds(timer: func.TimerRequest) -> None:
    """Daily job: compute per-city alert gap thresholds from historical data."""
    container = _get_container_client()

    active_cities = _read_json_blob(container, "api/active_cities.json", default={})

    # Always-active cities are included even if no one has registered them
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for c in ALWAYS_ACTIVE_CITIES:
        if c not in active_cities:
            active_cities[c] = now_str

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
        # Range response — prepend a fake header so csv.reader works
        csv_text = "data,date,time,alertDate,category,category_desc,matrix_id,rid\n" + raw_bytes.decode("utf-8")
        new_total_bytes = byte_offset + len(raw_bytes)
    else:
        csv_text = raw_bytes.decode("utf-8")
        new_total_bytes = len(raw_bytes)

    logging.info("Downloaded %d bytes (total offset: %d)", len(raw_bytes), new_total_bytes)

    now = datetime.now(timezone.utc)
    # CSV uses Israel local time (naive); strip tz for comparison.
    # 6-hour lag is generous enough to absorb the UTC+2/3 difference.
    cutoff_dt = (now - timedelta(hours=6)).replace(tzinfo=None)

    all_rows, pre_alerts_by_date = _load_csv_rows(csv_text, cutoff_dt)
    logging.info("Parsed %d rows (2026+, before 6h lag)", len(all_rows))

    watermark_dt = None
    if gap_data.get("watermark"):
        watermark_dt = datetime.fromisoformat(gap_data["watermark"])

    city_names = list(active_cities.keys())

    def _process_city(city_name):
        new_events = _analyze_city(city_name, all_rows, pre_alerts_by_date, watermark_dt)
        return city_name, new_events

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(_process_city, c): c for c in city_names}

    for future in futures:
        city_name, new_events = future.result()
        existing = gap_data["cities"].get(city_name, [])
        existing.extend(new_events)
        gap_data["cities"][city_name] = existing
        logging.info("City %s: %d new events (total %d)", city_name, len(new_events), len(existing))

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

    for city_name in gap_data["cities"]:
        events = gap_data["cities"][city_name]
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

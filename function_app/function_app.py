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

import json
import logging
import os
import threading
from datetime import datetime, timedelta, timezone

import azure.functions as func
import httpx
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobLeaseClient, BlobServiceClient, ContentSettings

from analysis import (
    analyze_all_cities,
    compute_all_thresholds,
    load_csv_rows,
)

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
LOCK_LEASE_SECONDS = 30  # short lease; background thread renews it
LOCK_RENEW_INTERVAL = 10  # renew every 10s (well before 30s expiry)


class _ComputeLock:
    """Blob lease-based lock with background renewal thread.

    Uses a short finite lease (30s) so that if the function crashes, the lock
    auto-expires quickly. A background daemon thread renews the lease every 10s
    while the context manager is held.
    """

    def __init__(self, container_client):
        self._container = container_client
        self._lease = None
        self._stop_event = threading.Event()
        self._renew_thread = None

    def _renew_loop(self):
        while not self._stop_event.wait(LOCK_RENEW_INTERVAL):
            try:
                self._lease.renew()
            except Exception:
                break  # lease lost — stop renewing

    def __enter__(self):
        blob = self._container.get_blob_client(LOCK_BLOB)
        # Ensure lock blob exists
        try:
            blob.upload_blob(b"lock", overwrite=False)
        except Exception:
            pass  # already exists
        self._lease = BlobLeaseClient(blob)
        self._lease.acquire(lease_duration=LOCK_LEASE_SECONDS)
        self._renew_thread = threading.Thread(
            target=self._renew_loop, daemon=True
        )
        self._renew_thread.start()
        return self

    def __exit__(self, *args):
        self._stop_event.set()
        if self._renew_thread:
            self._renew_thread.join(timeout=5)
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

CSV_URL = "https://raw.githubusercontent.com/dleshem/israel-alerts-data/refs/heads/main/israel-alerts.csv"
CITIES_MIX_URL = "https://alerts-history.oref.org.il/Shared/Ajax/GetCitiesMix.aspx"
ELADNAVA_CITIES_URL = "https://raw.githubusercontent.com/eladnava/redalert-android/master/app/src/main/res/raw/cities.json"


@app.function_name("compute_thresholds")
@app.timer_trigger(schedule="0 0 3 * * *", arg_name="timer", run_on_startup=False)
def compute_thresholds(timer: func.TimerRequest) -> None:
    """Daily job: compute per-city alert gap thresholds for ALL cities."""
    container = _get_container_client()

    # Phase 1: CSV download + threshold computation (locked, may fail independently)
    try:
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
            if resp.status_code == 416:
                # Stored offset exceeds file size (upstream CSV regenerated).
                # Reset and re-download from scratch.
                logging.warning("416 Range Not Satisfiable — resetting offset to 0")
                gap_data["csv_byte_offset"] = 0
                resp = httpx.get(CSV_URL, timeout=120.0, verify=True)
            resp.raise_for_status()
            raw_bytes = resp.content

            byte_offset = gap_data.get("csv_byte_offset", 0)
            if byte_offset > 0:
                csv_text = "data,date,time,alertDate,category,category_desc,matrix_id,rid\n" + raw_bytes.decode("utf-8")
                new_total_bytes = byte_offset + len(raw_bytes)
            else:
                csv_text = raw_bytes.decode("utf-8")
                new_total_bytes = len(raw_bytes)

            logging.info("Downloaded %d bytes (total offset: %d)", len(raw_bytes), new_total_bytes)

            now = datetime.now(timezone.utc)
            cutoff_dt = (now - timedelta(hours=6)).replace(tzinfo=None)

            all_rows, pre_alerts_by_date = load_csv_rows(csv_text, cutoff_dt)
            logging.info("Parsed %d rows (2026+, before 6h lag)", len(all_rows))

            watermark_dt = None
            if gap_data.get("watermark"):
                watermark_dt = datetime.fromisoformat(gap_data["watermark"])

            # Single-pass analysis for ALL cities
            new_city_events = analyze_all_cities(all_rows, pre_alerts_by_date, watermark_dt)
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
            now = datetime.now(timezone.utc)
            thresholds = compute_all_thresholds(gap_data)
            thresholds["updated"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")

            _write_json_blob(container, "api/gap_data.json", gap_data)
            _write_json_blob(container, "api/thresholds.json", thresholds)
            logging.info("Wrote thresholds for %d cities", len(thresholds["cities"]))
    except Exception:
        logging.exception("Threshold computation failed — continuing to city/geo refresh")

    # Refresh the cached city list from oref
    try:
        resp = httpx.get(CITIES_MIX_URL, timeout=30.0)
        resp.raise_for_status()
        raw = resp.json()
        labels = sorted({entry.get("label_he", entry.get("label", "")) for entry in raw} - {""})
        _write_json_blob(container, "api/cities.json", labels)
        logging.info("Refreshed cities.json: %d cities", len(labels))
    except Exception:
        labels = None
        logging.exception("Failed to refresh cities.json — keeping previous version")

    # Generate cities-geo.json (name → lat/lng) for browser geolocation → city lookup.
    # Only include cities whose names exactly match the canonical oref city list to avoid
    # mismatches (eladnava uses different apostrophe chars, etc.).
    if labels is not None:
        try:
            resp = httpx.get(ELADNAVA_CITIES_URL, timeout=30.0)
            resp.raise_for_status()
            geo_cities = resp.json()
            oref_set = set(labels)
            geo_list = []
            for c in geo_cities:
                name = c.get("name", "").strip()
                lat = c.get("lat")
                lng = c.get("lng")
                if name and lat and lng and name in oref_set:
                    geo_list.append({"name": name, "lat": lat, "lng": lng})
            _write_json_blob(container, "api/cities-geo.json", geo_list)
            logging.info(
                "Refreshed cities-geo.json: %d/%d cities with coordinates",
                len(geo_list), len(labels),
            )
        except Exception:
            logging.exception("Failed to refresh cities-geo.json — keeping previous version")

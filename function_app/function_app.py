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
import math
import os
import threading
import time as _time
from datetime import datetime, timedelta, timezone

import azure.functions as func
import httpx
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobLeaseClient, BlobServiceClient, ContentSettings

from analysis import (
    analyze_all_cities,
    compute_all_thresholds,
    find_no_warning_sirens,
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
# Geolocation: /api/locate endpoint
# ---------------------------------------------------------------------------

_CACHE_TTL = 3600  # 1 hour
_polygon_cache = None
_polygon_cache_ts = 0.0
_cities_geo_cache = None
_cities_geo_cache_ts = 0.0


def _load_cached_polygons(container):
    """Load polygon data from blob, caching in memory with TTL."""
    global _polygon_cache, _polygon_cache_ts
    now = _time.monotonic()
    if _polygon_cache is not None and (now - _polygon_cache_ts) < _CACHE_TTL:
        return _polygon_cache
    data = _read_json_blob(container, "api/polygons.json", default={})
    if data:  # only cache non-empty to avoid poisoning on transient errors
        _polygon_cache = data
        _polygon_cache_ts = now
    return data


def _load_cached_cities_geo(container):
    """Load cities-geo data from blob, caching in memory with TTL."""
    global _cities_geo_cache, _cities_geo_cache_ts
    now = _time.monotonic()
    if _cities_geo_cache is not None and (now - _cities_geo_cache_ts) < _CACHE_TTL:
        return _cities_geo_cache
    data = _read_json_blob(container, "api/cities-geo.json", default=[])
    if data:
        _cities_geo_cache = data
        _cities_geo_cache_ts = now
    return data


def _point_in_polygon(point_lat: float, point_lng: float, polygon: list) -> bool:
    """Ray-casting point-in-polygon test. Polygon is [[lat, lng], ...]."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        yi, xi = polygon[i]   # yi = lat, xi = lng
        yj, xj = polygon[j]
        if ((yi > point_lat) != (yj > point_lat)) and \
           (point_lng < (xj - xi) * (point_lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


@app.function_name("locate_city")
@app.route(route="locate", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def locate_city(req: func.HttpRequest) -> func.HttpResponse:
    """Resolve lat/lng to a city using polygon containment, falling back to nearest city."""
    lat_str = req.params.get("lat")
    lng_str = req.params.get("lng")
    if not lat_str or not lng_str:
        return func.HttpResponse(
            json.dumps({"error": "lat and lng query parameters are required"}),
            status_code=400, mimetype="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
        )

    try:
        lat = float(lat_str)
        lng = float(lng_str)
    except ValueError:
        return func.HttpResponse(
            json.dumps({"error": "lat and lng must be valid numbers"}),
            status_code=400, mimetype="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
        )

    if not (math.isfinite(lat) and math.isfinite(lng)):
        return func.HttpResponse(
            json.dumps({"error": "lat and lng must be finite numbers"}),
            status_code=400, mimetype="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
        )

    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return func.HttpResponse(
            json.dumps({"error": "lat must be -90..90 and lng must be -180..180"}),
            status_code=400, mimetype="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
        )

    container = _get_container_client()

    # Try polygon containment first
    polygons = _load_cached_polygons(container)
    for city_name, polygon in polygons.items():
        if _point_in_polygon(lat, lng, polygon):
            return func.HttpResponse(
                json.dumps({"city": city_name, "method": "polygon"}, ensure_ascii=False),
                status_code=200, mimetype="application/json",
                headers={"Access-Control-Allow-Origin": "*"},
            )

    # Fallback: nearest city by Euclidean distance
    cities_geo = _load_cached_cities_geo(container)
    best_name = None
    best_dist = float("inf")
    for c in cities_geo:
        d = (c["lat"] - lat) ** 2 + (c["lng"] - lng) ** 2
        if d < best_dist:
            best_dist = d
            best_name = c["name"]

    if best_name:
        return func.HttpResponse(
            json.dumps({"city": best_name, "method": "nearest"}, ensure_ascii=False),
            status_code=200, mimetype="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
        )

    return func.HttpResponse(
        json.dumps({"error": "no city found"}),
        status_code=404, mimetype="application/json",
        headers={"Access-Control-Allow-Origin": "*"},
    )


# ---------------------------------------------------------------------------
# 2. Daily timer-triggered compute_thresholds
# ---------------------------------------------------------------------------

CSV_URL = "https://raw.githubusercontent.com/dleshem/israel-alerts-data/refs/heads/main/israel-alerts.csv"
CITIES_MIX_URL = "https://alerts-history.oref.org.il/Shared/Ajax/GetCitiesMix.aspx"
ELADNAVA_CITIES_URL = "https://raw.githubusercontent.com/eladnava/redalert-android/master/app/src/main/res/raw/cities.json"
ELADNAVA_POLYGONS_URL = "https://raw.githubusercontent.com/eladnava/redalert-android/master/app/src/main/res/raw/polygons.json"


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
                default={"watermark": None, "last_rid": None, "cities": {}},
            )

            # Stream CSV — line-by-line to avoid loading 40+ MB into memory.
            # Use rid watermark to skip already-processed rows (survives
            # upstream CSV regeneration, unlike byte-offset).
            last_rid = gap_data.get("last_rid")
            logging.info("Streaming israel-alerts.csv (skip rid <= %s) …", last_rid)

            now = datetime.now(timezone.utc)
            cutoff_dt = (now - timedelta(hours=6)).replace(tzinfo=None)

            with httpx.Client(timeout=300.0, verify=True) as client:
                with client.stream("GET", CSV_URL) as resp:
                    resp.raise_for_status()
                    lines = resp.iter_lines()
                    all_rows, pre_alerts_by_date, max_rid = load_csv_rows(
                        lines, cutoff_dt, min_rid=last_rid,
                    )

            logging.info("Parsed %d rows (2026+, before 6h lag), max_rid=%s",
                         len(all_rows), max_rid)

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

            # Find sirens without any preceding pre-alert.
            # skip_initial_window=True avoids false positives at batch
            # boundaries where a pre-alert may have been in the prior batch.
            new_no_warning = find_no_warning_sirens(
                all_rows, skip_initial_window=(last_rid is not None),
            )
            nw_store = gap_data.get("no_warning_sirens", {})
            for city_name, new_events in new_no_warning.items():
                existing_nw = nw_store.get(city_name, [])
                seen_dates = {e["alert_date"] for e in existing_nw}
                for ev in new_events:
                    if ev["alert_date"] not in seen_dates:
                        existing_nw.append(ev)
                nw_store[city_name] = existing_nw
            gap_data["no_warning_sirens"] = nw_store

            # Update watermarks
            if all_rows:
                latest_dt = max(dt for dt, *_ in all_rows)
                gap_data["watermark"] = (latest_dt - timedelta(hours=6)).isoformat()
            if max_rid is not None:
                gap_data["last_rid"] = max_rid

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
    # Also build id→name mapping for polygon processing below.
    eladnava_id_to_name = {}
    if labels is not None:
        try:
            resp = httpx.get(ELADNAVA_CITIES_URL, timeout=30.0)
            resp.raise_for_status()
            geo_cities = resp.json()
            oref_set = set(labels)
            geo_list = []
            for c in geo_cities:
                name = c.get("name", "").strip()
                cid = c.get("id")
                lat = c.get("lat")
                lng = c.get("lng")
                if name and name in oref_set:
                    if cid is not None:
                        eladnava_id_to_name[str(cid)] = name
                    if lat and lng:
                        geo_list.append({"name": name, "lat": lat, "lng": lng})
            _write_json_blob(container, "api/cities-geo.json", geo_list)
            logging.info(
                "Refreshed cities-geo.json: %d/%d cities with coordinates",
                len(geo_list), len(labels),
            )
        except Exception:
            logging.exception("Failed to refresh cities-geo.json — keeping previous version")

    # Generate polygons.json (name → polygon coords) for server-side point-in-polygon.
    # polygons.json from eladnava is keyed by numeric city ID; map to names via cities.json.
    if eladnava_id_to_name:
        try:
            resp = httpx.get(ELADNAVA_POLYGONS_URL, timeout=30.0)
            resp.raise_for_status()
            raw_polygons = resp.json()
            named_polygons = {}
            for cid, coords in raw_polygons.items():
                name = eladnava_id_to_name.get(str(cid))
                if name and coords:
                    named_polygons[name] = coords
            _write_json_blob(container, "api/polygons.json", named_polygons)
            logging.info(
                "Refreshed polygons.json: %d/%d polygon entries mapped to oref cities",
                len(named_polygons), len(raw_polygons),
            )
        except Exception:
            logging.exception("Failed to refresh polygons.json — keeping previous version")

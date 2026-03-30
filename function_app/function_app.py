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
from datetime import datetime, timezone

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

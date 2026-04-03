#!/usr/bin/env python3
"""
Local CLI for running oref-alert threshold analysis.

Uses the same analysis.py module as the Azure Function to ensure identical
results. Downloads the CSV, runs analysis, and writes JSON output files.

Usage:
    python run_analysis.py                    # writes to stdout summary
    python run_analysis.py --output-dir .     # writes gap_data.json + thresholds.json
    python run_analysis.py --upload           # writes directly to Azure blob storage
"""

import argparse
import json
import logging
import sys
from datetime import datetime, timedelta, timezone

import httpx

from analysis import (
    analyze_all_cities,
    compute_all_thresholds,
    load_csv_rows,
)

CSV_URL = "https://raw.githubusercontent.com/dleshem/israel-alerts-data/refs/heads/main/israel-alerts.csv"

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description="Run oref-alert threshold analysis locally")
    parser.add_argument("--csv", help="Path to local CSV file (skips download)")
    parser.add_argument("--output-dir", help="Directory to write gap_data.json and thresholds.json")
    parser.add_argument("--upload", action="store_true", help="Upload results to Azure blob storage")
    parser.add_argument("--city", help="Show detailed stats for a specific city")
    args = parser.parse_args()

    # Load CSV
    if args.csv:
        log.info("Reading CSV from %s", args.csv)
        with open(args.csv, "r", encoding="utf-8") as f:
            csv_text = f.read()
        csv_byte_count = len(csv_text.encode("utf-8"))
    else:
        log.info("Downloading CSV from GitHub...")
        resp = httpx.get(CSV_URL, timeout=300.0)
        resp.raise_for_status()
        csv_text = resp.content.decode("utf-8")
        csv_byte_count = len(resp.content)
    log.info("CSV: %d bytes", csv_byte_count)

    # Parse
    now = datetime.now(timezone.utc)
    cutoff_dt = (now - timedelta(hours=6)).replace(tzinfo=None)
    all_rows, pre_alerts_by_date = load_csv_rows(csv_text, cutoff_dt)
    log.info("Parsed %d rows, %d pre-alert dates", len(all_rows), len(pre_alerts_by_date))

    # Analyze (from scratch, no watermark)
    city_events = analyze_all_cities(all_rows, pre_alerts_by_date, watermark_dt=None)
    total_events = sum(len(v) for v in city_events.values())
    log.info("Analyzed %d cities (%d total events)", len(city_events), total_events)

    # Build gap_data
    gap_data = {
        "watermark": (max(dt for dt, *_ in all_rows) - timedelta(hours=6)).isoformat() if all_rows else None,
        "csv_byte_offset": csv_byte_count,
        "cities": city_events,
    }

    # Compute thresholds
    thresholds = compute_all_thresholds(gap_data)
    thresholds["updated"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    with_timing = sum(1 for c in thresholds["cities"].values() if "earliest_siren_seconds" in c)
    log.info("Thresholds: %d cities, %d with siren timing", len(thresholds["cities"]), with_timing)

    # Show specific city if requested
    if args.city:
        city_thresh = thresholds["cities"].get(args.city)
        if city_thresh:
            log.info("\n%s: %s", args.city, json.dumps(city_thresh, ensure_ascii=False, indent=2))
        else:
            log.info("\n%s: not found in thresholds (may have < 5 events)", args.city)
        city_evts = city_events.get(args.city, [])
        log.info("Raw events: %d", len(city_evts))
        if city_evts:
            outcomes = {}
            for e in city_evts:
                outcomes[e["outcome"]] = outcomes.get(e["outcome"], 0) + 1
            log.info("Outcomes: %s", outcomes)
            with_pa = [e for e in city_evts if e.get("pre_alert_to_siren") is not None]
            log.info("With pre_alert_to_siren: %d", len(with_pa))
            if with_pa:
                vals = sorted(e["pre_alert_to_siren"] for e in with_pa)
                log.info("  min=%.1fs  median=%.1fs  max=%.1fs", vals[0], vals[len(vals)//2], vals[-1])

    # Output
    if args.output_dir:
        import os
        gap_path = os.path.join(args.output_dir, "gap_data.json")
        thresh_path = os.path.join(args.output_dir, "thresholds.json")
        with open(gap_path, "w", encoding="utf-8") as f:
            json.dump(gap_data, f, ensure_ascii=False)
        with open(thresh_path, "w", encoding="utf-8") as f:
            json.dump(thresholds, f, ensure_ascii=False)
        log.info("Wrote %s and %s", gap_path, thresh_path)

    if args.upload:
        from azure.identity import DefaultAzureCredential
        from azure.storage.blob import BlobServiceClient, ContentSettings

        log.info("Uploading to Azure blob storage...")
        cred = DefaultAzureCredential()
        account_url = "https://orefalertst.blob.core.windows.net"
        bsc = BlobServiceClient(account_url, credential=cred)
        container = bsc.get_container_client("$web")
        settings = ContentSettings(content_type="application/json; charset=utf-8", cache_control="no-cache")

        for name, data in [("api/gap_data.json", gap_data), ("api/thresholds.json", thresholds)]:
            container.get_blob_client(name).upload_blob(
                json.dumps(data, ensure_ascii=False), overwrite=True, content_settings=settings
            )
            log.info("  Uploaded %s", name)
        log.info("Done!")


if __name__ == "__main__":
    main()

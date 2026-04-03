"""
Shared analysis logic for oref-alert threshold computation.

Used by both the Azure Function (function_app.py) and the local CLI
(run_analysis.py) to ensure identical results.
"""

import csv
import io
from collections import defaultdict
from datetime import datetime, timedelta

HIST_ALERT_CATEGORIES = {1, 2, 3, 4, 7, 8, 9, 10, 11, 12}
END_CATEGORY = 13
PRE_ALERT_CATEGORY = 14
EVENT_WINDOW_MIN = 20
MIN_EVENTS_FOR_THRESHOLD = 5


def parse_date_time(date_str: str, time_str: str) -> datetime:
    """Parse DD.MM.YYYY + HH:MM:SS to datetime."""
    return datetime.strptime(f"{date_str} {time_str}", "%d.%m.%Y %H:%M:%S")


def city_matches(area: str, city: str) -> bool:
    """Substring match: 'בית שמש 188' matches 'בית שמש'."""
    return city in area


def load_csv_rows(csv_text: str, cutoff_dt: datetime):
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
            dt = parse_date_time(row[1], row[2])
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


def find_end_time(all_rows, target_city, start_dt):
    """Find the first END event (cat 13) for target_city after start_dt,
    capped at start_dt + EVENT_WINDOW_MIN minutes."""
    max_dt = start_dt + timedelta(minutes=EVENT_WINDOW_MIN)
    for dt, cat, areas, _ad in all_rows:
        if dt <= start_dt:
            continue
        if dt > max_dt:
            break
        if cat == END_CATEGORY and any(city_matches(a, target_city) for a in areas):
            return dt
    return max_dt


def find_sirens_in_window(all_rows, start_dt, end_dt):
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


def compute_gap(target_city, cohort_cities, sirens):
    """Compute the gap between first cohort siren and target city siren.

    Returns (gap_seconds, outcome, cohort_sirens_count).
      gap_seconds: float or None if target never got a siren
      outcome: 'immediate' | 'hit_after_gap' | 'miss'
      cohort_sirens_count: how many cohort cities got sirens
    """
    city_siren_time = None
    first_cohort_time = None
    seen_cohort = set()

    for dt, areas in sirens:
        for area in areas:
            if city_matches(area, target_city) and city_siren_time is None:
                city_siren_time = dt
            for cc in cohort_cities:
                if city_matches(area, cc) and cc not in seen_cohort:
                    seen_cohort.add(cc)
                    if first_cohort_time is None or dt < first_cohort_time:
                        first_cohort_time = dt

    if city_siren_time is None:
        return None, "miss", len(seen_cohort)

    if first_cohort_time is None or first_cohort_time >= city_siren_time:
        return 0, "immediate", len(seen_cohort)

    gap = (city_siren_time - first_cohort_time).total_seconds()
    return gap, "hit_after_gap", len(seen_cohort)


def analyze_all_cities(all_rows, pre_alerts_by_date, watermark_dt):
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

            pre_alert_to_siren = None
            if target_siren is not None:
                pre_alert_to_siren = (target_siren - pre_alert_dt).total_seconds()

            city_events[target_city].append({
                "outcome": outcome,
                "gap": gap,
                "alert_date": alert_date_str,
                "cohort_size": len(blast_list) - 1,
                "cohort_sirens": cohort_with_sirens,
                "pre_alert_to_siren": pre_alert_to_siren,
            })

    return dict(city_events)


def compute_threshold(events, target_fn_rate=0.05):
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


def compute_siren_timing_stats(events):
    """Compute summary statistics for pre-alert → target city siren times.

    Returns dict with earliest/median/p25/p75 in seconds, or None if no data.
    """
    values = sorted(
        e["pre_alert_to_siren"]
        for e in events
        if e.get("pre_alert_to_siren") is not None
    )
    if not values:
        return None

    n = len(values)
    if n % 2 == 1:
        median = values[n // 2]
    else:
        median = (values[n // 2 - 1] + values[n // 2]) / 2

    return {
        "earliest_siren_seconds": round(values[0], 1),
        "median_siren_seconds": round(median, 1),
        "p25_siren_seconds": round(values[max(0, n // 4)], 1),
        "p75_siren_seconds": round(values[min(n - 1, 3 * n // 4)], 1),
        "siren_timing_count": n,
    }


def compute_all_thresholds(gap_data, target_fn_rate=0.05):
    """Compute thresholds for all cities from gap_data.

    Returns dict suitable for thresholds.json (minus the 'updated' field).
    """
    thresholds = {
        "default_stable_seconds": 300,
        "target_fn_rate": target_fn_rate,
        "cities": {},
    }

    for city_name, events in gap_data["cities"].items():
        if len(events) < MIN_EVENTS_FOR_THRESHOLD:
            continue
        stable_sec, event_count, fn_rate = compute_threshold(events, target_fn_rate)
        city_thresh = {
            "stable_seconds": stable_sec,
            "events": event_count,
            "fn_rate": round(fn_rate, 4),
        }
        timing = compute_siren_timing_stats(events)
        if timing:
            city_thresh.update(timing)
        thresholds["cities"][city_name] = city_thresh

    return thresholds

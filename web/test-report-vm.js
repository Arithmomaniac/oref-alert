/**
 * test-report-vm.js — Unit tests for report-vm.js
 *
 * Run: node web/test-report-vm.js
 */

import { computeStats, fmtThresh, buildInsightText, buildStatCardsData, buildThresholdTableData } from "./report-vm.js";

var passed = 0;
var failed = 0;

function assert(condition, msg) {
  if (!condition) {
    console.error("  ✗ FAIL:", msg);
    failed++;
  } else {
    console.log("  ✓", msg);
    passed++;
  }
}

function approx(a, b, tol) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < (tol || 0.01);
}

// ── Test 1: computeStats — basic counts ──
console.log("\n1. computeStats — basic counts");
var events = [
  { outcome: "miss", gap: null, cohort_sirens: 2, pre_alert_to_siren: null },
  { outcome: "miss", gap: null, cohort_sirens: 0, pre_alert_to_siren: null },
  { outcome: "immediate", gap: 0, cohort_sirens: 3, pre_alert_to_siren: 5 },
  { outcome: "hit_after_gap", gap: 120, cohort_sirens: 2, pre_alert_to_siren: 180 },
  { outcome: "hit_after_gap", gap: 300, cohort_sirens: 4, pre_alert_to_siren: 360 },
];
var s = computeStats(events);
assert(s.miss === 2, "miss = 2, got " + s.miss);
assert(s.missWithSirens === 1, "missWithSirens = 1, got " + s.missWithSirens);
assert(s.immediate === 1, "immediate = 1, got " + s.immediate);
assert(s.gapCount === 2, "gapCount = 2, got " + s.gapCount);
assert(s.total === 5, "total = 5, got " + s.total);

// ── Test 2: computeStats — FN rate curve ──
console.log("\n2. computeStats — FN rate curve");
// thresholdValues[0] = 0: FN = gaps > 0 = 2 (120,300), denom = missWithSirens(1) + 2 = 3, rate = 66.7
assert(approx(s.fnRates[0], 66.7, 0.1), "FN at 0s = 66.7%, got " + s.fnRates[0]);
// thresholdValues[4] = 120: FN = gaps > 120 = 1 (300), denom = 1 + 1 = 2, rate = 50
assert(approx(s.fnRates[4], 50.0, 0.1), "FN at 120s = 50%, got " + s.fnRates[4]);
// thresholdValues[10] = 300: FN = gaps > 300 = 0, denom = 1 + 0 = 1, rate = 0
assert(approx(s.fnRates[10], 0, 0.1), "FN at 300s = 0%, got " + s.fnRates[10]);

// ── Test 3: computeStats — histogram bins (30s) ──
console.log("\n3. computeStats — histogram bins (30s)");
assert(s.histBins[120] === 1, "bin 120 = 1, got " + s.histBins[120]);
assert(s.histBins[300] === 1, "bin 300 = 1, got " + s.histBins[300]);
assert(!s.histBins[0], "bin 0 should not exist (immediate has gap=0 but outcome is 'immediate')");

// ── Test 4: computeStats — paSirenStats percentiles ──
console.log("\n4. computeStats — paSirenStats percentiles");
// preAlertToSiren finite values: [5, 180, 360], padded with 2 Infinity → [5, 180, 360, Inf, Inf]
var pa = s.paSirenStats;
assert(pa !== null, "paSirenStats should not be null");
assert(pa.hitCount === 3, "hitCount = 3, got " + pa.hitCount);
assert(pa.totalCount === 5, "totalCount = 5, got " + pa.totalCount);
assert(approx(pa.hitRate, 0.6), "hitRate = 0.6, got " + pa.hitRate);
assert(pa.min === 5, "min = 5, got " + pa.min);
assert(pa.max === 360, "max = 360, got " + pa.max);
// padded = [5, 180, 360, Inf, Inf], length=5
// median: idx = 0.5 * 4 = 2 → padded[2] = 360 (frac=0)
assert(pa.median === 360, "median = 360, got " + pa.median);
// p5: idx = 0.05 * 4 = 0.2 → lo=0, hi=1, frac=0.2 → 5 + 0.2*(180-5) = 5+35 = 40
assert(approx(pa.p5, 40, 0.1), "p5 ≈ 40, got " + pa.p5);
// p25: idx = 0.25 * 4 = 1 → padded[1] = 180 (frac=0)
assert(pa.p25 === 180, "p25 = 180, got " + pa.p25);
// p75: idx = 0.75 * 4 = 3 → padded[3] = Inf → lo=3 is !isFinite → null
assert(pa.p75 === null, "p75 = null (Infinity), got " + pa.p75);
// p95: idx = 0.95 * 4 = 3.8 → lo=3, !isFinite → null
assert(pa.p95 === null, "p95 = null (Infinity), got " + pa.p95);

// ── Test 5: computeStats — preAlertHistBins ──
console.log("\n5. computeStats — preAlertHistBins");
assert(s.preAlertHistBins[0] === 1, "PA bin 0 = 1 (val 5), got " + s.preAlertHistBins[0]);
assert(s.preAlertHistBins[180] === 1, "PA bin 180 = 1 (val 180), got " + s.preAlertHistBins[180]);
assert(s.preAlertHistBins[360] === 1, "PA bin 360 = 1 (val 360), got " + s.preAlertHistBins[360]);

// ── Test 6: computeStats — empty events ──
console.log("\n6. computeStats — empty events");
var empty = computeStats([]);
assert(empty.total === 0, "empty total = 0");
assert(empty.miss === 0, "empty miss = 0");
assert(empty.paSirenStats === null, "empty paSirenStats = null");

// ── Test 7: fmtThresh ──
console.log("\n7. fmtThresh");
assert(fmtThresh(0) === "0", '0 → "0", got "' + fmtThresh(0) + '"');
assert(fmtThresh(30) === "30s", '30 → "30s", got "' + fmtThresh(30) + '"');
assert(fmtThresh(60) === "1m", '60 → "1m", got "' + fmtThresh(60) + '"');
assert(fmtThresh(90) === "1m30s", '90 → "1m30s", got "' + fmtThresh(90) + '"');
assert(fmtThresh(120) === "2m", '120 → "2m", got "' + fmtThresh(120) + '"');
assert(fmtThresh(150) === "2m30s", '150 → "2m30s", got "' + fmtThresh(150) + '"');
assert(fmtThresh(3) === "3s", '3 → "3s", got "' + fmtThresh(3) + '"');

// ── Test 8: buildInsightText ──
console.log("\n8. buildInsightText");
var statsMap = { "CityA": s, "CityB": s };
var thresholdsData = {
  cities: {
    CityA: { stable_seconds: 120, fn_rate: 0.033, events: 50 },
    CityB: { stable_seconds: 240, fn_rate: 0.05, events: 30 }
  }
};
var insightText = buildInsightText(["CityA", "CityB"], statsMap, thresholdsData);
assert(insightText.indexOf("CityA") !== -1, "insight contains CityA");
assert(insightText.indexOf("120s") !== -1, "insight contains 120s threshold");
assert(insightText.indexOf("CityB") !== -1, "insight contains CityB");
assert(insightText.indexOf("240s") !== -1, "insight contains 240s threshold");
assert(insightText.indexOf("3.3%") !== -1, "insight contains 3.3% FN for CityA");
assert(insightText.indexOf("5.0%") !== -1, "insight contains 5.0% FN for CityB");

// ── Test 9: buildStatCardsData ──
console.log("\n9. buildStatCardsData");
var colors = ["#2196F3", "#F44336"];
var cards = buildStatCardsData(["CityA", "CityB"], statsMap, thresholdsData, colors);
assert(cards.length === 2, "cards length = 2, got " + cards.length);
assert(cards[0].cityName === "CityA", "first card is CityA");
assert(cards[0].color === "#2196F3", "first card color");
assert(cards[0].total === 5, "first card total = 5");
assert(cards[0].miss === 2, "first card miss = 2");
assert(cards[0].immediate === 1, "first card immediate = 1");
assert(cards[0].gapCount === 2, "first card gapCount = 2");
assert(cards[0].threshStr === "120s", "first card threshStr = 120s");
assert(cards[1].cityName === "CityB", "second card is CityB");
assert(cards[1].threshStr === "240s", "second card threshStr = 240s");

// ── Test 10: buildThresholdTableData ──
console.log("\n10. buildThresholdTableData");
var rows = buildThresholdTableData(["CityA", "CityB"], statsMap, thresholdsData, colors);
assert(rows.length === 2, "rows length = 2, got " + rows.length);
assert(rows[0].cityName === "CityA", "row 0 cityName = CityA");
assert(rows[0].threshold === "120s", "row 0 threshold = 120s");
assert(rows[0].events === 5, "row 0 events = 5");
assert(rows[0].fnRate === "3.3%", "row 0 fnRate = 3.3%");
assert(rows[0].miss === 2, "row 0 miss = 2");
assert(rows[0].missWithSirens === 1, "row 0 missWithSirens = 1");
assert(rows[0].immediate === 1, "row 0 immediate = 1");
assert(rows[0].gapCount === 2, "row 0 gapCount = 2");
assert(rows[0].color === "#2196F3", "row 0 color");

// ── Test 11: buildStatCardsData / buildThresholdTableData — city without threshold ──
console.log("\n11. buildStatCardsData / buildThresholdTableData — city without threshold data");
var noThreshData = { cities: {} };
var cardsNoTh = buildStatCardsData(["CityA"], { CityA: s }, noThreshData, ["#000"]);
assert(cardsNoTh[0].threshStr === "N/A", "threshStr = N/A when no threshold data");
var rowsNoTh = buildThresholdTableData(["CityA"], { CityA: s }, noThreshData, ["#000"]);
assert(rowsNoTh[0].threshold === "N/A", "threshold = N/A when no threshold data");
assert(rowsNoTh[0].fnRate === "N/A", "fnRate = N/A when no threshold data");

// ── Test 12: computeStats — all hits, no misses ──
console.log("\n12. computeStats — all hits, no misses");
var allHits = [
  { outcome: "hit_after_gap", gap: 60, cohort_sirens: 1, pre_alert_to_siren: 60 },
  { outcome: "hit_after_gap", gap: 90, cohort_sirens: 2, pre_alert_to_siren: 100 },
  { outcome: "immediate", gap: 0, cohort_sirens: 1, pre_alert_to_siren: 10 },
];
var ah = computeStats(allHits);
assert(ah.miss === 0, "no misses");
assert(ah.missWithSirens === 0, "no missWithSirens");
assert(ah.gapCount === 2, "gapCount = 2");
assert(ah.immediate === 1, "immediate = 1");
// FN at 0: fn=2 (60,90 > 0), denom = 0 + 2 = 2, rate = 100
assert(approx(ah.fnRates[0], 100, 0.1), "FN at 0s = 100% (no misses, all gaps)");
// FN at 90: fn = 0 (no gaps > 90), denom = 0+0 = 0, rate = 0
assert(approx(ah.fnRates[3], 0, 0.1), "FN at 90s = 0%");
// paSirenStats: all events have pre_alert_to_siren, no padding
assert(ah.paSirenStats.hitCount === 3, "allHits hitCount = 3");
assert(ah.paSirenStats.hitRate === 1, "allHits hitRate = 1");
assert(ah.paSirenStats.p75 !== null, "allHits p75 is finite");

// ── Results ──
console.log("\nResults: " + passed + " passed, " + failed + " failed");
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed ✓");
}

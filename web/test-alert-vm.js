/**
 * test-alert-vm.js — Unit tests for alert-vm.js
 *
 * Run: node web/test-alert-vm.js
 *
 * Zero-framework pattern matching test-engine.js.
 */

import * as vm from "./alert-vm.js";
import * as engine from "./alert-engine.js";

var passed = 0;
var failed = 0;

function assert(condition, msg) {
  if (!condition) {
    console.error("  \u2717 FAIL:", msg);
    failed++;
  } else {
    console.log("  \u2713", msg);
    passed++;
  }
}

// ── Test 1: COLOR_MAP completeness ──────────────────────────

console.log("\n1. COLOR_MAP completeness");
{
  var colors = ["green", "pre_alert", "siren_window", "likely_passed", "red"];
  colors.forEach(function(c) {
    assert(vm.COLOR_MAP[c] != null, c + " exists in COLOR_MAP");
    assert(typeof vm.COLOR_MAP[c].bg === "string", c + " has bg string");
    assert(typeof vm.COLOR_MAP[c].label === "string", c + " has label string");
  });
}

// ── Test 2: fmtDuration ─────────────────────────────────────

console.log("\n2. fmtDuration");
{
  assert(vm.fmtDuration(null) === null, "null \u2192 null");
  assert(vm.fmtDuration(45) === "45 \u05E9\u05E0\u05D9\u05D5\u05EA", "45 \u2192 '45 \u05E9\u05E0\u05D9\u05D5\u05EA'");
  assert(vm.fmtDuration(90) === "1:30", "90 \u2192 '1:30'");
  assert(vm.fmtDuration(0) === "0 \u05E9\u05E0\u05D9\u05D5\u05EA", "0 \u2192 '0 \u05E9\u05E0\u05D9\u05D5\u05EA'");
  assert(vm.fmtDuration(60) === "1:00", "60 \u2192 '1:00'");
  assert(vm.fmtDuration(125) === "2:05", "125 \u2192 '2:05'");
  assert(vm.fmtDuration(3600) === "60:00", "3600 \u2192 '60:00'");
}

// ── Test 3: deriveAlertVM — green ───────────────────────────

console.log("\n3. deriveAlertVM \u2014 green");
{
  var es = engine.createState();
  var avm = vm.deriveAlertVM("green", es, "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9");
  assert(avm.bgColor === "#00c853", "green bg");
  assert(avm.statusLabel === "\u05D4\u05DB\u05DC \u05EA\u05E7\u05D9\u05DF", "green label");
  assert(avm.showHelpBtn === false, "no help btn on green");
  assert(avm.preAlertInfo.show === false, "no pre-alert info on green");
  assert(avm.helpPanelData === null, "no help panel data on green");
}

// ── Test 4: deriveAlertVM — red ─────────────────────────────

console.log("\n4. deriveAlertVM \u2014 red");
{
  var avm = vm.deriveAlertVM("red", engine.createState(), "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9");
  assert(avm.bgColor === "#d50000", "red bg");
  assert(avm.statusLabel.indexOf("\u05D0\u05D6\u05E2\u05E7\u05D4") !== -1, "red label contains \u05D0\u05D6\u05E2\u05E7\u05D4");
  assert(avm.showHelpBtn === false, "no help btn on red");
}

// ── Test 5: deriveAlertVM — likely_passed with thresholds ───

console.log("\n5. deriveAlertVM \u2014 likely_passed");
{
  var es = engine.createState({ stableThresholdMs: 90000 });
  var avm = vm.deriveAlertVM("likely_passed", es, "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9");
  assert(avm.bgColor === "#ffab00", "likely_passed bg");
  assert(avm.showHelpBtn === true, "help btn shown on likely_passed");
  assert(avm.helpPanelData != null, "help panel data present");
  assert(avm.helpPanelData.type === "likely_passed", "help panel type");
  assert(avm.helpPanelData.threshFormatted === "1:30", "threshold formatted as 1:30");
  assert(avm.helpPanelData.city === "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9", "city in help panel data");
  assert(avm.helpPanelData.reportLink.indexOf("report.html") !== -1, "report link present");
}

// ── Test 6: deriveAlertVM — pre_alert with city thresholds ──

console.log("\n6. deriveAlertVM \u2014 pre_alert with city thresholds");
{
  var es = engine.createState();
  es.thresholdsData = {
    cities: {
      "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9": {
        p5_siren_seconds: 60,
        p25_siren_seconds: 120,
        median_siren_seconds: 180,
        p75_siren_seconds: 240,
        p95_siren_seconds: 300,
        siren_hit_rate: 0.72,
        stable_seconds: 240,
      },
    },
  };
  es.currentRecord = { type: "pre_alert", time: Math.floor(Date.now() / 1000) - 30 };

  var avm = vm.deriveAlertVM("pre_alert", es, "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9");
  assert(avm.preAlertInfo.show === true, "pre-alert info shown");
  assert(avm.preAlertInfo.text.indexOf("\u05D0\u05D6\u05E2\u05E7\u05D4 \u05DC\u05D0 \u05E6\u05E4\u05D5\u05D9\u05D4 \u05DC\u05E4\u05E0\u05D9") !== -1, "pre-alert text contains expected phrase");
  assert(avm.showHelpBtn === true, "help btn shown on pre_alert");
  assert(avm.helpPanelData != null, "help panel data present");
  assert(avm.helpPanelData.type === "pre_alert", "help panel type is pre_alert");
  assert(avm.helpPanelData.hitRate === 72, "hit rate is 72%");
  assert(avm.helpPanelData.pcts.length >= 4, "at least 4 percentile entries");
  // Verify percentile labels
  var labels = avm.helpPanelData.pcts.map(function(p) { return p.label; });
  assert(labels.indexOf("P5") !== -1, "P5 in percentiles");
  assert(labels.indexOf("P25") !== -1, "P25 in percentiles");
  assert(labels.indexOf("\u05D7\u05E6\u05D9\u05D5\u05DF") !== -1, "\u05D7\u05E6\u05D9\u05D5\u05DF in percentiles");
  assert(labels.indexOf("P75") !== -1, "P75 in percentiles");
  assert(labels.indexOf("P95") !== -1, "P95 in percentiles");
}

// ── Test 7: deriveAlertVM — siren_window ────────────────────

console.log("\n7. deriveAlertVM \u2014 siren_window");
{
  var es = engine.createState();
  es.thresholdsData = {
    cities: {
      "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9": {
        siren_hit_rate: 0.72,
        p5_siren_seconds: 60,
        p25_siren_seconds: 120,
        median_siren_seconds: 180,
        p75_siren_seconds: 240,
        p95_siren_seconds: 300,
      },
    },
  };
  es.currentRecord = { type: "pre_alert", time: Math.floor(Date.now() / 1000) - 30 };

  var avm = vm.deriveAlertVM("siren_window", es, "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9");
  assert(avm.preAlertInfo.show === true, "siren_window pre-alert info shown");
  assert(avm.preAlertInfo.text.indexOf("\u05D0\u05D6\u05E2\u05E7\u05D4 \u05E2\u05E9\u05D5\u05D9\u05D4 \u05DC\u05D4\u05D2\u05D9\u05E2 \u05D1\u05E7\u05E8\u05D5\u05D1") !== -1, "siren_window text correct");
  assert(avm.preAlertInfo.text.indexOf("72%") !== -1, "hit rate percentage in text");
  assert(avm.showHelpBtn === true, "help btn shown on siren_window");
  assert(avm.helpPanelData.type === "siren_window", "help panel type is siren_window");
}

// ── Test 8: deriveAlertVM — pre_alert without city thresholds

console.log("\n8. deriveAlertVM \u2014 pre_alert without thresholds");
{
  var es = engine.createState();
  var avm = vm.deriveAlertVM("pre_alert", es, "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9");
  assert(avm.showHelpBtn === false, "no help btn without thresholds");
  assert(avm.helpPanelData === null, "no help panel data without thresholds");
  assert(avm.preAlertInfo.show === false, "no pre-alert info without thresholds");
}

// ── Test 9: deriveAlertVM — P95 null, Max fallback ──────────

console.log("\n9. deriveAlertVM \u2014 P95 null, Max fallback");
{
  var es = engine.createState();
  es.thresholdsData = {
    cities: {
      "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9": {
        p5_siren_seconds: 60,
        p25_siren_seconds: 120,
        median_siren_seconds: 180,
        p75_siren_seconds: 240,
        p95_siren_seconds: null,
        latest_siren_seconds: 900,
        siren_hit_rate: 0.5,
      },
    },
  };
  es.currentRecord = { type: "pre_alert", time: Math.floor(Date.now() / 1000) - 30 };

  var avm = vm.deriveAlertVM("pre_alert", es, "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9");
  var labels = avm.helpPanelData.pcts.map(function(p) { return p.label; });
  assert(labels.indexOf("P95") === -1, "P95 not in percentiles when null");
  assert(labels.indexOf("Max") !== -1, "Max used as fallback when P95 is null");
}

// ── Test 10: deriveCityPickerVM ─────────────────────────────

console.log("\n10. deriveCityPickerVM");
{
  var cities = ["\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9", "\u05EA\u05DC \u05D0\u05D1\u05D9\u05D1", "\u05D1\u05D9\u05EA \u05E9\u05D0\u05DF"];
  var r = vm.deriveCityPickerVM("\u05D1\u05D9\u05EA", cities);
  assert(r.suggestions.length === 2, "2 suggestions for '\u05D1\u05D9\u05EA' (\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9 + \u05D1\u05D9\u05EA \u05E9\u05D0\u05DF)");
  assert(r.suggestions.indexOf("\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9") !== -1, "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9 in suggestions");
  assert(r.suggestions.indexOf("\u05D1\u05D9\u05EA \u05E9\u05D0\u05DF") !== -1, "\u05D1\u05D9\u05EA \u05E9\u05D0\u05DF in suggestions");
  assert(r.showError === false, "no error");

  var r2 = vm.deriveCityPickerVM("", cities);
  assert(r2.suggestions.length === 0, "empty input \u2192 no suggestions");

  var r3 = vm.deriveCityPickerVM("\u05D1\u05D9\u05EA", null);
  assert(r3.suggestions.length === 0, "null cities \u2192 no suggestions");

  // Max 8 results
  var manyCities = [];
  for (var i = 0; i < 20; i++) manyCities.push("\u05E2\u05D9\u05E8 " + i);
  var r4 = vm.deriveCityPickerVM("\u05E2\u05D9\u05E8", manyCities);
  assert(r4.suggestions.length === 8, "max 8 suggestions");
}

// ── Test 11: validateCity ───────────────────────────────────

console.log("\n11. validateCity");
{
  var cities = ["\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9", "\u05D7\u05E8\u05D9\u05E9"];
  assert(vm.validateCity("\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9", cities) === true, "valid city returns true");
  assert(vm.validateCity("\u05E2\u05D9\u05E8 \u05DC\u05D0 \u05E7\u05D9\u05D9\u05DE\u05EA", cities) === false, "invalid city returns false");
  assert(vm.validateCity("\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9", null) === true, "null list \u2192 true (can't validate)");
  assert(vm.validateCity(null, cities) === false, "null city returns false");
}

// ── Test 12: fmtDuration edge cases (rounding bug fix) ─────

console.log("\n12. fmtDuration edge cases");
{
  // The original Math.round bug: 119.5 % 60 = 59.5, Math.round(59.5) = 60 → "1:60"
  assert(vm.fmtDuration(119.5) === "1:59", "119.5 → 1:59 (not 1:60)");
  assert(vm.fmtDuration(179.5) === "2:59", "179.5 → 2:59 (not 2:60)");
  assert(vm.fmtDuration(59.5) === "59 \u05E9\u05E0\u05D9\u05D5\u05EA", "59.5 → 59 שניות (not 60)");
  assert(vm.fmtDuration(60) === "1:00", "60 → 1:00");
  assert(vm.fmtDuration(0) === "0 \u05E9\u05E0\u05D9\u05D5\u05EA", "0 → 0 שניות");
  assert(vm.fmtDuration(NaN) === null, "NaN → null");
  assert(vm.fmtDuration(undefined) === null, "undefined → null");
}

// ── Test 13: deriveAlertVM — likely_passed with null threshold ─

console.log("\n13. deriveAlertVM — likely_passed with null stableThresholdMs");
{
  var es13 = engine.createState({ stableThresholdMs: null });
  var avm13 = vm.deriveAlertVM("likely_passed", es13, "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9");
  assert(avm13.showHelpBtn === true, "showHelpBtn is true");
  assert(avm13.helpPanelData !== null, "helpPanelData exists");
  assert(avm13.helpPanelData.threshFormatted === null, "threshFormatted is null (not '0 שניות')");
}

// ── Test 14: deriveAlertVM — unknown color ──────────────────

console.log("\n14. deriveAlertVM — unknown color");
{
  var es14 = engine.createState();
  var avm14 = vm.deriveAlertVM("escalated", es14, "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9");
  assert(avm14.bgColor === "#9e9e9e", "unknown color → neutral gray bg");
  assert(avm14.statusLabel.indexOf("\u05DC\u05D0 \u05D9\u05D3\u05D5\u05E2") !== -1, "label indicates unknown state");
  assert(avm14.showHelpBtn === false, "no help button for unknown");
}

// ── Test 15: deriveAlertVM — pre_alert with no city thresholds ─

console.log("\n15. deriveAlertVM — pre_alert without city thresholds");
{
  var es15 = engine.createState();
  es15.thresholdsData = { cities: {} };
  es15.currentRecord = { type: "pre_alert", time: Math.floor(Date.now() / 1000) };
  var avm15 = vm.deriveAlertVM("pre_alert", es15, "\u05E2\u05D9\u05E8 \u05DC\u05D0 \u05E7\u05D9\u05D9\u05DE\u05EA");
  assert(avm15.showHelpBtn === false, "no help btn when city not in thresholds");
  assert(avm15.preAlertInfo.show === false, "no pre-alert info when city not in thresholds");
}

// ── Summary ─────────────────────────────────────────────────

console.log("\n" + "=".repeat(40));
console.log("Passed: " + passed + "  Failed: " + failed);
if (failed > 0) process.exit(1);

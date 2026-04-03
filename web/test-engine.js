/**
 * test-engine.js — Unit tests for alert-engine.js
 *
 * Run: node web/test-engine.js
 *
 * Uses the injectable clock (nowMs) to simulate real-world event timelines
 * without waiting. Each test builds state.json snapshots and feeds them to
 * engine.processState() at controlled timestamps.
 */

import * as engine from "./alert-engine.js";

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

function assertColor(result, expected, msg) {
  assert(result.color === expected, msg + " — expected " + expected + ", got " + result.color);
}

// Helper: seconds since epoch for a local time string like "09:00:38"
function t(timeStr) {
  return Math.floor(new Date("2026-04-01T" + timeStr).getTime() / 1000);
}
function tMs(timeStr) {
  return new Date("2026-04-01T" + timeStr).getTime();
}

var CITY = "בית שמש";
var COHORT = ["תל אביב - דרום העיר ויפו", "ראשון לציון - מזרח", "חולון"];

function makeStateJson(alerts, history, updatedAt) {
  return {
    alerts: alerts || [],
    history: history || [],
    updated_at: updatedAt || "2026-04-01T10:00:00Z",
  };
}

// ── Test 1: Happy path — real-time PRE_ALERT → cohort sirens → amber ──

console.log("\n1. Happy path — real-time amber");
{
  var es = engine.createState({ stableThresholdMs: 240000 }); // 240s
  var now = tMs("09:00:40");

  // Poll 1: PRE_ALERT arrives in real-time with cohort
  var state1 = makeStateJson([
    { cat: "10", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
      data: [CITY, ...COHORT] },
  ]);
  var r1 = engine.processState(state1, es, CITY, now);
  assertColor(r1, "yellow", "PRE_ALERT → yellow");
  assert(es.cohortCities.size === 3, "cohortCities has 3 cities");

  // Poll 2: Sirens for cohort cities (5s later)
  now += 5000;
  var state2 = makeStateJson([
    { cat: "10", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
      data: [CITY, ...COHORT] },
    { cat: "1", title: "ירי רקטות וטילים", data: COHORT },
  ]);
  var r2 = engine.processState(state2, es, CITY, now);
  assertColor(r2, "yellow", "sirens just started → still yellow (threshold not met)");
  assert(es.sirenCohortCities.size === 3, "all 3 cohort cities detected");

  // Poll 3: 240s later — threshold elapsed
  now += 240000;
  var r3 = engine.processState(state2, es, CITY, now);
  assertColor(r3, "yellow_orange", "240s elapsed → amber");
}

// ── Test 2: Today's bug — history-only PRE_ALERT (no cohort tracking) ──

console.log("\n2. History-only PRE_ALERT — amber via cohort reconstruction (bug fix)");
{
  var es = engine.createState({ stableThresholdMs: 240000 });
  var now = tMs("09:20:00"); // well past 240s after sirens at 09:06:31

  // Client opened AFTER the real-time PRE_ALERT disappeared.
  // state.alerts has only sirens; history has the PRE_ALERT + cohort PRE_ALERTs + cohort sirens.
  var state1 = makeStateJson(
    [{ cat: "1", title: "ירי רקטות וטילים", data: COHORT }],
    [
      // Our city's PRE_ALERT
      { alertDate: "2026-04-01 09:00:38", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        data: CITY, category: 14 },
      // Cohort PRE_ALERTs (same alertDate)
      { alertDate: "2026-04-01 09:00:38", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        data: "תל אביב - דרום העיר ויפו", category: 14 },
      { alertDate: "2026-04-01 09:00:38", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        data: "ראשון לציון - מזרח", category: 14 },
      { alertDate: "2026-04-01 09:00:38", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        data: "חולון", category: 14 },
      // Cohort sirens from history
      { alertDate: "2026-04-01 09:06:31", title: "ירי רקטות וטילים",
        data: "תל אביב - דרום העיר ויפו", category: 1 },
      { alertDate: "2026-04-01 09:06:31", title: "ירי רקטות וטילים",
        data: "ראשון לציון - מזרח", category: 1 },
      { alertDate: "2026-04-01 09:06:31", title: "ירי רקטות וטילים",
        data: "חולון", category: 1 },
    ],
  );
  var r1 = engine.processState(state1, es, CITY, now);
  assertColor(r1, "yellow_orange", "history cohort reconstruction → amber");
  assert(es.cohortCities.size === 3, "cohortCities reconstructed from history");
  assert(es.sirenCohortCities.size === 3, "sirenCohortCities populated from history");
}

// ── Test 3: END before threshold ──

console.log("\n3. END before threshold elapses");
{
  var es = engine.createState({ stableThresholdMs: 240000 });
  var now = tMs("09:00:40");

  // PRE_ALERT
  var state1 = makeStateJson([
    { cat: "10", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
      data: [CITY, ...COHORT] },
  ]);
  engine.processState(state1, es, CITY, now);

  // Sirens after 6 min
  now += 360000;
  var state2 = makeStateJson([
    { cat: "10", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
      data: [CITY, ...COHORT] },
    { cat: "1", title: "ירי רקטות וטילים", data: COHORT },
  ]);
  engine.processState(state2, es, CITY, now);

  // END arrives 60s later (only 60s after sirens, well before 240s threshold)
  now += 60000;
  var state3 = makeStateJson(
    [{ cat: "10", title: "האירוע הסתיים", data: [CITY] }],
    [{ alertDate: "2026-04-01 09:07:40", title: "האירוע הסתיים", data: CITY, category: 13 }],
  );
  var r3 = engine.processState(state3, es, CITY, now);
  assertColor(r3, "green", "END before 240s → green (correctly no amber)");
}

// ── Test 4: Siren for our city → red ──

console.log("\n4. Siren for our city → red");
{
  var es = engine.createState({ stableThresholdMs: 240000 });
  var now = tMs("09:00:40");

  var state1 = makeStateJson([
    { cat: "1", title: "ירי רקטות וטילים", data: [CITY, ...COHORT] },
  ]);
  var r1 = engine.processState(state1, es, CITY, now);
  assertColor(r1, "red", "siren for our city → red");
}

// ── Test 5: Cohort siren trickle does NOT reset timer (first-siren anchor) ──

console.log("\n5. Cohort siren trickle does NOT reset timer (first-siren)");
{
  var es = engine.createState({ stableThresholdMs: 240000 });
  var now = tMs("09:00:40");

  // PRE_ALERT
  var state1 = makeStateJson([
    { cat: "10", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
      data: [CITY, ...COHORT, "כרמיאל"] },
  ]);
  engine.processState(state1, es, CITY, now);

  // First batch of sirens (3 cities)
  now += 360000; // 6 min later
  var state2 = makeStateJson([
    { cat: "10", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
      data: [CITY, ...COHORT, "כרמיאל"] },
    { cat: "1", title: "ירי רקטות וטילים", data: COHORT },
  ]);
  engine.processState(state2, es, CITY, now);
  var firstSiren1 = es.firstCohortSirenMs;

  // New cohort city siren trickles in 30s later
  now += 30000;
  var state3 = makeStateJson([
    { cat: "10", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
      data: [CITY, ...COHORT, "כרמיאל"] },
    { cat: "1", title: "ירי רקטות וטילים", data: COHORT },
    { cat: "1", title: "ירי רקטות וטילים", data: ["כרמיאל"] },
  ]);
  engine.processState(state3, es, CITY, now);
  assert(es.firstCohortSirenMs === firstSiren1, "timer NOT reset when new cohort city detected (first-siren anchor)");
  assert(es.sirenCohortCities.size === 4, "4 cohort cities now tracked");

  // 240s after the FIRST batch (not the trickle) → amber
  now = firstSiren1 + 240000;
  var r4 = engine.processState(state3, es, CITY, now);
  assertColor(r4, "yellow_orange", "240s after first siren → amber");
}

// ── Test 6: PRE_ALERT expiry ──

console.log("\n6. PRE_ALERT expiry after 180 minutes");
{
  var es = engine.createState({ stableThresholdMs: 240000 });
  var now = tMs("09:00:40");

  var state1 = makeStateJson([
    { cat: "10", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
      data: [CITY, ...COHORT] },
  ]);
  var r1 = engine.processState(state1, es, CITY, now);
  assertColor(r1, "yellow", "PRE_ALERT → yellow");

  // 181 minutes later (past 180-min expiry), no more alerts
  now += 181 * 60 * 1000;
  var state2 = makeStateJson([], []);
  var r2 = engine.processState(state2, es, CITY, now);
  assertColor(r2, "green", "181 minutes later → expired → green");
}

// ── Test 7: RT alert dedup ──

console.log("\n7. RT alert dedup across polls");
{
  var es = engine.createState({ stableThresholdMs: 240000 });
  var now = tMs("09:00:40");

  var state1 = makeStateJson([
    { cat: "10", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
      data: [CITY, ...COHORT] },
  ]);

  // First poll — processes the PRE_ALERT
  var r1 = engine.processState(state1, es, CITY, now);
  assert(r1.events.length > 0, "first poll produces events");
  var eventCount1 = r1.events.filter(function(e) { return e.source === "RT"; }).length;

  // Second poll with identical state — should dedup
  now += 5000;
  var r2 = engine.processState(state1, es, CITY, now);
  var eventCount2 = r2.events.filter(function(e) { return e.source === "RT"; }).length;
  assert(eventCount2 === 0, "second poll with same data → no new RT events (deduped)");
}

// ── Test 8: History PRE_ALERT with no cohort sirens → stays yellow ──

console.log("\n8. History PRE_ALERT with no cohort sirens → yellow (no false amber)");
{
  var es = engine.createState({ stableThresholdMs: 240000 });
  var now = tMs("09:20:00");

  // History has PRE_ALERT for our city and cohort, but NO sirens for anyone
  var state1 = makeStateJson(
    [],
    [
      { alertDate: "2026-04-01 09:00:38", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        data: CITY, category: 14 },
      { alertDate: "2026-04-01 09:00:38", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        data: "תל אביב - דרום העיר ויפו", category: 14 },
      { alertDate: "2026-04-01 09:00:38", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        data: "ראשון לציון - מזרח", category: 14 },
    ],
  );
  var r1 = engine.processState(state1, es, CITY, now);
  assertColor(r1, "yellow", "history cohort but no sirens → stays yellow");
  assert(es.cohortCities.size === 2, "cohortCities reconstructed (2 cohort cities)");
  assert(es.sirenCohortCities.size === 0, "sirenCohortCities empty (no sirens in history)");
}

// ── Test 9: Thresholds data with earliest_siren_seconds accessible in engine state ──

console.log("\n9. Thresholds data with siren timing stats accessible on pre-alert");
{
  var thresholdsData = {
    updated: "2026-04-01T03:00:00Z",
    default_stable_seconds: 300,
    target_fn_rate: 0.05,
    cities: {
      [CITY]: {
        stable_seconds: 240,
        events: 42,
        fn_rate: 0.023,
        earliest_siren_seconds: 180,
        median_siren_seconds: 360,
        p25_siren_seconds: 210,
        p75_siren_seconds: 480,
        siren_timing_count: 35,
      },
    },
  };
  var es = engine.createState({ stableThresholdMs: 240000, thresholdsData: thresholdsData });
  var now = tMs("09:00:40");

  // PRE_ALERT arrives
  var state1 = makeStateJson([
    { cat: "10", title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
      data: [CITY, ...COHORT] },
  ]);
  var r1 = engine.processState(state1, es, CITY, now);
  assertColor(r1, "yellow", "PRE_ALERT → yellow with thresholds data");

  // Verify thresholds data is accessible
  var ci = es.thresholdsData && es.thresholdsData.cities && es.thresholdsData.cities[CITY];
  assert(ci != null, "thresholdsData.cities has our city");
  assert(ci.earliest_siren_seconds === 180, "earliest_siren_seconds is 180");
  assert(ci.median_siren_seconds === 360, "median_siren_seconds is 360");

  // Verify the "as soon as" time can be computed
  assert(es.currentRecord != null, "currentRecord is set");
  assert(es.currentRecord.time != null, "currentRecord.time is set");
  var expectedTimeMs = es.currentRecord.time * 1000 + ci.earliest_siren_seconds * 1000;
  var expectedDate = new Date(expectedTimeMs);
  assert(!isNaN(expectedDate.getTime()), "as-soon-as time computes to valid date");
}

// ── Summary ──

console.log("\n" + "═".repeat(40));
console.log("Results: " + passed + " passed, " + failed + " failed");
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed ✓");
}

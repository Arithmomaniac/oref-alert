/**
 * test-services.js — Unit tests for services.js
 *
 * Run: node web/test-services.js
 *
 * Uses mock globals (fetch, localStorage, document, window) so tests
 * run in Node.js without a browser.
 */

// ── Mock globals for Node.js ─────────────────────────────────
globalThis.localStorage = {
  _data: {},
  getItem: function(k) { return this._data[k] || null; },
  setItem: function(k, v) { this._data[k] = String(v); },
  clear: function() { this._data = {}; },
};
globalThis.document = {
  addEventListener: function() {},
};
globalThis.window = { appInsights: null };
globalThis.fetch = undefined;

import {
  trackEvent,
  createPoller,
  fetchThresholds,
  fetchCities,
  locateCity,
  createSessionManager,
  createVersionChecker,
} from "./services.js";

// ── Test harness ─────────────────────────────────────────────
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

var tests = [];
function addTest(name, fn) { tests.push({ name: name, fn: fn }); }

// ── Helper: build a mock Response ────────────────────────────
function mockResponse(body, ok) {
  return {
    ok: ok !== undefined ? ok : true,
    status: ok === false ? 500 : 200,
    json: function() { return Promise.resolve(body); },
  };
}

// ═══════════════════════════════════════════════════════════════
// fetchThresholds
// ═══════════════════════════════════════════════════════════════

addTest("fetchThresholds — success returns data", async function() {
  var mockFetch = function(url) {
    assert(url === "/api/thresholds.json", "correct URL");
    return Promise.resolve(mockResponse({ cities: { Haifa: 120 } }));
  };
  var data = await fetchThresholds(mockFetch);
  assert(data !== null, "returns data");
  assert(data.cities !== undefined, "has cities");
  assert(data.cities.Haifa === 120, "correct threshold value");
});

addTest("fetchThresholds — HTTP error returns null", async function() {
  var mockFetch = function() {
    return Promise.resolve(mockResponse(null, false));
  };
  var data = await fetchThresholds(mockFetch);
  assert(data === null, "returns null on HTTP error");
});

addTest("fetchThresholds — network error returns null", async function() {
  var mockFetch = function() { return Promise.reject(new Error("network")); };
  var data = await fetchThresholds(mockFetch);
  assert(data === null, "returns null on network error");
});

// ═══════════════════════════════════════════════════════════════
// fetchCities
// ═══════════════════════════════════════════════════════════════

addTest("fetchCities — success returns array", async function() {
  var cities = ["Haifa", "Tel Aviv", "Jerusalem"];
  var mockFetch = function(url) {
    assert(url === "/api/cities.json", "correct URL");
    return Promise.resolve(mockResponse(cities));
  };
  var data = await fetchCities(mockFetch);
  assert(Array.isArray(data), "returns array");
  assert(data.length === 3, "correct length");
});

addTest("fetchCities — HTTP error returns null", async function() {
  var mockFetch = function() {
    return Promise.resolve(mockResponse(null, false));
  };
  var data = await fetchCities(mockFetch);
  assert(data === null, "returns null on HTTP error");
});

addTest("fetchCities — network error returns null", async function() {
  var mockFetch = function() { return Promise.reject(new Error("offline")); };
  var data = await fetchCities(mockFetch);
  assert(data === null, "returns null on network error");
});

// ═══════════════════════════════════════════════════════════════
// locateCity
// ═══════════════════════════════════════════════════════════════

addTest("locateCity — success returns city name", async function() {
  var mockFetch = function(url) {
    assert(url === "https://api.example.com/locate?lat=32.8&lng=35", "correct URL");
    return Promise.resolve(mockResponse({ city: "Haifa" }));
  };
  var city = await locateCity(32.8, 35.0, "https://api.example.com", mockFetch);
  assert(city === "Haifa", "returns city name");
});

addTest("locateCity — HTTP error rejects", async function() {
  var mockFetch = function() {
    return Promise.resolve({ ok: false, status: 500, json: function() { return Promise.resolve({}); } });
  };
  var threw = false;
  try {
    await locateCity(32.8, 35.0, "", mockFetch);
  } catch(e) {
    threw = true;
    assert(e.message === "HTTP 500", "error message includes status");
  }
  assert(threw, "rejects on HTTP error");
});

addTest("locateCity — no city in response returns null", async function() {
  var mockFetch = function() {
    return Promise.resolve(mockResponse({ region: "North" }));
  };
  var city = await locateCity(32.8, 35.0, "", mockFetch);
  assert(city === null, "returns null when no city field");
});

// ═══════════════════════════════════════════════════════════════
// createPoller
// ═══════════════════════════════════════════════════════════════

addTest("createPoller — pollNow calls fetch and onData", async function() {
  var dataCalled = false;
  var poller = createPoller({
    url: "/api/state.json",
    interval: 60000,
    fetchFn: function(url) {
      assert(url === "/api/state.json", "polls correct URL");
      return Promise.resolve(mockResponse({ alerts: [] }));
    },
    onData: function(data) {
      dataCalled = true;
      assert(Array.isArray(data.alerts), "got alerts array");
    },
    onError: function() {},
  });
  poller.pollNow();
  await new Promise(function(r) { setTimeout(r, 50); });
  assert(dataCalled, "onData was called");
});

addTest("createPoller — pollNow calls onError on failure", async function() {
  var errorCalled = false;
  var poller = createPoller({
    url: "/api/state.json",
    interval: 60000,
    fetchFn: function() { return Promise.reject(new Error("timeout")); },
    onData: function() {},
    onError: function(e) {
      errorCalled = true;
      assert(e.message === "timeout", "error passed through");
    },
  });
  poller.pollNow();
  await new Promise(function(r) { setTimeout(r, 50); });
  assert(errorCalled, "onError was called");
});

addTest("createPoller — pollNow calls onError on HTTP error", async function() {
  var errorCalled = false;
  var poller = createPoller({
    url: "/api/state.json",
    interval: 60000,
    fetchFn: function() {
      return Promise.resolve({ ok: false, status: 503, json: function() { return Promise.resolve({}); } });
    },
    onData: function() {},
    onError: function(e) {
      errorCalled = true;
      assert(e.message === "HTTP 503", "HTTP error caught");
    },
  });
  poller.pollNow();
  await new Promise(function(r) { setTimeout(r, 50); });
  assert(errorCalled, "onError called for HTTP error");
});

addTest("createPoller — stop clears timer", function() {
  var poller = createPoller({
    url: "/test",
    interval: 100,
    fetchFn: function() { return Promise.resolve(mockResponse({})); },
    onData: function() {},
    onError: function() {},
  });
  poller.start();
  poller.stop();
  // No assertion needed beyond "doesn't throw"; stop is idempotent
  poller.stop();
  assert(true, "stop is idempotent and does not throw");
});

// ═══════════════════════════════════════════════════════════════
// trackEvent
// ═══════════════════════════════════════════════════════════════

addTest("trackEvent — no throw when appInsights is null", function() {
  globalThis.window.appInsights = null;
  var threw = false;
  try { trackEvent("test", { foo: "bar" }); } catch(e) { threw = true; }
  assert(!threw, "does not throw when appInsights is null");
});

addTest("trackEvent — calls appInsights.trackEvent when available", function() {
  var captured = null;
  globalThis.window.appInsights = {
    trackEvent: function(evt) { captured = evt; },
  };
  trackEvent("pageView", { page: "home" });
  assert(captured !== null, "trackEvent was called");
  assert(captured.name === "pageView", "event name passed");
  assert(captured.properties.page === "home", "properties passed");
  globalThis.window.appInsights = null;
});

// ═══════════════════════════════════════════════════════════════
// createSessionManager
// ═══════════════════════════════════════════════════════════════

addTest("createSessionManager — resetActivity stores timestamp", function() {
  localStorage.clear();
  var sm = createSessionManager({
    maxMs: 600000,
    warnMs: 300000,
    lsKey: "test_activity",
    onExpire: function() {},
    onWarn: function() {},
    onClear: function() {},
  });
  sm.resetActivity();
  var stored = localStorage.getItem("test_activity");
  assert(stored !== null, "timestamp stored");
  var ts = parseInt(stored, 10);
  assert(Math.abs(ts - Date.now()) < 1000, "timestamp is recent");
});

addTest("createSessionManager — start registers activity and listeners", function() {
  localStorage.clear();
  var listenerCount = 0;
  var origAddEventListener = globalThis.document.addEventListener;
  globalThis.document.addEventListener = function() { listenerCount++; };
  var sm = createSessionManager({
    maxMs: 600000,
    warnMs: 300000,
    lsKey: "test_start",
    onExpire: function() {},
    onWarn: function() {},
    onClear: function() {},
  });
  sm.start();
  assert(listenerCount === 3, "3 event listeners registered (click, touchstart, keypress)");
  assert(localStorage.getItem("test_start") !== null, "activity recorded on start");
  sm.stop();
  globalThis.document.addEventListener = origAddEventListener;
});

// ═══════════════════════════════════════════════════════════════
// createVersionChecker
// ═══════════════════════════════════════════════════════════════

addTest("createVersionChecker — detects version change", async function() {
  var callCount = 0;
  var newVersionCalled = false;
  var mockFetch = function() {
    callCount++;
    var ver = callCount === 1 ? "1.0.0" : "2.0.0";
    return Promise.resolve(mockResponse({ version: ver }));
  };
  var vc = createVersionChecker({
    interval: 999999,
    onNewVersion: function() { newVersionCalled = true; },
    fetchFn: mockFetch,
  });
  // First call sets initialVersion
  vc.start();
  await new Promise(function(r) { setTimeout(r, 50); });
  assert(!newVersionCalled, "no callback on first check (sets baseline)");
  // Simulate second check manually — stop timer first to avoid races
  vc.stop();
  // Re-create to simulate next poll with new version
  // The internal checkVersion is private, so we create a new checker
  // that starts with a known initial version then sees a different one.

  // Better approach: start() calls checkVersion immediately, so we just
  // need a second manual check. Since we can't call checkVersion directly,
  // we test via a fresh checker that returns different versions sequentially.
  callCount = 0;
  newVersionCalled = false;
  var vc2 = createVersionChecker({
    interval: 999999,
    onNewVersion: function() { newVersionCalled = true; },
    fetchFn: mockFetch,
  });
  vc2.start(); // sets initialVersion = "1.0.0" (callCount becomes 1)
  await new Promise(function(r) { setTimeout(r, 50); });
  vc2.stop();
  // Now start again — start() calls checkVersion, callCount = 2 → "2.0.0"
  // But start() creates a new timer and calls checkVersion again.
  // However initialVersion is already set from the first start.
  vc2.start(); // callCount becomes 2, version "2.0.0" ≠ "1.0.0"
  await new Promise(function(r) { setTimeout(r, 50); });
  assert(newVersionCalled, "onNewVersion called when version changes");
  vc2.stop();
});

addTest("createVersionChecker — no callback when version unchanged", async function() {
  var newVersionCalled = false;
  var mockFetch = function() {
    return Promise.resolve(mockResponse({ version: "1.0.0" }));
  };
  var vc = createVersionChecker({
    interval: 999999,
    onNewVersion: function() { newVersionCalled = true; },
    fetchFn: mockFetch,
  });
  vc.start();
  await new Promise(function(r) { setTimeout(r, 50); });
  vc.stop();
  vc.start(); // second check, same version
  await new Promise(function(r) { setTimeout(r, 50); });
  assert(!newVersionCalled, "no callback when version stays the same");
  vc.stop();
});

addTest("createVersionChecker — fetch error is silently ignored", async function() {
  var mockFetch = function() { return Promise.reject(new Error("offline")); };
  var vc = createVersionChecker({
    interval: 999999,
    onNewVersion: function() {},
    fetchFn: mockFetch,
  });
  var threw = false;
  try {
    vc.start();
    await new Promise(function(r) { setTimeout(r, 50); });
  } catch(e) { threw = true; }
  assert(!threw, "fetch errors are silently caught");
  vc.stop();
});

// ═══════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════

async function runAll() {
  console.log("services.js unit tests\n" + "=".repeat(40));
  for (var i = 0; i < tests.length; i++) {
    console.log("\n" + tests[i].name);
    try {
      await tests[i].fn();
    } catch(e) {
      console.error("  ✗ FAIL (uncaught):", e.message);
      failed++;
    }
  }
  await new Promise(function(r) { setTimeout(r, 100); });
  console.log("\n" + "=".repeat(40));
  console.log("Passed: " + passed + "  Failed: " + failed);
  process.exit(failed > 0 ? 1 : 0);
}

runAll();

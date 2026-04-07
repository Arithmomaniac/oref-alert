/**
 * services.js — IO/fetch services for oref-alert.
 * All functions accept injectable fetch/storage for testing.
 */

// ── Telemetry ─────────────────────────────────────────────
export function trackEvent(name, props) {
  try { if (typeof window !== "undefined" && window.appInsights) window.appInsights.trackEvent({ name: name, properties: props }); } catch(e) {}
}

// ── State polling ─────────────────────────────────────────
export function createPoller(opts) {
  // opts: { url, interval, onData, onError, fetchFn }
  var timer = null;
  var fetchFn = opts.fetchFn || fetch;
  function poll() {
    fetchFn(opts.url)
      .then(function(r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(opts.onData)
      .catch(opts.onError);
  }
  return {
    start: function() { poll(); timer = setInterval(poll, opts.interval); },
    stop: function() { if (timer) { clearInterval(timer); timer = null; } },
    pollNow: poll,
  };
}

// ── Threshold fetching (raw IO only) ──────────────────────
export function fetchThresholds(fetchFn) {
  return (fetchFn || fetch)("/api/thresholds.json")
    .then(function(r) { return r.ok ? r.json() : null; })
    .catch(function() { return null; });
}

// ── City services ─────────────────────────────────────────
export function fetchCities(fetchFn) {
  return (fetchFn || fetch)("/api/cities.json")
    .then(function(r) { return r.ok ? r.json() : null; })
    .catch(function() { return null; });
}

export function locateCity(lat, lng, apiBase, fetchFn) {
  return (fetchFn || fetch)(apiBase + "/locate?lat=" + lat + "&lng=" + lng)
    .then(function(r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function(data) { return data.city || null; });
}

// ── Session management ────────────────────────────────────
export function createSessionManager(opts) {
  // opts: { maxMs, warnMs, lsKey, onExpire, onWarn, onClear }
  var LS_KEY = opts.lsKey || "oref_lastActivity";
  var checkTimer = null;

  function resetActivity() {
    try { localStorage.setItem(LS_KEY, String(Date.now())); } catch(e) {}
  }
  function getLastActivity() {
    try { var v = localStorage.getItem(LS_KEY); return v ? parseInt(v, 10) : Date.now(); } catch(e) { return Date.now(); }
  }
  function check() {
    var elapsed = Date.now() - getLastActivity();
    if (elapsed >= opts.maxMs) { opts.onExpire(); return; }
    if (elapsed >= opts.warnMs) { opts.onWarn(); } else { opts.onClear(); }
  }

  return {
    start: function() {
      resetActivity();
      ["click", "touchstart", "keypress"].forEach(function(evt) {
        document.addEventListener(evt, resetActivity, { passive: true });
      });
      checkTimer = setInterval(check, 60000);
    },
    stop: function() {
      if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
      ["click", "touchstart", "keypress"].forEach(function(evt) {
        document.removeEventListener(evt, resetActivity);
      });
    },
    resetActivity: resetActivity,
  };
}

// ── Version check ─────────────────────────────────────────
export function createVersionChecker(opts) {
  // opts: { interval, onNewVersion, fetchFn }
  var initialVersion = null;
  var timer = null;
  var fetchFn = opts.fetchFn || fetch;

  function checkVersion() {
    fetchFn("./version.json", { cache: "no-store" })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || !data.version) return;
        if (!initialVersion) { initialVersion = data.version; return; }
        if (data.version !== initialVersion) opts.onNewVersion();
      })
      .catch(function() {});
  }

  return {
    start: function() { checkVersion(); timer = setInterval(checkVersion, opts.interval); },
    stop: function() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

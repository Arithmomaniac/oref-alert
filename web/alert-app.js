/**
 * alert-app.js — Thin glue that wires services, engine, and view-model
 * to the DOM. The only file that touches document/window.
 */
import * as engine from "./alert-engine.js";
import * as vm from "./alert-vm.js";
import * as svc from "./services.js";

// ── UI-only constants ─────────────────────────────────────
var POLL_INTERVAL = 5000;
var SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
var SESSION_WARN_MS = 6 * 24 * 60 * 60 * 1000;
var VERSION_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes
var FUNC_API = "https://orefalert-func.azurewebsites.net/api";

// ── DOM refs ───────────────────────────────────────────────
var elBody = document.body;
var elCenter = document.getElementById("center");
var elStatus = document.getElementById("status-text");
var elMissedUsInfo = document.getElementById("missed-us-info");
var elPreAlertInfo = document.getElementById("pre-alert-info");
var elClockMain = document.getElementById("clock-main");
var elClockSec = document.getElementById("clock-seconds");
var elCityLabel = document.getElementById("city-label");
var elEventLog = document.getElementById("event-log");
var elNoCity = document.getElementById("no-city");
var elConnWarn = document.getElementById("conn-warning");
var elBanner = document.getElementById("session-banner");
var elVersionBanner = document.getElementById("version-banner");
var elExpired = document.getElementById("expired-overlay");
var elHelpBtn = document.getElementById("help-btn");
var elBackBtn = document.getElementById("back-btn");
var elGithubLink = document.getElementById("github-link");

// ── State ──────────────────────────────────────────────────
var city = "";
var es = engine.createState();
var failCount = 0;
var pollTimer = null;
var sessionExpired = false;
var lastThresholdFetch = 0;
var knownCities = null;
var currentColor = null;

// ── Helpers ────────────────────────────────────────────────

function escapeHtml(s) {
  var d = document.createElement("div");
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}

function getCity() {
  var params = new URLSearchParams(window.location.search);
  return (params.get("city") || "").trim();
}

function getMissedUsOverride() {
  var params = new URLSearchParams(window.location.search);
  var v = params.get("missedus");
  return v ? parseInt(v, 10) : null;
}

// ── Threshold application (state mutation from raw data) ───

function applyThresholds(data) {
  if (!data) return;
  // Ignore stale thresholds (>2 days old)
  if (data.updated) {
    var age = Date.now() - new Date(data.updated).getTime();
    if (age > 2 * 24 * 60 * 60 * 1000) {
      es.stableThresholdMs = null;
      lastThresholdFetch = Date.now();
      return;
    }
  }
  es.thresholdsData = data;
  var override = getMissedUsOverride();
  var ci = data.cities && data.cities[city];
  if (override !== null) {
    es.stableThresholdMs = override * 1000;
  } else if (ci) {
    es.stableThresholdMs = ci.stable_seconds * 1000;
  } else {
    es.stableThresholdMs = null;
  }
  es.p5SirenMs = (ci && ci.p5_siren_seconds != null) ? ci.p5_siren_seconds * 1000 : null;
  lastThresholdFetch = Date.now();
  // Re-render if thresholds arrived while already displaying a color
  if (currentColor) {
    var saved = currentColor;
    currentColor = null;
    applyColor(saved);
  }
}

function loadThresholds() {
  svc.fetchThresholds().then(applyThresholds);
}

// ── Event log rendering ───────────────────────────────────

function renderEventLog() {
  var html = "";
  for (var i = 0; i < es.eventLog.length; i++) {
    var ev = es.eventLog[i];
    html += '<div class="ev">' +
      '<span class="dot dot-' + ev.dotColor + '"></span>' +
      '<span class="ev-time">' + (ev.time || "") + '</span>' +
      escapeHtml(ev.title) +
      '</div>';
  }
  elEventLog.innerHTML = html;
}

// ── Help panel HTML builders (from structured VM data) ─────

function buildHelpPanelHTML(data) {
  if (!data) return "";
  if (data.type === "likely_passed") {
    return buildLikelyPassedHTML(data);
  }
  return buildPreAlertPanelHTML(data);
}

function buildLikelyPassedHTML(data) {
  var threshMin = data.threshFormatted;
  // ערים סמוכות באותה התרעה קיבלו אזעקות, אך [city] לא קיבלה במשך N
  var html = '<div class="mu-summary">' +
    "\u05E2\u05E8\u05D9\u05DD \u05E1\u05DE\u05D5\u05DB\u05D5\u05EA \u05D1\u05D0\u05D5\u05EA\u05D4 " +
    "\u05D4\u05EA\u05E8\u05E2\u05D4 \u05E7\u05D9\u05D1\u05DC\u05D5 \u05D0\u05D6\u05E2\u05E7\u05D5\u05EA, " +
    "\u05D0\u05DA " + escapeHtml(data.city) + " \u05DC\u05D0 \u05E7\u05D9\u05D1\u05DC\u05D4 \u05D1\u05DE\u05E9\u05DA " +
    threshMin + " \u05DE\u05D4\u05D0\u05D6\u05E2\u05E7\u05D4 \u05D4\u05E8\u05D0\u05E9\u05D5\u05E0\u05D4 \u05D1\u05E2\u05E8\u05D9\u05DD \u05D4\u05E1\u05DE\u05D5\u05DB\u05D5\u05EA." +
    "<br>\u05D4\u05E1\u05D1\u05D9\u05E8\u05D5\u05EA \u05E9\u05D4\u05D0\u05D6\u05E2\u05E7\u05D4 \u05D0\u05DB\u05DF \u05E2\u05D1\u05E8\u05D4: " +
    "\u05DC\u05E4\u05D7\u05D5\u05EA 95%." +
    '</div>';
  html += '<div class="mu-link"><a href="' + data.reportLink +
    '">\u05DC\u05DE\u05D9\u05D3\u05E2 \u05E0\u05D5\u05E1\u05E3 \u2014 \u05D3\u05D5\u05F4\u05D7 \u05E0\u05D9\u05EA\u05D5\u05D7 \u05E1\u05E3 \u05D4\u05D4\u05DE\u05EA\u05E0\u05D4 \u2190</a></div>';
  return html;
}

function buildPreAlertPanelHTML(data) {
  var isWindow = (data.type === "siren_window");
  var intro = isWindow
    // הגעת לחלון שבו אזעקות ב[city] נוטות להגיע.
    ? "\u05D4\u05D2\u05E2\u05EA \u05DC\u05D7\u05DC\u05D5\u05DF \u05E9\u05D1\u05D5 \u05D0\u05D6\u05E2\u05E7\u05D5\u05EA \u05D1" + escapeHtml(data.city) + " \u05E0\u05D5\u05D8\u05D5\u05EA \u05DC\u05D4\u05D2\u05D9\u05E2."
    // עדיין לא הגיע זמן האזעקה ב[city].
    : "\u05E2\u05D3\u05D9\u05D9\u05DF \u05DC\u05D0 \u05D4\u05D2\u05D9\u05E2 \u05D6\u05DE\u05DF \u05D4\u05D0\u05D6\u05E2\u05E7\u05D4 \u05D1" + escapeHtml(data.city) + ".";

  var html = '<div class="mu-summary">' + intro;
  if (data.hitRate != null) {
    // Y% מההתראות הפכו לאזעקות.
    html += "<br>" + data.hitRate + "% \u05DE\u05D4\u05D4\u05EA\u05E8\u05D0\u05D5\u05EA \u05D4\u05E4\u05DB\u05D5 \u05DC\u05D0\u05D6\u05E2\u05E7\u05D5\u05EA.";
  }
  if (data.pcts && data.pcts.length > 0) {
    var pctStrs = data.pcts.map(function(p) { return p.label + ": " + p.formatted; });
    // תזמון היסטורי:
    html += "<br>\u05EA\u05D6\u05DE\u05D5\u05DF \u05D4\u05D9\u05E1\u05D8\u05D5\u05E8\u05D9: " + pctStrs.join(" \u00B7 ");
  }
  html += '</div>';
  html += '<div class="mu-link"><a href="' + data.reportLink +
    '">\u05DC\u05DE\u05D9\u05D3\u05E2 \u05E0\u05D5\u05E1\u05E3 \u2014 \u05D3\u05D5\u05F4\u05D7 \u05E0\u05D9\u05EA\u05D5\u05D7 \u05E1\u05E3 \u05D4\u05D4\u05DE\u05EA\u05E0\u05D4 \u2190</a></div>';
  return html;
}

// ── Color / UI rendering ──────────────────────────────────

function applyColor(color) {
  if (color === currentColor) return;
  currentColor = color;
  svc.trackEvent("ColorTransition", { color: color });

  var avm = vm.deriveAlertVM(color, es, city);

  elBody.style.backgroundColor = avm.bgColor;
  elStatus.textContent = avm.statusLabel;

  if (avm.showHelpBtn && avm.helpPanelData) {
    elMissedUsInfo.innerHTML = buildHelpPanelHTML(avm.helpPanelData);
    elHelpBtn.style.display = "inline-flex";
  } else {
    elHelpBtn.style.display = "none";
    elMissedUsInfo.style.display = "none";
  }

  if (avm.preAlertInfo.show) {
    elPreAlertInfo.innerHTML = avm.preAlertInfo.text;
    elPreAlertInfo.style.display = "block";
  } else {
    elPreAlertInfo.style.display = "none";
  }
}

function updateClock() {
  var now = new Date();
  var hh = String(now.getHours()).padStart(2, "0");
  var mm = String(now.getMinutes()).padStart(2, "0");
  var ss = String(now.getSeconds()).padStart(2, "0");
  elClockMain.textContent = hh + ":" + mm;
  elClockSec.textContent = ":" + ss;
}

// ── Polling & processing ──────────────────────────────────

function processState(state) {
  failCount = 0;
  var nowMs = Date.now();

  var result = engine.processState(state, es, city, nowMs);

  // Apply staleness warning
  if (result.staleWarning) {
    showWarning(result.staleWarning);
    svc.trackEvent("StaleDataWarning");
  } else {
    hideWarning();
  }

  // Add timestamps to new events for display
  var now = new Date();
  var hh = String(now.getHours()).padStart(2, "0");
  var mm = String(now.getMinutes()).padStart(2, "0");
  for (var e = 0; e < es.eventLog.length; e++) {
    if (!es.eventLog[e].time) {
      es.eventLog[e].time = hh + ":" + mm;
    }
  }

  renderEventLog();
  applyColor(result.color);
}

function poll() {
  if (sessionExpired) return;

  // Re-fetch thresholds every 24h
  if (Date.now() - lastThresholdFetch > 24 * 60 * 60 * 1000) {
    loadThresholds();
  }

  fetch("/api/state.json")
    .then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function(data) {
      processState(data);
    })
    .catch(function() {
      failCount++;
      if (failCount >= 3) {
        showWarning("\u26A0 \u05D0\u05D9\u05DF \u05D7\u05D9\u05D1\u05D5\u05E8"); // ⚠ אין חיבור
      }
    });
}

function showWarning(msg) {
  elConnWarn.textContent = msg;
  elConnWarn.style.display = "block";
}

function hideWarning() {
  elConnWarn.style.display = "none";
}

// ── Init ───────────────────────────────────────────────────

export function init() {
  city = getCity();

  if (!city) {
    elBody.style.backgroundColor = "#424242";
    elCenter.style.display = "none";
    elCityLabel.style.display = "none";
    elEventLog.style.display = "none";
    elNoCity.style.display = "block";

    var cityForm = document.getElementById("city-form");
    var cityInput = document.getElementById("city-input");
    var citySugg = document.getElementById("city-suggestions");
    var cityError = document.getElementById("city-error");
    var activeIdx = -1;

    // Fetch city list for autocomplete
    svc.fetchCities().then(function(data) { if (data) knownCities = data; });

    function showSuggestions(matches) {
      if (!matches.length) { citySugg.style.display = "none"; activeIdx = -1; return; }
      var html = "";
      for (var i = 0; i < Math.min(matches.length, 8); i++) {
        html += '<div class="sug" data-city="' + escapeHtml(matches[i]) + '">' + escapeHtml(matches[i]) + '</div>';
      }
      citySugg.innerHTML = html;
      citySugg.style.display = "block";
      activeIdx = -1;
    }

    function selectCity(name) {
      cityInput.value = name;
      citySugg.style.display = "none";
      cityError.style.display = "none";
      cityInput.classList.remove("invalid");
    }

    if (cityInput) {
      cityInput.addEventListener("input", function() {
        cityError.style.display = "none";
        cityInput.classList.remove("invalid");
        var val = cityInput.value.trim();
        if (!val || !knownCities) { citySugg.style.display = "none"; return; }
        var pickerVM = vm.deriveCityPickerVM(val, knownCities);
        showSuggestions(pickerVM.suggestions);
      });

      cityInput.addEventListener("keydown", function(e) {
        var items = citySugg.querySelectorAll(".sug");
        if (!items.length) return;
        if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); }
        else if (e.key === "Enter" && activeIdx >= 0) { e.preventDefault(); selectCity(items[activeIdx].dataset.city); return; }
        else return;
        for (var i = 0; i < items.length; i++) items[i].classList.toggle("active", i === activeIdx);
      });

      citySugg.addEventListener("click", function(e) {
        var el = e.target.closest(".sug");
        if (el) selectCity(el.dataset.city);
      });

      document.addEventListener("click", function(e) {
        if (!citySugg.contains(e.target) && e.target !== cityInput) citySugg.style.display = "none";
      });

      cityInput.focus();
    }

    if (cityForm) {
      cityForm.addEventListener("submit", function(e) {
        e.preventDefault();
        var val = cityInput.value.trim();
        if (!val) return;
        if (!vm.validateCity(val, knownCities)) {
          cityInput.classList.add("invalid");
          cityError.style.display = "block";
          return;
        }
        svc.trackEvent("CitySelected", { city: val });
        window.location.search = "?city=" + encodeURIComponent(val);
      });
    }

    // ── Geolocation: "Use my location" button ──────────────
    var locateBtn = document.getElementById("locate-btn");
    var locateError = document.getElementById("locate-error");

    if (navigator.geolocation && locateBtn) {
      locateBtn.style.display = "inline-block";

      locateBtn.addEventListener("click", function() {
        svc.trackEvent("GeolocationUsed");
        locateBtn.disabled = true;
        locateBtn.textContent = "\uD83D\uDCCD \u05DE\u05D0\u05EA\u05E8..."; // 📍 מאתר...
        locateError.style.display = "none";

        navigator.geolocation.getCurrentPosition(
          function onSuccess(pos) {
            svc.locateCity(pos.coords.latitude, pos.coords.longitude, FUNC_API)
              .then(function(foundCity) {
                if (foundCity) {
                  window.location.search = "?city=" + encodeURIComponent(foundCity);
                } else {
                  showLocateError("\u05DC\u05D0 \u05E0\u05DE\u05E6\u05D0\u05D4 \u05E2\u05D9\u05E8 \u05E7\u05E8\u05D5\u05D1\u05D4"); // לא נמצאה עיר קרובה
                }
              })
              .catch(function() {
                showLocateError("\u05E9\u05D2\u05D9\u05D0\u05D4 \u05D1\u05D0\u05D9\u05EA\u05D5\u05E8 \u05E2\u05D9\u05E8"); // שגיאה באיתור עיר
              });
          },
          function onError(err) {
            if (err.code === 1) {
              showLocateError("\u05D4\u05D2\u05D9\u05E9\u05D4 \u05DC\u05DE\u05D9\u05E7\u05D5\u05DD \u05E0\u05D3\u05D7\u05EA\u05D4"); // הגישה למיקום נדחתה
            } else if (err.code === 2) {
              showLocateError("\u05DC\u05D0 \u05E0\u05D9\u05EA\u05DF \u05DC\u05E7\u05D1\u05D5\u05E2 \u05DE\u05D9\u05E7\u05D5\u05DD"); // לא ניתן לקבוע מיקום
            } else {
              showLocateError("\u05D6\u05DE\u05DF \u05D4\u05DE\u05EA\u05E0\u05D4 \u05DC\u05DE\u05D9\u05E7\u05D5\u05DD \u05D7\u05DC\u05E3"); // זמן המתנה למיקום חלף
            }
          },
          { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
        );

        function showLocateError(msg) {
          locateBtn.disabled = false;
          locateBtn.textContent = "\uD83D\uDCCD \u05D4\u05E9\u05EA\u05DE\u05E9 \u05D1\u05DE\u05D9\u05E7\u05D5\u05DD \u05E9\u05DC\u05D9"; // 📍 השתמש במיקום שלי
          locateError.textContent = msg;
          locateError.style.display = "block";
        }
      });
    }

    return;
  }

  // ── City view ────────────────────────────────────────────

  // Show city label + update tab title
  elCityLabel.textContent = city;
  document.title = city + " \u2013 \u05D4\u05EA\u05E8\u05D0\u05D5\u05EA \u05E4\u05D9\u05E7\u05D5\u05D3 \u05D4\u05E2\u05D5\u05E8\u05E3";

  // Show back button + GitHub link
  elBackBtn.style.display = "block";
  elBackBtn.addEventListener("click", function() { window.location.href = "./"; });
  elGithubLink.style.display = "block";

  // Help button toggles missed-us panel
  elHelpBtn.addEventListener("click", function() {
    var panel = elMissedUsInfo;
    panel.style.display = panel.style.display === "block" ? "none" : "block";
  });

  // Validate city against known list
  svc.fetchCities().then(function(data) {
    if (data && data.indexOf(city) === -1) {
      var elInvalid = document.getElementById("invalid-city");
      elInvalid.textContent = "\u26A0 \u0022" + city + "\u0022 \u05DC\u05D0 \u05E0\u05DE\u05E6\u05D0\u05D4 \u05D1\u05E8\u05E9\u05D9\u05DE\u05EA \u05D4\u05E2\u05E8\u05D9\u05DD";
      elInvalid.style.display = "block";
    }
  });

  // Fetch thresholds
  loadThresholds();

  // Initial color
  applyColor("green");

  // Clock
  updateClock();
  setInterval(updateClock, 1000);

  // Session management
  var session = svc.createSessionManager({
    maxMs: SESSION_MAX_MS,
    warnMs: SESSION_WARN_MS,
    onExpire: function() {
      sessionExpired = true;
      if (pollTimer) clearInterval(pollTimer);
      elExpired.style.display = "flex";
      elExpired.addEventListener("click", function() { location.reload(); });
    },
    onWarn: function() { elBanner.style.display = "block"; },
    onClear: function() { elBanner.style.display = "none"; },
  });
  session.start();

  // Screen Wake Lock
  var wakeLock = null;

  function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    navigator.wakeLock.request("screen").then(function(sentinel) {
      wakeLock = sentinel;
      sentinel.addEventListener("release", function() { wakeLock = null; });
    }).catch(function() {});
  }

  requestWakeLock();
  document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === "visible") requestWakeLock();
  });

  // Version checking
  var versionChecker = svc.createVersionChecker({
    interval: VERSION_CHECK_INTERVAL,
    onNewVersion: function() { elVersionBanner.style.display = "block"; },
  });
  elVersionBanner.addEventListener("click", function() { location.reload(); });
  versionChecker.start();

  // Start polling
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL);
}

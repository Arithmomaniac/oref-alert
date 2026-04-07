/**
 * alert-vm.js — Pure view-model derivation for the oref-alert display.
 * No DOM, no fetch, no side effects. All functions are pure.
 */

export var COLOR_MAP = {
  green:         { bg: "#00c853", label: "\u05D4\u05DB\u05DC \u05EA\u05E7\u05D9\u05DF" },          // הכל תקין
  pre_alert:     { bg: "#f9a825", label: "\u05D4\u05EA\u05E8\u05D0\u05D4 \u05DE\u05D5\u05E7\u05D3\u05DE\u05EA" }, // התראה מוקדמת
  siren_window:  { bg: "#f57c00", label: "\u05D4\u05EA\u05E8\u05D0\u05D4 \u05DE\u05D5\u05E7\u05D3\u05DE\u05EA" }, // התראה מוקדמת
  likely_passed: { bg: "#ffab00", label: "\u05DB\u05E0\u05E8\u05D0\u05D4 \u05E2\u05D1\u05E8" },    // כנראה עבר
  red:           { bg: "#d50000", label: "!\u05D0\u05D6\u05E2\u05E7\u05D4" },                       // !אזעקה
};

// Build a formatted duration string like "1:30" or "45 שניות"
export function fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return null;
  var totalSec = Math.floor(sec);
  var m = Math.floor(totalSec / 60);
  var s = totalSec % 60;
  if (m > 0) return m + ":" + String(s).padStart(2, "0");
  return s + " \u05E9\u05E0\u05D9\u05D5\u05EA"; // שניות
}

/**
 * Derive a plain view-model object for the alert display.
 * NO DOM references. NO side effects.
 *
 * @param {string} color - One of the COLOR_MAP keys
 * @param {object} engineState - Engine state (es)
 * @param {string} city - Watched city name
 * @returns {object} View-model describing what the UI should show
 */
export function deriveAlertVM(color, engineState, city) {
  var info = COLOR_MAP[color];
  if (!info) {
    info = { bg: "#9e9e9e", label: "\u05DE\u05E6\u05D1 \u05DC\u05D0 \u05D9\u05D3\u05D5\u05E2" }; // מצב לא ידוע
  }
  var ci = engineState.thresholdsData && engineState.thresholdsData.cities &&
           engineState.thresholdsData.cities[city];

  var vm = {
    bgColor: info.bg,
    statusLabel: info.label,
    showHelpBtn: false,
    helpPanelData: null,
    preAlertInfo: { show: false, text: "" },
    eventLog: engineState.eventLog || [],
  };

  if (color === "likely_passed") {
    var threshFormatted = engineState.stableThresholdMs != null
      ? fmtDuration(Math.round(engineState.stableThresholdMs / 1000))
      : null;

    vm.showHelpBtn = true;
    vm.helpPanelData = {
      type: "likely_passed",
      city: city,
      threshFormatted: threshFormatted,
      reportLink: "/report.html#" + encodeURIComponent(city),
    };

  } else if (color === "pre_alert" || color === "siren_window") {
    var isWindow = (color === "siren_window");

    // One-line pre-alert info
    if (ci && engineState.currentRecord && engineState.currentRecord.time) {
      if (!isWindow && ci.p5_siren_seconds != null) {
        var p5Sec = ci.p5_siren_seconds;
        var expectedMs = engineState.currentRecord.time * 1000 + p5Sec * 1000;
        var expectedDate = new Date(expectedMs);
        var timeStr = String(expectedDate.getHours()).padStart(2, "0") + ":" +
          String(expectedDate.getMinutes()).padStart(2, "0");
        // אזעקה לא צפויה לפני X (≈HH:MM)
        vm.preAlertInfo = {
          show: true,
          text: "\u05D0\u05D6\u05E2\u05E7\u05D4 \u05DC\u05D0 \u05E6\u05E4\u05D5\u05D9\u05D4 \u05DC\u05E4\u05E0\u05D9 " +
            fmtDuration(p5Sec) + " (\u2248" + timeStr + ")",
        };
      } else if (isWindow) {
        var hitRatePct = ci.siren_hit_rate != null ? Math.round(ci.siren_hit_rate * 100) : null;
        // אזעקה עשויה להגיע בקרוב
        var infoText = "\u05D0\u05D6\u05E2\u05E7\u05D4 \u05E2\u05E9\u05D5\u05D9\u05D4 \u05DC\u05D4\u05D2\u05D9\u05E2 \u05D1\u05E7\u05E8\u05D5\u05D1";
        if (hitRatePct != null) {
          // — Y% מההתראות הפכו לאזעקות
          infoText += " \u2014 " + hitRatePct + "% \u05DE\u05D4\u05D4\u05EA\u05E8\u05D0\u05D5\u05EA \u05D4\u05E4\u05DB\u05D5 \u05DC\u05D0\u05D6\u05E2\u05E7\u05D5\u05EA";
        }
        vm.preAlertInfo = { show: true, text: infoText };
      }
    }

    // ? button with panel data
    if (ci) {
      var hitRate = ci.siren_hit_rate != null ? Math.round(ci.siren_hit_rate * 100) : null;
      var pcts = [];
      var keys = [
        { key: "p5_siren_seconds",     label: "P5" },
        { key: "p25_siren_seconds",    label: "P25" },
        { key: "median_siren_seconds", label: "\u05D7\u05E6\u05D9\u05D5\u05DF" }, // חציון
        { key: "p75_siren_seconds",    label: "P75" },
      ];
      // Show P95 if finite, otherwise show Max if P95 is null and a finite max exists
      if (ci.p95_siren_seconds != null) {
        keys.push({ key: "p95_siren_seconds", label: "P95" });
      } else if (ci.p95_siren_seconds == null && ci.latest_siren_seconds != null) {
        keys.push({ key: "latest_siren_seconds", label: "Max" });
      }
      keys.forEach(function(k) {
        if (ci[k.key] != null) {
          pcts.push({ label: k.label, formatted: fmtDuration(ci[k.key]) });
        }
      });

      vm.showHelpBtn = true;
      vm.helpPanelData = {
        type: isWindow ? "siren_window" : "pre_alert",
        city: city,
        hitRate: hitRate,
        pcts: pcts,
        reportLink: "/report.html#" + encodeURIComponent(city),
      };
    }
  }

  return vm;
}

/**
 * Derive city-picker autocomplete suggestions.
 * @param {string} inputValue - Current text input
 * @param {string[]|null} knownCities - List of valid cities
 * @returns {{ suggestions: string[], showError: boolean }}
 */
export function deriveCityPickerVM(inputValue, knownCities) {
  if (!inputValue || !knownCities) return { suggestions: [], showError: false };
  var matches = knownCities.filter(function(c) { return c.indexOf(inputValue) !== -1; });
  return { suggestions: matches.slice(0, 8), showError: false };
}

/**
 * Validate that a city name exists in the known list.
 * @param {string} cityName
 * @param {string[]|null} knownCities
 * @returns {boolean}
 */
export function validateCity(cityName, knownCities) {
  if (!knownCities) return true;  // can't validate without list
  return knownCities.indexOf(cityName) !== -1;
}

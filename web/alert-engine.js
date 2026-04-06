/**
 * alert-engine.js — Pure business logic for oref alert display.
 *
 * No DOM, no fetch, no Date.now(). All time-dependent functions accept a
 * `nowMs` parameter so callers (the site or tests) can inject the clock.
 *
 * Usage (browser):
 *   <script type="module">
 *     import * as engine from "./alert-engine.js";
 *     var state = engine.createState();
 *     // on each poll:
 *     var result = engine.processState(stateJson, state, city, Date.now());
 *     // result.color, result.events, result.staleWarning
 *   </script>
 *
 * Usage (Node.js tests):
 *   const engine = await import("./alert-engine.js");
 */

// ── Constants ──────────────────────────────────────────────────

export var RT_TO_HIST = { 1: 1, 3: 7, 4: 9, 5: 11, 6: 2, 7: 12, 13: 10 };
export var HIST_ALERT_CATEGORIES = new Set([1, 2, 3, 4, 7, 8, 9, 10, 11, 12]);
export var HIST_END_CATEGORY = 13;
export var HIST_PRE_ALERT_CATEGORY = 14;
export var RT_MESSAGE_CATEGORY = 10;
export var PRE_ALERT_WORD = "\u05D1\u05D3\u05E7\u05D5\u05EA";   // בדקות
export var END_WORD = "\u05D4\u05E1\u05EA\u05D9\u05D9\u05DD";     // הסתיים

export var ALERT = "alert";
export var PRE_ALERT = "pre_alert";
export var END = "end";

export var ALERT_EXPIRY_MIN = 180;
export var PRE_ALERT_EXPIRY_MIN = 180;
export var DEDUP_WINDOW_SEC = 180;
export var MAX_EVENTS = 10;
export var STALE_THRESHOLD_SEC = 60;

// ── State factory ──────────────────────────────────────────────

/**
 * Create a fresh engine state object.
 * @param {object} [opts]
 * @param {number|null} [opts.stableThresholdMs] - Amber threshold from thresholds.json
 * @param {object|null} [opts.thresholdsData] - Raw thresholds.json data
 */
export function createState(opts) {
  opts = opts || {};
  return {
    currentRecord: null,
    cohortCities: new Set(),
    sirenCohortCities: new Set(),
    firstCohortSirenMs: null,
    lastRtKeys: new Set(),
    eventLog: [],
    stableThresholdMs: opts.stableThresholdMs != null ? opts.stableThresholdMs : null,
    thresholdsData: opts.thresholdsData || null,
    firstPoll: true,
  };
}

// ── Helpers ────────────────────────────────────────────────────

export function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  var iter = a.values();
  var next = iter.next();
  while (!next.done) {
    if (!b.has(next.value)) return false;
    next = iter.next();
  }
  return true;
}

export function parseAlertDate(s) {
  return new Date(s.replace(" ", "T"));
}

// ── Classification ─────────────────────────────────────────────

export function classifyRealtime(cat, title) {
  if (cat === RT_MESSAGE_CATEGORY) {
    if (title.indexOf(PRE_ALERT_WORD) !== -1) {
      return { type: PRE_ALERT, histCat: HIST_PRE_ALERT_CATEGORY };
    }
    if (title.indexOf(END_WORD) !== -1) {
      return { type: END, histCat: HIST_END_CATEGORY };
    }
    return { type: ALERT, histCat: RT_TO_HIST[cat] || cat };
  }
  var histCat = RT_TO_HIST[cat];
  if (histCat === undefined) return { type: null, histCat: null };
  if (HIST_ALERT_CATEGORIES.has(histCat)) {
    return { type: ALERT, histCat: histCat };
  }
  return { type: null, histCat: null };
}

export function classifyHistory(cat) {
  if (cat === HIST_END_CATEGORY) return END;
  if (cat === HIST_PRE_ALERT_CATEGORY) return PRE_ALERT;
  if (HIST_ALERT_CATEGORIES.has(cat)) return ALERT;
  return null;
}

// ── Record management ──────────────────────────────────────────

export function makeRecord(type, category, title, timeSec) {
  var expiryMs = null;
  if (type === ALERT) {
    expiryMs = timeSec * 1000 + ALERT_EXPIRY_MIN * 60 * 1000;
  } else if (type === PRE_ALERT) {
    expiryMs = timeSec * 1000 + PRE_ALERT_EXPIRY_MIN * 60 * 1000;
  }
  return { type: type, category: category, title: title, time: timeSec, expiryMs: expiryMs };
}

export function shouldUpdate(newRec, curRec) {
  if (curRec === null) return true;
  if (newRec.type === PRE_ALERT && curRec.type === ALERT) return false;
  if (newRec.type === END) return newRec.time > curRec.time;
  if (newRec.time <= curRec.time) return false;
  if (newRec.category === curRec.category && (newRec.time - curRec.time) <= DEDUP_WINDOW_SEC) {
    return false;
  }
  return true;
}

// ── Color determination ────────────────────────────────────────

/**
 * Determine display color from record + engine state.
 * @param {object|null} rec
 * @param {object} es - Engine state
 * @param {number} nowMs - Current time in ms
 */
export function getColor(rec, es, nowMs) {
  if (!rec) return "green";
  if (rec.type === ALERT) return "red";
  if (rec.type === PRE_ALERT) {
    if (es.stableThresholdMs !== null &&
        es.sirenCohortCities.size > 0 && es.firstCohortSirenMs !== null &&
        (nowMs - es.firstCohortSirenMs) >= es.stableThresholdMs) {
      return "likely_passed";
    }
    return "pre_alert";
  }
  return "green";
}

// ── Expiry check ───────────────────────────────────────────────

/**
 * Check if currentRecord has expired. Mutates engine state if expired.
 * Returns event object if expiry happened, null otherwise.
 */
export function removeExpired(es, nowMs) {
  if (es.currentRecord && es.currentRecord.expiryMs !== null && nowMs > es.currentRecord.expiryMs) {
    es.currentRecord = makeRecord(END, HIST_END_CATEGORY, "פג תוקף", Math.floor(nowMs / 1000));
    es.cohortCities = new Set();
    es.sirenCohortCities = new Set();
    es.firstCohortSirenMs = null;
    return { dotColor: "green", title: "פג תוקף התראה", source: "SYS", causedChange: true };
  }
  return null;
}

// ── Main state machine ─────────────────────────────────────────

/**
 * Process a state.json snapshot. Mutates `es` (engine state).
 *
 * @param {object} state - Parsed state.json (alerts, history, updated_at)
 * @param {object} es    - Engine state (from createState)
 * @param {string} city  - Watched city name
 * @param {number} nowMs - Current time in ms (injectable clock)
 * @returns {{ color: string, events: Array, staleWarning: string|null }}
 */
export function processState(state, es, city, nowMs) {
  var events = [];

  // Check staleness
  var staleWarning = null;
  if (state.updated_at) {
    var updatedMs = new Date(state.updated_at).getTime();
    var ageSec = (nowMs - updatedMs) / 1000;
    if (ageSec > STALE_THRESHOLD_SEC) {
      staleWarning = "\u26A0 \u05E0\u05EA\u05D5\u05E0\u05D9\u05DD \u05DC\u05D0 \u05E2\u05D3\u05DB\u05E0\u05D9\u05D9\u05DD";
    }
  }

  // ── Pass 1: Process real-time alerts ──────────────────────
  var newRtKeys = new Set();
  if (Array.isArray(state.alerts)) {
    for (var i = 0; i < state.alerts.length; i++) {
      var a = state.alerts[i];
      var cat = parseInt(a.cat, 10);
      var title = a.title || "";
      var data = a.data || [];
      var rtKey = cat + "|" + title + "|" + data.join(",");
      newRtKeys.add(rtKey);

      if (es.lastRtKeys.has(rtKey)) continue;

      var cityMatch = false;
      for (var j = 0; j < data.length; j++) {
        if (data[j] === city) { cityMatch = true; break; }
      }
      if (!cityMatch) continue;

      var cl = classifyRealtime(cat, title);
      if (cl.type === null) continue;

      var timeSec = Math.floor(nowMs / 1000);
      var rec = makeRecord(cl.type, cl.histCat, title, timeSec);
      var changed = shouldUpdate(rec, es.currentRecord);
      if (changed) {
        es.currentRecord = rec;
      }

      // Cohort tracking on PRE_ALERT
      if (cl.type === PRE_ALERT) {
        var newCohort = new Set(data.filter(function(d) { return d !== city; }));
        if (!setsEqual(newCohort, es.cohortCities)) {
          es.cohortCities = newCohort;
          es.sirenCohortCities = new Set();
          es.firstCohortSirenMs = null;
        }
      }
      // Clear cohort when leaving PRE_ALERT
      if (cl.type !== PRE_ALERT && changed) {
        es.cohortCities = new Set();
        es.sirenCohortCities = new Set();
        es.firstCohortSirenMs = null;
      }

      var evColor = getColor(rec, es, nowMs) === "green" ? "green" : getColor(rec, es, nowMs) === "red" ? "red" : "pre_alert";
      events.push({ dotColor: evColor, title: title, source: "RT", causedChange: changed });
    }
  }
  es.lastRtKeys = newRtKeys;

  // ── Pass 2: check if cohort cities have sirens ────────────
  if (es.cohortCities.size > 0 && es.currentRecord && es.currentRecord.type === PRE_ALERT) {
    if (Array.isArray(state.alerts)) {
      for (var p2 = 0; p2 < state.alerts.length; p2++) {
        var a2 = state.alerts[p2];
        var cat2 = parseInt(a2.cat, 10);
        var cl2 = classifyRealtime(cat2, a2.title || "");
        if (cl2.type !== ALERT) continue;

        var data2 = a2.data || [];
        for (var d2 = 0; d2 < data2.length; d2++) {
          if (es.cohortCities.has(data2[d2]) && !es.sirenCohortCities.has(data2[d2])) {
            es.sirenCohortCities.add(data2[d2]);
            if (es.firstCohortSirenMs === null) {
              es.firstCohortSirenMs = nowMs;
            }
          }
        }
      }
    }

    // Check if we just transitioned to likely_passed
    var missedUsColor = getColor(es.currentRecord, es, nowMs);
    if (missedUsColor === "likely_passed") {
      var lastEvt = es.eventLog.length > 0 ? es.eventLog[0] : null;
      if (!lastEvt || lastEvt.dotColor !== "likely_passed") {
        events.push({ dotColor: "likely_passed", title: "\u05DB\u05E0\u05E8\u05D0\u05D4 \u05E2\u05D1\u05E8", source: "SYS", causedChange: true });
      }
    }
  }

  // ── Pass 3: Process history ───────────────────────────────
  if (Array.isArray(state.history)) {
    for (var h = 0; h < state.history.length; h++) {
      var hist = state.history[h];
      var hData = hist.data || "";
      if (hData !== city) continue;

      var hCat = parseInt(hist.category || hist.cat, 10);
      var hType = classifyHistory(hCat);
      if (hType === null) continue;

      var hTime = 0;
      if (hist.alertDate) {
        hTime = Math.floor(parseAlertDate(hist.alertDate).getTime() / 1000);
      }
      var hTitle = hist.title || "";
      var hRec = makeRecord(hType, hCat, hTitle, hTime);
      var hChanged = shouldUpdate(hRec, es.currentRecord);
      if (hChanged) {
        es.currentRecord = hRec;
      }

      // Reconstruct cohort from history when PRE_ALERT came from history
      if (hType === PRE_ALERT && hChanged && es.cohortCities.size === 0) {
        var preAlertDate = hist.alertDate || "";
        // Find other cities with cat=14 and matching alertDate
        for (var c = 0; c < state.history.length; c++) {
          var ch = state.history[c];
          if (parseInt(ch.category || ch.cat, 10) !== HIST_PRE_ALERT_CATEGORY) continue;
          if ((ch.alertDate || "") !== preAlertDate) continue;
          var chCity = ch.data || "";
          if (chCity && chCity !== city) {
            es.cohortCities.add(chCity);
          }
        }
        // Find cohort cities that got sirens in history
        if (es.cohortCities.size > 0) {
          for (var s = 0; s < state.history.length; s++) {
            var sh = state.history[s];
            var sCat = parseInt(sh.category || sh.cat, 10);
            if (!HIST_ALERT_CATEGORIES.has(sCat)) continue;
            var sCity = sh.data || "";
            if (es.cohortCities.has(sCity) && !es.sirenCohortCities.has(sCity)) {
              es.sirenCohortCities.add(sCity);
              // Use the earliest siren's alertDate as the first-siren anchor
              var sirenTime = sh.alertDate ? parseAlertDate(sh.alertDate).getTime() : nowMs;
              if (es.firstCohortSirenMs === null || sirenTime < es.firstCohortSirenMs) {
                es.firstCohortSirenMs = sirenTime;
              }
            }
          }
        }
      }

      var hDotColor = getColor(hRec, es, nowMs) === "red" ? "red" : getColor(hRec, es, nowMs) === "pre_alert" ? "pre_alert" : "green";
      events.push({ dotColor: hDotColor, title: hTitle || ("\u05E7\u05D8\u05D2\u05D5\u05E8\u05D9\u05D4 " + hCat), source: "HIST", causedChange: hChanged });
    }
  }

  // ── Post-history likely_passed check (mirrors Pass 2 transition event) ──
  if (es.cohortCities.size > 0 && es.currentRecord && es.currentRecord.type === PRE_ALERT) {
    var postHistColor = getColor(es.currentRecord, es, nowMs);
    if (postHistColor === "likely_passed") {
      var lastEvt2 = es.eventLog.length > 0 ? es.eventLog[0] : null;
      var alreadyLogged = events.some(function(ev) { return ev.dotColor === "likely_passed"; });
      if (!alreadyLogged && (!lastEvt2 || lastEvt2.dotColor !== "likely_passed")) {
        events.push({ dotColor: "likely_passed", title: "\u05DB\u05E0\u05E8\u05D0\u05D4 \u05E2\u05D1\u05E8", source: "SYS", causedChange: true });
      }
    }
  }

  // ── Expiry ────────────────────────────────────────────────
  var expiryEvent = removeExpired(es, nowMs);
  if (expiryEvent) {
    events.push(expiryEvent);
  }

  // ── Final color ───────────────────────────────────────────
  var color = getColor(es.currentRecord, es, nowMs);

  // ── Update event log (only state-changing events) ─────────
  for (var e = 0; e < events.length; e++) {
    if (events[e].causedChange) {
      es.eventLog.unshift(events[e]);
    }
  }
  if (es.eventLog.length > MAX_EVENTS) es.eventLog.length = MAX_EVENTS;

  // ── Rebuild recent history on first poll ──────────────────
  if (es.firstPoll) {
    es.firstPoll = false;
    var histEvents = rebuildRecentHistory(state, city, nowMs);
    for (var re = 0; re < histEvents.length; re++) {
      es.eventLog.unshift(histEvents[re]);
    }
    if (es.eventLog.length > MAX_EVENTS) es.eventLog.length = MAX_EVENTS;
  }

  return { color: color, events: events, staleWarning: staleWarning };
}

// ── History replay (first-load only) ───────────────────────────

/**
 * Rebuild event log entries from recent history (last 3 hours).
 * Does NOT mutate currentRecord — only produces event log entries.
 */
export function rebuildRecentHistory(state, city, nowMs) {
  var results = [];
  if (!Array.isArray(state.history)) return results;

  var historyWindowAgo = nowMs - 3 * 60 * 60 * 1000;
  var relevant = [];
  for (var h = 0; h < state.history.length; h++) {
    var hist = state.history[h];
    if ((hist.data || "") !== city) continue;
    var hCat = parseInt(hist.category || hist.cat, 10);
    var hType = classifyHistory(hCat);
    if (hType === null) continue;
    var hTime = 0;
    if (hist.alertDate) {
      hTime = parseAlertDate(hist.alertDate).getTime();
    }
    if (hTime < historyWindowAgo) continue;
    relevant.push({ type: hType, cat: hCat, title: hist.title || "", timeMs: hTime });
  }
  relevant.sort(function(a, b) { return a.timeMs - b.timeMs; });
  for (var r = 0; r < relevant.length; r++) {
    var ev = relevant[r];
    var dotColor = ev.type === ALERT ? "red" : ev.type === PRE_ALERT ? "pre_alert" : "green";
    var dt = new Date(ev.timeMs);
    var hh = String(dt.getHours()).padStart(2, "0");
    var mm = String(dt.getMinutes()).padStart(2, "0");
    results.push({
      dotColor: dotColor,
      time: hh + ":" + mm,
      title: ev.title || ("\u05E7\u05D8\u05D2\u05D5\u05E8\u05D9\u05D4 " + ev.cat),
      source: "HIST",
    });
  }
  return results;
}

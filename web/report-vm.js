/**
 * report-vm.js — Pure computation for the oref-alert threshold report.
 * No DOM, no fetch. All functions are pure and testable in Node.js.
 */

/**
 * Compute statistics for a single city's events.
 * @param {Array} events — array of event objects with outcome, gap,
 *   cohort_sirens, pre_alert_to_siren fields.
 * @returns {Object} computed stats
 */
export function computeStats(events) {
  var miss = 0, missWithSirens = 0, immediate = 0, gapIntervals = [];
  var preAlertToSiren = [];
  events.forEach(function(e) {
    if (e.outcome === "miss") {
      miss++;
      if (e.cohort_sirens > 0) missWithSirens++;
    } else if (e.outcome === "immediate") {
      immediate++;
    } else if (e.outcome === "hit_after_gap") {
      gapIntervals.push(e.gap);
    }
    if (e.pre_alert_to_siren != null) {
      preAlertToSiren.push(e.pre_alert_to_siren);
    }
  });
  gapIntervals.sort(function(a, b) { return a - b; });
  preAlertToSiren.sort(function(a, b) { return a - b; });

  var maxThresh = 1200;
  var thresholdValues = [];
  for (var t = 0; t <= maxThresh; t += 30) thresholdValues.push(t);
  var fnRates = thresholdValues.map(function(t) {
    var fn = gapIntervals.filter(function(g) { return g > t; }).length;
    var denom = missWithSirens + fn;
    return denom > 0 ? Math.round(fn / denom * 1000) / 10 : 0;
  });

  var histBins = {};
  gapIntervals.forEach(function(iv) {
    var b = Math.floor(iv / 30) * 30;
    histBins[b] = (histBins[b] || 0) + 1;
  });

  var preAlertHistBins = {};
  preAlertToSiren.forEach(function(iv) {
    var b = Math.floor(iv / 30) * 30;
    preAlertHistBins[b] = (preAlertHistBins[b] || 0) + 1;
  });

  var paSirenStats = null;
  var totalEvents = events.length;
  var hitCount = preAlertToSiren.length;
  if (totalEvents > 0) {
    // Pad with Infinity for miss events so percentiles use the full denominator
    var missCount = totalEvents - hitCount;
    var padded = preAlertToSiren.slice();
    for (var mi = 0; mi < missCount; mi++) padded.push(Infinity);
    // padded is already sorted (finite values first, then Infinity)
    function percentile(arr, pct) {
      var idx = pct / 100 * (arr.length - 1);
      var lo = Math.floor(idx), hi = Math.min(lo + 1, arr.length - 1);
      if (!isFinite(arr[lo])) return null;
      var frac = idx - lo;
      if (frac === 0 || !isFinite(arr[hi])) return arr[lo];
      return arr[lo] + frac * (arr[hi] - arr[lo]);
    }
    var med = percentile(padded, 50);
    paSirenStats = {
      min: hitCount > 0 ? preAlertToSiren[0] : null,
      p5:  percentile(padded, 5),
      p25: percentile(padded, 25),
      median: med,
      p75: percentile(padded, 75),
      p95: percentile(padded, 95),
      max: hitCount > 0 ? preAlertToSiren[hitCount - 1] : null,
      hitCount: hitCount,
      totalCount: totalEvents,
      hitRate: hitCount / totalEvents
    };
  }

  return {
    miss: miss, missWithSirens: missWithSirens, immediate: immediate,
    gapCount: gapIntervals.length, total: events.length,
    gapIntervals: gapIntervals, fnRates: fnRates,
    thresholdValues: thresholdValues, histBins: histBins,
    preAlertToSiren: preAlertToSiren, preAlertHistBins: preAlertHistBins,
    paSirenStats: paSirenStats
  };
}

/**
 * Format a threshold value (in seconds) for display.
 * @param {number} t — seconds
 * @returns {string} formatted string ("0", "30s", "1m", "1m30s")
 */
export function fmtThresh(t) {
  if (t === 0) return "0";
  if (t < 60) return t + "s";
  if (t % 60 === 0) return (t / 60) + "m";
  return Math.floor(t / 60) + "m" + (t % 60 < 10 ? "0" : "") + (t % 60) + "s";
}

/**
 * Build the insight box text string.
 * @param {string[]} selected — city names
 * @param {Object} stats — map of cityName → computeStats result
 * @param {Object} thresholdsData — thresholds JSON (has .cities)
 * @returns {string} HTML string for the insight box
 */
export function buildInsightText(selected, stats, thresholdsData) {
  var insightParts = [];
  selected.forEach(function(c) {
    var th = thresholdsData.cities && thresholdsData.cities[c];
    if (th) {
      insightParts.push("<strong>" + c + ": " + th.stable_seconds + "s</strong> (" +
        (th.fn_rate * 100).toFixed(1) + "% FN, " + th.events + " events)");
    }
  });
  return "Selected thresholds (\u22645% false negative rate): " + insightParts.join(" &nbsp;|&nbsp; ");
}

/**
 * Build structured data for stat cards.
 * @param {string[]} selected — city names
 * @param {Object} stats — map of cityName → computeStats result
 * @param {Object} thresholdsData — thresholds JSON (has .cities)
 * @param {string[]} colors — array of hex color strings
 * @returns {Array} array of { cityName, color, total, miss, immediate, gapCount, threshStr }
 */
export function buildStatCardsData(selected, stats, thresholdsData, colors) {
  return selected.map(function(c, i) {
    var s = stats[c];
    var th = thresholdsData.cities && thresholdsData.cities[c];
    var threshStr = th ? th.stable_seconds + "s" : "N/A";
    return {
      cityName: c,
      color: colors[i],
      total: s.total,
      miss: s.miss,
      immediate: s.immediate,
      gapCount: s.gapCount,
      threshStr: threshStr
    };
  });
}

/**
 * Build structured data for the threshold table.
 * @param {string[]} selected — city names
 * @param {Object} stats — map of cityName → computeStats result
 * @param {Object} thresholdsData — thresholds JSON (has .cities)
 * @param {string[]} colors — array of hex color strings
 * @returns {Array} array of row objects
 */
export function buildThresholdTableData(selected, stats, thresholdsData, colors) {
  return selected.map(function(c, i) {
    var s = stats[c];
    var th = thresholdsData.cities && thresholdsData.cities[c];
    return {
      cityName: c,
      color: colors[i],
      threshold: th ? th.stable_seconds + "s" : "N/A",
      events: s.total,
      fnRate: th ? (th.fn_rate * 100).toFixed(1) + "%" : "N/A",
      miss: s.miss,
      missWithSirens: s.missWithSirens,
      immediate: s.immediate,
      gapCount: s.gapCount
    };
  });
}

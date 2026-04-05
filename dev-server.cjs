/**
 * Local dev server with mock data to preview the alert display.
 * Usage: node dev-server.js [scenario]
 *
 * Scenarios: green (default), yellow, amber, red
 * Open http://localhost:3000/?city=בית שמש
 */
var http = require("http");
var fs = require("fs");
var path = require("path");

var PORT = 3000;
var scenario = process.argv[2] || "amber";

var CITY = "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9"; // בית שמש

// ── Mock data for each scenario ────────────────────────────────

var nowIso = new Date().toISOString().replace("T", " ").slice(0, 19);

function minutesAgo(m) {
  var d = new Date(Date.now() - m * 60000);
  // Format as local time (engine's parseAlertDate treats these as local)
  var yyyy = d.getFullYear();
  var mm = String(d.getMonth() + 1).padStart(2, "0");
  var dd = String(d.getDate()).padStart(2, "0");
  var hh = String(d.getHours()).padStart(2, "0");
  var mi = String(d.getMinutes()).padStart(2, "0");
  var ss = String(d.getSeconds()).padStart(2, "0");
  return yyyy + "-" + mm + "-" + dd + " " + hh + ":" + mi + ":" + ss;
}

var SCENARIOS = {
  green: {
    alerts: [],
    history: [],
  },
  yellow: {
    // Active PRE_ALERT for our city + cohort
    alerts: [
      {
        cat: "10",
        title: "\u05D9\u05E8\u05D9 \u05D8\u05D9\u05DC\u05D9\u05DD \u05D1\u05D3\u05E7\u05D5\u05EA \u05D4\u05E7\u05E8\u05D5\u05D1\u05D5\u05EA",
        data: [CITY, "\u05E7\u05E8\u05D9\u05EA \u05DE\u05DC\u05D0\u05DB\u05D9", "\u05E8\u05DE\u05DC\u05D4", "\u05D9\u05E8\u05D5\u05E9\u05DC\u05D9\u05DD"],
      },
    ],
    history: [
      {
        data: CITY,
        category: "14",
        alertDate: minutesAgo(2),
        title: "\u05D9\u05E8\u05D9 \u05D8\u05D9\u05DC\u05D9\u05DD \u05D1\u05D3\u05E7\u05D5\u05EA \u05D4\u05E7\u05E8\u05D5\u05D1\u05D5\u05EA",
      },
    ],
  },
  amber: {
    // History-only: PRE_ALERT for our city + cohort cities already got sirens minutes ago
    alerts: [],
    history: [
      {
        data: CITY,
        category: "14",
        alertDate: minutesAgo(5),
        title: "\u05D9\u05E8\u05D9 \u05D8\u05D9\u05DC\u05D9\u05DD \u05D1\u05D3\u05E7\u05D5\u05EA \u05D4\u05E7\u05E8\u05D5\u05D1\u05D5\u05EA",
      },
      // Cohort cities got sirens in history
      {
        data: "\u05E7\u05E8\u05D9\u05EA \u05DE\u05DC\u05D0\u05DB\u05D9",
        category: "1",
        alertDate: minutesAgo(4),
        title: "\u05D9\u05E8\u05D9 \u05D8\u05D9\u05DC\u05D9\u05DD",
      },
      {
        data: "\u05E8\u05DE\u05DC\u05D4",
        category: "1",
        alertDate: minutesAgo(3),
        title: "\u05D9\u05E8\u05D9 \u05D8\u05D9\u05DC\u05D9\u05DD",
      },
      // Also add cohort PRE_ALERTs so history reconstruction works
      {
        data: "\u05E7\u05E8\u05D9\u05EA \u05DE\u05DC\u05D0\u05DB\u05D9",
        category: "14",
        alertDate: minutesAgo(5),
        title: "\u05D9\u05E8\u05D9 \u05D8\u05D9\u05DC\u05D9\u05DD \u05D1\u05D3\u05E7\u05D5\u05EA \u05D4\u05E7\u05E8\u05D5\u05D1\u05D5\u05EA",
      },
      {
        data: "\u05E8\u05DE\u05DC\u05D4",
        category: "14",
        alertDate: minutesAgo(5),
        title: "\u05D9\u05E8\u05D9 \u05D8\u05D9\u05DC\u05D9\u05DD \u05D1\u05D3\u05E7\u05D5\u05EA \u05D4\u05E7\u05E8\u05D5\u05D1\u05D5\u05EA",
      },
      {
        data: "\u05D9\u05E8\u05D5\u05E9\u05DC\u05D9\u05DD",
        category: "14",
        alertDate: minutesAgo(5),
        title: "\u05D9\u05E8\u05D9 \u05D8\u05D9\u05DC\u05D9\u05DD \u05D1\u05D3\u05E7\u05D5\u05EA \u05D4\u05E7\u05E8\u05D5\u05D1\u05D5\u05EA",
      },
    ],
  },
  red: {
    alerts: [
      {
        cat: "1",
        title: "\u05D9\u05E8\u05D9 \u05D8\u05D9\u05DC\u05D9\u05DD",
        data: [CITY],
      },
    ],
    history: [
      {
        data: CITY,
        category: "1",
        alertDate: minutesAgo(0),
        title: "\u05D9\u05E8\u05D9 \u05D8\u05D9\u05DC\u05D9\u05DD",
      },
    ],
  },
};

var thresholds = {
  updated: new Date().toISOString(),
  cities: {
    "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9": { stable_seconds: 90, fn_rate: 0.04, events: 47, earliest_siren_seconds: 180, median_siren_seconds: 360 },
    "\u05E7\u05E8\u05DE\u05D9\u05D0\u05DC": { stable_seconds: 120, fn_rate: 0.03, events: 62, earliest_siren_seconds: 90, median_siren_seconds: 240 },
    "\u05D7\u05E8\u05D9\u05E9": { stable_seconds: 150, fn_rate: 0.05, events: 34, earliest_siren_seconds: 120, median_siren_seconds: 300 },
  },
};

var cities = [
  "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9",
  "\u05E7\u05E8\u05DE\u05D9\u05D0\u05DC",
  "\u05D7\u05E8\u05D9\u05E9",
  "\u05E7\u05E8\u05D9\u05EA \u05DE\u05DC\u05D0\u05DB\u05D9",
  "\u05E8\u05DE\u05DC\u05D4",
  "\u05D9\u05E8\u05D5\u05E9\u05DC\u05D9\u05DD",
];

// ── MIME types ────────────────────────────────────────────────

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// ── Server ────────────────────────────────────────────────────

var scenarioData = SCENARIOS[scenario] || SCENARIOS.green;

http.createServer(function (req, res) {
  var url = req.url.split("?")[0];

  // API mock endpoints
  if (url === "/api/state.json") {
    var state = {
      alerts: scenarioData.alerts,
      history: scenarioData.history,
      updated_at: new Date().toISOString(),
    };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(state));
    return;
  }

  if (url === "/api/thresholds.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(thresholds));
    return;
  }

  if (url === "/api/cities.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(cities));
    return;
  }

  if (url === "/api/cities-geo.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify([
      { name: "\u05D1\u05D9\u05EA \u05E9\u05DE\u05E9", lat: 31.731, lng: 34.988 },
      { name: "\u05E7\u05E8\u05DE\u05D9\u05D0\u05DC", lat: 31.594, lng: 34.565 },
    ]));
    return;
  }

  if (url.startsWith("/api/")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // Static file serving from web/
  var filePath = url === "/" ? "/index.html" : url;
  var fullPath = path.join(__dirname, "web", filePath);

  // Security: prevent path traversal
  if (!fullPath.startsWith(path.join(__dirname, "web"))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(fullPath, function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end("Not found: " + filePath);
      return;
    }
    var ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, function () {
  console.log("Dev server running at http://localhost:" + PORT + "/?city=" + encodeURIComponent(CITY));
  console.log("Scenario: " + scenario.toUpperCase());
  console.log("");
  console.log("Available scenarios: node dev-server.js [green|yellow|amber|red]");
});

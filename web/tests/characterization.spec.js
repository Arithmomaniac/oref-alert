// @ts-check
import { test, expect } from "@playwright/test";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEB_DIR = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const CITY = "בית שמש";

/**
 * Start a local HTTP server that serves index.html and mock API responses.
 * fixtureFile controls what /api/state.json returns.
 */
function startMockServer(fixtureFile) {
  const stateData = fs.readFileSync(path.join(FIXTURES_DIR, fixtureFile), "utf-8");

  const isLikelyPassed = fixtureFile === "state-likely_passed.json";
  const isSirenWindow = fixtureFile.includes("siren_window");
  const thresholds = JSON.stringify({
    updated: new Date().toISOString(),
    default_stable_seconds: 300,
    target_fn_rate: 0.05,
    cities: {
      [CITY]: {
        stable_seconds: isLikelyPassed ? 0 : 240,
        p5_siren_seconds: isSirenWindow ? 0 : 60,
        earliest_siren_seconds: 180,
        p25_siren_seconds: 210,
        median_siren_seconds: 360,
        p75_siren_seconds: 480,
        p95_siren_seconds: 600,
        latest_siren_seconds: 900,
        siren_hit_count: 72,
        total_pre_alert_events: 100,
        siren_hit_rate: 0.72,
      },
    },
  });

  const cities = JSON.stringify([CITY, "תל אביב - דרום העיר ויפו", "ראשון לציון - מזרח", "חולון"]);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/api/state.json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(stateData);
      return;
    }
    if (url.pathname === "/api/thresholds.json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(thresholds);
      return;
    }
    if (url.pathname === "/api/cities.json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(cities);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const fullPath = path.join(WEB_DIR, filePath);

    if (!fs.existsSync(fullPath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(fullPath);
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".css": "text/css; charset=utf-8",
    };

    res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
    res.end(fs.readFileSync(fullPath));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Start a mock server that returns HTTP 500 for /api/state.json
 * to simulate connection failures.
 */
function startMockServerWithErrors() {
  const cities = JSON.stringify([CITY, "תל אביב - דרום העיר ויפו", "ראשון לציון - מזרח", "חולון"]);
  const thresholds = JSON.stringify({
    updated: new Date().toISOString(),
    default_stable_seconds: 300,
    target_fn_rate: 0.05,
    cities: {},
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/api/state.json") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
      return;
    }
    if (url.pathname === "/api/thresholds.json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(thresholds);
      return;
    }
    if (url.pathname === "/api/cities.json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(cities);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const fullPath = path.join(WEB_DIR, filePath);

    if (!fs.existsSync(fullPath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(fullPath);
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".css": "text/css; charset=utf-8",
    };

    res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
    res.end(fs.readFileSync(fullPath));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ── 1. City picker (no-city view) ──────────────────────────────

test.describe("City picker (no-city view)", () => {
  test("shows city picker when no city param, center is hidden", async ({ page }) => {
    const mock = await startMockServer("state-green.json");
    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.goto(`${mock.url}/?`);
      await page.waitForTimeout(2000);

      const noCity = page.locator("#no-city");
      await expect(noCity).toBeVisible();

      const center = page.locator("#center");
      await expect(center).toBeHidden();
    } finally {
      mock.server.close();
    }
  });

  test("shows suggestions when typing in city input", async ({ page }) => {
    const mock = await startMockServer("state-green.json");
    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.goto(`${mock.url}/?`);
      // Wait for cities.json to load
      await page.waitForTimeout(2000);

      const cityInput = page.locator("#city-input");
      await cityInput.fill("בית");
      await page.waitForTimeout(500);

      const suggestions = page.locator("#city-suggestions");
      await expect(suggestions).toBeVisible();
      // Should contain "בית שמש" as a suggestion
      const sugItems = page.locator("#city-suggestions .sug");
      await expect(sugItems).toHaveCount(1);
      await expect(sugItems.first()).toContainText("בית שמש");
    } finally {
      mock.server.close();
    }
  });

  test("navigates to city URL on valid submission", async ({ page }) => {
    const mock = await startMockServer("state-green.json");
    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.goto(`${mock.url}/?`);
      await page.waitForTimeout(2000);

      const cityInput = page.locator("#city-input");
      await cityInput.fill(CITY);
      await page.waitForTimeout(500);

      const goButton = page.locator("#city-go");
      await goButton.click();

      // Wait for navigation
      await page.waitForURL(/city=/);
      expect(page.url()).toContain(`city=${encodeURIComponent(CITY)}`);
    } finally {
      mock.server.close();
    }
  });

  test("shows error on invalid city submission", async ({ page }) => {
    const mock = await startMockServer("state-green.json");
    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.goto(`${mock.url}/?`);
      await page.waitForTimeout(2000);

      const cityInput = page.locator("#city-input");
      await cityInput.fill("עיר שלא קיימת");
      await page.waitForTimeout(500);

      const goButton = page.locator("#city-go");
      await goButton.click();
      await page.waitForTimeout(500);

      // Error message visible
      const cityError = page.locator("#city-error");
      await expect(cityError).toBeVisible();

      // Input gets .invalid class
      await expect(cityInput).toHaveClass(/invalid/);
    } finally {
      mock.server.close();
    }
  });
});

// ── 2. Event log rendering ─────────────────────────────────────

test.describe("Event log rendering", () => {
  test("shows event log with .dot-red entry on red state", async ({ page }) => {
    const mock = await startMockServer("state-red.json");
    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);
      await page.waitForTimeout(7000);

      const eventLog = page.locator("#event-log");
      await expect(eventLog).toBeVisible();

      const redDots = page.locator("#event-log .dot-red");
      expect(await redDots.count()).toBeGreaterThanOrEqual(1);
    } finally {
      mock.server.close();
    }
  });

  test("shows event log entries on likely_passed state", async ({ page }) => {
    const mock = await startMockServer("state-likely_passed.json");
    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);
      // Need extra time for likely_passed threshold to elapse
      await page.waitForTimeout(13000);

      const eventLog = page.locator("#event-log");
      await expect(eventLog).toBeVisible();

      const entries = page.locator("#event-log .ev");
      expect(await entries.count()).toBeGreaterThanOrEqual(1);

      // Should have at least one dot of likely_passed or pre_alert color
      const likelyDots = page.locator("#event-log .dot-likely_passed");
      const preAlertDots = page.locator("#event-log .dot-pre_alert");
      const total = (await likelyDots.count()) + (await preAlertDots.count());
      expect(total).toBeGreaterThanOrEqual(1);
    } finally {
      mock.server.close();
    }
  });
});

// ── 3. Connection warning ──────────────────────────────────────

test.describe("Connection warning", () => {
  test("shows connection warning after 3+ failed polls", async ({ page }) => {
    test.setTimeout(60000);
    const mock = await startMockServerWithErrors();
    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);

      // Wait for 3+ poll cycles (5s each) + margin
      await page.waitForTimeout(20000);

      const connWarning = page.locator("#conn-warning");
      await expect(connWarning).toBeVisible();

      const text = await connWarning.textContent();
      expect(text).toContain("אין חיבור");
    } finally {
      mock.server.close();
    }
  });
});

// ── 4. Invalid city banner ─────────────────────────────────────

test.describe("Invalid city banner", () => {
  test("shows invalid city banner for unknown city", async ({ page }) => {
    const mock = await startMockServer("state-green.json");
    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.goto(`${mock.url}/?city=${encodeURIComponent("NONEXISTENT_CITY")}`);
      await page.waitForTimeout(7000);

      const invalidBanner = page.locator("#invalid-city");
      await expect(invalidBanner).toBeVisible();

      const text = await invalidBanner.textContent();
      expect(text).toContain("NONEXISTENT_CITY");
    } finally {
      mock.server.close();
    }
  });
});

// ── 5. Help button interaction (pre_alert) ─────────────────────

test.describe("Help button interaction", () => {
  test("toggles missed-us panel on pre_alert", async ({ page }) => {
    const mock = await startMockServer("state-pre_alert.json");
    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);
      await page.waitForTimeout(7000);

      // Help button should be visible
      const helpBtn = page.locator("#help-btn");
      await expect(helpBtn).toBeVisible();

      // Panel should be hidden initially
      const missedUsInfo = page.locator("#missed-us-info");
      await expect(missedUsInfo).toBeHidden();

      // Click to open
      await helpBtn.click();
      await expect(missedUsInfo).toBeVisible();

      // Click to close
      await helpBtn.click();
      await expect(missedUsInfo).toBeHidden();
    } finally {
      mock.server.close();
    }
  });
});

// ── 6. Siren window info text ──────────────────────────────────

test.describe("Siren window info text", () => {
  test("shows siren window info text on siren_window state", async ({ page }) => {
    const mock = await startMockServer("state-siren_window.json");
    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);
      await page.waitForTimeout(7000);

      const preAlertInfo = page.locator("#pre-alert-info");
      await expect(preAlertInfo).toBeVisible();

      const text = await preAlertInfo.textContent();
      expect(text).toContain("אזעקה עשויה להגיע בקרוב");
    } finally {
      mock.server.close();
    }
  });
});

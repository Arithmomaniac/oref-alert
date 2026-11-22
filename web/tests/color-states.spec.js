// @ts-check
import { test, expect } from "@playwright/test";
import http from "http";
import { execFileSync } from "node:child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEB_DIR = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const CITY = "בית שמש";
test.beforeEach(({ context }) => context.route("https://**", route => route.abort()));

/**
 * Start a local HTTP server that serves index.html and mock API responses.
 * fixtureFile controls what /api/state.json returns.
 * thresholds are always returned with a 0s threshold for the test city
 * (so amber triggers immediately when conditions are met).
 */
function startMockServer(fixtureFile) {
  const stateData = fs.readFileSync(path.join(FIXTURES_DIR, fixtureFile), "utf-8");

  // Thresholds: differentiate fixture types for threshold values
  const isLikelyPassed = fixtureFile === "state-likely_passed.json";  // likely_passed: stable=0
  const isSirenWindow = fixtureFile.includes("siren_window"); // siren_window: p5=0
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
      res.end(stateData.replaceAll("$NOW", new Date().toISOString()));
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
    // Register/compute endpoints — just return OK
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    // Serve static files from web/
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

const EXPECTED = {
  green:        { bg: "rgb(0, 200, 83)",   text: "הכל תקין" },
  pre_alert:    { bg: "rgb(249, 168, 37)", text: "התראה מוקדמת" },
  siren_window: { bg: "rgb(245, 124, 0)",  text: "התראה מוקדמת" },
  red:          { bg: "rgb(213, 0, 0)",    text: "!אזעקה" },
  likely_passed: { bg: "rgb(255, 171, 0)",  text: "כנראה עבר" },
};

test.describe("Alert display color states", () => {
  /** @type {{ server: http.Server, port: number, url: string }} */
  let mock;

  test("backend snapshot displays a live siren during a history outage", async ({ page }) => {
    test.skip(!process.env.TEST_POLLER, "Requires Python with function_app dependencies");
    const body = execFileSync("python", [path.join(WEB_DIR, "..", "tests", "emit_siren_snapshot.py"), CITY],
      { encoding: "utf8" });
    mock = await startMockServer("state-green.json");
    try {
      await page.route("**/api/state.json", route => route.fulfill({ contentType: "application/json", body }));
      await page.route("**/orefalert-func.azurewebsites.net/**", route => route.fulfill({ json: {} }));
      await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);
      await expect(page.locator("#status-text")).toContainText("אזעקה");
      await expect(page.getByText(/היסטורי/).first()).toBeVisible();
    } finally {
      mock.server.close();
    }
  });

  for (const [color, fixture] of [
    ["green", "state-green.json"],
    ["pre_alert", "state-pre_alert.json"],
    ["siren_window", "state-siren_window.json"],
    ["red", "state-red.json"],
    ["likely_passed", "state-likely_passed.json"],
  ]) {
    test(`should show ${color} state`, async ({ page }) => {
      mock = await startMockServer(fixture);

      try {
        // Intercept the register/compute calls that go to the real function app
        await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
        );

        await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);

        // Wait for at least one poll cycle (5s) + rendering
        await page.waitForTimeout(7000);

        // For likely_passed: need a second poll so stable threshold elapses
        if (color === "likely_passed") {
          await page.waitForTimeout(6000);
        }

        const bg = await page.evaluate(() => {
          return window.getComputedStyle(document.body).backgroundColor;
        });

        const statusText = await page.evaluate(() => {
          return document.getElementById("status-text").textContent.trim();
        });

        expect(bg).toBe(EXPECTED[color].bg);
        // For red, the "!" may appear at either end due to RTL
        if (color === "red") {
          expect(statusText).toContain("אזעקה");
        } else {
          expect(statusText).toBe(EXPECTED[color].text);
        }

        // Take screenshot for visual reference
        await page.screenshot({
          path: path.join(__dirname, `baseline-${color}.png`),
          fullPage: true,
        });
      } finally {
        mock.server.close();
      }
    });
  }
});

test("startup, frozen snapshot, network loss and recovery", async ({ page }) => {
  const mock = await startMockServer("state-green.json");
  const time = new Date("2026-04-01T12:00:00Z");
  const good = { ok: true, last_success_at: time.toISOString() };
  let snapshot = { alerts: [], history: [], updated_at: time.toISOString(),
    feeds: { live: good, history: good } };
  let offline = false;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  try {
    await page.clock.install({ time });
    await page.route("**/api/state.json", async route => {
      await held;
      if (offline) return route.abort();
      return route.fulfill({ json: snapshot });
    });
    await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);
    const status = page.locator("#status-text");
    const warning = page.locator("#conn-warning");
    await expect(status).toHaveText("מצב ההתרעות לא ידוע");
    release();
    await expect(status).toHaveText(EXPECTED.green.text);
    await page.clock.fastForward(65000);
    await expect(status).toHaveText("מצב ההתרעות לא ידוע");
    await expect(warning).toBeVisible();
    const stamp = await page.evaluate(() => new Date().toISOString());
    snapshot = { ...snapshot, updated_at: stamp, alerts: [{ cat: "1", data: [CITY] }],
      feeds: { live: { ok: true, last_success_at: stamp }, history: good } };
    await page.clock.fastForward(5000);
    await expect(status).toContainText("אזעקה");
    await expect(warning).toContainText("היסטוריית");
    offline = true;
    await page.clock.fastForward(5000);
    await expect(warning).toContainText("אין חיבור");
    await expect(status).toContainText("אזעקה");
    offline = false;
    snapshot.alerts = [{ cat: "10", title: "הסתיים", data: [CITY] }];
    const recovered = await page.evaluate(() => new Date().toISOString());
    snapshot.updated_at = recovered;
    snapshot.feeds.live = snapshot.feeds.history = { ok: true, last_success_at: recovered };
    await page.clock.fastForward(5000);
    await expect(status).toHaveText(EXPECTED.green.text);
    await expect(warning).toBeHidden();
  } finally {
    release();
    mock.server.close();
  }
});

test.describe("Pre-alert 'as soon as' info", () => {
  /** @type {{ server: http.Server, port: number, url: string }} */
  let mock;

  test("should show 'as soon as' siren timing on pre_alert page", async ({ page }) => {
    mock = await startMockServer("state-pre_alert.json");

    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);
      await page.waitForTimeout(7000);

      // Verify background is pre_alert
      const bg = await page.evaluate(() =>
        window.getComputedStyle(document.body).backgroundColor
      );
      expect(bg).toBe(EXPECTED.pre_alert.bg);

      // Verify the pre-alert-info element is visible and contains the inline one-liner
      const preAlertInfo = page.locator("#pre-alert-info");
      await expect(preAlertInfo).toBeVisible();

      // Should contain the Hebrew "not expected before X (≈HH:MM)" text
      const text = await preAlertInfo.textContent();
      expect(text).toContain("אזעקה לא צפויה לפני");
      // Should contain a time estimate (≈HH:MM)
      expect(text).toMatch(/≈\d{2}:\d{2}/);

      await page.screenshot({
        path: path.join(__dirname, "baseline-pre_alert-asap.png"),
        fullPage: true,
      });
    } finally {
      mock.server.close();
    }
  });

  test("should NOT show 'as soon as' info on green page", async ({ page }) => {
    mock = await startMockServer("state-green.json");

    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);
      await page.waitForTimeout(7000);

      const preAlertInfo = page.locator("#pre-alert-info");
      await expect(preAlertInfo).toBeHidden();
    } finally {
      mock.server.close();
    }
  });

  test("should NOT show 'as soon as' info on likely_passed page", async ({ page }) => {
    mock = await startMockServer("state-likely_passed.json");

    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);
      await page.waitForTimeout(13000);

      // Should be likely_passed
      const bg = await page.evaluate(() =>
        window.getComputedStyle(document.body).backgroundColor
      );
      expect(bg).toBe(EXPECTED.likely_passed.bg);

      // pre-alert-info should be hidden; help button should be visible
      const preAlertInfo = page.locator("#pre-alert-info");
      await expect(preAlertInfo).toBeHidden();

      const helpBtn = page.locator("#help-btn");
      await expect(helpBtn).toBeVisible();

      // Click ? to open the missed-us panel, then verify it appears
      await helpBtn.click();
      const missedUsInfo = page.locator("#missed-us-info");
      await expect(missedUsInfo).toBeVisible();
    } finally {
      mock.server.close();
    }
  });
});

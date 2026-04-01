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
 * thresholds are always returned with a 0s threshold for the test city
 * (so amber triggers immediately when conditions are met).
 */
function startMockServer(fixtureFile) {
  const stateData = fs.readFileSync(path.join(FIXTURES_DIR, fixtureFile), "utf-8");

  // Thresholds: 0s for amber test (immediate trigger), 240s otherwise
  const isAmberFixture = fixtureFile.includes("amber");
  const thresholds = JSON.stringify({
    updated: new Date().toISOString(),
    default_stable_seconds: 300,
    target_fn_rate: 0.05,
    cities: {
      [CITY]: { stable_seconds: isAmberFixture ? 0 : 240, events: 100, fn_rate: 0.0 },
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
  green:  { bg: "rgb(0, 200, 83)",  text: "הכל תקין" },
  yellow: { bg: "rgb(249, 168, 37)", text: "התראה מוקדמת" },
  red:    { bg: "rgb(213, 0, 0)",    text: "!אזעקה" },      // note: RTL, "!" first in DOM
  amber:  { bg: "rgb(255, 171, 0)",  text: "כנראה עבר" },
};

test.describe("Alert display color states", () => {
  /** @type {{ server: http.Server, port: number, url: string }} */
  let mock;

  for (const [color, fixture] of [
    ["green", "state-green.json"],
    ["yellow", "state-yellow.json"],
    ["red", "state-red.json"],
    ["amber", "state-amber.json"],
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

        // For amber: need a second poll so getColor evaluates with stable threshold elapsed
        if (color === "amber") {
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

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

function startMockServer() {
  const stateData = fs.readFileSync(path.join(FIXTURES_DIR, "state-green.json"), "utf-8");
  const thresholds = JSON.stringify({
    updated: new Date().toISOString(),
    default_stable_seconds: 300,
    target_fn_rate: 0.05,
    cities: { [CITY]: { stable_seconds: 240, events: 100, fn_rate: 0.0 } },
  });
  const cities = JSON.stringify([CITY]);

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
    if (!fs.existsSync(fullPath)) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(fullPath);
    const ct = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };
    res.writeHead(200, { "Content-Type": ct[ext] || "application/octet-stream" });
    res.end(fs.readFileSync(fullPath));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

test.describe("Screen Wake Lock", () => {
  /** @type {{ server: http.Server, port: number, url: string }} */
  let mock;

  test("should request a screen wake lock on load", async ({ page }) => {
    mock = await startMockServer();

    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      // Inject a mock navigator.wakeLock before the page script runs
      await page.addInitScript(() => {
        const sentinel = {
          released: false,
          type: "screen",
          _listeners: {},
          addEventListener(evt, fn) { this._listeners[evt] = fn; },
          release() {
            this.released = true;
            if (this._listeners.release) this._listeners.release();
            return Promise.resolve();
          },
        };

        window.__wakeLockCalls = [];
        Object.defineProperty(navigator, "wakeLock", {
          value: {
            request(type) {
              window.__wakeLockCalls.push({ type, time: Date.now() });
              return Promise.resolve(sentinel);
            },
          },
          configurable: true,
        });
        window.__wakeLockSentinel = sentinel;
      });

      await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);
      await page.waitForTimeout(3000);

      // Verify wake lock was requested with type "screen"
      const calls = await page.evaluate(() => window.__wakeLockCalls);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].type).toBe("screen");
    } finally {
      mock.server.close();
    }
  });

  test("should re-acquire wake lock after each visibility toggle", async ({ page }) => {
    mock = await startMockServer();

    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      await page.addInitScript(() => {
        const makeSentinel = () => ({
          released: false,
          type: "screen",
          _listeners: {},
          addEventListener(evt, fn) { this._listeners[evt] = fn; },
          release() {
            this.released = true;
            if (this._listeners.release) this._listeners.release();
            return Promise.resolve();
          },
        });

        window.__wakeLockCalls = [];
        Object.defineProperty(navigator, "wakeLock", {
          value: {
            request(type) {
              window.__wakeLockCalls.push({ type, time: Date.now() });
              return Promise.resolve(makeSentinel());
            },
          },
          configurable: true,
        });
      });

      await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);
      await page.waitForTimeout(2000);

      // Should have the initial request from page load
      const initialCalls = await page.evaluate(() => window.__wakeLockCalls.length);
      expect(initialCalls).toBe(1);

      // Toggle hidden → visible three times; each should re-acquire
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await page.waitForTimeout(300);
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await page.waitForTimeout(500);

        const count = await page.evaluate(() => window.__wakeLockCalls.length);
        expect(count).toBe(initialCalls + i + 1);
      }

      // Final check: all 4 calls (1 init + 3 toggles) requested "screen"
      const allCalls = await page.evaluate(() => window.__wakeLockCalls);
      expect(allCalls).toHaveLength(4);
      for (const call of allCalls) {
        expect(call.type).toBe("screen");
      }
    } finally {
      mock.server.close();
    }
  });

  test("should not crash when wake lock API is unavailable", async ({ page }) => {
    mock = await startMockServer();

    try {
      await page.route("**/orefalert-func.azurewebsites.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
      );

      // Explicitly remove wakeLock to simulate unsupported browser
      await page.addInitScript(() => {
        if ("wakeLock" in navigator) {
          delete navigator.wakeLock;
        }
      });

      await page.goto(`${mock.url}/?city=${encodeURIComponent(CITY)}`);
      await page.waitForTimeout(3000);

      // Page should still work — check green background
      const bg = await page.evaluate(() =>
        window.getComputedStyle(document.body).backgroundColor
      );
      expect(bg).toBe("rgb(0, 200, 83)");
    } finally {
      mock.server.close();
    }
  });
});

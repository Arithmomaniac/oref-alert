import { test, expect } from '@playwright/test';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.resolve(__dirname, '..');

const DEFAULT_CITIES = ['כרמיאל', 'בית שמש', 'חריש'];
const HASH_CITIES = ['אילת', 'נתיבות'];

function events(count) {
  const result = [];
  for (let i = 0; i < count; i++) {
    result.push({
      outcome: i % 3 === 0 ? 'miss' : i % 3 === 1 ? 'immediate' : 'hit_after_gap',
      gap: i % 3 === 2 ? 90 + i * 10 : null,
      cohort_sirens: i % 3 === 0 ? 1 : 2,
      pre_alert_to_siren: i % 3 === 0 ? null : 120 + i * 20,
    });
  }
  return result;
}

function buildMockData() {
  const cityNames = [...DEFAULT_CITIES, ...HASH_CITIES];
  const cities = {};
  const thresholdCities = {};
  const noWarning = {};
  cityNames.forEach((city, index) => {
    cities[city] = events(4 + index);
    thresholdCities[city] = {
      stable_seconds: 120 + index * 30,
      fn_rate: 0.03 + index * 0.005,
      events: cities[city].length,
    };
    noWarning[city] = { count: index };
  });
  return {
    gapData: { watermark: null, last_rid: null, cities, no_warning_sirens: {} },
    thresholds: {
      updated: new Date().toISOString(),
      default_stable_seconds: 300,
      target_fn_rate: 0.05,
      cities: thresholdCities,
      no_warning_sirens: noWarning,
    },
  };
}

function startMockServer() {
  const { gapData, thresholds } = buildMockData();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/gap_data.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(gapData));
      return;
    }
    if (url.pathname === '/api/thresholds.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(thresholds));
      return;
    }

    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const fullPath = path.join(WEB_DIR, filePath);
    if (!fs.existsSync(fullPath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(fullPath);
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
    };
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(fullPath));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function preparePage(page) {
  await page.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Chart = function(){ this.destroy = function(){}; };',
    })
  );
  await page.route('https://js.monitor.azure.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Microsoft = { ApplicationInsights: { ApplicationInsights: function(){ this.loadAppInsights = function(){}; this.trackPageView = function(){}; } } };',
    })
  );
}

test('report loads with default 3 cities', async ({ page }) => {
  const mock = await startMockServer();
  try {
    await preparePage(page);
    await page.goto(`${mock.url}/report.html`);
    // Wait for data to load
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#loading')).toBeHidden();

    // 3 inputs should have default values
    const sel0 = page.locator('#sel0');
    const sel1 = page.locator('#sel1');
    const sel2 = page.locator('#sel2');
    await expect(sel0).toHaveValue('כרמיאל');
    await expect(sel1).toHaveValue('בית שמש');
    await expect(sel2).toHaveValue('חריש');

    // Stat cards should be visible
    await expect(page.locator('#stat-cards .stat-card')).toHaveCount(3);

    // Charts should be rendered
    await expect(page.locator('#outcomeChart')).toBeVisible();
    await expect(page.locator('#fnRateChart')).toBeVisible();
  } finally {
    mock.server.close();
  }
});

test('report loads cities from URL hash', async ({ page }) => {
  const mock = await startMockServer();
  try {
    await preparePage(page);
    await page.goto(`${mock.url}/report.html#${encodeURIComponent('אילת,נתיבות')}`);
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    const sel0 = page.locator('#sel0');
    const sel1 = page.locator('#sel1');
    const sel2 = page.locator('#sel2');
    await expect(sel0).toHaveValue('אילת');
    await expect(sel1).toHaveValue('נתיבות');
    await expect(sel2).toHaveValue('');  // only 2 cities

    // 2 stat cards
    await expect(page.locator('#stat-cards .stat-card')).toHaveCount(2);
  } finally {
    mock.server.close();
  }
});

test('city picker filters on type', async ({ page }) => {
  const mock = await startMockServer();
  try {
    await preparePage(page);
    await page.goto(`${mock.url}/report.html`);
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    // Clear first input and type a search term
    const sel0 = page.locator('#sel0');
    await sel0.fill('');
    await sel0.fill('אילת');

    // Suggestions should appear
    const sug0 = page.locator('#sug0');
    await expect(sug0).toBeVisible();
    const items = sug0.locator('.sug');
    const count = await items.count();
    expect(count).toBeGreaterThan(0);

    // First suggestion should contain the search text
    const firstText = await items.first().textContent();
    expect(firstText).toContain('אילת');

    // Click to select
    await items.first().click();
    await expect(sug0).toBeHidden();

    // URL hash should update
    const url = page.url();
    expect(url).toContain('#');
  } finally {
    mock.server.close();
  }
});

test('how it works details toggle', async ({ page }) => {
  const mock = await startMockServer();
  try {
    await preparePage(page);
    await page.goto(`${mock.url}/report.html`);
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    const details = page.locator('details');
    const summary = details.locator('summary');

    // Initially closed — content not visible
    const content = details.locator('p').first();
    await expect(content).toBeHidden();

    // Click to open
    await summary.click();
    await expect(content).toBeVisible();
  } finally {
    mock.server.close();
  }
});

import { test, expect } from '@playwright/test';

const BASE = 'https://orefalertst.z39.web.core.windows.net';

test('report loads with default 3 cities', async ({ page }) => {
  await page.goto(`${BASE}/report.html`);
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
});

test('report loads cities from URL hash', async ({ page }) => {
  await page.goto(`${BASE}/report.html#${encodeURIComponent('אילת,נתיבות')}`);
  await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

  const sel0 = page.locator('#sel0');
  const sel1 = page.locator('#sel1');
  const sel2 = page.locator('#sel2');
  await expect(sel0).toHaveValue('אילת');
  await expect(sel1).toHaveValue('נתיבות');
  await expect(sel2).toHaveValue('');  // only 2 cities

  // 2 stat cards
  await expect(page.locator('#stat-cards .stat-card')).toHaveCount(2);
});

test('city picker filters on type', async ({ page }) => {
  await page.goto(`${BASE}/report.html`);
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
});

test('how it works details toggle', async ({ page }) => {
  await page.goto(`${BASE}/report.html`);
  await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

  const details = page.locator('details');
  const summary = details.locator('summary');

  // Initially closed — content not visible
  const content = details.locator('p').first();
  await expect(content).toBeHidden();

  // Click to open
  await summary.click();
  await expect(content).toBeVisible();
});

import { expect, test } from '@playwright/test';

// The worker's wasm is the largest thing the site serves and nothing asks for it until
// Client.connect runs, so it lands inside the wait after the connect click. These check that
// the hint is issued before the click, and only when it would be used.
//
// The module itself is routed away: this is about whether the hint is emitted, and pulling
// 9.8 MB through the dev server on every run would be the slowest test in the suite.
const block = (page: import('@playwright/test').Page) =>
  page.route('**/probe_web_local_bg.wasm', (route) => route.abort());

test('reaching for Connect prefetches the worker wasm', async ({ page }) => {
  await block(page);
  await page.goto('/');
  const hint = page.locator('link[rel=prefetch][href*="probe_web_local_bg"]');
  await expect(hint).toHaveCount(0);

  await page.locator('#connect').hover();
  await expect(hint).toHaveCount(1);
});

test('the WebSocket transport does not prefetch a worker it will not use', async ({ page }) => {
  await block(page);
  await page.goto('/');
  // the label's <small> sits over the radio, so click the label rather than the input
  await page.getByText('WebSocket', { exact: false }).first().click();

  await page.locator('#connect').hover();
  await expect(page.locator('link[rel=prefetch][href*="probe_web_local_bg"]')).toHaveCount(0);
});

test('the fake probe does not prefetch the real worker', async ({ page }) => {
  await block(page);
  await page.goto('/?fake=1');

  await page.locator('#connect').hover();
  await expect(page.locator('link[rel=prefetch][href*="probe_web_local_bg"]')).toHaveCount(0);
});

import { expect, test } from '@playwright/test';

// The inspect app on the fake worker: the local transport implements `info`,
// so capability negotiation enables Scan and the scan runs against the fake
// probe. It has no debug port (DP access returns NotImplemented), so the events
// report that rather than a component tree; the real scan is verified on hardware.
test('inspect app scans through the worker info endpoint', async ({ page }) => {
  await page.goto('/inspect/?auto=1&transport=webusb&fake=1&probe=fake');
  await expect(page.locator('#log')).toContainText('AUTORUN_DONE', { timeout: 45_000 });
  await expect(page.locator('#log')).toContainText('info supported');
  await expect(page.locator('#log')).toContainText('SCAN_RESULT=PASS');
  await expect(page.locator('#scan-status')).toContainText(/done, [1-9]\d* event/);
});

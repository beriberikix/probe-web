import { expect, test } from '@playwright/test';

// Phase 4: debug endpoints served by the WebUSB worker, against the fake probe's mocked core.
test('worker core endpoints: run control, registers, hardware breakpoints (fake probe)', async ({ page }) => {
  await page.goto('/debug.html?webusb-fake=core');
  await expect(page.locator('#log')).toContainText('CORE_RESULT=', { timeout: 60_000 });
  const log = await page.locator('#log').textContent();
  expect(log?.split('\n').filter((l) => l.startsWith('FAIL'))).toEqual([]);
  expect(log).toContain('CORE_RESULT=PASS');
});

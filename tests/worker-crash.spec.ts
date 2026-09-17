import { expect, test } from '@playwright/test';

// A panic in the local worker must fail calls, not hang them: the fake build
// panics when asked to scan probe ffff:fffe (see probe-web-local target_info).
test('a crashed worker rejects in-flight and later calls as worker-crashed', async ({ page }) => {
  await page.goto('/?idle=1&crashtest=1');
  await expect(page.locator('#log')).toContainText('CRASH_RESULT=', { timeout: 30_000 });
  await expect(page.locator('#log')).toContainText('CRASH_RESULT=PASS');
  await expect(page.locator('#log')).toContainText('test panic requested through the fake probe');
});

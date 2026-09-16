import { expect, test } from '@playwright/test';

// The local (in-tab) transport end to end without hardware: worker boots
// probe-rs, the schema negotiates, a fake probe with a mocked core attaches
// to MCXA153, halts, reads memory, resumes.
test('local transport with the fake probe attaches and reads memory', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto('/?auto=1&transport=webusb&fake=1');
  await expect(page.locator('#log')).toContainText('AUTORUN_DONE', { timeout: 45_000 });
  const log = await page.locator('#log').textContent();
  expect(log).toContain('connected via webusb');
  expect(log).toContain('probe: Fake probe');
  expect(log).toContain('attached: MCXA153');
  expect(log).toContain('FAKE_RESULT=PASS');
  // Capability negotiation: the worker advertises a truthful subset.
  expect(log).toMatch(/\d+ unsupported endpoint\(s\)/);
});

test('flash panel refuses to flash without a session', async ({ page }) => {
  await page.goto('/');
  const flashButton = page.locator('probe-flash-panel').locator('button.primary');
  await expect(flashButton).toBeDisabled();
});

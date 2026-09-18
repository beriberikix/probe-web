import { expect, test } from '@playwright/test';

test('target picker searches the registry, shows chip info, imports YAML', async ({ page }) => {
  // Heavy for a UI test: it needs a connected client for the chip registry, so the page loads the
  // 12.6 MB fake-probe worker and runs a fake flash first. That fits comfortably on a developer
  // machine and not always on a shared CI runner, where the default budget timed out mid-test.
  test.slow();
  await page.goto('/?auto=1&transport=webusb&fake=1');
  await expect(page.locator('#log')).toContainText('AUTORUN_DONE', { timeout: 45_000 });
  const picker = page.locator('probe-target-picker');
  await expect(picker).toContainText(/\d+ families/);
  await picker.locator('input[type=text]').fill('mcxa153');
  const row = picker.locator('li', { hasText: 'MCXA153' }).first();
  await row.click();
  await expect(page.locator('#chip')).toHaveValue('MCXA153');
  await expect(picker).toContainText('PROGRAM_FLASH');
  await expect(picker).toContainText('Nvm');
  // Import a renamed copy of the MCXA family; it must show up in the registry.
  await picker.locator('input[type=file]').setInputFiles('apps/flash/public/targets/test-family.yaml');
  await expect(picker).toContainText(/imported test-family.yaml: 1 new family/);
  await picker.locator('input[type=text]').fill('MCXA153-imported');
  await expect(picker.locator('li', { hasText: 'MCXA153-imported' })).toHaveCount(1);
});

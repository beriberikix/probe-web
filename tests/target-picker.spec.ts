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
  // The importer is a no-op without a client, and a file input's change event is lost if the
  // element is re-rendered under it — so check it is live, then that the handler actually ran.
  const fileInput = picker.locator('input[type=file]');
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles('apps/flash/public/targets/test-family.yaml');
  await expect(picker).toContainText(/reading test-family.yaml|imported test-family.yaml/);
  await expect(picker).toContainText(/imported test-family.yaml: 1 new family/);
  await picker.locator('input[type=text]').fill('MCXA153-imported');
  await expect(picker.locator('li', { hasText: 'MCXA153-imported' })).toHaveCount(1);
});

test('target picker imports a CMSIS pack and lists its families', async ({ page }) => {
  // Same reason as above: the registry needs a connected client.
  test.slow();
  await page.goto('/?auto=1&transport=webusb&fake=1');
  await expect(page.locator('#log')).toContainText('AUTORUN_DONE', { timeout: 45_000 });

  const picker = page.locator('probe-target-picker');
  const fileInput = picker.locator('input[type=file]');
  await expect(fileInput).toBeEnabled();

  // A pack is not loaded wholesale: its families are listed for the user to choose from,
  // because a real vendor DFP carries dozens.
  await fileInput.setInputFiles('apps/flash/public/targets/minimal.pack');
  await expect(picker).toContainText('1 family — choose what to load');
  const pending = picker.locator('#pending li');
  await expect(pending).toHaveCount(1);
  await expect(pending.first()).toContainText('ProbeWebTest');
  await expect(pending.first()).toContainText('1 chip');

  await pending.first().click();
  await expect(picker).toContainText(/imported ProbeWebTest \(minimal.pack\): 1 new family/);

  // And the chip is now in the registry, which is the whole point.
  await picker.locator('input[type=text]').fill('ProbeWebTestChip');
  await expect(picker.locator('li', { hasText: 'ProbeWebTestChip' })).toHaveCount(1);
});

test('target picker reports a wrong file as a readable error', async ({ page }) => {
  test.slow();
  await page.goto('/?auto=1&transport=webusb&fake=1');
  await expect(page.locator('#log')).toContainText('AUTORUN_DONE', { timeout: 45_000 });

  const picker = page.locator('probe-target-picker');
  await expect(picker.locator('input[type=file]')).toBeEnabled();
  // Picking the wrong file is the common mistake; the typed fault has to surface as a
  // sentence, not a stack trace.
  await picker.locator('input[type=file]').setInputFiles({
    name: 'not-really.pack',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('this is not a zip'),
  });
  await expect(picker).toContainText(/import failed:.*not a readable \.pack archive/);
});

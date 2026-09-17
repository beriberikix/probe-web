import { expect, test } from '@playwright/test';

// Debugger components against the scripted FakeDebugger (debug.html?fake=1).
test.describe('debugger components (fake debugger)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/debug.html?fake=1');
    await expect(page.locator('#log')).toContainText('fake debugger ready');
  });

  test('callstack, variables and registers render the stop and follow frame selection', async ({ page }) => {
    const stack = page.locator('probe-callstack');
    await expect(stack.locator('tr[data-frame]')).toHaveCount(4);
    await expect(stack.locator('tr[data-frame="i32::wrapping_mul"]')).toContainText('(inlined)');
    await expect(stack.locator('tr.selected')).toHaveAttribute('data-frame', 'step_b');

    const vars = page.locator('probe-variables');
    await expect(vars.locator('[data-path="Variables/point"]')).toBeVisible();
    await vars.locator('[data-path="Variables/point"] .twisty').click();
    await expect(vars.locator('[data-path="Variables/point/x"] .value')).toHaveText('2');
    await expect(vars.locator('[data-path="Variables/point/y"] .value')).toHaveText('4');

    // Selecting main shows its locals instead.
    await stack.locator('tr[data-frame="main"]').click();
    await expect(vars.locator('[data-path="Variables/n"] .value')).toHaveText('2');
    await expect(vars.locator('[data-path="Variables/point"]')).toHaveCount(0);

    const regs = page.locator('probe-registers');
    await expect(regs.locator('tr[data-register="R15"] .value')).toHaveText('0x00000978');
    await expect(regs.locator('tr[data-register="R13"]')).toContainText('R13 (SP)');
    await expect(regs.locator('tr[data-register="S0"]')).toHaveCount(0); // floating point collapsed by default
  });

  test('controls drive run state; panels go stale while running and refresh with change marks', async ({ page }) => {
    const controls = page.locator('probe-core-controls');
    await expect(controls.locator('.state')).toContainText('halted');
    await expect(controls.getByRole('button', { name: 'Pause' })).toBeDisabled();

    await controls.getByRole('button', { name: 'Continue' }).click();
    await expect(controls.locator('.state')).toContainText('running');
    await expect(page.locator('probe-registers table')).toHaveClass(/stale/);
    await expect(controls.getByRole('button', { name: 'Step over' })).toBeDisabled();

    await controls.getByRole('button', { name: 'Pause' }).click();
    await expect(controls.locator('.state')).toContainText('paused at 0x00000900');
    await expect(page.locator('probe-registers tr[data-register="R15"] .value')).toHaveText('0x00000900');

    await controls.getByRole('button', { name: 'Step over' }).click();
    await expect(controls.locator('.state')).toContainText('step at 0x00000902');
    const pc = page.locator('probe-registers tr[data-register="R15"] .value');
    await expect(pc).toHaveText('0x00000902');
    await expect(pc).toHaveClass(/changed/);
    await expect(page.locator('probe-registers tr[data-register="R0"] .value')).not.toHaveClass(/changed/);

    const calls = await page.evaluate(() => (window as unknown as { fake: { calls: string[] } }).fake.calls);
    expect(calls).toEqual(['continue', 'pause', 'step over']);
  });

  test('editing a register and a variable writes through the debugger', async ({ page }) => {
    const regs = page.locator('probe-registers');
    await regs.locator('tr[data-register="R0"] .value').dblclick();
    await regs.locator('tr[data-register="R0"] input').fill('0xdeadbeef');
    await regs.locator('tr[data-register="R0"] input').press('Enter');
    await expect(regs.locator('tr[data-register="R0"] .value')).toHaveText('0xdeadbeef');

    const vars = page.locator('probe-variables');
    await vars.locator('[data-path="Static"] .twisty').click();
    await vars.locator('[data-path="Static/cm33_debug"] .twisty').click();
    await vars.locator('[data-path="Static/cm33_debug/COUNTER"] .value').dblclick();
    await vars.locator('[data-path="Static/cm33_debug/COUNTER"] input').fill('42');
    await vars.locator('[data-path="Static/cm33_debug/COUNTER"] input').press('Enter');
    await expect(vars.locator('[data-path="Static/cm33_debug/COUNTER"] .value')).toHaveText('42');

    const calls = await page.evaluate(() => (window as unknown as { fake: { calls: string[] } }).fake.calls);
    expect(calls).toEqual(['writeRegister R0=deadbeef', 'setVariable COUNTER=42']);
  });

  test('expansion survives a new stop; watches re-evaluate', async ({ page }) => {
    const vars = page.locator('probe-variables');
    await vars.locator('[data-path="Variables/point"] .twisty').click();
    await expect(vars.locator('[data-path="Variables/point/x"] .value')).toHaveText('2');

    const add = vars.getByPlaceholder('add watch (name)');
    await add.fill('COUNTER');
    await add.press('Enter');
    await add.fill('bogus');
    await add.press('Enter');
    await expect(vars.locator('[data-watch="COUNTER"] .value')).toHaveText('1');
    await expect(vars.locator('[data-watch="bogus"] .value')).toHaveClass(/err/);

    await page.locator('probe-core-controls').getByRole('button', { name: 'Continue' }).click();
    await page.evaluate(() => (window as unknown as { fake: { hit(): void } }).fake.hit());
    await expect(vars.locator('[data-path="Variables/point/x"] .value')).toHaveText('3'); // still expanded, new values
    await expect(vars.locator('[data-watch="COUNTER"] .value')).toHaveText('2');
  });
});

test('debugger() is available on the WebUSB worker, which now serves the debug endpoints (fake probe)', async ({ page }) => {
  await page.goto('/debug.html?webusb-fake=1');
  await expect(page.locator('#log')).toContainText('DEBUGGER_RESULT=', { timeout: 30_000 });
  await expect(page.locator('#log')).toContainText('DEBUGGER_RESULT=PASS');
  await expect(page.locator('#log')).toContainText('pause → "Request"');
  // The worker has no disassembler: the panel says so instead of showing an error.
  await expect(page.locator('#log')).toContainText('disassembly panel: Disassembly is not available on this connection');
  await expect(page.locator('probe-disassembly .unavailable')).toBeVisible();
});

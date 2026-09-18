import { expect, test } from '@playwright/test';

type FakeWindow = { fake: { calls: string[]; hit(pc?: bigint): void; continue(): Promise<void> } };
const calls = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as FakeWindow).fake.calls);

// Breakpoints, disassembly, memory view and peripherals against the FakeDebugger (debug.html?fake=1).
test.describe('debugger components B (fake debugger)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/debug.html?fake=1');
    await expect(page.locator('#log')).toContainText('fake debugger ready');
  });

  test('breakpoints: add by file:line and address, show failures, highlight hits, remove', async ({ page }) => {
    const bps = page.locator('probe-breakpoints');
    const input = bps.getByPlaceholder('src/main.rs:40 or 0x938');
    await input.fill('src/main.rs:40');
    await input.press('Enter');
    await input.fill('src/main.rs:1');
    await input.press('Enter');
    await input.fill('0x938');
    await input.press('Enter');
    const rows = bps.locator('tr[data-breakpoint]');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('main.rs:40');
    await expect(rows.nth(0)).toContainText('0x00000950');
    await expect(rows.nth(1).locator('.message')).toHaveText('no code at this location');
    await expect(rows.nth(2)).toContainText('0x00000938');
    expect(await calls(page)).toEqual(['setSourceBreakpoints src/main.rs 40', 'setSourceBreakpoints src/main.rs 40,1', 'setInstructionBreakpoints 938']);

    // A stop at 0x950 highlights the breakpoint that caused it.
    await page.evaluate(async () => { const f = (window as unknown as FakeWindow).fake; await f.continue(); f.hit(0x950n); });
    await expect(rows.nth(0)).toHaveClass(/selected/);

    await rows.nth(1).getByRole('button', { name: '✕' }).click();
    await expect(rows).toHaveCount(2);
    await bps.getByRole('button', { name: 'Remove all' }).click();
    await expect(bps).toContainText('no breakpoints');
  });

  test('disassembly: PC row, source headers, gutter toggles instruction breakpoints', async ({ page }) => {
    const dis = page.locator('probe-disassembly');
    await expect(dis.locator('tr.pc')).toHaveAttribute('data-address', '0x00000978');
    await expect(dis.locator('tr.src').first()).toContainText('main.rs:');
    const row = dis.locator('tr[data-address="0x0000097a"]');
    await row.locator('.gutter').click();
    await expect(row.locator('.gutter')).toHaveText('●');
    await row.locator('.gutter').click();
    await expect(row.locator('.gutter')).toHaveText('');
    expect(await calls(page)).toEqual(['setInstructionBreakpoints 97a', 'setInstructionBreakpoints ']);

    await dis.getByPlaceholder('address (0x…)').fill('0x1000');
    await dis.getByPlaceholder('address (0x…)').press('Enter');
    await expect(dis.locator('tr.pc')).toHaveCount(0);
    await expect(dis.getByRole('button', { name: 'Follow PC' })).toBeEnabled();
  });

  test('memory view: bytes, ASCII, grouping and endianness, byte edit, Intel HEX', async ({ page }) => {
    const mem = page.locator('probe-memory-view');
    const addr = mem.locator('input.address');
    await addr.fill('0x20000030');
    await addr.press('Enter');
    const first = mem.locator('tr[data-offset="0"]');
    await expect(first.locator('td.cell').first()).toHaveText('30');
    await expect(first.locator('td.ascii')).toHaveText('0123456789:;<=>?');
    await mem.getByLabel('group').selectOption('4');
    await expect(first.locator('td.cell').first()).toHaveText('33323130');
    await mem.getByLabel('big-endian').check();
    await expect(first.locator('td.cell').first()).toHaveText('30313233');
    await mem.getByLabel('group').selectOption('1');
    await first.locator('td.cell').nth(2).dblclick();
    await first.locator('input.edit').fill('ff');
    await first.locator('input.edit').press('Enter');
    expect(await calls(page)).toEqual(['writeMemory 20000032 1']);
    const hex = await mem.evaluate((el) => (el as unknown as { exportHex(): string }).exportHex());
    expect(hex.split('\n')[0]).toBe(':020000042000DA');
    expect(hex.split('\n')[1].startsWith(':10003000303132')).toBe(true);
  });

  test('memory view: variable highlights and lock view', async ({ page }) => {
    const mem = page.locator('probe-memory-view');
    const addr = mem.locator('input.address');
    await addr.fill('0x20000000');
    await addr.press('Enter');
    const first = mem.locator('tr[data-offset="0"]');
    await expect(first.locator('td.cell').first()).toHaveText('00');

    // COUNTER (u32 at 0x20000000) colours 4 bytes.
    await mem.getByLabel('watch variable').fill('COUNTER');
    await mem.getByLabel('watch variable').press('Enter');
    await expect(mem.locator('.chip[data-label="COUNTER"]')).toBeVisible();
    await expect(mem.locator('td.cell[data-highlight="COUNTER"]')).toHaveCount(4);
    await expect(first.locator('td.cell').nth(4)).not.toHaveAttribute('data-highlight', /.*/);
    // Grouped as u16, both groups of the u32 are coloured.
    await mem.getByLabel('group').selectOption('2');
    await expect(mem.locator('td.cell[data-highlight="COUNTER"]')).toHaveCount(2);
    await mem.getByLabel('group').selectOption('1');
    // A name without an address is an error, not a highlight.
    await mem.getByLabel('watch variable').fill('nope');
    await mem.getByLabel('watch variable').press('Enter');
    await expect(mem.locator('.err')).toContainText('nope has no address');
    await mem.getByRole('button', { name: 'unwatch COUNTER' }).click();
    await expect(mem.locator('td.cell[data-highlight]')).toHaveCount(0);

    // Locked: other panels cannot move it, Refresh and the address field are disabled.
    await mem.getByLabel('lock view').check();
    await expect(addr).toBeDisabled();
    await expect(mem.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    const moved = await mem.evaluate((el) => (el as unknown as { goTo(a: bigint): Promise<boolean> }).goTo(0x20000100n));
    expect(moved).toBe(false);
    await expect(addr).toHaveValue('0x20000000');
    await expect(first.locator('td.cell').first()).toHaveText('00');
    // A stop does not re-read a locked view.
    await page.evaluate(() => {
      const f = (window as unknown as { fake: { readMemory(a: bigint, n: number): Promise<Uint8Array>; reads?: number } }).fake;
      const read = f.readMemory.bind(f);
      f.reads = 0;
      f.readMemory = (a, n) => { f.reads!++; return read(a, n); };
    });
    await page.evaluate(async () => { const f = (window as unknown as FakeWindow).fake; await f.continue(); f.hit(); });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { fake: { reads: number } }).fake.reads)).toBe(0);
    await mem.getByLabel('lock view').uncheck();
    // Unlocked, the same stop re-reads it.
    await page.evaluate(async () => { const f = (window as unknown as FakeWindow).fake; await f.continue(); f.hit(); });
    await expect.poll(() => page.evaluate(() => (window as unknown as { fake: { reads: number } }).fake.reads)).toBeGreaterThan(0);
    expect(await mem.evaluate((el) => (el as unknown as { goTo(a: bigint): Promise<boolean> }).goTo(0x20000100n))).toBe(true);
    await expect(addr).toHaveValue('0x20000100');
  });

  test('peripherals: load an SVD, expand registers and fields, filter', async ({ page }) => {
    const periph = page.locator('probe-peripherals');
    await expect(periph).toContainText('load an SVD file');
    await periph.locator('input[type=file]').setInputFiles({ name: 'scb.svd', mimeType: 'application/xml', buffer: Buffer.from('<device/>') });
    await expect(periph.locator('[data-path="/SCB"]')).toBeVisible();
    await periph.locator('[data-path="/SCB"] .twisty').click();
    await expect(periph.locator('[data-path="/SCB/SCB.CPUID"] .value')).toHaveText('0x411FD210');
    await periph.locator('[data-path="/SCB/SCB.CPUID"] .twisty').click();
    await expect(periph.locator('[data-path="/SCB/SCB.CPUID/SCB.CPUID.IMPLEMENTER"] .name')).toHaveText('IMPLEMENTER');
    await periph.getByPlaceholder('filter peripherals').fill('gpio');
    await expect(periph.locator('[data-path="/SCB"]')).toHaveCount(0);
    await expect(periph.locator('[data-path="/GPIO0"]')).toBeVisible();
    expect(await calls(page)).toEqual(['loadSvd']);
  });
});

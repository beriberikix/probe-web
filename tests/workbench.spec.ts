import { expect, test } from '@playwright/test';

type Wb = {
  workbench: { source: { path: string | null; pcLine: number | null; breakpointLines(): number[]; onToggleBreakpoint(p: string, l: number): Promise<void> }; consoleView: { lines: string[] } };
  fake: { hit(pc?: bigint): void; calls: string[] };
  dock: { getPanel(id: string): unknown; removePanel(p: unknown): void };
};

// The workbench with the scripted FakeDebugger behind the DAP adapter.
test.describe('workbench (fake debugger)', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('launch, stop, source view with PC and gutter breakpoints, panels follow', async ({ page }) => {
    await page.goto('/workbench/?fake=1&fresh=1');
    for (const title of ['Run', 'Call stack', 'Variables', 'Registers', 'Console', 'Breakpoints']) {
      await expect(page.locator('.dv-tab', { hasText: title }).first()).toBeVisible();
    }
    await page.click('#launch');
    await expect(page.locator('#status')).toHaveText('running');
    await page.evaluate(() => (window as unknown as Wb).fake.hit());
    await expect(page.locator('#status')).toHaveText('stopped (breakpoint)');

    await expect.poll(() => page.evaluate(() => { const s = (window as unknown as Wb).workbench.source; return `${s.path}:${s.pcLine}`; })).toBe('/build/fw/src/main.rs:40');
    await expect(page.locator('.monaco-editor .pc-line')).toHaveCount(1);
    await expect(page.locator('.dv-tab', { hasText: 'main.rs' })).toBeVisible();
    await expect(page.locator('probe-callstack tr.selected')).toHaveAttribute('data-frame', 'step_b');
    await expect(page.locator('probe-variables [data-path="Variables/point"]')).toBeVisible();

    // Gutter: add line 12, then remove it.
    await page.evaluate(() => { const w = (window as unknown as Wb).workbench; return w.source.onToggleBreakpoint(w.source.path!, 12); });
    await expect.poll(() => page.evaluate(() => (window as unknown as Wb).workbench.source.breakpointLines())).toEqual([12]);
    await page.evaluate(() => { const w = (window as unknown as Wb).workbench; return w.source.onToggleBreakpoint(w.source.path!, 12); });
    await expect.poll(() => page.evaluate(() => (window as unknown as Wb).workbench.source.breakpointLines())).toEqual([]);
    const calls = await page.evaluate(() => (window as unknown as Wb).fake.calls);
    expect(calls).toEqual(expect.arrayContaining(['setSourceBreakpoints /build/fw/src/main.rs 12', 'setSourceBreakpoints /build/fw/src/main.rs ']));

    // A breakpoint requested under a relative path is removed from the gutter of the absolute file.
    await page.locator('.dv-tab', { hasText: 'Breakpoints' }).click();
    await page.locator('probe-breakpoints').getByPlaceholder('src/main.rs:40 or 0x938').fill('src/main.rs:20');
    await page.locator('probe-breakpoints').getByPlaceholder('src/main.rs:40 or 0x938').press('Enter');
    await expect.poll(() => page.evaluate(() => (window as unknown as Wb).workbench.source.breakpointLines())).toEqual([20]);
    await page.evaluate(() => { const w = (window as unknown as Wb).workbench; return w.source.onToggleBreakpoint(w.source.path!, 20); });
    await expect.poll(() => page.evaluate(() => (window as unknown as Wb).workbench.source.breakpointLines())).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as Wb).fake.calls)).toContain('setSourceBreakpoints src/main.rs ');

    // Run control from the Run panel moves the PC in the source view.
    await page.locator('probe-core-controls').getByRole('button', { name: 'Step over' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Wb).workbench.source.pcLine)).toBe(41);
    await expect(page.locator('#status')).toHaveText('stopped (step)');
    await expect.poll(() => page.evaluate(() => (window as unknown as Wb).workbench.consoleView.lines.join('\n'))).toContain('probe-rs: launched');
  });

  test('layout is saved and restored; reset layout brings panels back', async ({ page }) => {
    await page.goto('/workbench/?fake=1&fresh=1');
    await expect(page.locator('.dv-tab', { hasText: 'Memory' })).toHaveCount(1);
    await page.evaluate(() => { const d = (window as unknown as Wb).dock; d.removePanel(d.getPanel('memory')); });
    await page.waitForTimeout(600); // debounced save
    await page.goto('/workbench/?fake=1');
    await expect(page.locator('.dv-tab', { hasText: 'Registers' })).toHaveCount(1);
    await expect(page.locator('.dv-tab', { hasText: 'Memory' })).toHaveCount(0);
    await page.click('#reset-layout');
    await expect(page.locator('.dv-tab', { hasText: 'Memory' })).toHaveCount(1);
  });
});

// The transport picker: WebUSB runs probe-rs in the page, so the server fields do not apply.
test.describe('workbench transport picker', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('WebUSB hides the server fields and offers the probe chooser; the choice is remembered', async ({ page }) => {
    await page.goto('/workbench/?fake=1&fresh=1');
    await expect(page.locator('#url')).toBeVisible();
    await expect(page.locator('#pick-probe')).toBeHidden();

    await page.selectOption('#transport', 'webusb');
    await expect(page.locator('#url')).toBeHidden();
    await expect(page.locator('#token')).toBeHidden();
    await expect(page.locator('#pick-probe')).toBeVisible();

    // Remembered across reloads, and ?transport= wins over what was remembered.
    await page.reload();
    await expect(page.locator('#transport')).toHaveValue('webusb');
    await expect(page.locator('#pick-probe')).toBeVisible();
    await page.goto('/workbench/?fake=1&transport=websocket');
    await expect(page.locator('#url')).toBeVisible();
    await expect(page.locator('#pick-probe')).toBeHidden();
  });
});

// Picked files and the source folder are remembered. Real FileSystemHandles are needed (IndexedDB
// clones them), so the pickers are stubbed with handles from the origin private file system.
// Reading such a handle back from IndexedDB crashes Playwright's Chromium builds (both the headless
// shell and full Chromium, 1243), so only the stored keys are checked here; the restore logic is
// unit-tested in packages/artifacts/test/permission.test.ts.
test.describe('workbench file handles', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('picking the ELF, SVD and source folder remembers them; Forget clears them', async ({ page }) => {
    const storedKeys = () => page.evaluate(() => new Promise<string[]>((resolve) => {
      const open = indexedDB.open('probe-web-artifacts', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('handles');
      open.onsuccess = () => {
        const req = open.result.transaction('handles').objectStore('handles').getAllKeys();
        req.onsuccess = () => resolve(req.result.map(String).sort());
      };
    }));

    await page.goto('/workbench/?fake=1&fresh=1');
    await expect.poll(storedKeys).toEqual([]);
    // `fresh` is applied once and dropped from the address, so a reload does not clear again.
    await expect.poll(() => new URL(page.url()).searchParams.has('fresh')).toBe(false);
    expect(new URL(page.url()).searchParams.get('fake')).toBe('1');
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const proj = await root.getDirectoryHandle('proj', { create: true });
      const write = async (dir: FileSystemDirectoryHandle, name: string, text: string) => {
        const h = await dir.getFileHandle(name, { create: true });
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
        return h;
      };
      const src = await proj.getDirectoryHandle('src', { create: true });
      await write(src, 'main.rs', 'fn main() {}\n');
      const queue = [await write(root, 'fw.elf', '\x7fELF'), await write(root, 'cm.svd', '<device/>')];
      const w = window as unknown as Record<string, unknown>;
      w.showOpenFilePicker = async () => [queue.shift()];
      w.showDirectoryPicker = async () => proj;
    });

    await page.click('#pick-elf');
    await expect(page.locator('#elf-name')).toHaveText('fw.elf');
    await page.click('#pick-svd');
    await expect(page.locator('#svd-name')).toHaveText('cm.svd');
    await page.click('#pick-src');
    await expect(page.locator('#src-name')).toHaveText('proj/');
    const text = await page.evaluate(() => (window as unknown as { workbench: { source: { sources: { read(p: string): Promise<string | null> } } } }).workbench.source.sources.read('/home/user/proj/src/main.rs'));
    expect(text).toBe('fn main() {}\n');
    await expect.poll(storedKeys).toEqual(['workbench.elf', 'workbench.sources', 'workbench.svd']);

    await page.click('#forget');
    await expect.poll(storedKeys).toEqual([]);
    await expect(page.locator('#resume')).toBeHidden();
  });
});

test.describe('workbench layout sizing', () => {
  const sizes = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const d = (window as unknown as { dock: { getPanel(id: string): { group: { element: HTMLElement } } | undefined } }).dock;
    const rect = (id: string) => d.getPanel(id)!.group.element.getBoundingClientRect();
    const controls = document.querySelector('probe-core-controls')!.getBoundingClientRect();
    return { run: rect('controls'), source: rect('source'), console: rect('console'), controlsBottom: controls.bottom, dock: document.getElementById('dock')!.getBoundingClientRect() };
  });

  for (const [width, height] of [[1400, 900], [900, 560]] as const) {
    test(`default layout fits the Run panel to its controls at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/workbench/?fake=1&fresh=1');
      await expect.poll(async () => { const s = await sizes(page); return s.controlsBottom <= s.run.bottom + 0.5 && s.run.height < 200; }).toBe(true);
      const s = await sizes(page);
      // The controls are fully visible, the Run group is not much taller than them, the source keeps room.
      expect(s.run.bottom - s.controlsBottom).toBeLessThan(24);
      expect(s.source.height).toBeGreaterThan(s.dock.height * 0.3);
    });
  }

  test('a layout saved while the dock had no size is ignored; a restored layout fills the window', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/workbench/?fake=1&fresh=1');
    await page.waitForTimeout(600);
    const good = await page.evaluate(() => localStorage.getItem('probe-web.workbench.layout.v1'));
    expect(JSON.parse(good!).grid.height).toBeGreaterThan(200);

    // Tiny saved layout (as written from a background tab before this fix).
    await page.evaluate((json) => {
      const j = JSON.parse(json);
      j.grid.width = 100;
      j.grid.height = 100;
      localStorage.setItem('probe-web.workbench.layout.v1', JSON.stringify(j));
    }, good!);
    await page.goto('/workbench/?fake=1');
    await expect.poll(async () => (await sizes(page)).source.height).toBeGreaterThan(250);

    // A good saved layout restores and is laid out to the current (smaller) window.
    await page.evaluate((json) => localStorage.setItem('probe-web.workbench.layout.v1', json), good!);
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto('/workbench/?fake=1');
    await expect.poll(async () => { const s = await sizes(page); return Math.round(s.console.bottom); }).toBeGreaterThan(560);
    const s = await sizes(page);
    expect(s.console.bottom).toBeLessThanOrEqual(s.dock.bottom + 1);
  });
});

test.describe('config import', () => {
  test('an Embed.toml prefills the connection settings and is remembered', async ({ page }) => {
    await page.goto('/workbench/?fresh=1&fake=1');
    await page.locator('#dock').waitFor();

    await page.locator('#config-file').setInputFiles({
      name: 'Embed.toml',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        '[default.general]\nchip = "MCXA153"\n\n[default.probe]\nprotocol = "Jtag"\nserial = "ABC123"\n',
      ),
    });

    await expect(page.locator('#chip')).toHaveValue('MCXA153');
    await expect(page.locator('#probe')).toHaveValue('ABC123');
    await expect(page.locator('#protocol')).toHaveValue('Jtag');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Wb).workbench.consoleView.lines.join('\n')))
      .toContain('applied chip, probe, protocol');

    // Settings are persisted like any other change, so a reload keeps them.
    await page.reload();
    await expect(page.locator('#chip')).toHaveValue('MCXA153');
  });

  test('a launch.json with a remote section switches transport and reports the files it names', async ({ page }) => {
    await page.goto('/workbench/?fresh=1&fake=1');
    await page.locator('#dock').waitFor();

    await page.locator('#config-file').setInputFiles({
      name: 'launch.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        configurations: [{
          type: 'probe-rs-debug',
          chip: 'nRF9160_xxAA',
          wireProtocol: 'Swd',
          coreConfigs: [{ programBinary: 'target/debug/app', svdFile: 'nrf9160.svd' }],
        }],
      })),
    });

    await expect(page.locator('#chip')).toHaveValue('nRF9160_xxAA');
    // A browser cannot open a path, so it says what to pick rather than failing silently.
    const lines = () => page.evaluate(() => (window as unknown as Wb).workbench.consoleView.lines.join('\n'));
    await expect.poll(lines).toContain('names a ELF at target/debug/app');
    await expect.poll(lines).toContain('names a SVD at nrf9160.svd');
  });
});

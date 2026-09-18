import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The pack importer, running as a browser actually runs it.
 *
 * `cargo test` already covers the conversion itself against real vendor packs. What can
 * only be checked here is that the separate `probe-web-targets` wasm instantiates under
 * Chrome and that its errors arrive as `Error`s carrying a `kind` -- the contract the
 * target picker will switch on.
 */
// Playwright runs from the repo root; the specs are not an ES module context, so no
// `import.meta.url` here. The fixtures live under the flasher's public directory so the
// same files are reachable over HTTP for the `?pack=` flow.
const fixture = (name: string) =>
  Array.from(readFileSync(join('apps', 'flash', 'public', 'targets', name)));

test('imports a pack in the browser and reports typed faults', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));

  await page.goto('/?targets=1');
  await expect.poll(() => logs.some((l) => l.includes('TARGETS_READY'))).toBe(true);

  const pack = fixture('minimal.pack');

  const families = await page.evaluate(async (bytes) => {
    const t = (window as any).probeWebTargets;
    return await t.packToYaml(new Uint8Array(bytes));
  }, pack);

  expect(families).toHaveLength(1);
  expect(families[0].name).toBe('ProbeWebTest');
  expect(families[0].variants).toBe(1);
  // The YAML is what `chips/load` takes, so it has to name the chip.
  expect(families[0].yaml).toContain('ProbeWebTestChip');

  // Picking the wrong file is the common case; it has to be distinguishable.
  const fault = await page.evaluate(async () => {
    const t = (window as any).probeWebTargets;
    try {
      await t.packToYaml(new Uint8Array([1, 2, 3, 4]));
      return null;
    } catch (e: any) {
      return { kind: e.kind, message: String(e.message) };
    }
  });
  expect(fault?.kind).toBe('bad-archive');
  expect(fault?.message).toContain('.pack');

  const elfFault = await page.evaluate(async () => {
    const t = (window as any).probeWebTargets;
    try {
      await t.flmToYaml(new Uint8Array([1, 2, 3, 4]), 'x.FLM');
      return null;
    } catch (e: any) {
      return e.kind;
    }
  });
  expect(elfFault).toBe('bad-elf');
});

test('a chip imported from a pack can actually be attached to', async ({ page }) => {
  // `chips/load` puts the family in the worker's registry, and `Probe::attach` must use that
  // registry rather than only the built-in families, or an imported chip is listed but not
  // attachable (`ChipNotFound`). Listing it is not the test -- attaching to it is.
  test.slow();
  await page.goto(
    '/?auto=1&transport=webusb&fake=1&pack=/targets/minimal.pack&family=ProbeWebTest&chip=ProbeWebTestChip',
  );
  const log = page.locator('#log');
  await expect(log).toContainText(/pack: .*1\/1 family loaded/, { timeout: 45_000 });
  await expect(log).toContainText('ProbeWebTest (1 chips)');
  await expect(log).toContainText('attached: ProbeWebTestChip');
});

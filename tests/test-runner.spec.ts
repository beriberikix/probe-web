import { expect, test } from '@playwright/test';

/**
 * `<probe-test-runner>` against a stubbed session.
 *
 * The fake probe has a mocked core and cannot execute firmware, so `tests/*` cannot be
 * driven through it — the endpoints need a real target answering over semihosting. What
 * CI can check is the part that is ours: that the component lists, runs in order, and
 * reports each outcome the suite is designed to produce (pass, failure with a reason,
 * expected panic, ignored).
 */
test('lists, runs and reports every outcome', async ({ page }) => {
  await page.goto('/debug.html?fake=1');

  const summary = await page.evaluate(async () => {
    const el = document.createElement('probe-test-runner');
    const calls: string[] = [];
    const tests = [
      { name: 'arithmetic_works', expected_outcome: 'Pass', ignored: false, timeout: null, address: null },
      { name: 'panics_as_expected', expected_outcome: 'Panic', ignored: false, timeout: null, address: null },
      { name: 'breaks', expected_outcome: 'Pass', ignored: false, timeout: null, address: null },
      { name: 'skipped_entirely', expected_outcome: 'Pass', ignored: true, timeout: null, address: null },
    ];
    (el as unknown as { session: unknown }).session = {
      supports: (path: string) => path.startsWith('tests/'),
      listTests: async (_boot: unknown, onEvent: (e: unknown) => void) => {
        calls.push('list');
        onEvent({ kind: 'semihosting', stream: 'stdout', data: 'booting\n' });
        return { version: 1, tests };
      },
      runTest: async (t: { name: string }) => {
        calls.push(`run:${t.name}`);
        return t.name === 'breaks' ? { Failed: 'assertion failed: 1 == 2' } : 'Success';
      },
    };
    (el as unknown as { bootInfo: unknown }).bootInfo = { FromRam: null };
    document.body.append(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    await (el as unknown as { list(): Promise<void> }).list();
    await (el as unknown as { runAll(): Promise<void> }).runAll();
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    const row = (name: string) =>
      el.shadowRoot!.querySelector(`tr[data-test="${name}"]`)?.getAttribute('data-state');
    return {
      calls,
      arithmetic: row('arithmetic_works'),
      panics: row('panics_as_expected'),
      breaks: row('breaks'),
      skipped: row('skipped_entirely'),
      detail: el.shadowRoot!.querySelector('.detail')?.textContent,
      summary: el.shadowRoot!.querySelector('#summary')?.textContent,
      output: el.shadowRoot!.querySelector('output')?.textContent,
    };
  });

  // An ignored test is never run: that is the point of marking it.
  expect(summary.calls).toEqual(['list', 'run:arithmetic_works', 'run:panics_as_expected', 'run:breaks']);
  expect(summary.arithmetic).toBe('pass');
  // A test that is *expected* to panic and does is a pass, not a failure.
  expect(summary.panics).toBe('pass');
  expect(summary.breaks).toBe('fail');
  expect(summary.skipped).toBe('ignored');
  expect(summary.detail).toContain('assertion failed');
  expect(summary.summary).toContain('2 passed, 1 failed, 1 ignored of 4');
  // Console output from the target is shown, not swallowed.
  expect(summary.output).toContain('booting');
});

test('says so when the server has no test endpoints', async ({ page }) => {
  await page.goto('/debug.html?fake=1');
  const text = await page.evaluate(async () => {
    const el = document.createElement('probe-test-runner');
    (el as unknown as { session: unknown }).session = { supports: () => false };
    document.body.append(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    return el.shadowRoot!.textContent ?? '';
  });
  expect(text).toContain('does not provide the embedded-test endpoints');
});

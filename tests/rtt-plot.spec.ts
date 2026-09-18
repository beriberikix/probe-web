import { expect, test } from '@playwright/test';

/**
 * `<probe-rtt-plot>` fed raw bytes, the way the `rtt-bytes` event feeds it.
 *
 * The hardware check is the one that proves the whole path; this covers what can go wrong
 * in the browser regardless of the target: sample framing across reads, the rolling
 * window, and filtering by channel.
 */
test('plots samples from a binary channel, across split reads', async ({ page }) => {
  await page.goto('/debug.html?fake=1');

  const result = await page.evaluate(async () => {
    const el = document.createElement('probe-rtt-plot') as HTMLElement & {
      updateComplete: Promise<unknown>;
      channel: number;
      format: string;
      window: number;
      samples: readonly number[];
      push(channel: number, bytes: Uint8Array): void;
    };
    el.channel = 1;
    el.format = 'u32';
    el.window = 4;
    document.body.append(el);
    await el.updateComplete;

    // A sample split across two reads, which is what an RTT poll actually does.
    el.push(1, new Uint8Array([1, 0, 0]));
    const afterPartial = [...el.samples];
    el.push(1, new Uint8Array([0, 2, 0, 0, 0]));
    const afterRest = [...el.samples];

    // Another channel's bytes must not land in this trace.
    el.push(0, new Uint8Array([9, 9, 9, 9]));
    const afterOtherChannel = [...el.samples];

    // Overflow the window; the oldest samples are dropped.
    el.push(1, new Uint8Array([3, 0, 0, 0, 4, 0, 0, 0, 5, 0, 0, 0]));
    await el.updateComplete;

    return {
      afterPartial,
      afterRest,
      afterOtherChannel,
      windowed: [...el.samples],
      stat: el.shadowRoot!.querySelector('#stat')?.textContent ?? '',
      canvas: !!el.shadowRoot!.querySelector('canvas'),
    };
  });

  expect(result.afterPartial).toEqual([]);
  expect(result.afterRest).toEqual([1, 2]);
  expect(result.afterOtherChannel).toEqual([1, 2]);
  // window = 4, so 1 and 2 have rolled off the front.
  expect(result.windowed).toEqual([2, 3, 4, 5]);
  expect(result.stat).toContain('5 samples');
  expect(result.stat).toContain('last 5');
  expect(result.canvas).toBe(true);
});

test('changing the format re-reads the stream rather than mixing widths', async ({ page }) => {
  await page.goto('/debug.html?fake=1');
  const samples = await page.evaluate(async () => {
    const el = document.createElement('probe-rtt-plot') as HTMLElement & {
      updateComplete: Promise<unknown>; channel: number; format: string;
      samples: readonly number[]; push(c: number, b: Uint8Array): void;
    };
    el.channel = 1;
    el.format = 'u32';
    document.body.append(el);
    await el.updateComplete;
    el.push(1, new Uint8Array([1, 0, 0, 0]));
    el.format = 'u8';
    await el.updateComplete;
    el.push(1, new Uint8Array([7, 8]));
    return [...el.samples];
  });
  expect(samples).toEqual([7, 8]);
});

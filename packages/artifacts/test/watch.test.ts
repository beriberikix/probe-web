import { describe, expect, it, vi } from 'vitest';
import { watchFile, type FileHandleLike } from '../src/index';

function fakeHandle(initial: { data: string; lastModified: number }) {
  let cur = { ...initial };
  const handle: FileHandleLike = {
    name: 'app.elf',
    getFile: async () => ({
      name: 'app.elf',
      lastModified: cur.lastModified,
      size: cur.data.length,
      arrayBuffer: async () => new TextEncoder().encode(cur.data).buffer as ArrayBuffer,
    }),
  };
  return { handle, set: (data: string, lastModified: number) => (cur = { data, lastModified }) };
}

describe('watchFile', () => {
  it('does not fire for the file as picked, fires once per settled change', async () => {
    vi.useFakeTimers();
    const f = fakeHandle({ data: 'v1', lastModified: 1000 });
    const changes: string[] = [];
    const stop = watchFile(f.handle, (c) => changes.push(new TextDecoder().decode(c.bytes)), { intervalMs: 100, settleMs: 200 });
    await vi.advanceTimersByTimeAsync(350);
    expect(changes).toEqual([]);
    // A build writes in two steps 120 ms apart (inside the 200 ms settle window); only the final result is reported.
    f.set('v2-partial', 2000);
    await vi.advanceTimersByTimeAsync(120);
    f.set('v2', 2020);
    await vi.advanceTimersByTimeAsync(400);
    expect(changes).toEqual(['v2']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toEqual(['v2']);
    stop();
    vi.useRealTimers();
  });
});

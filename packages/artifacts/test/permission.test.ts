import { describe, expect, it } from 'vitest';
import { readPermission, restoreHandles, type PermissionHandleLike } from '../src/index.ts';

function handle(state: PermissionState, onRequest: PermissionState = 'granted') {
  const calls: string[] = [];
  const h: PermissionHandleLike = {
    name: 'fw.elf',
    queryPermission: async () => { calls.push('query'); return state; },
    requestPermission: async () => { calls.push('request'); state = onRequest; return onRequest; },
  };
  return { h, calls };
}

describe('readPermission', () => {
  it('is granted without asking when the browser still grants access', async () => {
    const { h, calls } = handle('granted');
    expect(await readPermission(h)).toBe(true);
    expect(calls).toEqual(['query']);
  });

  it('only checks by default (no user gesture needed)', async () => {
    const { h, calls } = handle('prompt');
    expect(await readPermission(h)).toBe(false);
    expect(calls).toEqual(['query']);
  });

  it('asks when requested and reports the answer', async () => {
    expect(await readPermission(handle('prompt', 'granted').h, { request: true })).toBe(true);
    expect(await readPermission(handle('prompt', 'denied').h, { request: true })).toBe(false);
  });

  it('treats handles without a permission API as readable and errors as not granted', async () => {
    expect(await readPermission({ name: 'x' })).toBe(true);
    expect(await readPermission({ name: 'x', queryPermission: async () => { throw new Error('gone'); } })).toBe(false);
  });
});

describe('restoreHandles', () => {
  const store = (entries: Record<string, unknown>) => {
    const map = new Map(Object.entries(entries));
    return {
      get: async (k: string) => map.get(k) ?? null,
      put: async (k: string, h: unknown) => { map.set(k, h); },
      delete: async (k: string) => { map.delete(k); },
      keys: async () => [...map.keys()],
    };
  };

  it('applies granted handles, reports the ones waiting for permission, skips missing ones', async () => {
    const applied: string[] = [];
    const s = store({ dir: handle('granted').h, elf: handle('prompt').h });
    const result = await restoreHandles(s, [
      { key: 'dir', apply: (h) => { applied.push(`dir:${h.name}`); } },
      { key: 'elf', apply: (h) => { applied.push(`elf:${h.name}`); } },
      { key: 'svd', apply: () => { applied.push('svd'); } },
    ]);
    expect(applied).toEqual(['dir:fw.elf']);
    expect(result).toEqual({ restored: ['dir'], waiting: [{ key: 'elf', name: 'fw.elf' }], failed: [] });
  });

  it('asks for permission when requested (the Reopen button) and applies what was granted', async () => {
    const granted = handle('prompt', 'granted');
    const denied = handle('prompt', 'denied');
    const s = store({ elf: granted.h, svd: denied.h });
    const applied: string[] = [];
    const result = await restoreHandles(s, [
      { key: 'elf', apply: () => { applied.push('elf'); } },
      { key: 'svd', apply: () => { applied.push('svd'); } },
    ], { request: true });
    expect(applied).toEqual(['elf']);
    expect(result.waiting).toEqual([{ key: 'svd', name: 'fw.elf' }]);
    expect(granted.calls).toEqual(['query', 'request']);
  });

  it('reports a handle that can no longer be read (file moved or deleted) without stopping', async () => {
    const s = store({ elf: handle('granted').h, svd: handle('granted').h });
    const result = await restoreHandles(s, [
      { key: 'elf', apply: () => { throw new Error('NotFoundError'); } },
      { key: 'svd', apply: () => {} },
    ]);
    expect(result.failed).toEqual([{ key: 'elf', name: 'fw.elf', error: 'NotFoundError' }]);
    expect(result.restored).toEqual(['svd']);
  });
});

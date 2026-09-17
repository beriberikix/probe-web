import { describe, expect, it } from 'vitest';
import { DirectorySourceProvider, UrlSourceProvider, matchSourcePath, type DirectoryHandleLike } from '../src/sources.ts';

describe('matchSourcePath', () => {
  it('matches on / boundaries, prefers the longest suffix, handles Windows separators', () => {
    const cands = ['main.rs', 'src/main.rs', 'other/src/main.rs', 'ain.rs'];
    expect(matchSourcePath('/home/ci/fw/src/main.rs', cands)).toBe('src/main.rs');
    expect(matchSourcePath('/home/ci/other/src/main.rs', cands)).toBe('other/src/main.rs');
    expect(matchSourcePath('C:\\build\\fw\\src\\main.rs', ['./src/main.rs'])).toBe('src/main.rs');
    expect(matchSourcePath('/x/domain.rs', ['main.rs'])).toBeNull();
  });
});

function dir(name: string, entries: Record<string, string | object>): DirectoryHandleLike {
  return {
    name,
    async *values() {
      for (const [n, v] of Object.entries(entries)) {
        if (typeof v === 'string') yield { kind: 'file', name: n, getFile: async () => ({ text: async () => v }) };
        else yield { kind: 'directory', name: n, ...(dir(n, v as Record<string, string | object>) as object) } as never;
      }
    },
  };
}

describe('source providers', () => {
  it('DirectorySourceProvider finds files by suffix and skips target/', async () => {
    const root = dir('fw', { src: { 'main.rs': 'fn main() {}' }, target: { 'main.rs': 'nope' }, '.git': { x: 'y' } });
    const p = new DirectorySourceProvider(root);
    expect(await p.resolve('/home/ci/fw/src/main.rs')).toBe('src/main.rs');
    expect(await p.read('/home/ci/fw/src/main.rs')).toBe('fn main() {}');
    expect(await p.read('/home/ci/fw/src/lib.rs')).toBeNull();
  });

  it('UrlSourceProvider maps the build prefix onto a base URL', async () => {
    const p = new UrlSourceProvider({ base: '/sources/fw', prefix: '/home/ci/fw' });
    expect(await p.resolve('/home/ci/fw/src/main.rs')).toBe('src/main.rs');
    expect(await p.resolve('/rustc/abc/library/core/src/lib.rs')).toBeNull();
  });
});

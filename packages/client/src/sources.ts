/**
 * Mapping DWARF source paths to source text in a browser.
 *
 * probe-rs reports locations with the absolute paths recorded at build time
 * (e.g. `/home/ci/fw/src/main.rs`), which do not exist where the debugger runs.
 * A `SourceProvider` finds the text another way: in a directory the user
 * picked (File System Access), or under a URL. Matching is by path suffix on
 * `/` boundaries, the same rule probe-rs uses for source breakpoints, so
 * `src/main.rs` in the workspace matches `/home/ci/fw/src/main.rs`.
 */

const norm = (p: string) => p.replace(/\\/g, '/');

/**
 * The candidate that is the longest `/`-boundary suffix of `path` (or equal to it).
 * Candidates are relative paths such as `src/main.rs`. Returns `null` if none match.
 */
export function matchSourcePath(path: string, candidates: Iterable<string>): string | null {
  const target = norm(path);
  let best: string | null = null;
  for (const c of candidates) {
    const cand = norm(c).replace(/^\.?\//, '');
    if (!cand) continue;
    const ok = target === cand || target.endsWith('/' + cand);
    if (ok && (best === null || cand.length > best.length)) best = cand;
  }
  return best;
}

/**
 * Finds source text for the DWARF paths probe-rs reports. Implemented by
 * {@link DirectorySourceProvider} and {@link UrlSourceProvider}; implement it yourself to serve
 * sources from anywhere else.
 */
export interface SourceProvider {
  /** Source text for a DWARF path, or `null` if this provider has no such file. */
  read(path: string): Promise<string | null>;
  /** The workspace-relative path a DWARF path maps to (for display and breakpoints), or `null`. */
  resolve(path: string): Promise<string | null>;
}

/**
 * Serve sources from a URL. `prefix` is the build-time directory that `base` corresponds to:
 * `{ base: '/src/fw/', prefix: '/home/ci/fw/' }` maps `/home/ci/fw/src/main.rs` to
 * `/src/fw/src/main.rs`. Paths outside `prefix` are not served.
 */
export class UrlSourceProvider implements SourceProvider {
  private readonly base: string;
  private readonly prefix: string;
  private readonly cache = new Map<string, Promise<string | null>>();

  /** `base`: the URL the sources are served under. `prefix`: the build-time directory it corresponds to. */
  constructor(opts: { base: string; prefix: string }) {
    this.base = opts.base.endsWith('/') ? opts.base : opts.base + '/';
    this.prefix = norm(opts.prefix).replace(/\/?$/, '/');
  }

  /** The path relative to `prefix`, or `null` if `path` is outside it. */
  async resolve(path: string): Promise<string | null> {
    const p = norm(path);
    return p.startsWith(this.prefix) ? p.slice(this.prefix.length) : null;
  }

  /** Fetch the file (once; results are cached). `null` if it is outside `prefix` or the fetch fails. */
  read(path: string): Promise<string | null> {
    let hit = this.cache.get(path);
    if (!hit) {
      hit = this.resolve(path).then(async (rel) => {
        if (rel === null) return null;
        const res = await fetch(this.base + rel.split('/').map(encodeURIComponent).join('/'));
        return res.ok ? res.text() : null;
      });
      this.cache.set(path, hit);
    }
    return hit;
  }
}

/** The parts of the File System Access directory handle API used here. */
export interface DirectoryHandleLike {
  /** The directory's name. */
  name: string;
  /** Its entries: files and subdirectories (as handles themselves). */
  values(): AsyncIterable<{ kind: 'file' | 'directory'; name: string } & Record<string, unknown>>;
}

/**
 * Serve sources from a directory the user picked (`showDirectoryPicker()`), matched by path suffix.
 * The tree is indexed once (skipping `target`, `node_modules` and dot-directories); call
 * `reindex()` after files are added.
 */
export class DirectorySourceProvider implements SourceProvider {
  private readonly root: DirectoryHandleLike;
  private readonly maxFiles: number;
  private index: Promise<Map<string, { getFile(): Promise<{ text(): Promise<string> }> }>> | null = null;
  /** Directory names never indexed (dot-directories are skipped as well). */
  static readonly SKIP = new Set(['target', 'node_modules', '.git']);

  /** `maxFiles` caps how many files are indexed (default 20 000), so picking a huge tree stays cheap. */
  constructor(root: DirectoryHandleLike, opts: { maxFiles?: number } = {}) {
    this.root = root;
    this.maxFiles = opts.maxFiles ?? 20_000;
  }

  /** Forget the index; the tree is walked again on the next lookup. */
  reindex(): void {
    this.index = null;
  }

  private build() {
    if (!this.index) {
      this.index = (async () => {
        const files = new Map<string, { getFile(): Promise<{ text(): Promise<string> }> }>();
        const walk = async (dir: DirectoryHandleLike, prefix: string) => {
          for await (const entry of dir.values()) {
            if (files.size >= this.maxFiles) return;
            if (entry.kind === 'directory') {
              if (DirectorySourceProvider.SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
              await walk(entry as unknown as DirectoryHandleLike, `${prefix}${entry.name}/`);
            } else {
              files.set(`${prefix}${entry.name}`, entry as unknown as { getFile(): Promise<{ text(): Promise<string> }> });
            }
          }
        };
        await walk(this.root, '');
        return files;
      })();
    }
    return this.index;
  }

  /** The workspace-relative file `path` maps to (see {@link matchSourcePath}), or `null`. */
  async resolve(path: string): Promise<string | null> {
    return matchSourcePath(path, (await this.build()).keys());
  }

  /** The text of the file `path` maps to, or `null` if none matches. */
  async read(path: string): Promise<string | null> {
    const files = await this.build();
    const rel = matchSourcePath(path, files.keys());
    if (rel === null) return null;
    return (await files.get(rel)!.getFile()).text();
  }
}

/**
 * @probe-web/artifacts — firmware images as inputs: pick a file once with the
 * File System Access API, keep the handle (persisted in IndexedDB so it
 * survives reloads), and watch it so a rebuild re-flashes without another
 * file dialog. Also plain sources: drag-drop files, URLs.
 */

export interface ArtifactSource {
  /** Stable name for caching/logs (file name or URL). */
  name: string;
  /** Read the current bytes. */
  bytes(): Promise<Uint8Array>;
  /** Watchable sources report changes; others resolve `null`. */
  watch?(onChange: (a: ArtifactChange) => void, opts?: WatchOptions): () => void;
}

export interface ArtifactChange {
  name: string;
  bytes: Uint8Array;
  lastModified: number;
  size: number;
}

export interface WatchOptions {
  /** Poll interval in ms (the File System Access API has no change events). */
  intervalMs?: number;
  /** Debounce: wait until the file stops changing for this long (build tools write in steps). */
  settleMs?: number;
}

export function hasFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

/** Minimal shape of the parts of FileSystemFileHandle we use, for tests. */
export interface FileHandleLike {
  name: string;
  getFile(): Promise<{ name: string; lastModified: number; size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  queryPermission?(d: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'read' }): Promise<PermissionState>;
}

/** A file picked with the File System Access API; watchable. */
export class FileArtifact implements ArtifactSource {
  constructor(readonly handle: FileHandleLike) {}
  get name() { return this.handle.name; }

  /** True when read permission is already granted (no user gesture needed). */
  async hasPermission(): Promise<boolean> {
    if (!this.handle.queryPermission) return true;
    return (await this.handle.queryPermission({ mode: 'read' })) === 'granted';
  }

  /** Re-acquire read permission after a reload (needs a user gesture if not granted). */
  async ensurePermission(): Promise<boolean> {
    if (!this.handle.queryPermission) return true;
    if ((await this.handle.queryPermission({ mode: 'read' })) === 'granted') return true;
    return (await this.handle.requestPermission?.({ mode: 'read' })) === 'granted';
  }

  async bytes(): Promise<Uint8Array> {
    const f = await this.handle.getFile();
    return new Uint8Array(await f.arrayBuffer());
  }

  watch(onChange: (a: ArtifactChange) => void, opts: WatchOptions = {}): () => void {
    return watchFile(this.handle, onChange, opts);
  }
}

/** Poll a file handle's `lastModified`/`size`; fire once the file has settled. */
export function watchFile(handle: FileHandleLike, onChange: (a: ArtifactChange) => void, opts: WatchOptions = {}): () => void {
  const interval = opts.intervalMs ?? 500;
  const settle = opts.settleMs ?? 300;
  let last: { lastModified: number; size: number } | null = null;
  let pendingSince = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const f = await handle.getFile();
      const cur = { lastModified: f.lastModified, size: f.size };
      if (last === null) {
        last = cur; // baseline: the file as picked
      } else if (cur.lastModified !== last.lastModified || cur.size !== last.size) {
        if (!pendingSince) pendingSince = Date.now();
        // Keep sampling until it stops changing for `settle` ms.
        const stable = await waitStable(handle, cur, settle);
        if (stable) {
          last = { lastModified: stable.lastModified, size: stable.size };
          pendingSince = 0;
          onChange({ name: f.name, bytes: new Uint8Array(await stable.arrayBuffer()), lastModified: stable.lastModified, size: stable.size });
        }
      }
    } catch {
      // Permission revoked or file gone: keep polling; the next successful read re-baselines.
      last = null;
    }
    if (!stopped) timer = setTimeout(tick, interval);
  };
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function waitStable(handle: FileHandleLike, seen: { lastModified: number; size: number }, settle: number) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, settle));
    const f = await handle.getFile();
    if (f.lastModified === seen.lastModified && f.size === seen.size) return f;
    seen = { lastModified: f.lastModified, size: f.size };
  }
  return null;
}

/** Open the file picker (user gesture required). */
export async function pickFile(opts: { description?: string; extensions?: string[] } = {}): Promise<FileArtifact> {
  if (!hasFileSystemAccess()) throw new Error('File System Access API is not available in this browser');
  const w = window as unknown as { showOpenFilePicker(o: unknown): Promise<FileHandleLike[]> };
  const [handle] = await w.showOpenFilePicker({
    multiple: false,
    types: [{ description: opts.description ?? 'Firmware image', accept: { 'application/octet-stream': opts.extensions ?? ['.elf', '.hex', '.bin', '.uf2', '.axf'] } }],
  });
  return new FileArtifact(handle);
}

/** A `File` from drag-drop or `<input type=file>`; not watchable. */
export function fromFile(file: File): ArtifactSource {
  return { name: file.name, bytes: async () => new Uint8Array(await file.arrayBuffer()) };
}

/** A URL; re-fetched on every `bytes()`. */
export function fromUrl(url: string): ArtifactSource {
  return {
    name: url,
    bytes: async () => {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

// ---- handle persistence (IndexedDB stores FileSystemFileHandle objects) ----

const DB = 'probe-web-artifacts';
const STORE = 'handles';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Remember a picked handle under `key` (e.g. the manifest name). */
export async function rememberHandle(key: string, handle: FileHandleLike): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Restore a remembered handle; `null` if none. Call `ensurePermission()` before reading. */
export async function recallHandle(key: string): Promise<FileArtifact | null> {
  try {
    const db = await openDb();
    const handle = await new Promise<FileHandleLike | undefined>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return handle ? new FileArtifact(handle) : null;
  } catch {
    return null;
  }
}

export async function forgetHandle(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
  });
}

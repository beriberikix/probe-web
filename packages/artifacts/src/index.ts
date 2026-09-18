/**
 * Firmware images as inputs: pick a file once with the File System Access
 * API, keep the handle (persisted in IndexedDB so it survives reloads), and
 * watch it so a rebuild re-flashes without another file dialog. Also plain
 * sources (drag-dropped files, URLs) and {@link downloadBytes} for handing a
 * file back to the user.
 *
 * The file picker and handle persistence need the File System Access API
 * (Chromium-based desktop browsers; check {@link hasFileSystemAccess}), and
 * {@link pickFile} must run in a user gesture.
 *
 * @example
 * ```ts
 * import { pickFile } from '@probe-web/artifacts';
 *
 * button.onclick = async () => {
 *   const artifact = await pickFile({ extensions: ['.elf'] }); // user gesture: opens the picker
 *   await flash(await artifact.bytes());
 *   // Poll the file; flash again after each rebuild, once the file has stopped changing.
 *   const stop = artifact.watch((change) => void flash(change.bytes));
 * };
 * ```
 *
 * @packageDocumentation
 */

/** A firmware image that can be read, and possibly watched, whatever it came from. */
export interface ArtifactSource {
  /** Stable name for caching/logs (file name or URL). */
  name: string;
  /** Read the current bytes. */
  bytes(): Promise<Uint8Array>;
  /**
   * Call `onChange` with the new contents whenever the source changes; returns
   * a function that stops watching. Only watchable sources (a
   * {@link FileArtifact}) have it.
   */
  watch?(onChange: (a: ArtifactChange) => void, opts?: WatchOptions): () => void;
}

/** A new version of a watched file, passed to the `watch` callback. */
export interface ArtifactChange {
  /** File name. */
  name: string;
  /** The file's full contents after the change. */
  bytes: Uint8Array;
  /** Modification time, in ms since the epoch. */
  lastModified: number;
  /** Size in bytes. */
  size: number;
}

/** Polling options for {@link watchFile} and {@link FileArtifact.watch}. */
export interface WatchOptions {
  /** Poll interval in ms (the File System Access API has no change events). Default 500. */
  intervalMs?: number;
  /** Debounce: wait until the file stops changing for this long, in ms (build tools write in steps). Default 300. */
  settleMs?: number;
}

/** True when the File System Access API's file picker (`showOpenFilePicker`) is available. */
export function hasFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

/** Minimal shape of the parts of FileSystemFileHandle we use, for tests. */
export interface FileHandleLike {
  /** File name. */
  name: string;
  /** Snapshot of the file's current contents and metadata. */
  getFile(): Promise<{ name: string; lastModified: number; size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  /** Current read permission, without prompting. */
  queryPermission?(d: { mode: 'read' }): Promise<PermissionState>;
  /** Ask the user for read permission (needs a user gesture). */
  requestPermission?(d: { mode: 'read' }): Promise<PermissionState>;
}

/** A file picked with the File System Access API; watchable. */
export class FileArtifact implements ArtifactSource {
  /**
   * Wrap a file handle, e.g. one from `showOpenFilePicker` or a drag-drop.
   *
   * @param handle The underlying file handle; pass it to {@link rememberHandle} to keep it across reloads.
   */
  constructor(readonly handle: FileHandleLike) {}
  /** The file's name. */
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

  /** Read the file's current contents. */
  async bytes(): Promise<Uint8Array> {
    const f = await this.handle.getFile();
    return new Uint8Array(await f.arrayBuffer());
  }

  /** Watch the file for changes with {@link watchFile}; returns a function that stops watching. */
  watch(onChange: (a: ArtifactChange) => void, opts: WatchOptions = {}): () => void {
    return watchFile(this.handle, onChange, opts);
  }
}

/**
 * Poll a file handle's `lastModified`/`size`; fire once the file has settled.
 * The first read is the baseline and does not fire. If a read fails (permission
 * revoked, file gone) polling continues and the next successful read becomes
 * the new baseline. Returns a function that stops polling.
 */
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

/**
 * Open the file picker (user gesture required) for one firmware image. By
 * default it offers `.elf`, `.hex`, `.bin`, `.uf2` and `.axf`; `extensions`
 * replaces that list and `description` labels it. Rejects if the API is
 * missing or the user cancels.
 */
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

/** A handle whose read permission can be queried and requested (file or directory handle). */
export interface PermissionHandleLike {
  /** File or directory name. */
  name: string;
  /** Current read permission, without prompting. */
  queryPermission?(d: { mode: 'read' }): Promise<PermissionState>;
  /** Ask the user for read permission (needs a user gesture). */
  requestPermission?(d: { mode: 'read' }): Promise<PermissionState>;
}

/**
 * Read permission for a restored handle. With `request: false` only checks (safe without a user
 * gesture); with `request: true` asks the user, which must run inside a user gesture.
 */
export async function readPermission(handle: PermissionHandleLike, opts: { request?: boolean } = {}): Promise<boolean> {
  if (!handle.queryPermission) return true;
  try {
    if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
    if (!opts.request) return false;
    return (await handle.requestPermission?.({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Remember a picked handle under `key` (e.g. the manifest name). Any `FileSystemHandle` works,
 * directories included; the object must be a real handle (IndexedDB structured-clones it).
 */
export async function rememberHandle(key: string, handle: FileHandleLike | PermissionHandleLike): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Restore a remembered file handle; `null` if none. Call {@link FileArtifact.ensurePermission} before reading. */
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

/** Restore a remembered handle of any kind (e.g. a directory handle); `null` if none. */
export async function recallRawHandle<T = unknown>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise<T | null>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** Delete the handle remembered under `key`, if any. */
export async function forgetHandle(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
  });
}

// ---- restoring a set of remembered handles ----

/** Where handles are kept; `indexedDbHandleStore` in browsers, a map in tests. */
export interface HandleStore {
  /** The handle stored under `key`, or `null` / `undefined` if none. */
  get(key: string): Promise<unknown>;
  /** Store `handle` under `key`, replacing any previous one. */
  put(key: string, handle: unknown): Promise<void>;
  /** Remove the handle stored under `key`. */
  delete(key: string): Promise<void>;
  /** Every stored key. */
  keys(): Promise<string[]>;
}

/**
 * The {@link HandleStore} used in browsers: the same IndexedDB store as
 * {@link rememberHandle}, {@link recallRawHandle} and {@link forgetHandle}.
 */
export const indexedDbHandleStore: HandleStore = {
  get: (key) => recallRawHandle(key),
  put: (key, handle) => rememberHandle(key, handle as PermissionHandleLike),
  delete: (key) => forgetHandle(key),
  async keys() {
    try {
      const db = await openDb();
      return await new Promise<string[]>((resolve, reject) => {
        const req = db.transaction(STORE).objectStore(STORE).getAllKeys();
        req.onsuccess = () => resolve(req.result.map(String));
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  },
};

/** One handle for {@link restoreHandles} to restore, and what to do with it. */
export interface RestoreEntry<H extends PermissionHandleLike = PermissionHandleLike> {
  /** Key the handle was stored under. */
  key: string;
  /** Use the restored handle (read the file, index the folder, …). */
  apply(handle: H): Promise<void> | void;
}

/** Outcome of {@link restoreHandles}. Keys with nothing stored appear in none of the lists. */
export interface RestoreResult {
  /** Keys whose handle was applied. */
  restored: string[];
  /** Handles that still need read permission (ask inside a user gesture with `request: true`). */
  waiting: { key: string; name: string }[];
  /** Handles that could not be used (file moved or deleted, …). */
  failed: { key: string; name: string; error: string }[];
}

/**
 * Restore remembered handles in order. Without `request` nothing prompts, so it is safe on page
 * load; with it, each missing permission is requested (call from a click handler). A typical page
 * calls it once on load, then again with `request: true` from a button when
 * {@link RestoreResult.waiting} is not empty.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function restoreHandles(store: HandleStore, entries: RestoreEntry<any>[], opts: { request?: boolean } = {}): Promise<RestoreResult> {
  const result: RestoreResult = { restored: [], waiting: [], failed: [] };
  for (const entry of entries) {
    const handle = (await store.get(entry.key).catch(() => null)) as PermissionHandleLike | null;
    if (!handle) continue;
    if (!(await readPermission(handle, opts))) {
      result.waiting.push({ key: entry.key, name: handle.name });
      continue;
    }
    try {
      await entry.apply(handle);
      result.restored.push(entry.key);
    } catch (e) {
      result.failed.push({ key: entry.key, name: handle.name, error: (e as Error).message ?? String(e) });
    }
  }
  return result;
}

/**
 * Hand the user a file, e.g. a coredump or an exported memory region, as a download named
 * `name`.
 *
 * There is no `showSaveFilePicker` here on purpose: it is Chromium-only and needs a user gesture,
 * whereas an object URL works wherever the rest of this does, including inside the
 * sandboxed frame the tests run in.
 *
 * The URL is revoked on the next task rather than immediately, because revoking it in the
 * same tick can cancel the download in some browsers.
 */
export function downloadBytes(name: string, bytes: Uint8Array | ArrayBuffer, type = 'application/octet-stream'): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

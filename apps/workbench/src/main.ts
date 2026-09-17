// probe-web workbench: flash + debug in one page. The source view talks DAP to an
// inline ProbeDebugAdapter; the other panels are @probe-web/ui components on the
// same Debugger. Query flags: ?fake=1 (scripted FakeDebugger, for tests),
// ?auto=1&token=…&probe=…&chip=…&elf=/firmware/….elf&bp=40 (hardware check).
import 'dockview/dist/styles/dockview.css';
import '@probe-web/ui';
import { createDockview, type DockviewApi, type IContentRenderer } from 'dockview';
import type { DebugProtocol as DP } from '@vscode/debugprotocol';
import { Client, DirectorySourceProvider, elfHasRtt, openSession, UrlSourceProvider, type Debugger, type DirectoryHandleLike, type Session, type SourceProvider } from '@probe-web/client';
import { describe, hasWebUsb, requestProbe } from '@probe-web/devices';
import { FakeDebugger } from '@probe-web/client/testing';
import { ProbeDebugAdapter, type DebuggerLike } from '@probe-web/dap';
import { FileArtifact, hasFileSystemAccess, indexedDbHandleStore, pickFile, restoreHandles, type FileHandleLike, type PermissionHandleLike, type RestoreEntry } from '@probe-web/artifacts';
import { DapClient } from './dap-client.ts';
import { SourceView } from './source-view.ts';
import { ConsoleView } from './console-view.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const qs = new URLSearchParams(location.search);
const LAYOUT_KEY = 'probe-web.workbench.layout.v1';
const SETTINGS_KEY = 'probe-web.workbench.settings.v1';

// ------------------------------------------------------------------ panels

const source = new SourceView();
const consoleView = new ConsoleView();
const log = (m: string, color?: 'gray' | 'red' | 'green' | 'cyan') => { consoleView.writeln(m, color); console.log('[workbench] ' + m); };

/** Component panels: tag name per dockview component name. */
const COMPONENTS: Record<string, { tag: string; title: string }> = {
  controls: { tag: 'probe-core-controls', title: 'Run' },
  callstack: { tag: 'probe-callstack', title: 'Call stack' },
  variables: { tag: 'probe-variables', title: 'Variables' },
  registers: { tag: 'probe-registers', title: 'Registers' },
  breakpoints: { tag: 'probe-breakpoints', title: 'Breakpoints' },
  disassembly: { tag: 'probe-disassembly', title: 'Disassembly' },
  memory: { tag: 'probe-memory-view', title: 'Memory' },
  peripherals: { tag: 'probe-peripherals', title: 'Peripherals' },
};
const elements = new Map<string, HTMLElement & { debugger: Debugger | null }>();
let currentDebugger: Debugger | null = null;

function createComponent(options: { id: string; name: string }): IContentRenderer {
  if (options.name === 'source') return { element: source.element, init: () => {} };
  if (options.name === 'console') return { element: consoleView.element, init: () => {} };
  const spec = COMPONENTS[options.name];
  const wrapper = document.createElement('div');
  wrapper.className = 'panel';
  if (spec) {
    const el = document.createElement(spec.tag) as HTMLElement & { debugger: Debugger | null };
    el.debugger = currentDebugger;
    elements.set(options.name, el);
    wrapper.append(el);
  }
  return { element: wrapper, init: () => {} };
}

function defaultLayout(api: DockviewApi) {
  api.clear();
  api.addPanel({ id: 'source', component: 'source', title: 'Source', renderer: 'always' });
  api.addPanel({ id: 'controls', component: 'controls', title: 'Run', position: { referencePanel: 'source', direction: 'above' } });
  api.addPanel({ id: 'callstack', component: 'callstack', title: 'Call stack', position: { referencePanel: 'source', direction: 'right' } });
  api.addPanel({ id: 'variables', component: 'variables', title: 'Variables', position: { referencePanel: 'callstack', direction: 'below' } });
  api.addPanel({ id: 'peripherals', component: 'peripherals', title: 'Peripherals', position: { referencePanel: 'variables', direction: 'within' } });
  api.addPanel({ id: 'console', component: 'console', title: 'Console', renderer: 'always', position: { referencePanel: 'source', direction: 'below' } });
  api.addPanel({ id: 'breakpoints', component: 'breakpoints', title: 'Breakpoints', position: { referencePanel: 'console', direction: 'within' } });
  api.addPanel({ id: 'disassembly', component: 'disassembly', title: 'Disassembly', position: { referencePanel: 'console', direction: 'within' } });
  api.addPanel({ id: 'memory', component: 'memory', title: 'Memory', position: { referencePanel: 'console', direction: 'within' } });
  api.addPanel({ id: 'registers', component: 'registers', title: 'Registers', position: { referencePanel: 'variables', direction: 'right' } });
  api.getPanel('console')?.api.setActive();
  api.getPanel('variables')?.api.setActive();
  void whenDockHasSize().then(() => {
    fitDock();
    const height = $('dock').clientHeight;
    api.getPanel('console')?.group.api.setSize({ height: Math.round(Math.min(260, height * 0.3)) });
    api.getPanel('callstack')?.group.api.setSize({ width: Math.round(Math.min(520, $('dock').clientWidth * 0.4)) });
    fitRunPanel(api);
  });
}

/** Resolves once the dock element has a real size (not while the tab is hidden or before CSS applies). */
function whenDockHasSize(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => ($('dock').clientWidth >= MIN_DOCK && $('dock').clientHeight >= MIN_DOCK ? resolve() : requestAnimationFrame(check));
    check();
  });
}
const MIN_DOCK = 200;

/** Lay dockview out to the dock element's current size (a restored layout keeps its saved size otherwise). */
function fitDock() {
  const el = $('dock');
  if (el.clientWidth >= MIN_DOCK && el.clientHeight >= MIN_DOCK) dock.layout(el.clientWidth, el.clientHeight, true);
}

/** Size the Run group to its content: the tab header plus the controls, which wrap in narrow panels. */
function fitRunPanel(api: DockviewApi) {
  const panel = api.getPanel('controls');
  const content = elements.get('controls');
  if (!panel || !content) return;
  const header = panel.group.element.querySelector('.dv-tabs-and-actions-container') as HTMLElement | null;
  const wrapperPadding = 12; // .panel padding (6px top and bottom)
  const wanted = (header?.offsetHeight ?? 35) + content.getBoundingClientRect().height + wrapperPadding;
  panel.group.api.setSize({ height: Math.round(Math.max(72, Math.min(wanted, 220))) });
}

const dock: DockviewApi = createDockview($('dock'), { createComponent, className: 'dockview-theme-light' });
(window as unknown as { dock: DockviewApi }).dock = dock;
function restoreLayout() {
  if (qs.has('fresh')) { defaultLayout(dock); return; }
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    const layout = saved ? JSON.parse(saved) : null;
    // A layout saved while the dock had no real size (a background tab) would restore as tiny groups.
    if (layout && layout.grid?.width >= MIN_DOCK && layout.grid?.height >= MIN_DOCK) {
      dock.fromJSON(layout);
      void whenDockHasSize().then(fitDock);
      // Source and console are single instances created outside dockview; make sure they exist.
      if (!dock.getPanel('source') || !dock.getPanel('console')) defaultLayout(dock);
      return;
    }
  } catch {
    /* fall through to the default */
  }
  defaultLayout(dock);
}
restoreLayout();
let saveTimer = 0;
dock.onDidLayoutChange(() => {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (document.hidden || $('dock').clientWidth < MIN_DOCK || $('dock').clientHeight < MIN_DOCK) return;
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(dock.toJSON())); } catch { /* storage unavailable */ }
  }, 300);
});
$('reset-layout').onclick = () => {
  try { localStorage.removeItem(LAYOUT_KEY); } catch { /* ignore */ }
  defaultLayout(dock);
};

// ------------------------------------------------------------------ settings

const inputs = ['transport', 'url', 'token', 'probe', 'chip', 'protocol'] as const;
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, string>;
  for (const k of inputs) if (saved[k]) $<HTMLInputElement>(k).value = saved[k];
} catch { /* ignore */ }
for (const k of inputs) if (qs.get(k)) $<HTMLInputElement>(k).value = qs.get(k)!;
const saveSettings = () => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(Object.fromEntries(inputs.map((k) => [k, $<HTMLInputElement>(k).value])))); } catch { /* ignore */ }
};

/** WebUSB runs probe-rs in this page, so the server fields do not apply and a probe must be granted. */
function applyTransport() {
  const webusb = $<HTMLSelectElement>('transport').value === 'webusb';
  for (const id of ['url', 'token']) $<HTMLInputElement>(id).hidden = webusb;
  $<HTMLButtonElement>('pick-probe').hidden = !webusb;
}
$('transport').onchange = () => { applyTransport(); saveSettings(); };
applyTransport();

$('pick-probe').onclick = async () => {
  if (!hasWebUsb()) { log('this browser has no WebUSB (Chromium only); use the WebSocket transport', 'red'); return; }
  try {
    const device = await requestProbe({ any: true });
    const probe = describe(device);
    $<HTMLInputElement>('probe').value = probe.serial || probe.label;
    saveSettings();
    log(`probe granted: ${probe.label}${probe.serial ? ` (${probe.serial})` : ''}`, 'gray');
  } catch {
    /* the chooser was dismissed */
  }
};

// ------------------------------------------------------------------ sources, program, SVD

// In development the sources are reachable through Vite's /@fs/ route (inside server.fs.allow).
/** Tries each provider in turn, so a shipped demo and a dev checkout can both resolve. */
function firstOf(...providers: SourceProvider[]): SourceProvider {
  return {
    async resolve(path) {
      for (const p of providers) {
        const hit = await p.resolve(path);
        if (hit !== null) return hit;
      }
      return null;
    },
    async read(path) {
      for (const p of providers) {
        const text = await p.read(path);
        if (text !== null) return text;
      }
      return null;
    },
  };
}

// The demo firmware is built with its paths remapped to /probe-web-firmware/ and its sources
// shipped next to the images (scripts/build-firmware.sh), so the deployed workbench shows code
// without the visitor having a checkout. Otherwise: Vite's /@fs/ route in development, or the
// folder picked with Sources….
let sources: SourceProvider = firstOf(
  new UrlSourceProvider({
    base: new URL('firmware/src/', document.baseURI).href,
    prefix: '/probe-web-firmware/',
  }),
  new UrlSourceProvider({ base: qs.get('srcBase') ?? '/@fs/', prefix: qs.get('srcPrefix') ?? '/' }),
);
source.sources = sources;
// Picked files and the source folder are remembered in IndexedDB (File System Access handles) and
// offered again after a reload: silently if the browser still grants read access, otherwise
// behind a "Resume" button (asking for permission needs a user gesture).
const HANDLE_KEYS = { elf: 'workbench.elf', svd: 'workbench.svd', sources: 'workbench.sources' } as const;
const handleStore = indexedDbHandleStore;
type DirHandle = DirectoryHandleLike & PermissionHandleLike;

function useSources(dir: DirHandle) {
  sources = new DirectorySourceProvider(dir);
  source.sources = sources;
  $('src-name').textContent = `${dir.name}/`;
  log(`sources: ${dir.name}/`, 'gray');
}

$('pick-src').onclick = async () => {
  const picker = (window as unknown as { showDirectoryPicker?: () => Promise<DirHandle> }).showDirectoryPicker;
  if (!picker) { log('this browser has no directory picker (File System Access)', 'red'); return; }
  let dir: DirHandle;
  try { dir = await picker(); } catch { return; /* cancelled */ }
  useSources(dir);
  void handleStore.put(HANDLE_KEYS.sources, dir).catch((e) => log(`could not remember: ${(e as Error).message}`, 'red'));
};

let elf: { bytes: Uint8Array; name: string } | null = null;
let artifact: FileArtifact | null = null;
let stopWatching: (() => void) | null = null;

async function useElf(a: FileArtifact) {
  artifact = a;
  elf = { bytes: await a.bytes(), name: a.name };
  $('elf-name').textContent = a.name;
  stopWatching?.();
  stopWatching = a.watch(() => void reflash());
}

$('pick-elf').onclick = async () => {
  let a: FileArtifact;
  try { a = await pickFile({ description: 'ELF', extensions: ['.elf', '.axf', '.out'] }); } catch { return; /* cancelled */ }
  await useElf(a);
  void handleStore.put(HANDLE_KEYS.elf, a.handle).catch((e) => log(`could not remember: ${(e as Error).message}`, 'red'));
};

let svd: { bytes: Uint8Array; name: string } | null = null;

async function useSvd(file: { name: string; bytes: Uint8Array }) {
  svd = file;
  $('svd-name').textContent = file.name;
  if (currentDebugger) await (elements.get('peripherals') as unknown as { loadSvd(b: Uint8Array, n: string): Promise<void> })?.loadSvd(svd.bytes, svd.name);
}

$('pick-svd').onclick = async () => {
  if (hasFileSystemAccess()) {
    let a: FileArtifact;
    try { a = await pickFile({ description: 'SVD', extensions: ['.svd', '.xml'] }); } catch { return; /* cancelled */ }
    await useSvd({ name: a.name, bytes: await a.bytes() });
    void handleStore.put(HANDLE_KEYS.svd, a.handle).catch((e) => log(`could not remember: ${(e as Error).message}`, 'red'));
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.svd,.xml';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (f) await useSvd({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  };
  input.click();
};

/** Remembered handles, directory first (each permission prompt needs the click still active). */
const restoreEntries: RestoreEntry<any>[] = [
  { key: HANDLE_KEYS.sources, apply: (dir: DirHandle) => { if (!$('src-name').textContent) useSources(dir); } },
  { key: HANDLE_KEYS.elf, apply: async (h: FileHandleLike) => { if (!elf) await useElf(new FileArtifact(h)); } },
  { key: HANDLE_KEYS.svd, apply: async (h: FileHandleLike) => { if (!svd) { const a = new FileArtifact(h); await useSvd({ name: a.name, bytes: await a.bytes() }); } } },
];

async function reopen(request: boolean) {
  const result = await restoreHandles(handleStore, restoreEntries, { request });
  for (const f of result.failed) log(`could not reopen ${f.name}: ${f.error}`, 'red');
  const button = $<HTMLButtonElement>('resume');
  button.hidden = result.waiting.length === 0;
  button.textContent = `Reopen ${result.waiting.map((w) => (w.key === HANDLE_KEYS.sources ? `${w.name}/` : w.name)).join(', ')}`;
  button.title = 'Reopen the ELF, SVD and source folder from the last session (the browser asks for read access)';
  if (request && result.waiting.length) log(`read access not granted for ${result.waiting.map((w) => w.name).join(', ')}`, 'red');
}

$('resume').onclick = () => void reopen(true);

$('forget').onclick = async () => {
  await Promise.all(Object.values(HANDLE_KEYS).map((k) => handleStore.delete(k).catch(() => {})));
  $<HTMLButtonElement>('resume').hidden = true;
  log('forgot the remembered ELF, SVD and source folder', 'gray');
};

if (qs.has('fresh')) {
  void Promise.all(Object.values(HANDLE_KEYS).map((k) => handleStore.delete(k).catch(() => {})));
  // Apply `fresh` once: a later reload (including a dev-server reload) must not clear again.
  const url = new URL(location.href);
  url.searchParams.delete('fresh');
  history.replaceState(history.state, '', url);
} else if (!qs.has('auto')) {
  void reopen(false);
}

// ------------------------------------------------------------------ session

let dap: DapClient | null = null;
let session: Session | null = null;
let client: Client | null = null;
let unsubscribe: (() => void)[] = [];

function setStatus(text: string) {
  $('status').textContent = text;
}

function useDebugger(d: Debugger | null) {
  currentDebugger = d;
  for (const el of elements.values()) el.debugger = d;
  if (d) d.addEventListener('breakpoints', () => renderBreakpointGlyphs());
}

function renderBreakpointGlyphs() {
  const d = currentDebugger;
  if (!d || !source.path) { source.setBreakpoints([]); return; }
  const here = source.path;
  const marks = d.breakpoints()
    .filter((b) => inFile(b, here))
    .map((b) => ({ line: b.source?.line ?? b.line ?? 0, verified: b.verified }))
    .filter((m) => m.line > 0);
  source.setBreakpoints(marks);
}

/** Whether a source breakpoint belongs to the file at DWARF path `file` (requested by that path or a suffix of it). */
function inFile(b: { kind: string; path: string | null; source: { path: string } | null }, file: string): boolean {
  if (b.kind !== 'source') return false;
  if (b.source?.path === file) return true;
  const rel = (b.path ?? '').replace(/\\/g, '/').replace(/^\.?\//, '');
  return !!rel && (file === rel || file.replace(/\\/g, '/').endsWith('/' + rel));
}

/**
 * Toggle a breakpoint from the gutter. DAP sets breakpoints per requested path, and the same file
 * may have breakpoints requested under different paths (e.g. `src/main.rs` from the Breakpoints
 * panel and the absolute DWARF path from the gutter), so each affected request path is updated.
 */
source.onToggleBreakpoint = async (path, line) => {
  if (!dap || !currentDebugger) return;
  const here = currentDebugger.breakpoints().filter((b) => inFile(b, path));
  const byRequest = new Map<string, number[]>();
  for (const b of here) byRequest.set(b.path!, [...(byRequest.get(b.path!) ?? []), b.line!]);
  const atLine = here.filter((b) => (b.source?.line ?? b.line) === line);
  const updates = new Map<string, number[]>();
  if (atLine.length) {
    for (const b of atLine) updates.set(b.path!, byRequest.get(b.path!)!.filter((l) => l !== b.line));
  } else {
    updates.set(path, [...(byRequest.get(path) ?? []), line]);
  }
  try {
    for (const [requestPath, lines] of updates) {
      const res = await dap.request<DP.SetBreakpointsResponse>('setBreakpoints', { source: { path: requestPath }, breakpoints: lines.map((l) => ({ line: l })) });
      const bad = res.body.breakpoints.filter((b) => !b.verified);
      if (bad.length) log(`breakpoint not set: ${bad.map((b) => b.message).join('; ')}`, 'red');
    }
  } catch (e) {
    log(`setBreakpoints: ${(e as Error).message}`, 'red');
  }
  renderBreakpointGlyphs();
};

async function showTopFrame() {
  if (!dap) return;
  try {
    const st = await dap.request<DP.StackTraceResponse>('stackTrace', { threadId: 1, levels: 30 });
    const frame = st.body.stackFrames.find((f) => f.source?.path && f.presentationHint !== 'subtle')
      ?? st.body.stackFrames.find((f) => f.source?.path);
    if (frame?.source?.path) {
      await source.show(frame.source.path, frame.line);
      dock.getPanel('source')?.api.setTitle(source.title);
    }
    renderBreakpointGlyphs();
  } catch (e) {
    log(`stackTrace: ${(e as Error).message}`, 'red');
  }
}

/** The fake-probe worker. Dev-only: the `import.meta.env.DEV` guard is what keeps its 12 MB
 * wasm module out of production bundles, since a bundler emits any chunk it can reach. */
async function fakeWorker(): Promise<Worker> {
  if (!import.meta.env.DEV) throw new Error('the fake probe is only available in development');
  const { createFakeLocalWorker } = await import('@probe-web/client/testing/worker');
  return createFakeLocalWorker();
}

async function connectReal(kind: 'launch' | 'attach') {
  const transport = $<HTMLSelectElement>('transport').value === 'webusb' ? 'webusb' : 'websocket';
  const opened = await openSession({
    transport,
    url: $<HTMLInputElement>('url').value,
    token: $<HTMLInputElement>('token').value,
    probe: $<HTMLInputElement>('probe').value,
    chip: $<HTMLInputElement>('chip').value || undefined,
    protocol: $<HTMLInputElement>('protocol').value as 'Swd' | 'Jtag',
    worker: qs.has('fakeProbe') ? await fakeWorker() : undefined,
  });
  ({ client, session } = opened);
  log(`attached ${$<HTMLInputElement>('chip').value} via ${transport}: ${opened.probe.identifier}`, 'gray');
  if (elf && kind === 'launch') {
    const t0 = performance.now();
    // `target`: the chip's default image format (IDF with bootloader on ESP32 chips, ELF elsewhere).
    await session.flash({ image: elf.bytes, name: elf.name, format: 'target', options: { verify: true } });
    log(`flashed ${elf.name} in ${Math.round(performance.now() - t0)} ms`, 'gray');
  }
  const d = session.debugger();
  if (elf) await d.loadDebugInfo(elf.bytes, elf.name);
  if (elf && elfHasRtt(elf.bytes)) await d.enableRtt({ elf: elf.bytes });
  return { debugger: d as unknown as DebuggerLike, close: () => { client?.close(); client = null; session = null; } };
}

async function start(kind: 'launch' | 'attach') {
  await stop();
  saveSettings();
  setStatus(`${kind === 'launch' ? 'launching' : 'attaching'}…`);
  const fake = qs.has('fake');
  const adapter = new ProbeDebugAdapter({
    sources,
    connect: async () => {
      if (fake) {
        const f = new FakeDebugger();
        (window as unknown as { fake: FakeDebugger }).fake = f;
        return { debugger: f as unknown as DebuggerLike };
      }
      return connectReal(kind);
    },
  });
  dap = new DapClient(adapter);
  unsubscribe = [
    dap.on<DP.OutputEvent['body']>('output', (b) => consoleView.write(b.output, b.category === 'stdout' ? undefined : 'gray')),
    dap.on<DP.StoppedEvent['body']>('stopped', (b) => {
      setStatus(`stopped (${b.reason})`);
      void showTopFrame();
    }),
    dap.on('continued', () => { setStatus('running'); source.setPc(null); }),
    dap.on('terminated', () => setStatus('not connected')),
  ];
  try {
    await dap.request('initialize', { adapterID: 'probe-rs', clientID: 'probe-web-workbench', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
    const initialized = new Promise<void>((r) => { const off = dap!.on('initialized', () => { off(); r(); }); });
    await dap.request(kind, { stopOnEntry: $<HTMLInputElement>('stop-on-entry').checked });
    await initialized;
    // The adapter's debugger drives the component panels too.
    const d = adapter.debugger as unknown as Debugger;
    useDebugger(d);
    if (svd) await (elements.get('peripherals') as unknown as { loadSvd(b: Uint8Array, n: string): Promise<void> })?.loadSvd(svd.bytes, svd.name);
    $<HTMLButtonElement>('stop').disabled = false;
    return d;
  } catch (e) {
    log(`${kind} failed: ${(e as Error).message}`, 'red');
    setStatus('not connected');
    await stop();
    throw e;
  }
}

async function configurationDone() {
  await dap!.request('configurationDone');
  setStatus(currentDebugger?.state === 'halted' ? 'stopped' : 'running');
}

async function stop() {
  for (const off of unsubscribe) off();
  unsubscribe = [];
  if (dap) {
    try { await dap.request('disconnect', { terminateDebuggee: true }); } catch { /* already gone */ }
  }
  dap = null;
  useDebugger(null);
  source.setPc(null);
  $<HTMLButtonElement>('stop').disabled = true;
  setStatus('not connected');
}

/** Rebuild detected: re-flash, reload debug info (breakpoints are re-applied), restart. */
async function reflash() {
  if (!artifact || !session || !currentDebugger) return;
  try {
    const bytes = await artifact.bytes();
    elf = { bytes, name: artifact.name };
    const d = currentDebugger;
    log(`${artifact.name} changed: re-flashing`, 'cyan');
    if (d.state !== 'halted') await d.pause();
    await session.flash({ image: bytes, name: artifact.name, format: 'target', options: { verify: true } });
    await d.loadDebugInfo(bytes, artifact.name);
    await d.resetAndHalt();
    await d.continue();
    log('re-flashed and restarted', 'green');
  } catch (e) {
    log(`re-flash failed: ${(e as Error).message}`, 'red');
  }
}

$('launch').onclick = async () => { try { await start('launch'); await configurationDone(); } catch { /* logged */ } };
$('attach').onclick = async () => { try { await start('attach'); await configurationDone(); } catch { /* logged */ } };
$('stop').onclick = () => void stop();
addEventListener('pagehide', () => { client?.close(); });

(window as unknown as { workbench: unknown }).workbench = { source, consoleView, start, configurationDone, stop, get dap() { return dap; }, get debugger() { return currentDebugger; } };

// ------------------------------------------------------------------ automation

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bring a panel to the front and return its element. dockview only renders a panel while its tab is
 * active (source and console aside), so a panel that a restored layout left in a background tab has
 * no DOM until it is shown - which is also what a user does before reading it.
 */
async function show(name: string): Promise<(HTMLElement & { debugger: Debugger | null }) | undefined> {
  dock.getPanel(name)?.api.setActive();
  await sleep(150);
  return elements.get(name);
}

if (qs.has('fake')) {
  // A synthetic source for the fake program's DWARF path.
  sources = { read: async (p) => (p === '/build/fw/src/main.rs' ? Array.from({ length: 80 }, (_, i) => `// line ${i + 1}`).join('\n') : null), resolve: async () => null };
  source.sources = sources;
  log('fake mode', 'gray');
}

if (qs.has('auto')) {
  void (async () => {
    const t0 = performance.now();
    const results: [string, boolean, string][] = [];
    const check = (name: string, ok: boolean, detail: string) => { results.push([name, ok, detail]); log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`, ok ? 'green' : 'red'); };
    try {
      const elfUrl = qs.get('elf')!;
      elf = { bytes: new Uint8Array(await (await fetch(elfUrl)).arrayBuffer()), name: elfUrl };
      const bpLine = Number(qs.get('bp') ?? 40);
      const d = await start('launch');
      const srcPath = qs.get('srcPath') ?? 'src/main.rs';
      const res = await dap!.request<DP.SetBreakpointsResponse>('setBreakpoints', { source: { path: srcPath }, breakpoints: [{ line: bpLine }] });
      check('breakpoint verified', res.body.breakpoints[0]?.verified === true, JSON.stringify(res.body.breakpoints[0]));
      const stopped = new Promise<void>((r) => { const off = dap!.on('stopped', () => { off(); r(); }); });
      await configurationDone();
      await stopped;
      await sleep(1500);
      check('source view shows main.rs with the PC at the breakpoint line', !!source.path?.endsWith(srcPath) && source.pcLine === bpLine, `${source.path}:${source.pcLine}`);
      check('source view shows the breakpoint glyph', source.breakpointLines().includes(bpLine), JSON.stringify(source.breakpointLines()));
      const stackRow = (await show('callstack'))?.shadowRoot?.querySelector('tr.selected')?.getAttribute('data-frame');
      check('call stack panel selects step_b', stackRow === 'step_b', String(stackRow));
      const hasPoint = !!(await show('variables'))?.shadowRoot?.querySelector('[data-path="Variables/point"]');
      check('variables panel shows point', hasPoint, String(hasPoint));

      // Memory panel: watch TABLE (a [u16; 4] static), view it, then lock the view.
      const mem = (await show('memory')) as unknown as import('@probe-web/ui').ProbeMemoryView | undefined;
      if (mem) {
        const h = await mem.watch('TABLE');
        await mem.goTo(h.address, 32);
        await sleep(500);
        const lit = [...(mem.shadowRoot?.querySelectorAll('td.cell[data-highlight="TABLE"]') ?? [])].map((c) => c.textContent!.trim());
        check('memory panel highlights TABLE (8 bytes)', h.size === 8 && lit.join(' ') === '11 11 22 22 33 33 44 44', `${h.size} bytes at 0x${h.address.toString(16)}: ${lit.join(' ')}`);
        mem.locked = true;
        const moved = await mem.goTo(h.address + 0x100n);
        check('locked memory panel ignores goTo', !moved && mem.address === h.address, `moved=${moved} address=0x${mem.address.toString(16)}`);
        mem.locked = false;
      } else {
        check('memory panel present', false, 'no memory element');
      }

      // Gutter breakpoint on a later line, then continue to it.
      const later = Number(qs.get('bp2') ?? 43);
      await source.onToggleBreakpoint(source.path!, later);
      await sleep(300);
      check('gutter adds a verified breakpoint', source.breakpointLines().includes(later) && d.breakpoints().some((b) => b.verified && (b.source?.line === later)), JSON.stringify(source.breakpointLines()));
      await source.onToggleBreakpoint(source.path!, bpLine); // remove the first one
      await sleep(300);
      const next = new Promise<void>((r) => { const off = dap!.on('stopped', () => { off(); r(); }); });
      ((await show('controls'))?.shadowRoot?.querySelector('button[title="Continue"]') as HTMLButtonElement | undefined)?.click();
      await next;
      await sleep(1200);
      check('continue (Run panel) stops at the gutter breakpoint', source.pcLine === later, `pc line ${source.pcLine}`);
      check('first breakpoint removed from the gutter', !source.breakpointLines().includes(bpLine), JSON.stringify(source.breakpointLines()));
      check('console shows the adapter output', consoleView.lines.some((l) => l.includes('probe-rs: launched')), consoleView.lines.slice(0, 3).join(' | '));
      await stop();
    } catch (e) {
      check('no errors', false, (e as Error).stack ?? String(e));
    }
    const ok = results.length > 0 && results.every((r) => r[1]);
    log(`WORKBENCH_RESULT=${ok ? 'PASS' : 'FAIL'} in ${Math.round(performance.now() - t0)} ms`, ok ? 'green' : 'red');
    (window as unknown as { workbenchResult: unknown }).workbenchResult = { ok, results };
  })();
}

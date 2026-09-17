// A minimal IDE on @probe-web/dap: everything goes through DAP requests and events,
// as it would from VS Code web or Theia. Monaco shows the stopped frame's source with
// gutter breakpoints; xterm prints output, the stack and the locals at each stop.
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/languages/definitions/rust/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { DebugProtocol as DP } from '@vscode/debugprotocol';
import { ProbeDebugAdapter } from '@probe-web/dap';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const qs = new URLSearchParams(location.search);
for (const k of ['url', 'token', 'probe', 'chip', 'elf']) if (qs.get(k)) $<HTMLInputElement>(k).value = qs.get(k)!;

const editor = monaco.editor.create($('editor'), { readOnly: true, glyphMargin: true, automaticLayout: true, minimap: { enabled: false }, model: null });
const bpDecorations = editor.createDecorationsCollection();
const pcDecoration = editor.createDecorationsCollection();
const term = new Terminal({ convertEol: true, fontSize: 12, theme: { background: '#0b0f14' } });
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('term'));
new ResizeObserver(() => fit.fit()).observe($('term'));
const out: string[] = [];
const print = (s: string) => { out.push(s); term.writeln(s); console.log('[ide] ' + s); };

// ---- the DAP client
let adapter: ProbeDebugAdapter | null = null;
let seq = 1;
const pending = new Map<number, (r: DP.Response) => void>();
const handlers = new Map<string, (body: never) => void>();
function request<T extends DP.Response>(command: string, args?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const s = seq++;
    pending.set(s, (r) => (r.success ? resolve(r as T) : reject(new Error(r.message))));
    adapter!.handleMessage({ seq: s, type: 'request', command, arguments: args } as DP.Request);
  });
}
const on = <B>(event: string, fn: (body: B) => void) => handlers.set(event, fn as (body: never) => void);

// ---- state: the open file, its breakpoint lines, the current thread stop
let file: string | null = null;
let pcLine: number | null = null;
const breakpoints = new Map<string, number[]>();
const sourceUrl = (path: string) => '/@fs' + path; // dev server; a real IDE reads its workspace

async function open(path: string, line: number | null) {
  if (file !== path) {
    const text = await (await fetch(sourceUrl(path))).text();
    editor.setModel(monaco.editor.createModel(text, 'rust'));
    file = path;
  }
  pcLine = line;
  pcDecoration.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'pc' } }] : []);
  if (line) editor.revealLineInCenter(line);
  renderBreakpoints();
}

function renderBreakpoints() {
  const lines = (file && breakpoints.get(file)) || [];
  bpDecorations.set(lines.map((l) => ({ range: new monaco.Range(l, 1, l, 1), options: { glyphMarginClassName: 'bp' } })));
}

async function setBreakpoints(path: string, lines: number[]) {
  const res = await request<DP.SetBreakpointsResponse>('setBreakpoints', { source: { path }, breakpoints: lines.map((line) => ({ line })) });
  breakpoints.set(path, res.body.breakpoints.filter((b) => b.verified).map((b) => b.line!));
  for (const b of res.body.breakpoints) print(`breakpoint ${b.verified ? 'set' : 'NOT set'} at ${path.split('/').pop()}:${b.line ?? '?'}${b.message ? ` (${b.message})` : ''}`);
  renderBreakpoints();
}

editor.onMouseDown((e) => {
  if (!adapter || !file || e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
  const line = e.target.position!.lineNumber;
  const lines = breakpoints.get(file) ?? [];
  void setBreakpoints(file, lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line]);
});

async function onStopped(body: DP.StoppedEvent['body']) {
  const st = await request<DP.StackTraceResponse>('stackTrace', { threadId: 1, levels: 20 });
  const frames = st.body.stackFrames;
  print(`stopped: ${body.reason} — ${frames.filter((f) => f.presentationHint !== 'subtle').slice(0, 3).map((f) => `${f.name}:${f.line}`).join(' ← ')}`);
  const top = frames.find((f) => f.source?.path && f.presentationHint !== 'subtle');
  if (!top) return;
  await open(top.source!.path!, top.line);
  const scopes = await request<DP.ScopesResponse>('scopes', { frameId: top.id });
  const locals = scopes.body.scopes.find((s) => s.presentationHint === 'locals');
  if (!locals) return;
  const vars = await request<DP.VariablesResponse>('variables', { variablesReference: locals.variablesReference });
  for (const v of vars.body.variables) {
    let value = v.value;
    if (v.variablesReference) {
      const kids = await request<DP.VariablesResponse>('variables', { variablesReference: v.variablesReference });
      value = `{ ${kids.body.variables.map((k) => `${k.name}: ${k.value}`).join(', ')} }`;
    }
    print(`  ${v.name} = ${value}`);
  }
}

async function launch() {
  adapter?.dispose();
  adapter = new ProbeDebugAdapter();
  adapter.onDidSendMessage((m) => {
    if (m.type === 'response') pending.get((m as DP.Response).request_seq)?.(m as DP.Response);
    else if (m.type === 'event') handlers.get((m as DP.Event).event)?.((m as DP.Event).body as never);
  });
  on<DP.OutputEvent['body']>('output', (b) => print(b.output.trimEnd()));
  on<DP.StoppedEvent['body']>('stopped', (b) => void onStopped(b));
  on('continued', () => { pcDecoration.clear(); pcLine = null; print('running'); });
  on('terminated', () => print('terminated'));
  const initialized = new Promise<void>((r) => on('initialized', () => r()));
  await request('initialize', { adapterID: 'probe-rs', linesStartAt1: true, columnsStartAt1: true });
  await request('launch', {
    // `?transport=webusb` debugs through probe-rs in a Worker over WebUSB instead of probe-rs serve.
    transport: qs.get('transport') === 'webusb' ? 'webusb' : 'websocket',
    url: $<HTMLInputElement>('url').value, token: $<HTMLInputElement>('token').value,
    probe: $<HTMLInputElement>('probe').value, chip: $<HTMLInputElement>('chip').value,
    protocol: qs.get('protocol') === 'Jtag' ? 'Jtag' : 'Swd',
    program: $<HTMLInputElement>('elf').value,
  });
  await initialized;
  for (const [path, lines] of breakpoints) await setBreakpoints(path, lines);
}

$('launch').onclick = () => void launch().then(() => request('configurationDone')).catch((e) => print(`error: ${e.message}`));
$('stop').onclick = () => void request('disconnect', { terminateDebuggee: true }).catch(() => {});
for (const b of document.querySelectorAll<HTMLButtonElement>('button[data-cmd]')) {
  b.onclick = () => void request(b.dataset.cmd!, { threadId: 1 }).catch((e) => print(`${b.dataset.cmd}: ${e.message}`));
}
addEventListener('pagehide', () => adapter?.dispose());

// ?auto=1&bp=40: hardware check through DAP only.
if (qs.has('auto')) {
  void (async () => {
    const results: string[] = [];
    const check = (name: string, ok: boolean, detail: string) => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`); print(results.at(-1)!); };
    const waitStop = () => new Promise<void>((r) => { const prev = handlers.get('stopped'); on<DP.StoppedEvent['body']>('stopped', (b) => { void onStopped(b).then(() => { if (prev) handlers.set('stopped', prev); r(); }); }); });
    try {
      await launch();
      const bp = Number(qs.get('bp') ?? 40);
      const srcPath = qs.get('srcPath') ?? 'src/main.rs';
      await setBreakpoints(srcPath, [bp]);
      const stopped = waitStop();
      await request('configurationDone');
      await stopped;
      check('stopped at the breakpoint with the source open', !!(file as string | null)?.endsWith(srcPath) && (pcLine as number | null) === bp, `${file}:${pcLine}`);
      check('locals printed from DAP variables', out.some((l) => /point = \{ x: \d+, y: \d+ \}/.test(l)), out.filter((l) => l.includes('point')).join(' | '));
      const stepped = waitStop();
      await request('next', { threadId: 1 });
      await stepped;
      check('step over moved the PC line', (pcLine as number | null) !== null && pcLine !== bp, `line ${pcLine}`);
      await request('disconnect', { terminateDebuggee: true });
    } catch (e) {
      check('no errors', false, (e as Error).message);
    }
    print(`MONACO_IDE_RESULT=${results.length && results.every((r) => r.startsWith('PASS')) ? 'PASS' : 'FAIL'}`);
  })();
}

/**
 * Hardware test for @probe-web/dap: drives ProbeDebugAdapter only through DAP
 * messages, with its default connection to `probe-rs serve`.
 *
 *   node dap.ts --elf ../../apps/flash/public/firmware/mcxa153-debug.elf --chip MCXA153 --probe mcu-link
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { DebugProtocol as DP } from '@vscode/debugprotocol';
import { ProbeDebugAdapter } from '@probe-web/dap';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:3000' },
    token: { type: 'string', default: 'spike' },
    elf: { type: 'string' },
    chip: { type: 'string' },
    probe: { type: 'string' },
    firmwareSrc: { type: 'string', default: '../../hardware-tests/firmware/cm33-debug/src/main.rs' },
    /** Breakpoint path as a client would send it (a suffix of the DWARF path). */
    srcPath: { type: 'string', default: 'src/main.rs' },
    protocol: { type: 'string', default: 'Swd' },
    format: { type: 'string', default: 'target' },
    /** probe-rs serve does not implement disassembly for Xtensa. */
    noDisassembly: { type: 'boolean', default: false },
  },
});
if (!args.elf || !args.chip) {
  console.error('usage: dap.ts --elf <file> --chip <name> [--probe <substring>]');
  process.exit(2);
}

const t0 = performance.now();
const since = () => `${((performance.now() - t0) / 1000).toFixed(2)}s`;
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`[${since()}] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const adapter = new ProbeDebugAdapter();
const events: DP.Event[] = [];
const pending = new Map<number, (r: DP.Response) => void>();
const waiters: { event: string; resolve: (e: DP.Event) => void }[] = [];
adapter.onDidSendMessage((m) => {
  if (m.type === 'response') pending.get((m as DP.Response).request_seq)?.(m as DP.Response);
  else if (m.type === 'event') {
    const e = m as DP.Event;
    events.push(e);
    const i = waiters.findIndex((w) => w.event === e.event);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(e);
    else if (e.event === 'output') process.stdout.write(`  | ${(e.body as { output: string }).output}`);
  }
});
let seq = 1;
async function request<T extends DP.Response>(command: string, a?: unknown): Promise<T> {
  const s = seq++;
  const res = await new Promise<T>((resolve) => {
    pending.set(s, resolve as (r: DP.Response) => void);
    adapter.handleMessage({ seq: s, type: 'request', command, arguments: a } as DP.Request);
  });
  if (!res.success) throw new Error(`${command} failed: ${res.message}`);
  return res;
}
const nextEvent = (event: string, timeoutMs = 8000) => new Promise<DP.Event>((resolve, reject) => {
  const waiter = { event, resolve: (e: DP.Event) => { clearTimeout(t); resolve(e); } };
  const t = setTimeout(() => {
    waiters.splice(waiters.indexOf(waiter), 1);
    reject(new Error(`no ${event} event within ${timeoutMs} ms`));
  }, timeoutMs);
  waiters.push(waiter);
});

const source = (await readFile(args.firmwareSrc!, 'utf8')).split('\n');
const lineOf = (needle: string) => source.findIndex((l) => l.includes(needle)) + 1;
const sumLine = lineOf('let sum = point.x + point.y;');

try {
  const init = await request<DP.InitializeResponse>('initialize', { adapterID: 'probe-rs', linesStartAt1: true, columnsStartAt1: true });
  check('initialize: capabilities', !!init.body?.supportsDisassembleRequest && !!init.body.supportsInstructionBreakpoints);

  const initialized = nextEvent('initialized', 30000);
  // The firmware writes samples to channel 1; say so, or those bytes are decoded as text
  // and land in the same stdout stream as the `n=… result=…` lines this checks.
  await request('launch', { url: args.url, token: args.token, probe: args.probe, chip: args.chip, protocol: args.protocol, format: args.format, program: new Uint8Array(await readFile(args.elf)), rttChannels: [{ channelNumber: 1, dataFormat: 'BinaryLE' }] });
  await initialized;
  console.log(`[${since()}] launched (flashed + debug info)`);

  const bps = await request<DP.SetBreakpointsResponse>('setBreakpoints', { source: { path: args.srcPath }, breakpoints: [{ line: sumLine }] });
  const bp = bps.body.breakpoints[0];
  check('setBreakpoints: verified at the line', bp.verified && bp.line === sumLine && !!bp.instructionReference, JSON.stringify(bp));

  let stopped = nextEvent('stopped');
  await request('configurationDone');
  let stop = await stopped;
  check('configurationDone runs to the breakpoint', (stop.body as DP.StoppedEvent['body']).reason === 'breakpoint' && (stop.body as DP.StoppedEvent['body']).hitBreakpointIds?.[0] === bp.id, JSON.stringify(stop.body));

  let st = await request<DP.StackTraceResponse>('stackTrace', { threadId: 1 });
  const names = st.body.stackFrames.map((f) => f.name);
  check('stackTrace: step_b at the breakpoint line, then step_a', names[0] === 'step_b' && st.body.stackFrames[0].line === sumLine && names[1] === 'step_a', st.body.stackFrames.slice(0, 3).map((f) => `${f.name}:${f.line}`).join(' <- '));

  const scopes = await request<DP.ScopesResponse>('scopes', { frameId: st.body.stackFrames[0].id });
  const locals = scopes.body.scopes.find((s) => s.presentationHint === 'locals')!;
  const vars = await request<DP.VariablesResponse>('variables', { variablesReference: locals.variablesReference });
  const point = vars.body.variables.find((v) => v.name === 'point')!;
  const pv = await request<DP.VariablesResponse>('variables', { variablesReference: point.variablesReference });
  const x = Number(pv.body.variables.find((v) => v.name === 'x')?.value);
  const y = Number(pv.body.variables.find((v) => v.name === 'y')?.value);
  check('variables: point = {n, 2n}', x >= 1 && y === 2 * x, `x=${x} y=${y}`);

  const ev = await request<DP.EvaluateResponse>('evaluate', { expression: 'COUNTER', frameId: st.body.stackFrames[0].id, context: 'watch' });
  // Line 40's breakpoint is past the prologue; optimised code may already have incremented COUNTER.
  check('evaluate COUNTER is n - 1 or n', [x - 1, x].includes(Number(ev.body.result)), `${ev.body.result} (n=${x})`);

  const pc = st.body.stackFrames[0].instructionPointerReference!;
  if (args.noDisassembly) {
    console.log(`[${since()}] SKIP disassemble (not implemented by probe-rs serve for this architecture)`);
  } else {
    const dis = await request<DP.DisassembleResponse>('disassemble', { memoryReference: pc, instructionOffset: 0, instructionCount: 4 });
    check('disassemble at the PC', dis.body.instructions[0]?.address === pc && dis.body.instructions.every((i) => i.instruction), dis.body.instructions.map((i) => `${i.address} ${i.instruction}`).join(' | '));
  }

  const table = await request<DP.EvaluateResponse>('evaluate', { expression: 'TABLE', context: 'watch' });
  const mem = await request<DP.ReadMemoryResponse>('readMemory', { memoryReference: table.body.memoryReference!, count: 8 });
  const bytes = Buffer.from(mem.body.data!, 'base64');
  check('readMemory at TABLE (via evaluate memoryReference)', bytes.toString('hex') === '1111222233334444', `${mem.body.address}: ${bytes.toString('hex')}`);

  const depthBefore = st.body.stackFrames.filter((f) => f.presentationHint !== 'subtle').length;
  stopped = nextEvent('stopped');
  await request('stepOut', { threadId: 1 });
  stop = await stopped;
  st = await request<DP.StackTraceResponse>('stackTrace', { threadId: 1 });
  const realFrames = st.body.stackFrames.filter((f) => f.presentationHint !== 'subtle');
  // From line 40 (optimised code) probe-rs's step out may run on past step_a into main; from a
  // later line it lands in step_a (see debug.ts). Either way it must leave step_b.
  check('stepOut leaves step_b for a caller', (stop.body as DP.StoppedEvent['body']).reason === 'step' && realFrames[0]?.name !== 'step_b' && realFrames.length < depthBefore, `${realFrames[0]?.name}:${realFrames[0]?.line} (depth ${depthBefore} -> ${realFrames.length})`);

  stopped = nextEvent('stopped');
  await request('next', { threadId: 1, granularity: 'instruction' });
  await stopped;
  const st2 = await request<DP.StackTraceResponse>('stackTrace', { threadId: 1 });
  check('next (instruction granularity) moves the PC', st2.body.stackFrames[0].instructionPointerReference !== st.body.stackFrames[0].instructionPointerReference, `${st.body.stackFrames[0].instructionPointerReference} -> ${st2.body.stackFrames[0].instructionPointerReference}`);

  await request('setBreakpoints', { source: { path: args.srcPath }, breakpoints: [] });
  const continued = nextEvent('continued');
  const outputsBefore = events.length;
  await request('continue', { threadId: 1 });
  await continued;
  const stray = await nextEvent('stopped', 2500).then(() => 'stopped', () => 'still running');
  check('continue with no breakpoints keeps running', stray === 'still running', stray);
  const rttLines = events.slice(outputsBefore).filter((e) => e.event === 'output' && (e.body as DP.OutputEvent['body']).category === 'stdout')
    .map((e) => (e.body as DP.OutputEvent['body']).output).join('').split('\n').filter((l) => /^n=\d+ result=-?\d+$/.test(l));
  check('RTT output arrives as DAP output events while running', rttLines.length >= 2, rttLines.slice(0, 3).join(' | '));

  stopped = nextEvent('stopped');
  await request('pause', { threadId: 1 });
  check('pause reports a pause stop', ((await stopped).body as DP.StoppedEvent['body']).reason === 'pause');

  const terminated = nextEvent('terminated');
  await request('disconnect', { terminateDebuggee: true });
  await terminated;
  check('disconnect terminates the session', true);
} catch (e) {
  console.error(`[${since()}] error: ${(e as Error).stack ?? e}`);
  failures++;
  adapter.dispose();
}
console.log(failures ? `DAP_RESULT=FAIL (${failures})` : 'DAP_RESULT=PASS');
process.exit(failures ? 1 : 0);

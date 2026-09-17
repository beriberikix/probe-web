/**
 * A Debug Adapter Protocol implementation for probe-rs, running in the page
 * (or a worker, or Node) on top of `@probe-web/client`'s `Debugger`.
 *
 * It has the shape VS Code web's `DebugAdapterInlineImplementation` expects:
 * `handleMessage(request)` in, `onDidSendMessage(listener)` out. Request
 * mapping follows probe-rs's own DAP server (probe-rs-tools
 * `dap_server/debug_adapter/dap/adapter.rs`). One thread per debugged core
 * (currently one core, thread id 1).
 */
import type { DebugProtocol as DP } from '@vscode/debugprotocol';
import type { Breakpoint, DebugOutput, Debugger, SourceProvider, StoppedDetail } from '@probe-web/client';

/** The `Debugger` surface the adapter uses (the SDK class and `FakeDebugger` both satisfy it). */
export type DebuggerLike = Pick<Debugger,
  | 'state' | 'lastStop' | 'addEventListener' | 'removeEventListener' | 'start' | 'dispose' | 'refresh'
  | 'continue' | 'pause' | 'step' | 'reset' | 'resetAndHalt'
  | 'loadDebugInfo' | 'loadSvd' | 'stackTrace' | 'scopes' | 'variables' | 'evaluate' | 'setVariable'
  | 'setSourceBreakpoints' | 'setInstructionBreakpoints' | 'disassemble' | 'readMemory' | 'writeMemory' | 'writeRegister'>
  & Partial<Pick<Debugger, 'enableRtt'>>;

/** Arguments of `launch` / `attach` (custom fields of this adapter). */
export interface ProbeLaunchArguments extends DP.LaunchRequestArguments {
  /** `probe-rs serve` WebSocket URL and token. */
  url?: string;
  token?: string;
  /** Probe to use: substring of its identifier or serial number (first probe if omitted). */
  probe?: string;
  chip?: string;
  protocol?: 'Swd' | 'Jtag';
  /** Firmware ELF: bytes, or a URL to fetch. Loaded for debug info; flashed on `launch` unless `flash` is false. */
  program?: Uint8Array | string;
  flash?: boolean;
  /** Image format for flashing: `target` (default) uses the chip's own default, e.g. `idf` on ESP32 chips, `elf` on most others. */
  format?: 'target' | 'elf' | 'hex' | 'bin' | 'uf2' | 'idf';
  /** CMSIS-SVD for the Peripherals scope: bytes or URL. */
  svd?: Uint8Array | string;
  /** Show RTT output as DAP `output` events (default true when the program links RTT). */
  rtt?: boolean;
  /** Stop at the reset vector after launch instead of running. */
  stopOnEntry?: boolean;
}

export interface ConnectResult {
  debugger: DebuggerLike;
  /** Release the connection (called on disconnect). */
  close?: () => void | Promise<void>;
}

export interface AdapterOptions {
  /**
   * Create the debugger for `launch` / `attach`. Defaults to connecting to
   * `probe-rs serve` with `@probe-web/client` (see `connectProbeRs`).
   */
  connect?: (args: ProbeLaunchArguments, kind: 'launch' | 'attach') => Promise<ConnectResult>;
  /** Serves `source` requests (source text for DWARF paths). */
  sources?: SourceProvider;
}

type Listener = (message: DP.ProtocolMessage) => void;

const THREAD = 1;
const hex = (v: bigint) => '0x' + v.toString(16).padStart(8, '0');
const basename = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function bytesOf(source: Uint8Array | string): Promise<Uint8Array> {
  if (typeof source !== 'string') return source;
  const res = await fetch(source);
  if (!res.ok) throw new Error(`fetch ${source}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

class DapError extends Error {}

export class ProbeDebugAdapter {
  private readonly opts: AdapterOptions;
  private listeners: Listener[] = [];
  private seq = 1;
  private dbg: DebuggerLike | null = null;
  private close: (() => void | Promise<void>) | null = null;
  private unlisten: (() => void) | null = null;
  private configured = false;
  private launchArgs: ProbeLaunchArguments | null = null;
  private kind: 'launch' | 'attach' = 'launch';
  private entryStop: StoppedDetail | null = null;
  private clientLinesStartAt1 = true;
  private clientColumnsStartAt1 = true;

  constructor(options: AdapterOptions = {}) {
    this.opts = options;
  }

  /** The debugger created by `launch` / `attach`, for hosts that also show other views of it. */
  get debugger(): DebuggerLike | null {
    return this.dbg;
  }

  onDidSendMessage(listener: Listener): { dispose(): void } {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  }

  /** Handle one DAP request. Responses and events go to `onDidSendMessage` listeners. */
  handleMessage(message: DP.ProtocolMessage): void {
    if (message.type !== 'request') return;
    void this.dispatch(message as DP.Request);
  }

  dispose(): void {
    void this.shutdown();
  }

  private send(message: DP.ProtocolMessage) {
    const full = { ...message, seq: this.seq++ } as DP.ProtocolMessage;
    for (const l of this.listeners) l(full);
  }

  private event(event: string, body?: unknown) {
    this.send({ seq: 0, type: 'event', event, body } as DP.Event);
  }

  private respond(request: DP.Request, body?: unknown) {
    this.send({ seq: 0, type: 'response', request_seq: request.seq, command: request.command, success: true, body } as DP.Response);
  }

  private fail(request: DP.Request, message: string) {
    this.send({
      seq: 0, type: 'response', request_seq: request.seq, command: request.command, success: false, message,
      body: { error: { id: 1, format: message, showUser: true } },
    } as DP.ErrorResponse);
  }

  private get d(): DebuggerLike {
    if (!this.dbg) throw new DapError('not connected: send launch or attach first');
    return this.dbg;
  }

  private line(n: number | null | undefined): number {
    return (n ?? 0) - 1 + (this.clientLinesStartAt1 ? 1 : 0);
  }
  private fromClientLine(n: number): number {
    return this.clientLinesStartAt1 ? n : n + 1;
  }
  private column(n: number | null | undefined): number {
    return (n ?? 1) - 1 + (this.clientColumnsStartAt1 ? 1 : 0);
  }

  private async dispatch(request: DP.Request) {
    try {
      const handler = (this as unknown as Record<string, (r: DP.Request, a: unknown) => Promise<unknown>>)[`on_${request.command}`];
      if (!handler) {
        this.fail(request, `unsupported request: ${request.command}`);
        return;
      }
      const body = await handler.call(this, request, request.arguments ?? {});
      this.respond(request, body);
    } catch (e) {
      this.fail(request, (e as Error)?.message ?? String(e));
    }
  }

  // ------------------------------------------------------------ lifecycle

  protected async on_initialize(_r: DP.InitializeRequest, a: DP.InitializeRequestArguments): Promise<DP.Capabilities> {
    this.clientLinesStartAt1 = a.linesStartAt1 !== false;
    this.clientColumnsStartAt1 = a.columnsStartAt1 !== false;
    return {
      supportsConfigurationDoneRequest: true,
      supportsSetVariable: true,
      supportsEvaluateForHovers: true,
      supportsDisassembleRequest: true,
      supportsInstructionBreakpoints: true,
      supportsSteppingGranularity: true,
      supportsReadMemoryRequest: true,
      supportsWriteMemoryRequest: true,
      supportsTerminateRequest: true,
      supportsRestartRequest: false,
      supportsValueFormattingOptions: false,
    };
  }

  private async start(args: ProbeLaunchArguments, kind: 'launch' | 'attach') {
    const connect = this.opts.connect ?? connectProbeRs;
    const { debugger: dbg, close } = await connect(args, kind);
    this.dbg = dbg;
    this.close = close ?? null;
    this.launchArgs = args;
    this.kind = kind;
    const onStopped = (e: Event) => {
      if (this.configured) this.emitStopped((e as CustomEvent<StoppedDetail>).detail);
    };
    const onContinued = () => {
      if (this.configured) this.event('continued', { threadId: THREAD, allThreadsContinued: true });
    };
    const onBreakpoints = (e: Event) => this.emitBreakpointChanges((e as CustomEvent<Breakpoint[]>).detail);
    const onOutput = (e: Event) => {
      const o = (e as CustomEvent<DebugOutput>).detail;
      this.event('output', { category: 'stdout', output: o.text, group: undefined, data: { source: o.source, channel: o.source === 'rtt' ? o.channel : undefined } });
    };
    // Poller failures (e.g. the server refusing to service a semihosting halt) would otherwise be
    // invisible; report each distinct message once until the poller recovers or it changes.
    let lastError: string | null = null;
    const onError = (e: Event) => {
      const err = (e as CustomEvent).detail as { message?: string } | undefined;
      const message = err?.message ?? String(err);
      if (message === lastError) return;
      lastError = message;
      this.event('output', { category: 'stderr', output: `probe-rs: ${message}\n` });
    };
    const onRecovered = () => { lastError = null; };
    dbg.addEventListener('output', onOutput);
    dbg.addEventListener('error', onError);
    dbg.addEventListener('stopped', onRecovered);
    dbg.addEventListener('continued', onRecovered);
    dbg.addEventListener('stopped', onStopped);
    dbg.addEventListener('continued', onContinued);
    dbg.addEventListener('breakpoints', onBreakpoints);
    this.unlisten = () => {
      dbg.removeEventListener('stopped', onStopped);
      dbg.removeEventListener('continued', onContinued);
      dbg.removeEventListener('breakpoints', onBreakpoints);
      dbg.removeEventListener('output', onOutput);
      dbg.removeEventListener('error', onError);
      dbg.removeEventListener('stopped', onRecovered);
      dbg.removeEventListener('continued', onRecovered);
    };
    if (kind === 'launch') {
      // Reset now, before the client sends breakpoints: a reset can clear hardware
      // comparators (it does on the MCX family), so probe-rs's DAP server resets here too.
      this.entryStop = await dbg.resetAndHalt();
    }
    dbg.start();
    this.event('output', { category: 'console', output: `probe-rs: ${kind === 'launch' ? 'launched' : 'attached'}\n` });
    // Breakpoints can be set now; stop/continue events flow after configurationDone.
    this.event('initialized');
  }

  protected async on_launch(_r: DP.LaunchRequest, a: ProbeLaunchArguments) {
    await this.start(a, 'launch');
  }

  protected async on_attach(_r: DP.AttachRequest, a: ProbeLaunchArguments) {
    await this.start(a, 'attach');
  }

  protected async on_configurationDone() {
    const d = this.d;
    if (this.kind === 'launch') {
      // The target was reset and halted during launch; report that or run.
      this.configured = true;
      if (this.launchArgs?.stopOnEntry && this.entryStop) this.emitStopped(this.entryStop, 'entry');
      else await d.continue();
    } else {
      this.configured = true;
      const state = await d.refresh();
      if (state === 'halted' && d.lastStop) this.emitStopped(d.lastStop);
    }
  }

  private async shutdown() {
    this.unlisten?.();
    this.unlisten = null;
    this.dbg?.dispose();
    this.dbg = null;
    const close = this.close;
    this.close = null;
    await close?.();
  }

  protected async on_disconnect(_r: DP.DisconnectRequest, a: DP.DisconnectArguments) {
    if (this.dbg && this.kind === 'launch' && a.terminateDebuggee !== false) {
      // Leave the target running rather than halted mid-way.
      try { if (this.dbg.state === 'halted') await this.dbg.continue(); } catch { /* best effort */ }
    }
    await this.shutdown();
    this.event('terminated');
  }

  protected async on_terminate() {
    await this.shutdown();
    this.event('terminated');
  }

  // ------------------------------------------------------------ events

  private emitStopped(stop: StoppedDetail, forced?: string) {
    const r = stop.reason;
    let reason = forced ?? 'pause';
    let description: string | undefined;
    if (!forced) {
      if (r === 'Step') reason = 'step';
      else if (r === 'Request') reason = 'pause';
      else if (r === 'Exception') reason = 'exception';
      else if (typeof r === 'object' && 'Breakpoint' in r) {
        const cause = r.Breakpoint;
        reason = typeof cause === 'object' && 'Semihosting' in cause ? 'semihosting' : 'breakpoint';
      } else {
        reason = 'pause';
        description = typeof r === 'string' ? r : JSON.stringify(r);
      }
    }
    this.event('stopped', {
      reason,
      description,
      threadId: THREAD,
      allThreadsStopped: true,
      hitBreakpointIds: stop.breakpoints.length ? stop.breakpoints : undefined,
    });
  }

  private emitBreakpointChanges(_list: Breakpoint[]) {
    // Breakpoint responses already carry the state; nothing is changed behind the client's back yet.
  }

  // ------------------------------------------------------------ breakpoints

  private toDapBreakpoint(b: Breakpoint): DP.Breakpoint {
    return {
      id: b.id,
      verified: b.verified,
      message: b.message ?? undefined,
      line: b.source?.line ? this.line(b.source.line) : b.line !== null ? this.line(b.line) : undefined,
      column: b.source?.column ? this.column(b.source.column) : undefined,
      source: b.source ? { name: basename(b.source.path), path: b.source.path } : undefined,
      instructionReference: b.address !== null ? hex(b.address) : undefined,
    };
  }

  protected async on_setBreakpoints(_r: DP.SetBreakpointsRequest, a: DP.SetBreakpointsArguments): Promise<DP.SetBreakpointsResponse['body']> {
    const path = a.source.path;
    if (!path) throw new DapError('setBreakpoints needs source.path');
    const requested: DP.SourceBreakpoint[] = a.breakpoints ?? a.lines?.map((line) => ({ line })) ?? [];
    const specs = requested.map((b) => ({
      line: this.fromClientLine(b.line),
      column: b.column === undefined ? undefined : this.clientColumnsStartAt1 ? b.column : b.column + 1,
    }));
    const placed = await this.d.setSourceBreakpoints(path, specs);
    return { breakpoints: placed.map((b) => this.toDapBreakpoint(b)) };
  }

  protected async on_setInstructionBreakpoints(_r: DP.SetInstructionBreakpointsRequest, a: DP.SetInstructionBreakpointsArguments): Promise<DP.SetInstructionBreakpointsResponse['body']> {
    const addresses = a.breakpoints.map((b) => BigInt(b.instructionReference) + BigInt(b.offset ?? 0));
    const placed = await this.d.setInstructionBreakpoints(addresses);
    return { breakpoints: placed.map((b) => this.toDapBreakpoint(b)) };
  }

  // ------------------------------------------------------------ threads, stack, variables

  protected async on_threads(): Promise<DP.ThreadsResponse['body']> {
    return { threads: [{ id: THREAD, name: 'core 0' }] };
  }

  protected async on_stackTrace(_r: DP.StackTraceRequest, a: DP.StackTraceArguments): Promise<DP.StackTraceResponse['body']> {
    const d = this.d;
    if (d.state !== 'halted') throw new DapError('the core is running');
    const frames = await d.stackTrace();
    const start = a.startFrame ?? 0;
    const end = a.levels ? start + a.levels : frames.length;
    return {
      totalFrames: frames.length,
      stackFrames: frames.slice(start, end).map((f) => ({
        id: f.id,
        name: f.functionName,
        source: f.source ? { name: basename(f.source.path), path: f.source.path } : undefined,
        line: f.source?.line ? this.line(f.source.line) : 0,
        column: f.source ? this.column(f.source.column) : 0,
        instructionPointerReference: hex(f.pc),
        presentationHint: f.inlined ? 'subtle' : 'normal',
      })),
    };
  }

  protected async on_scopes(_r: DP.ScopesRequest, a: DP.ScopesArguments): Promise<DP.ScopesResponse['body']> {
    const scopes = await this.d.scopes(a.frameId);
    return {
      scopes: scopes.map((s) => ({
        name: s.name,
        variablesReference: s.reference,
        expensive: s.expensive,
        presentationHint: s.name === 'Variables' ? 'locals' : s.name === 'Registers' ? 'registers' : undefined,
      })),
    };
  }

  /** Variables references of the Registers scope, so setVariable can route register writes. */
  private registerScopes = new Set<number>();

  protected async on_variables(_r: DP.VariablesRequest, a: DP.VariablesArguments): Promise<DP.VariablesResponse['body']> {
    const vars = await this.d.variables(a.variablesReference, a.filter);
    return {
      variables: vars.map((v) => {
        if (v.type === 'Platform Register') this.registerScopes.add(a.variablesReference);
        return {
          name: v.name,
          value: v.value,
          type: v.type ?? undefined,
          variablesReference: v.reference,
          evaluateName: v.evaluateName ?? undefined,
          memoryReference: v.memoryReference ?? undefined,
          namedVariables: v.namedChildren ?? undefined,
          indexedVariables: v.indexedChildren ?? undefined,
        };
      }),
    };
  }

  protected async on_setVariable(_r: DP.SetVariableRequest, a: DP.SetVariableArguments): Promise<DP.SetVariableResponse['body']> {
    const d = this.d;
    if (this.registerScopes.has(a.variablesReference)) {
      // Registers are listed as "R0/a1/r1"; the first alias is the register name.
      const name = a.name.split('/')[0];
      await d.writeRegister(name, BigInt(a.value));
      return { value: a.value };
    }
    const r = await d.setVariable({ name: a.name, parent: a.variablesReference }, a.value);
    return { value: r.value, type: r.type ?? undefined, variablesReference: r.reference, memoryReference: r.memoryReference ?? undefined };
  }

  protected async on_evaluate(_r: DP.EvaluateRequest, a: DP.EvaluateArguments): Promise<DP.EvaluateResponse['body']> {
    const r = await this.d.evaluate(a.expression, a.frameId);
    return { result: r.value, type: r.type ?? undefined, variablesReference: r.reference, memoryReference: r.memoryReference ?? undefined };
  }

  protected async on_source(_r: DP.SourceRequest, a: DP.SourceArguments): Promise<DP.SourceResponse['body']> {
    const path = a.source?.path;
    const text = path && this.opts.sources ? await this.opts.sources.read(path) : null;
    if (text === null) throw new DapError(`source not available: ${path ?? a.sourceReference}`);
    return { content: text };
  }

  // ------------------------------------------------------------ run control

  protected async on_continue(): Promise<DP.ContinueResponse['body']> {
    await this.d.continue();
    return { allThreadsContinued: true };
  }

  protected async on_pause() {
    await this.d.pause();
  }

  private async stepWith(a: DP.StepInArguments | DP.NextArguments | DP.StepOutArguments, mode: 'over' | 'into' | 'out') {
    const result = await this.d.step(a.granularity === 'instruction' ? 'instruction' : mode);
    if (result.warning) this.event('output', { category: 'console', output: `step: ${result.warning}\n` });
  }

  protected async on_next(_r: DP.NextRequest, a: DP.NextArguments) { await this.stepWith(a, 'over'); }
  protected async on_stepIn(_r: DP.StepInRequest, a: DP.StepInArguments) { await this.stepWith(a, 'into'); }
  protected async on_stepOut(_r: DP.StepOutRequest, a: DP.StepOutArguments) { await this.stepWith(a, 'out'); }

  // ------------------------------------------------------------ memory & disassembly

  protected async on_readMemory(_r: DP.ReadMemoryRequest, a: DP.ReadMemoryArguments): Promise<DP.ReadMemoryResponse['body']> {
    const address = BigInt(a.memoryReference) + BigInt(a.offset ?? 0);
    const bytes = await this.d.readMemory(address, a.count);
    return { address: hex(address), data: toBase64(bytes), unreadableBytes: a.count - bytes.length || undefined };
  }

  protected async on_writeMemory(_r: DP.WriteMemoryRequest, a: DP.WriteMemoryArguments): Promise<DP.WriteMemoryResponse['body']> {
    const address = BigInt(a.memoryReference) + BigInt(a.offset ?? 0);
    const data = fromBase64(a.data);
    await this.d.writeMemory(address, data);
    this.event('memory', { memoryReference: a.memoryReference, offset: a.offset ?? 0, count: data.length });
    return { bytesWritten: data.length };
  }

  protected async on_disassemble(_r: DP.DisassembleRequest, a: DP.DisassembleArguments): Promise<DP.DisassembleResponse['body']> {
    const list = await this.d.disassemble(BigInt(a.memoryReference), a.instructionCount, a.instructionOffset ?? 0, a.offset ?? 0);
    return {
      instructions: list.map((i) => ({
        address: hex(i.address),
        instruction: i.text,
        instructionBytes: i.bytes ?? undefined,
        location: i.source ? { name: basename(i.source.path), path: i.source.path } : undefined,
        line: i.source?.line ? this.line(i.source.line) : undefined,
      })),
    };
  }
}

/**
 * The default `connect`: WebSocket to `probe-rs serve`, attach, flash on launch
 * (unless `flash: false`), load debug info and the optional SVD.
 */
export async function connectProbeRs(args: ProbeLaunchArguments, kind: 'launch' | 'attach'): Promise<ConnectResult> {
  const { Client } = await import('@probe-web/client');
  if (!args.url) throw new Error('launch/attach needs `url` (probe-rs serve WebSocket URL)');
  const client = await Client.connect({ kind: 'websocket', url: args.url, token: args.token ?? '' });
  try {
    const probes = await client.listProbes();
    const want = args.probe?.toLowerCase();
    const probe = want ? probes.find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want)) : probes[0];
    if (!probe) throw new Error(`no probe matching ${JSON.stringify(args.probe ?? '')}`);
    const session = await client.attach({ probe, chip: args.chip, protocol: args.protocol ?? 'Swd' });
    const program = args.program === undefined ? null : await bytesOf(args.program);
    const name = typeof args.program === 'string' ? args.program : 'program.elf';
    if (program && kind === 'launch' && args.flash !== false) {
      await session.flash({ image: program, name, format: args.format ?? 'target', options: { verify: true } });
    }
    const dbg = session.debugger();
    if (program) await dbg.loadDebugInfo(program, name);
    const { elfHasRtt } = await import('@probe-web/client');
    if (program && args.rtt !== false && elfHasRtt(program)) await dbg.enableRtt({ elf: program });
    if (args.svd !== undefined) await dbg.loadSvd(await bytesOf(args.svd), typeof args.svd === 'string' ? args.svd : 'device.svd');
    return { debugger: dbg, close: () => client.close() };
  } catch (e) {
    client.close();
    throw e;
  }
}

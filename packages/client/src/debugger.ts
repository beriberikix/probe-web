/**
 * `Debugger`: run control and inspection for one core, on top of probe-rs's
 * RPC (the WebSocket transport to `probe-rs serve`; the WebUSB worker lacks
 * these endpoints). It is the single owner of debug state for its core, so UI
 * components and the DAP adapter never call the raw endpoints directly:
 *
 * - calls are serialised (the server handles one request at a time anyway, and
 *   ordering matters: debug state must be cleared before the core resumes);
 * - a status poller turns `core/status` into `stopped` / `continued` events,
 *   because the server sends no halt notifications;
 * - register names and widths come from probe-rs's own tables
 *   (`registers.generated.ts`), since the RPC identifies registers by id only.
 */
import type * as Wire from './wire';
import type { RttChannelConfigInput } from './index.ts';
import { armCommon, cortexM, cortexMFp, riscv, v8mMain, v8mSecurity, xtensa, type RegisterInfo } from './registers.generated.ts';

export type { RegisterInfo };

/** The subset of the SDK `Session` the debugger needs (kept structural for tests with fakes). */
export interface DebugSessionLike {
  targetMetadata(): Promise<Wire.WireSessionTargetMetadata>;
  raw: {
    clearCoreDebugState(core: number): Promise<void>;
    step(core: number, mode: Wire.WireSteppingMode): Promise<unknown>;
    loadDebugInfo(elf: Uint8Array, name: string): Promise<void>;
    loadSvd(core: number, svd: Uint8Array, name: string): Promise<void>;
    clearSvd(core: number): Promise<void>;
    richStackTrace(core: number, limit: number): Promise<unknown>;
    scopes(core: number, frameId: number): Promise<unknown>;
    variables(core: number, reference: number, filter?: string | null): Promise<unknown>;
    evaluate(core: number, frameId: number | null | undefined, expression: string): Promise<unknown>;
    setVariable(core: number, parentKey: bigint, name: string, value: string): Promise<unknown>;
    resolveSourceBreakpoints(locations: Wire.SourceBreakpointLocation[]): Promise<unknown>;
    resolveSourceLocations(addresses: BigUint64Array): Promise<unknown>;
    disassemble(core: number, memoryReference: bigint, byteOffset: bigint, instructionOffset: bigint, count: bigint): Promise<unknown>;
    rttChannels?(): Promise<unknown>;
    pollRtt?(channels: Uint32Array): Promise<unknown>;
  };
  /** Whether the server implements an endpoint (the SDK Session; optional so tests can omit it). */
  supports?(path: keyof Wire.Endpoints): boolean;
  /** The SDK Session's RTT setup (optional so tests can omit it). */
  createRttClient?(opts: { elf?: Uint8Array; channels?: RttChannelConfigInput[] }): Promise<unknown>;
  core(index: number): DebugCoreLike;
}

export interface DebugCoreLike {
  raw: {
    status(): Promise<unknown>;
    halt(timeoutMs: number): Promise<unknown>;
    run(): Promise<void>;
    reset(): Promise<void>;
    resetAndHalt(timeoutMs: number): Promise<unknown>;
    metadata(): Promise<unknown>;
    readRegisters(ids: Uint16Array): Promise<unknown>;
    writeRegister(id: number, value: Wire.WireRegisterValue): Promise<void>;
    readBytes(address: bigint, count: number): Promise<Uint8Array>;
    writeMemory8(address: bigint, data: Uint8Array): Promise<void>;
    enableVectorCatch(condition: Wire.WireVectorCatchCondition): Promise<void>;
    setHwBreakpoints(addresses: BigUint64Array): Promise<unknown>;
    clearHwBreakpoints(addresses: BigUint64Array): Promise<void>;
    handleSemihosting?(): Promise<unknown>;
  };
}

export type RunState = 'running' | 'halted' | 'sleeping' | 'locked-up' | 'unknown';

export interface StoppedDetail {
  /** Why the core halted. Debugger-initiated stops report `Request` (pause) or `Step`. */
  reason: Wire.WireHaltReason;
  pc: bigint;
  /** Ids of the breakpoints at `pc` when the stop was a breakpoint. */
  breakpoints: number[];
}

export interface Breakpoint {
  id: number;
  kind: 'source' | 'instruction';
  /** Source breakpoints: the path as requested (a workspace-relative suffix works) and 1-based line. */
  path: string | null;
  line: number | null;
  column: number | null;
  /** Set on the target (hardware comparator allocated). */
  verified: boolean;
  /** Where it was placed: probe-rs moves source breakpoints to a valid statement. */
  address: bigint | null;
  /** The resolved location (source breakpoints may move to another line). */
  source: SourceLocation | null;
  /** Why it is not verified, e.g. no code at that line or no free comparator. */
  message: string | null;
}

export interface Instruction {
  address: bigint;
  text: string;
  bytes: string | null;
  source: SourceLocation | null;
}

export interface RegisterValue {
  info: RegisterInfo;
  value: bigint;
}

/** A stack frame from the last stop. Only valid while `epoch` equals the debugger's epoch. */
export interface Frame {
  /** Frame handle; also the variables reference of the frame's Registers scope. */
  id: number;
  functionName: string;
  pc: bigint;
  inlined: boolean;
  source: SourceLocation | null;
  epoch: number;
}

export interface SourceLocation {
  /** Absolute path as recorded in DWARF at build time. */
  path: string;
  line: number | null;
  column: number | null;
}

export interface Scope {
  name: string;
  /** Pass to `variables()`; 0 means no children. */
  reference: number;
  expensive: boolean;
  hint: string | null;
}

export interface Variable {
  name: string;
  value: string;
  type: string | null;
  /** Pass to `variables()` for children; 0 means none. */
  reference: number;
  /** The reference of the scope or variable this was listed under (the key `setVariable` needs). */
  parent: number;
  evaluateName: string | null;
  memoryReference: string | null;
  namedChildren: number | null;
  indexedChildren: number | null;
}

export interface Evaluation {
  value: string;
  type: string | null;
  reference: number;
  memoryReference: string | null;
}

/** Raw bytes from a binary RTT channel (`rtt-bytes` event), for plotting or decoding. */
export interface RttBytes {
  channel: number;
  bytes: Uint8Array;
}

/** Target output seen while debugging (`output` event). */
export type DebugOutput =
  | { source: 'rtt'; channel: number; text: string }
  | { source: 'semihosting'; text: string };

export type SteppingMode = 'instruction' | 'over' | 'into' | 'out';

const STEP_MODES: Record<SteppingMode, Wire.WireSteppingMode> = {
  instruction: 'StepInstruction',
  over: 'OverStatement',
  into: 'IntoStatement',
  out: 'OutOfStatement',
};

export interface DebuggerOptions {
  core?: number;
  /** Poll interval while the core runs (ms). The server sends no halt events. */
  pollRunningMs?: number;
  /** Poll interval while the core is halted (ms). */
  pollHaltedMs?: number;
  /** Timeout for halt requests (ms). */
  haltTimeoutMs?: number;
  /**
   * How `step('out')` is performed.
   *
   * `server` asks probe-rs to step out. `caller-breakpoint` instead runs to the caller's return
   * address, which the stack trace already gives us. `auto` (the default) picks
   * `caller-breakpoint` on Xtensa, where probe-rs's step out walks the windowed register file
   * wrongly and leaves the function's caller behind, and `server` everywhere else.
   */
  stepOut?: StepOutStrategy;
  /** How long `step('out')` waits for the caller to be reached (ms). */
  stepOutTimeoutMs?: number;
}

export type StepOutStrategy = 'auto' | 'server' | 'caller-breakpoint';

function wireSourceLocation(l: Wire.WireSourceLocation): SourceLocation {
  const column = l.column === null ? null : l.column === 'LeftEdge' ? 1 : Number(l.column.Column);
  return { path: l.path, line: l.line === null ? null : Number(l.line), column };
}

function isSemihostingHalt(s: Wire.WireCoreStatus): boolean {
  if (typeof s !== 'object' || !('Halted' in s)) return false;
  const r = s.Halted;
  return typeof r === 'object' && 'Breakpoint' in r && typeof r.Breakpoint === 'object' && 'Semihosting' in r.Breakpoint;
}

function runState(s: Wire.WireCoreStatus): RunState {
  if (s === 'Running') return 'running';
  if (s === 'Sleeping') return 'sleeping';
  if (s === 'LockedUp') return 'locked-up';
  if (typeof s === 'object' && 'Halted' in s) return 'halted';
  return 'unknown';
}

export function registerValueToBigInt(v: Wire.WireRegisterValue): bigint {
  if ('U32' in v) return BigInt(v.U32 >>> 0);
  if ('U64' in v) return v.U64;
  return v.U128;
}

function registerValueFromBigInt(info: RegisterInfo, value: bigint): Wire.WireRegisterValue {
  if (info.bits <= 32) return { U32: Number(BigInt.asUintN(32, value)) };
  if (info.bits <= 64) return { U64: BigInt.asUintN(64, value) };
  return { U128: BigInt.asUintN(128, value) };
}

/** Registers probe-rs knows for a core type (a superset; unreadable ones are dropped when read). */
export function registerTable(coreType: Wire.WireCoreType, fpu: boolean): RegisterInfo[] {
  switch (coreType) {
    case 'Armv6m':
      return [...armCommon, ...cortexM];
    case 'Armv7m':
    case 'Armv7em':
      return [...armCommon, ...cortexM, ...(fpu ? cortexMFp : [])];
    case 'Armv8m':
      return [...armCommon, ...cortexM, ...v8mMain, ...v8mSecurity, ...(fpu ? cortexMFp : [])];
    case 'Riscv':
    case 'Riscv64':
      return riscv;
    case 'Xtensa':
      return xtensa;
    default:
      // A-profile tables are not generated yet.
      return armCommon;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Debugger extends EventTarget {
  readonly session: DebugSessionLike;
  readonly coreIndex: number;
  readonly core: DebugCoreLike;
  private readonly opts: Required<Omit<DebuggerOptions, 'core'>>;
  private rttBusy = false;
  private queue: Promise<unknown> = Promise.resolve();
  private polling = false;
  private disposed = false;
  private lastState: RunState | null = null;
  private registers: RegisterInfo[] | null = null;
  private coreType: Wire.WireCoreType | null = null;
  /** Increments whenever the core resumes; results tied to a stop carry it. */
  epoch = 0;
  private frames: Frame[] | null = null;
  private framesEpoch = -1;
  /** Variable references handed out during the current epoch (the server panics on unknown ones). */
  private liveRefs = new Set<number>();
  private hasDebugInfo = false;
  private sourceBreakpoints = new Map<string, Breakpoint[]>();
  private instructionBreakpoints: Breakpoint[] = [];
  /** Hardware breakpoint addresses set on the target, with how many breakpoints use each. */
  private hwRefs = new Map<bigint, number>();
  private nextBreakpointId = 1;
  private rtt: { channels: number[] | null; flushAfterStop: boolean } | null = null;
  state: RunState = 'unknown';
  lastStop: StoppedDetail | null = null;

  constructor(session: DebugSessionLike, options: DebuggerOptions = {}) {
    super();
    this.session = session;
    this.coreIndex = options.core ?? 0;
    this.core = session.core(this.coreIndex);
    this.opts = {
      pollRunningMs: options.pollRunningMs ?? 50,
      pollHaltedMs: options.pollHaltedMs ?? 200,
      haltTimeoutMs: options.haltTimeoutMs ?? 500,
      stepOut: options.stepOut ?? 'auto',
      stepOutTimeoutMs: options.stepOutTimeoutMs ?? 5_000,
    };
  }

  /** The core is about to move: frame and variable handles from the last stop become stale. */
  private invalidate() {
    this.epoch++;
    this.frames = null;
    this.liveRefs.clear();
  }

  /** Serialise a call behind every earlier one. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private emit(type: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Record a new state; emits `stopped`/`continued` only on transitions. */
  private noteStatus(status: Wire.WireCoreStatus, pc?: bigint) {
    const next = runState(status);
    const prev = this.lastState;
    this.lastState = next;
    this.state = next;
    if (next === prev) return;
    if (next === 'halted' && typeof status === 'object') {
      if (prev !== null && prev !== 'halted') {
        // The core ran since we last looked (e.g. resumed by another tool): new stop, new handles.
        this.epoch++;
        this.frames = null;
        this.liveRefs.clear();
      }
      const at = pc ?? this.lastStop?.pc ?? 0n;
      const isBreakpoint = typeof status.Halted === 'object' && 'Breakpoint' in status.Halted;
      this.lastStop = { reason: status.Halted, pc: at, breakpoints: isBreakpoint ? this.breakpointsAt(at) : [] };
      if (this.rtt) this.rtt.flushAfterStop = true;
      this.emit('stopped', this.lastStop);
    } else if (next === 'running' || next === 'sleeping') {
      this.lastStop = null;
      this.emit('continued');
    } else if (next === 'locked-up') {
      this.emit('locked-up');
    }
    this.emit('state', next);
  }

  /** Current status, read now (not from the poller). */
  refresh(): Promise<RunState> {
    return this.exclusive(async () => {
      let status = (await this.core.raw.status()) as Wire.WireCoreStatus;
      if (isSemihostingHalt(status) && this.core.raw.handleSemihosting) {
        // The core stopped on a semihosting call: let the server service it (it resumes the core
        // for console/file writes) and report its output instead of a stop.
        const result = (await this.core.raw.handleSemihosting()) as { status: Wire.WireCoreStatus; events: Wire.WireSemihostingUiEvent[] };
        for (const ev of result.events) {
          const text = typeof ev === 'object' && 'LogToConsole' in ev ? ev.LogToConsole + '\n'
            : typeof ev === 'object' && 'RttOutput' in ev ? ev.RttOutput.data : null;
          if (text !== null) this.emit('output', { source: 'semihosting', text } satisfies DebugOutput);
        }
        status = result.status;
      }
      const pc = runState(status) === 'halted' && this.lastState !== 'halted' ? await this.readPcUnlocked() : undefined;
      this.noteStatus(status, pc);
      return this.state;
    });
  }

  /** Start polling `core/status` (idempotent). Stops on `dispose()`. */
  start(): void {
    if (this.polling || this.disposed) return;
    this.polling = true;
    void (async () => {
      while (!this.disposed) {
        try {
          await this.refresh();
          if (this.rtt && (this.state === 'running' || this.state === 'sleeping' || this.rtt.flushAfterStop)) {
            this.rtt.flushAfterStop = false;
            await this.pollRtt();
          }
        } catch (e) {
          this.emit('error', e);
        }
        await sleep(this.state === 'halted' ? this.opts.pollHaltedMs : this.opts.pollRunningMs);
      }
      this.polling = false;
    })();
  }

  dispose(): void {
    this.disposed = true;
  }

  private async readPcUnlocked(): Promise<bigint> {
    const table = await this.registerTableUnlocked();
    const pc = table.find((r) => r.roles.includes('ProgramCounter'));
    if (!pc) return 0n;
    const [res] = (await this.core.raw.readRegisters(new Uint16Array([pc.id]))) as Wire.WireRegisterReadResult[];
    return res && 'Ok' in res.result ? registerValueToBigInt(res.result.Ok) : 0n;
  }

  private async registerTableUnlocked(): Promise<RegisterInfo[]> {
    if (!this.registers) {
      const meta = await this.session.targetMetadata();
      const coreType = meta.cores.find((c) => c.index === this.coreIndex)?.core_type ?? 'Armv7m';
      this.coreType = coreType;
      const coreMeta = (await this.core.raw.metadata()) as Wire.WireCoreMetadata;
      let table = registerTable(coreType, coreMeta.fpu_support);
      const fpCount = coreMeta.floating_point_register_count;
      if (fpCount !== null) {
        // Keep only the FP registers this core has (FPSCR + S0..S<n-1>).
        let seen = 0;
        table = table.filter((r) => !(r.roles.includes('FloatingPoint') && seen++ >= Number(fpCount)));
      }
      this.registers = table;
    }
    return this.registers;
  }

  /** Register names, ids and widths for this core. */
  registerTable(): Promise<RegisterInfo[]> {
    return this.exclusive(() => this.registerTableUnlocked());
  }

  // ------------------------------------------------------------ run control

  /** Halt; emits `stopped` with reason `Request`. */
  pause(): Promise<StoppedDetail> {
    return this.exclusive(async () => {
      const info = (await this.core.raw.halt(this.opts.haltTimeoutMs)) as Wire.WireCoreInformation;
      this.noteStatus({ Halted: 'Request' }, info.pc);
      return this.lastStop!;
    });
  }

  /** Resume. Clears the server's per-core debug state first, so no stale frame or variable ids survive. */
  continue(): Promise<void> {
    return this.exclusive(async () => {
      await this.session.raw.clearCoreDebugState(this.coreIndex);
      this.invalidate();
      await this.core.raw.run();
      this.noteStatus('Running');
    });
  }

  /** Step (`instruction` needs no debug info; the others need `loadDebugInfo`). Emits `stopped` with reason `Step`. */
  step(mode: SteppingMode): Promise<{ pc: bigint; warning: string | null }> {
    return this.exclusive(async () => {
      if (mode === 'out' && (await this.stepOutStrategyUnlocked()) === 'caller-breakpoint') {
        const stepped = await this.stepOutToCallerUnlocked();
        if (stepped) return stepped;
        // No caller to return to (or no comparator free): fall through to probe-rs.
      }
      await this.session.raw.clearCoreDebugState(this.coreIndex);
      this.invalidate();
      const pc = this.lastStop?.pc;
      // A statement step that starts on one of our hardware breakpoints can stop on that same
      // breakpoint without moving (seen with step out on a Cortex-M33). Lift the breakpoint for
      // the duration of the step and put it back afterwards.
      const lifted = mode !== 'instruction' && pc !== undefined && this.hwRefs.has(pc) ? pc : null;
      if (lifted !== null) await this.core.raw.clearHwBreakpoints(new BigUint64Array([lifted]));
      let res: Wire.StepResponse;
      try {
        res = (await this.session.raw.step(this.coreIndex, STEP_MODES[mode])) as Wire.StepResponse;
      } finally {
        if (lifted !== null) await this.core.raw.setHwBreakpoints(new BigUint64Array([lifted]));
      }
      // Force a transition so listeners refresh even though the core was already halted
      // (null, not 'running': the epoch was already bumped above).
      this.lastState = null;
      this.noteStatus({ Halted: 'Step' }, res.program_counter);
      return { pc: res.program_counter, warning: res.warning };
    });
  }

  private async stepOutStrategyUnlocked(): Promise<StepOutStrategy> {
    const configured = this.opts.stepOut;
    if (configured !== 'auto') return configured;
    // registerTableUnlocked caches the core type on the way past.
    await this.registerTableUnlocked();
    return this.coreType === 'Xtensa' ? 'caller-breakpoint' : 'server';
  }

  /**
   * Step out by running to the caller's return address, which the stack trace already knows.
   *
   * Returns null when it cannot be done — no caller frame, or no comparator free — so the caller
   * can fall back to probe-rs's own step out. A recursive function can hit the same address in a
   * deeper frame, so the stop only counts once the stack pointer is above where it started.
   */
  private async stepOutToCallerUnlocked(): Promise<{ pc: bigint; warning: string | null } | null> {
    const frames = await this.framesUnlocked(8);
    const caller = frames.slice(1).find((f) => !f.inlined);
    if (!caller) return null;

    const table = await this.registerTableUnlocked();
    const spId = table.find((r) => r.roles.includes('StackPointer'))?.id;
    const spBefore = spId === undefined ? null : await this.readRegisterUnlocked(spId);

    const already = this.hwRefs.has(caller.pc);
    if (!already) {
      const failed = await this.acquire([caller.pc]);
      if (failed.has(caller.pc)) return null;
    }

    const deadline = Date.now() + this.opts.stepOutTimeoutMs;
    try {
      for (;;) {
        await this.session.raw.clearCoreDebugState(this.coreIndex);
        this.invalidate();
        await this.core.raw.run();
        // The deadline covers the whole step, not just one wait: a recursive function can hit
        // the caller's address again and again.
        const status = Date.now() >= deadline ? null : await this.waitForHaltUnlocked(deadline);
        if (!status) {
          // Still running: leave it halted where it is rather than pretending to have stepped.
          const info = (await this.core.raw.halt(this.opts.haltTimeoutMs)) as Wire.WireCoreInformation;
          this.lastState = null;
          this.noteStatus({ Halted: 'Request' }, info.pc);
          return { pc: info.pc, warning: 'step out timed out; the caller was not reached' };
        }
        const pc = await this.readPcUnlocked();
        const sp = spId === undefined ? null : await this.readRegisterUnlocked(spId);
        const returned = spBefore === null || sp === null || sp > spBefore;
        if (pc !== caller.pc || returned) {
          this.lastState = null;
          // Stopping anywhere else means another breakpoint won the race; report it as such.
          this.noteStatus(pc === caller.pc ? { Halted: 'Step' } : { Halted: { Breakpoint: 'Hardware' } }, pc);
          return { pc, warning: null };
        }
        // Same address, same frame depth: a recursive call, so keep going until the deadline.
        if (Date.now() >= deadline) {
          const info = (await this.core.raw.halt(this.opts.haltTimeoutMs)) as Wire.WireCoreInformation;
          this.lastState = null;
          this.noteStatus({ Halted: 'Request' }, info.pc);
          return { pc: info.pc, warning: 'step out timed out; the caller was not reached' };
        }
      }
    } finally {
      if (!already) await this.release([caller.pc]);
    }
  }

  private async readRegisterUnlocked(id: number): Promise<bigint | null> {
    const [res] = (await this.core.raw.readRegisters(new Uint16Array([id]))) as Wire.WireRegisterReadResult[];
    return res && 'Ok' in res.result ? registerValueToBigInt(res.result.Ok) : null;
  }

  /** Poll until the core halts, or `deadline` passes (in which case: null). */
  private async waitForHaltUnlocked(deadline: number): Promise<Wire.WireCoreStatus | null> {
    for (;;) {
      const status = (await this.core.raw.status()) as Wire.WireCoreStatus;
      if (runState(status) === 'halted') return status;
      if (Date.now() >= deadline) return null;
      await sleep(this.opts.pollRunningMs);
    }
  }

  /** Reset and keep running. Breakpoints are armed again (see `resetAndHalt`). */
  reset(): Promise<void> {
    return this.exclusive(async () => {
      await this.session.raw.clearCoreDebugState(this.coreIndex);
      this.invalidate();
      // Halt through the reset so breakpoints are armed before the firmware runs past them.
      if (!this.hasBreakpoints()) {
        await this.core.raw.reset();
        this.noteStatus('Running');
        return false;
      }
      await this.core.raw.resetAndHalt(this.opts.haltTimeoutMs);
      return true;
    }).then(async (rearm) => {
      if (!rearm) return;
      await this.reapplyBreakpoints();
      await this.exclusive(async () => {
        await this.core.raw.run();
        this.noteStatus('Running');
      });
    });
  }

  /**
   * Reset and halt at the reset vector; emits `stopped`. Breakpoints are armed again afterwards:
   * a reset clears the hardware comparators on some targets (MCX family, ESP32-S3).
   */
  resetAndHalt(): Promise<StoppedDetail> {
    return this.exclusive(async () => {
      await this.session.raw.clearCoreDebugState(this.coreIndex);
      this.invalidate();
      const info = (await this.core.raw.resetAndHalt(this.opts.haltTimeoutMs)) as Wire.WireCoreInformation;
      this.lastState = null;
      this.noteStatus({ Halted: 'Request' }, info.pc);
      return this.lastStop!;
    }).then(async (stop) => {
      if (this.hasBreakpoints()) await this.reapplyBreakpoints();
      return stop;
    });
  }

  private hasBreakpoints(): boolean {
    return this.sourceBreakpoints.size > 0 || this.instructionBreakpoints.length > 0;
  }

  enableVectorCatch(condition: Wire.WireVectorCatchCondition): Promise<void> {
    return this.exclusive(() => this.core.raw.enableVectorCatch(condition));
  }

  // ------------------------------------------------------------ debug info, stack, variables

  /** Upload an ELF (content-hash cached on the server) and load its DWARF. Needed for statement
   *  stepping, source breakpoints, stack traces with names, and every variables query. */
  loadDebugInfo(elf: Uint8Array, name = 'firmware.elf'): Promise<void> {
    return this.exclusive(async () => {
      await this.session.raw.loadDebugInfo(elf, name);
      this.hasDebugInfo = true;
      this.frames = null;
      this.liveRefs.clear();
    }).then(async () => {
      // Source lines may map to different addresses in the new image.
      if (this.sourceBreakpoints.size) await this.reapplyBreakpoints();
    });
  }

  /** Load a CMSIS-SVD file; its peripherals appear as the Peripherals scope. */
  loadSvd(svd: Uint8Array, name = 'device.svd'): Promise<void> {
    return this.exclusive(() => this.session.raw.loadSvd(this.coreIndex, svd, name));
  }

  clearSvd(): Promise<void> {
    return this.exclusive(() => this.session.raw.clearSvd(this.coreIndex));
  }

  private requireHalted(what: string) {
    if (this.state !== 'halted') {
      throw Object.assign(new Error(`${what} needs a halted core (state: ${this.state})`), { kind: 'not-halted' });
    }
  }

  private requireDebugInfo(what: string) {
    if (!this.hasDebugInfo) {
      throw Object.assign(new Error(`${what} needs debug info: call loadDebugInfo first`), { kind: 'no-debug-info' });
    }
  }

  private async framesUnlocked(limit: number): Promise<Frame[]> {
    if (this.frames && this.framesEpoch === this.epoch) return this.frames;
    this.requireHalted('a stack trace');
    const traces = (await this.session.raw.richStackTrace(this.coreIndex, limit)) as Wire.RichStackTraces;
    const trace = traces.cores.find((c) => c.core === this.coreIndex) ?? traces.cores[0];
    this.liveRefs.clear();
    this.frames = (trace?.frames ?? []).map((f) => {
      this.liveRefs.add(f.id);
      return {
        id: f.id,
        functionName: f.function_name,
        pc: registerValueToBigInt(f.program_counter),
        inlined: f.is_inlined,
        source: f.location
          ? { path: f.location.file, line: f.location.line === null ? null : Number(f.location.line), column: f.location.column === null ? null : Number(f.location.column) }
          : null,
        epoch: this.epoch,
      };
    });
    this.framesEpoch = this.epoch;
    return this.frames;
  }

  /** Stack frames of the current stop (taken once per stop, then cached). The core must be halted. */
  stackTrace(limit = 200): Promise<Frame[]> {
    return this.exclusive(() => this.framesUnlocked(limit));
  }

  private checkFrame(frameId: number) {
    if (!this.frames || this.framesEpoch !== this.epoch || !this.frames.some((f) => f.id === frameId)) {
      throw Object.assign(new Error(`frame ${frameId} is not part of the current stop`), { kind: 'stale-reference' });
    }
  }

  private checkRef(reference: number) {
    if (!this.liveRefs.has(reference)) {
      throw Object.assign(new Error(`variables reference ${reference} is not from the current stop`), { kind: 'stale-reference' });
    }
  }

  /** Scopes of a frame: Static, Peripherals (with an SVD), Registers, Variables. */
  scopes(frameId: number): Promise<Scope[]> {
    return this.exclusive(async () => {
      this.requireDebugInfo('scopes');
      await this.framesUnlocked(200);
      this.checkFrame(frameId);
      const scopes = (await this.session.raw.scopes(this.coreIndex, frameId)) as Wire.WireScope[];
      return scopes.map((sc) => {
        const reference = Number(sc.variables_reference);
        if (reference) this.liveRefs.add(reference);
        return { name: sc.name, reference, expensive: sc.expensive, hint: sc.presentation_hint };
      });
    });
  }

  /** Children of a scope or variable. `filter`: `indexed` or `named` to page large aggregates. */
  variables(reference: number, filter?: 'indexed' | 'named'): Promise<Variable[]> {
    return this.exclusive(async () => {
      this.requireDebugInfo('variables');
      this.checkRef(reference);
      const vars = (await this.session.raw.variables(this.coreIndex, reference, filter ?? null)) as Wire.WireVariable[];
      return vars.map((v) => {
        const child = Number(v.variables_reference);
        if (child) this.liveRefs.add(child);
        return {
          name: v.name,
          value: v.value,
          type: v.type_,
          reference: child,
          parent: reference,
          evaluateName: v.evaluate_name,
          memoryReference: v.memory_reference,
          namedChildren: v.named_variables === null ? null : Number(v.named_variables),
          indexedChildren: v.indexed_variables === null ? null : Number(v.indexed_variables),
        };
      });
    });
  }

  /** Look up a register, a variable in the frame, or a static by name (probe-rs has no expression parser). */
  evaluate(expression: string, frameId?: number): Promise<Evaluation> {
    return this.exclusive(async () => {
      this.requireDebugInfo('evaluate');
      await this.framesUnlocked(200);
      if (frameId !== undefined) this.checkFrame(frameId);
      const r = (await this.session.raw.evaluate(this.coreIndex, frameId ?? null, expression)) as Wire.WireEvaluateResponse;
      const reference = Number(r.variables_reference);
      if (reference) this.liveRefs.add(reference);
      return { value: r.result, type: r.type_, reference, memoryReference: r.memory_reference };
    });
  }

  /** Write a variable's value (parsed by probe-rs for the variable's type). Registers: use `writeRegister`. */
  setVariable(variable: Pick<Variable, 'name' | 'parent'>, value: string): Promise<Evaluation> {
    return this.exclusive(async () => {
      this.requireDebugInfo('setVariable');
      this.requireHalted('setVariable');
      this.checkRef(variable.parent);
      const r = (await this.session.raw.setVariable(this.coreIndex, BigInt(variable.parent), variable.name, value)) as Wire.WireSetVariableResponse;
      const reference = Number(r.variables_reference);
      if (reference) this.liveRefs.add(reference);
      return { value: r.value, type: r.type_, reference, memoryReference: r.memory_reference };
    });
  }

  // ------------------------------------------------------------ breakpoints

  private breakpointsAt(address: bigint): number[] {
    return this.allBreakpoints().filter((b) => b.verified && b.address === address).map((b) => b.id);
  }

  private allBreakpoints(): Breakpoint[] {
    return [...[...this.sourceBreakpoints.values()].flat(), ...this.instructionBreakpoints];
  }

  /** Every breakpoint, source then instruction. */
  breakpoints(): Breakpoint[] {
    return this.allBreakpoints();
  }

  /** Set comparators for addresses not yet on the target; returns an error message per failed address. */
  private async acquire(addresses: bigint[]): Promise<Map<bigint, string>> {
    const failed = new Map<bigint, string>();
    const fresh = [...new Set(addresses)].filter((a) => !this.hwRefs.has(a));
    if (fresh.length) {
      const results = (await this.core.raw.setHwBreakpoints(new BigUint64Array(fresh))) as ({ Ok: null } | { Err: string })[];
      fresh.forEach((a, i) => {
        const r = results[i];
        if (r && 'Err' in r) failed.set(a, r.Err);
      });
    }
    for (const a of addresses) {
      if (!failed.has(a)) this.hwRefs.set(a, (this.hwRefs.get(a) ?? 0) + 1);
    }
    return failed;
  }

  /** Drop one use of each address; clears comparators nothing uses any more. */
  private async release(addresses: bigint[]): Promise<void> {
    const clear: bigint[] = [];
    for (const a of addresses) {
      const n = (this.hwRefs.get(a) ?? 0) - 1;
      if (n > 0) this.hwRefs.set(a, n);
      else if (this.hwRefs.delete(a)) clear.push(a);
    }
    if (clear.length) await this.core.raw.clearHwBreakpoints(new BigUint64Array(clear));
  }

  private verifiedAddresses(list: Breakpoint[]): bigint[] {
    return list.filter((b) => b.verified && b.address !== null).map((b) => b.address!);
  }

  private async placeSource(path: string, specs: { line: number; column?: number }[]): Promise<Breakpoint[]> {
    if (!specs.length) return [];
    const resolutions = (await this.session.raw.resolveSourceBreakpoints(
      specs.map((sp) => ({ path, line: BigInt(sp.line), column: sp.column === undefined ? null : BigInt(sp.column) })),
    )) as Wire.BreakpointResolution[];
    const placed = resolutions.map((r, i): Breakpoint => {
      const bp = r.breakpoint;
      return {
        id: this.nextBreakpointId++,
        kind: 'source',
        path,
        line: specs[i].line,
        column: specs[i].column ?? null,
        verified: !!bp,
        address: bp ? bp.address : null,
        source: bp ? wireSourceLocation(bp.source_location) : null,
        message: bp ? null : r.error ?? 'no code at this location',
      };
    });
    const failed = await this.acquire(this.verifiedAddresses(placed));
    for (const b of placed) {
      if (b.address !== null && failed.has(b.address)) {
        b.verified = false;
        b.message = failed.get(b.address)!;
      }
    }
    return placed;
  }

  /**
   * Replace the breakpoints in one source file (as DAP `setBreakpoints` does). `path` may be the
   * absolute build path or a relative suffix such as `src/main.rs`. Needs debug info.
   */
  setSourceBreakpoints(path: string, specs: { line: number; column?: number }[]): Promise<Breakpoint[]> {
    return this.exclusive(async () => {
      this.requireDebugInfo('source breakpoints');
      await this.release(this.verifiedAddresses(this.sourceBreakpoints.get(path) ?? []));
      const placed = await this.placeSource(path, specs);
      if (placed.length) this.sourceBreakpoints.set(path, placed);
      else this.sourceBreakpoints.delete(path);
      this.emit('breakpoints', this.allBreakpoints());
      return placed;
    });
  }

  /** Replace all instruction (address) breakpoints. */
  setInstructionBreakpoints(addresses: (number | bigint)[]): Promise<Breakpoint[]> {
    return this.exclusive(async () => {
      await this.release(this.verifiedAddresses(this.instructionBreakpoints));
      const wanted = addresses.map((a) => BigInt(a));
      const failed = await this.acquire(wanted);
      const locations = this.hasDebugInfo && wanted.length
        ? ((await this.session.raw.resolveSourceLocations(new BigUint64Array(wanted))) as (Wire.WireSourceLocation | null)[])
        : [];
      this.instructionBreakpoints = wanted.map((address, i) => ({
        id: this.nextBreakpointId++,
        kind: 'instruction',
        path: null,
        line: null,
        column: null,
        verified: !failed.has(address),
        address,
        source: locations[i] ? wireSourceLocation(locations[i]!) : null,
        message: failed.get(address) ?? null,
      }));
      this.emit('breakpoints', this.allBreakpoints());
      return this.instructionBreakpoints;
    });
  }

  /** Remove every breakpoint from the target. */
  clearBreakpoints(): Promise<void> {
    return this.exclusive(async () => {
      const all = [...this.hwRefs.keys()];
      this.hwRefs.clear();
      this.sourceBreakpoints.clear();
      this.instructionBreakpoints = [];
      if (all.length) await this.core.raw.clearHwBreakpoints(new BigUint64Array(all));
      this.emit('breakpoints', []);
    });
  }

  /**
   * Set every breakpoint again: after loading a new ELF (source lines may map elsewhere) or on
   * targets that lose comparators on reset (MCX family, ESP32-S3); `reset`/`resetAndHalt` call it.
   */
  reapplyBreakpoints(): Promise<Breakpoint[]> {
    return this.exclusive(async () => {
      const sources = [...this.sourceBreakpoints.entries()].map(([path, list]) => [path, list.map((b) => ({ line: b.line!, column: b.column ?? undefined }))] as const);
      const instructions = this.instructionBreakpoints.map((b) => b.address!);
      const all = [...this.hwRefs.keys()];
      this.hwRefs.clear();
      // After a reset the comparators may already be empty; clearing is best effort.
      if (all.length) await this.core.raw.clearHwBreakpoints(new BigUint64Array(all)).catch(() => {});
      this.sourceBreakpoints.clear();
      if (this.hasDebugInfo) {
        for (const [path, specs] of sources) this.sourceBreakpoints.set(path, await this.placeSource(path, specs));
      }
      const failed = await this.acquire(instructions);
      this.instructionBreakpoints = this.instructionBreakpoints.map((b) => ({ ...b, verified: !failed.has(b.address!), message: failed.get(b.address!) ?? null }));
      this.emit('breakpoints', this.allBreakpoints());
      return this.allBreakpoints();
    });
  }

  // ------------------------------------------------------------ source & disassembly

  /** Source locations for addresses (null where there is no line information). */
  resolveSourceLocations(addresses: (number | bigint)[]): Promise<(SourceLocation | null)[]> {
    return this.exclusive(async () => {
      this.requireDebugInfo('resolveSourceLocations');
      const locs = (await this.session.raw.resolveSourceLocations(new BigUint64Array(addresses.map((a) => BigInt(a))))) as (Wire.WireSourceLocation | null)[];
      return locs.map((l) => (l ? wireSourceLocation(l) : null));
    });
  }

  /**
   * Disassemble `count` instructions starting at `address` shifted by `instructionOffset`
   * instructions (negative looks backwards, as DAP `disassemble` does).
   */
  /**
   * Whether this connection can disassemble. `probe-rs serve` can; the WebUSB worker cannot
   * (probe-rs uses capstone, which is C code). Views should show that instead of an error.
   */
  get canDisassemble(): boolean {
    return this.session.supports?.('core/disassemble') ?? true;
  }

  disassemble(address: number | bigint, count: number, instructionOffset = 0, byteOffset = 0): Promise<Instruction[]> {
    if (!this.canDisassemble) {
      return Promise.reject(Object.assign(new Error('disassembly is not available on this connection (the WebUSB transport has no disassembler)'), { kind: 'unsupported' }));
    }
    return this.exclusive(async () => {
      const list = (await this.session.raw.disassemble(this.coreIndex, BigInt(address), BigInt(byteOffset), BigInt(instructionOffset), BigInt(count))) as Wire.WireDisassembledInstruction[];
      return list.map((ins) => ({
        address: BigInt(ins.address),
        text: ins.instruction,
        bytes: ins.instruction_bytes,
        source: ins.location?.path
          ? { path: ins.location.path, line: ins.line === null ? null : Number(ins.line), column: ins.column === null ? null : Number(ins.column) }
          : null,
      }));
    });
  }

  // ------------------------------------------------------------ target output

  /**
   * Show the firmware's RTT output while debugging: creates an RTT client (with an exact scan
   * region when `elf` links `_SEGGER_RTT`) and polls its up channels whenever the poller runs
   * (`start()`); output arrives as `output` events. Semihosting output is reported the same way
   * without calling this.
   */
  enableRtt(options: { elf?: Uint8Array; channels?: RttChannelConfigInput[] } = {}): Promise<void> {
    return this.exclusive(async () => {
      if (!this.session.createRttClient) throw Object.assign(new Error('RTT needs an SDK session'), { kind: 'unsupported' });
      // Channels default to `String`. A firmware writing samples has to say so, or its
      // bytes arrive decoded as text and the `rtt-bytes` event never fires.
      await this.session.createRttClient({ elf: options.elf, channels: options.channels });
      this.rtt = { channels: null, flushAfterStop: false };
    });
  }

  /** Read RTT once now (the poller does this while the core runs). */
  pollRtt(): Promise<void> {
    return this.exclusive(async () => {
      const rtt = this.rtt;
      const raw = this.session.raw;
      if (!rtt || !raw.rttChannels || !raw.pollRtt || this.rttBusy) return;
      this.rttBusy = true;
      try {
        if (!rtt.channels) {
          try {
            const ch = (await raw.rttChannels()) as { up: { number: number }[] };
            // No up channels yet means the firmware has not initialised its control block (e.g.
            // right after flashing, when RAM holds none); ask again on the next poll.
            if (!ch.up.length) return;
            rtt.channels = ch.up.map((c) => c.number);
          } catch {
            return; // control block not set up yet; try again on the next poll
          }
        }
        const outputs = (await raw.pollRtt(new Uint32Array(rtt.channels))) as (
          | { kind: 'text'; channel: number; text: string }
          | { kind: 'defmt'; channel: number; lines: { level: string | null; message: string }[] }
          | { kind: 'bytes'; channel: number; bytes: number[] }
          | { kind: 'error'; channel: number; message: string }
        )[];
        for (const o of outputs) {
          // A BinaryLE channel carries data, not text. Hex is what a console can show, but
          // it is lossy for anything that wants the values — a plot, say — so the raw
          // bytes go out as their own event and the hex line is kept for the console.
          if (o.kind === 'bytes') {
            // Binary channels report bytes only. Rendering them as hex into the same
            // stream as the text channels reads as noise and, worse, interleaves with a
            // partial text line and corrupts it — which is how this was found: a DAP
            // check that parses `n=… result=…` lines started losing them once a firmware
            // gained a second, binary channel.
            this.emit('rtt-bytes', { channel: o.channel, bytes: Uint8Array.from(o.bytes) } satisfies RttBytes);
            continue;
          }
          const text = o.kind === 'text' ? o.text
            : o.kind === 'defmt' ? o.lines.map((l) => `${l.level ? l.level.toUpperCase() + ' ' : ''}${l.message}\n`).join('')
            : null;
          if (text) this.emit('output', { source: 'rtt', channel: o.channel, text } satisfies DebugOutput);
        }
      } finally {
        this.rttBusy = false;
      }
    });
  }

  // ------------------------------------------------------------ registers & memory

  /** Read every register in the table; registers the core does not have are left out. */
  readRegisters(): Promise<RegisterValue[]> {
    return this.exclusive(async () => {
      const table = await this.registerTableUnlocked();
      const results = (await this.core.raw.readRegisters(new Uint16Array(table.map((r) => r.id)))) as Wire.WireRegisterReadResult[];
      const byId = new Map(table.map((r) => [r.id, r]));
      const out: RegisterValue[] = [];
      for (const r of results) {
        const info = byId.get(r.id);
        if (info && 'Ok' in r.result) out.push({ info, value: registerValueToBigInt(r.result.Ok) });
      }
      return out;
    });
  }

  /** Write a register by name (case-insensitive) or id. The core must be halted. */
  writeRegister(register: string | number, value: bigint): Promise<void> {
    return this.exclusive(async () => {
      const table = await this.registerTableUnlocked();
      const info = typeof register === 'number'
        ? table.find((r) => r.id === register)
        : table.find((r) => r.name.toLowerCase() === register.toLowerCase());
      if (!info) throw Object.assign(new Error(`unknown register ${register}`), { kind: 'unknown-register' });
      await this.core.raw.writeRegister(info.id, registerValueFromBigInt(info, value));
    });
  }

  /** Read up to `count` bytes; a shorter result means the rest is unreadable. */
  readMemory(address: number | bigint, count: number): Promise<Uint8Array> {
    return this.exclusive(() => this.core.raw.readBytes(BigInt(address), count));
  }

  writeMemory(address: number | bigint, data: Uint8Array): Promise<void> {
    return this.exclusive(() => this.core.raw.writeMemory8(BigInt(address), data));
  }
}

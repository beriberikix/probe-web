/**
 * @probe-web/client — the headless probe-rs SDK for browsers (and Node over
 * WebSocket). One API, two transports: a native `probe-rs serve` over
 * WebSocket, or probe-rs itself compiled to wasm inside a Web Worker over
 * WebUSB. Wire types are generated from the probe-rs RPC schema (`./wire`).
 */
import init, { ProbeWebClient, ProbeWebSession, ProbeWebCore, elfSymbolAddress, rttSymbolAddress } from '../wasm/probe_web_core.js';
import type * as Wire from './wire';
import { Debugger, type DebugSessionLike, type DebuggerOptions } from './debugger.ts';

export type { Wire };
export { Debugger, registerTable, registerValueToBigInt } from './debugger.ts';
export { DirectorySourceProvider, UrlSourceProvider, matchSourcePath } from './sources.ts';
export { fromEmbedToml, fromLaunchJson, importConfig, type ImportedConfig } from './config.ts';
export type { DirectoryHandleLike, SourceProvider } from './sources.ts';
export type { Breakpoint, DebugOutput, DebuggerOptions, Evaluation, Frame, Instruction, RegisterInfo, RegisterValue, RttBytes, RunState, Scope, SourceLocation, SteppingMode, StoppedDetail, Variable } from './debugger.ts';

let wasmReady: Promise<unknown> | null = null;

/** Address of a symbol in an ELF (exact name). Call after `ensureWasm()`. */
export function elfSymbol(elf: Uint8Array, name: string): bigint | undefined {
  return elfSymbolAddress(elf, name);
}

/** Whether an ELF links an RTT control block (`_SEGGER_RTT`). Call after `ensureWasm()`. */
export function elfHasRtt(elf: Uint8Array): boolean {
  return rttSymbolAddress(elf) !== undefined;
}

const isNode = !!(globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;

/** Instantiate the wasm module once. Called implicitly by `Client.connect`. */
export function ensureWasm(): Promise<unknown> {
  if (!wasmReady) {
    wasmReady = isNode
      ? (async () => {
          // Node's fetch cannot load file: URLs; read the module from disk. The
          // specifier is a variable so browser bundlers leave it alone.
          const fsName = 'node:fs/promises';
          const { readFile } = (await import(/* @vite-ignore */ fsName)) as { readFile(u: URL): Promise<Uint8Array> };
          return init({ module_or_path: await readFile(new URL('../wasm/probe_web_core_bg.wasm', import.meta.url)) });
        })()
      : init();
  }
  return wasmReady;
}

export type Transport =
  | { kind: 'websocket'; url: string; token?: string }
  | {
      kind: 'webusb';
      /** Defaults to a worker running probe-rs; tests pass the fake-probe worker from
       * `@probe-web/client/testing`. */
      worker?: Worker;
    };

/**
 * Create the worker that hosts probe-rs for the WebUSB transport. `log` raises
 * probe-rs's tracing level inside the worker (its output is mirrored to the page
 * as `log:` messages); in a browser it also comes from `?workerLog=` on the page.
 */
export function createLocalWorker(opts: { log?: string } = {}): Worker {
  // The URL is written out in full: a bundler only recognises a worker, and so only emits its
  // chunk, when the URL is a literal. The fake-probe worker lives in `@probe-web/client/testing`
  // for the same reason — referencing it here would put a second 12 MB wasm module into every
  // deployed page.
  const worker = new Worker(new URL('../worker/local-worker.js', import.meta.url), { type: 'module' });
  worker.postMessage(`init:${workerLogLevel(opts.log) ?? ''}`);
  return worker;
}

/** The worker's probe-rs tracing level: explicit, else `?workerLog=` on the page. */
export function workerLogLevel(explicit?: string): string | undefined {
  return (
    explicit ??
    (typeof location !== 'undefined'
      ? (new URLSearchParams(location.search).get('workerLog') ?? undefined)
      : undefined)
  );
}

export interface ProbeWebError extends Error {
  /** e.g. `transport`, `remote`, `probe-in-use-other-tab`, `worker-crashed` */
  kind?: string;
  connectUnderReset?: boolean;
}

export type FormatName = 'target' | 'elf' | 'bin' | 'hex' | 'uf2' | 'idf';

export interface FlashJob {
  /** Image bytes, or something fetchable into bytes. */
  image: Uint8Array | ArrayBuffer | Blob | string | Promise<Uint8Array>;
  /** Name used for upload caching and logs. */
  name?: string;
  format?: FormatName;
  /** For `bin` images: where to place them (default: first NVM region). */
  baseAddress?: number | bigint;
  /** For `bin` images: bytes to skip at the start. */
  skip?: number;
  options?: Partial<DownloadOptionsInput>;
}

export interface DownloadOptionsInput {
  keepUnwrittenBytes: boolean;
  doChipErase: boolean;
  skipErase: boolean;
  verify: boolean;
  disableDoubleBuffering: boolean;
  preferredAlgos: string[];
  ramChunkSize?: number | bigint;
}

export interface AttachOptions {
  probe: Wire.DebugProbeEntry;
  /** probe-rs chip name, or omit for auto-detection. */
  chip?: string;
  protocol?: 'Swd' | 'Jtag';
  speedKhz?: number;
  connectUnderReset?: boolean;
  allowEraseAll?: boolean;
}

export type ProgressEvent = Wire.ProgressEvent;
export type ProgressListener = (event: ProgressEvent) => void;

export type MonitorEvent =
  | { kind: 'rtt-discovered'; up: Wire.ChannelInfo[]; down: Wire.ChannelInfo[] }
  | { kind: 'text'; channel: number; text: string }
  | { kind: 'defmt'; channel: number; lines: { level: string | null; message: string; location: string | null }[]; malformed: boolean }
  | { kind: 'bytes'; channel: number; bytes: number[] }
  | { kind: 'semihosting'; stream: string; data: string };

export interface RttChannelConfigInput {
  channelNumber?: number;
  dataFormat?: 'String' | 'BinaryLE' | 'Defmt';
  mode?: 'NoBlockSkip' | 'NoBlockTrim' | 'BlockIfFull';
  showTimestamps?: boolean;
  showLocation?: boolean;
}

async function toBytes(image: FlashJob['image']): Promise<Uint8Array> {
  if (image instanceof Promise) return image;
  if (image instanceof Uint8Array) return image;
  if (image instanceof ArrayBuffer) return new Uint8Array(image);
  if (typeof image === 'string') {
    const res = await fetch(image);
    if (!res.ok) throw new Error(`fetch ${image}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  return new Uint8Array(await image.arrayBuffer());
}

function formatOptions(job: FlashJob): Wire.FormatOptions {
  const kind = (job.format ?? 'target');
  const binary_format = (kind.charAt(0).toUpperCase() + kind.slice(1)) as Wire.FormatKind;
  return {
    binary_format,
    bin_options: {
      base_address: job.baseAddress === undefined ? null : BigInt(job.baseAddress),
      skip: job.skip ?? 0,
    },
    idf_options: {
      idf_bootloader: null,
      idf_partition_table: null,
      idf_target_app_partition: null,
      idf_flash_mode: null,
      idf_flash_freq: null,
    },
    elf_options: { skip_section: [] },
  };
}

function downloadOptions(o: Partial<DownloadOptionsInput> = {}): Wire.DownloadOptions {
  return {
    keep_unwritten_bytes: o.keepUnwrittenBytes ?? false,
    do_chip_erase: o.doChipErase ?? false,
    skip_erase: o.skipErase ?? false,
    verify: o.verify ?? true,
    disable_double_buffering: o.disableDoubleBuffering ?? false,
    preferred_algos: o.preferredAlgos ?? [],
    ram_chunk_size: o.ramChunkSize === undefined ? null : BigInt(o.ramChunkSize),
  };
}

function rttConfig(c: RttChannelConfigInput = {}): Wire.RttChannelConfig {
  return {
    channelNumber: c.channelNumber ?? null,
    dataFormat: c.dataFormat ?? 'String',
    mode: c.mode ?? null,
    showTimestamps: c.showTimestamps ?? true,
    showLocation: c.showLocation ?? false,
    logFormat: null,
  };
}

/** Why a local worker died, once it has (set from its `fatal:` message or `error` event). */
interface CrashState { reason: string | null }

function crashedError(state: CrashState, cause: unknown): unknown {
  if (!state.reason) return cause;
  const err = new Error(`the probe-rs worker crashed: ${state.reason}`) as ProbeWebError & { cause?: unknown };
  err.kind = 'worker-crashed';
  err.cause = cause;
  return err;
}

/**
 * Wrap a wasm-bindgen object so that, once the worker behind it has died, its
 * failures surface as `kind: 'worker-crashed'` with the worker's reason rather
 * than a generic transport error. Objects it returns (sessions, cores) are
 * wrapped too.
 */
function guardCrash<T extends object>(raw: T, state: CrashState): T {
  const wrap = (x: unknown) => (x && typeof x === 'object' && '__wbg_ptr' in x ? guardCrash(x, state) : x);
  return new Proxy(raw, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || prop === 'constructor' || prop === 'free') return value;
      return (...args: unknown[]) => {
        let result: unknown;
        try {
          result = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (e) {
          throw crashedError(state, e);
        }
        if (result instanceof Promise) {
          return result.then(wrap, (e) => { throw crashedError(state, e); });
        }
        return wrap(result);
      };
    },
  });
}

export class Client {
  private worker: Worker | null = null;
  private releaseLock: (() => void) | null = null;
  private crash: CrashState | null = null;
  /** Why the local worker died, or `null` while it is alive (always `null` over WebSocket). */
  get crashReason(): string | null {
    return this.crash?.reason ?? null;
  }
  readonly raw: ProbeWebClient;
  readonly transport: Transport['kind'];
  // Plain fields (no parameter properties): Node runs this file with type stripping only.
  private constructor(raw: ProbeWebClient, transport: Transport['kind']) {
    this.raw = raw;
    this.transport = transport;
  }

  /** Close the transport: terminates the worker (releasing the USB device and
   *  the cross-tab lock) or drops the WebSocket. The client is unusable after. */
  close(): void {
    this.releaseLock?.();
    this.releaseLock = null;
    this.worker?.terminate();
    this.worker = null;
    this.raw.close();
    this.raw.free();
  }

  static async connect(transport: Transport): Promise<Client> {
    await ensureWasm();
    if (transport.kind === 'websocket') {
      const raw = await ProbeWebClient.connectWebSocket(transport.url, transport.token ?? '');
      return new Client(raw, 'websocket');
    }
    const worker = transport.worker ?? createLocalWorker();
    // Listen before connecting, so a crash during start-up is attributed too. This
    // listener runs before the transport's own handler closes the channel.
    const crash: CrashState = { reason: null };
    worker.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string' && ev.data.startsWith('fatal:')) crash.reason ??= ev.data.slice('fatal:'.length);
    });
    worker.addEventListener('error', (ev) => { crash.reason ??= ev.message || 'uncaught error in the worker'; });
    const raw = await ProbeWebClient.connectWorker(worker);
    const client = new Client(guardCrash(raw, crash), 'webusb');
    client.worker = worker;
    client.crash = crash;
    return client;
  }

  /** Endpoints/topics the connected server does not implement (RPC paths). */
  capabilities(): { unsupportedEndpoints: string[]; unsupportedTopics: string[] } {
    return this.raw.capabilities() as { unsupportedEndpoints: string[]; unsupportedTopics: string[] };
  }
  /** Whether the server implements an RPC endpoint path, e.g. `"stack_trace/scopes"`. */
  supports(path: keyof Wire.Endpoints): boolean {
    return !this.capabilities().unsupportedEndpoints.includes(path);
  }

  listProbes(): Promise<Wire.DebugProbeEntry[]> {
    return this.raw.listProbes() as Promise<Wire.DebugProbeEntry[]>;
  }
  listChipFamilies(): Promise<Wire.ChipFamily[]> {
    return this.raw.listChipFamilies() as Promise<Wire.ChipFamily[]>;
  }
  chipInfo(name: string): Promise<Wire.ChipData> {
    return this.raw.chipInfo(name) as Promise<Wire.ChipData>;
  }
  loadChipFamily(yaml: string): Promise<void> {
    return this.raw.loadChipFamily(yaml);
  }

  /** Enumerate what is behind a probe (DP/AP, ROM tables, IDCODEs) with no chip definition. */
  info(opts: { probe: Wire.DebugProbeEntry; protocol?: 'Swd' | 'Jtag'; speedKhz?: number; connectUnderReset?: boolean; targetSel?: number; scanChain?: number[] }, onEvent: (e: Wire.InfoEvent) => void): Promise<void> {
    const req: Wire.TargetInfoRequest = {
      probe: opts.probe,
      speed: opts.speedKhz ?? null,
      connect_under_reset: opts.connectUnderReset ?? false,
      dry_run: false,
      target_sel: opts.targetSel ?? null,
      protocol: opts.protocol ?? 'Swd',
      scan_chain: opts.scanChain ?? [],
    };
    return this.raw.info(req, onEvent as (e: unknown) => void);
  }

  async attach(opts: AttachOptions): Promise<Session> {
    if (this.transport === 'webusb' && !this.releaseLock) {
      // Chrome claims the USB interface per tab; take a cross-tab lock so a
      // second tab gets a clear error instead of an opaque USB failure.
      const release = await acquireProbeLock(`${opts.probe.vendor_id}:${opts.probe.product_id}:${opts.probe.serial_number}`);
      if (!release) {
        const e = new Error('this probe is in use by another tab of this site') as ProbeWebError;
        e.kind = 'probe-in-use-other-tab';
        throw e;
      }
      this.releaseLock = release;
    }
    const req: Wire.AttachRequest = {
      chip: opts.chip ?? null,
      protocol: opts.protocol ?? null,
      probe: opts.probe,
      speed: opts.speedKhz ?? null,
      connect_under_reset: opts.connectUnderReset ?? false,
      dry_run: false,
      allow_erase_all: opts.allowEraseAll ?? false,
      resume_target: false,
      wait_for_probe: null,
    };
    const raw = await this.raw.attach(req);
    return new Session(raw, (path) => this.supports(path));
  }
}

/** RPC endpoints a `Debugger` needs; missing on the WebUSB worker today. */
const DEBUG_ENDPOINTS: (keyof Wire.Endpoints)[] = ['core/step', 'core/read_registers', 'stack_trace/rich', 'stack_trace/scopes', 'debug_state/load_debug_info'];

/** What {@link openSession} needs: a transport, which probe (substring of its name or serial), and the target. */
export interface OpenSessionOptions {
  transport: 'websocket' | 'webusb';
  /** WebSocket URL of `probe-rs serve` (default `ws://127.0.0.1:3000`). */
  url?: string;
  token?: string;
  /** A worker to host probe-rs in, instead of the default one (tests pass the fake-probe worker). */
  worker?: Worker;
  /** Case-insensitive substring of the probe's name or serial number; the first probe when omitted. */
  probe?: string;
  chip?: string;
  protocol?: 'Swd' | 'Jtag';
  connectUnderReset?: boolean;
}

/**
 * Connect over either transport, pick a probe and attach: the same few lines every app and check
 * page needs. On WebUSB the probe must already be granted to the page (`requestProbe`).
 */
export async function openSession(opts: OpenSessionOptions): Promise<{ client: Client; session: Session; probe: Wire.DebugProbeEntry }> {
  const client = await Client.connect(
    opts.transport === 'webusb'
      ? { kind: 'webusb', worker: opts.worker }
      : { kind: 'websocket', url: opts.url ?? 'ws://127.0.0.1:3000', token: opts.token ?? '' },
  );
  try {
    const probes = await client.listProbes();
    const want = (opts.probe ?? '').toLowerCase();
    const probe = probes.find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want));
    if (!probe) {
      const where = opts.transport === 'webusb' ? 'granted to this page' : 'on the server';
      throw Object.assign(new Error(`no probe matching "${opts.probe ?? ''}" ${where} (found: ${probes.map((p) => p.identifier).join(', ') || 'none'})`), { kind: 'probe-not-found' });
    }
    const session = await client.attach({ probe, chip: opts.chip, protocol: opts.protocol, connectUnderReset: opts.connectUnderReset });
    return { client, session, probe };
  } catch (e) {
    client.close();
    throw e;
  }
}

export class Session {
  readonly raw: ProbeWebSession;
  /** Whether the server implements an endpoint (always true when unknown). */
  readonly supports: (path: keyof Wire.Endpoints) => boolean;
  constructor(raw: ProbeWebSession, supports: (path: keyof Wire.Endpoints) => boolean = () => true) {
    this.raw = raw;
    this.supports = supports;
  }

  targetMetadata(): Promise<Wire.WireSessionTargetMetadata> {
    return this.raw.targetMetadata() as Promise<Wire.WireSessionTargetMetadata>;
  }

  /** Program an image. Resolves with its BootInfo (pass to `boot`). */
  async flash(job: FlashJob, onProgress?: ProgressListener): Promise<Wire.BootInfo> {
    const bytes = await toBytes(job.image);
    const name = job.name ?? (typeof job.image === 'string' ? job.image : 'image');
    return this.raw.flash(bytes, name, formatOptions(job), downloadOptions(job.options), onProgress) as Promise<Wire.BootInfo>;
  }

  async verify(job: FlashJob, onProgress?: ProgressListener): Promise<Wire.VerifyResult> {
    const bytes = await toBytes(job.image);
    const name = job.name ?? (typeof job.image === 'string' ? job.image : 'image');
    return this.raw.verify(bytes, name, formatOptions(job), onProgress) as Promise<Wire.VerifyResult>;
  }

  eraseAll(onProgress?: ProgressListener): Promise<void> {
    return this.raw.eraseAll(onProgress);
  }

  boot(bootInfo: Wire.BootInfo, core = 0): Promise<void> {
    return this.raw.boot(bootInfo, core);
  }

  /** Configure RTT before flashing an image that contains a control block, and before `monitor`. */
  createRttClient(opts: { scanRegion?: Wire.ScanRegion; /** ELF of the firmware: its `_SEGGER_RTT` symbol gives an exact scan region */ elf?: Uint8Array; channels?: RttChannelConfigInput[]; defaults?: RttChannelConfigInput } = {}): Promise<Wire.RttClientData> {
    let region: Wire.ScanRegion = opts.scanRegion ?? 'Ram';
    if (!opts.scanRegion && opts.elf) {
      const addr = rttSymbolAddress(opts.elf);
      if (addr !== undefined) region = { Exact: addr };
    }
    return this.raw.createRttClient(
      region,
      (opts.channels ?? []).map(rttConfig),
      rttConfig(opts.defaults),
    ) as Promise<Wire.RttClientData>;
  }

  /** Monitor without RTT from now on (the server stops scanning for a control block). */
  clearRttClient(): void {
    this.raw.clearRttClient();
  }

  /** Provide the ELF whose defmt table decodes `Defmt` channels. */
  setDefmtElf(elf: Uint8Array): boolean {
    return this.raw.setDefmtElf(elf);
  }

  /** Run until cancelled or the core halts. `mode` is `'attach'` or the BootInfo from `flash`. */
  async monitor(mode: 'attach' | Wire.BootInfo, onEvent: (e: MonitorEvent) => void, opts: { catchReset?: boolean; catchHardfault?: boolean; catchSvc?: boolean; catchHlt?: boolean } = {}): Promise<Wire.MonitorExitReason> {
    const wireMode: Wire.MonitorMode = mode === 'attach' ? 'AttachToRunning' : { Run: mode };
    this.cancelled = false;
    try {
      return (await this.raw.monitor(wireMode, opts, onEvent as (e: unknown) => void)) as Wire.MonitorExitReason;
    } catch (e) {
      // probe-rs serve tears down the event channel on cancel before its run
      // loop notices; that surfaces as a send error. Report the cancel instead.
      if (this.cancelled && /channel closed|Failed to send/i.test(String((e as Error).message))) return 'UserExit';
      throw e;
    }
  }
  private cancelled = false;

  rttWrite(channel: number, data: Uint8Array | string, timeoutMs = 1000): Promise<number> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return this.raw.rttWrite(channel, bytes, timeoutMs);
  }

  /** Stop a running `monitor`. */
  cancel(): Promise<void> {
    this.cancelled = true;
    return this.raw.cancel();
  }

  core(index = 0): Core {
    return new Core(this.raw.core(index));
  }

  /** A `Debugger` for one core (WebSocket transport; see `debugger.ts`). */
  debugger(options: DebuggerOptions = {}): Debugger {
    const missing = DEBUG_ENDPOINTS.filter((e) => !this.supports(e));
    if (missing.length) {
      throw Object.assign(
        new Error(`debugging is not available on this connection (missing ${missing.join(', ')}); connect to probe-rs serve over WebSocket`),
        { kind: 'unsupported', missing },
      );
    }
    return new Debugger(this as unknown as DebugSessionLike, options);
  }
}

export class Core {
  readonly raw: ProbeWebCore;
  constructor(raw: ProbeWebCore) {
    this.raw = raw;
  }
  halt(timeoutMs = 500): Promise<Wire.WireCoreInformation> {
    return this.raw.halt(timeoutMs) as Promise<Wire.WireCoreInformation>;
  }
  run(): Promise<void> { return this.raw.run(); }
  status(): Promise<Wire.WireCoreStatus> { return this.raw.status() as Promise<Wire.WireCoreStatus>; }
  reset(): Promise<void> { return this.raw.reset(); }
  resetAndHalt(timeoutMs = 500): Promise<Wire.WireCoreInformation> {
    return this.raw.resetAndHalt(timeoutMs) as Promise<Wire.WireCoreInformation>;
  }
  readMemory8(address: number | bigint, count: number): Promise<Uint8Array> {
    return this.raw.readMemory8(BigInt(address), count);
  }
  readMemory32(address: number | bigint, count: number): Promise<Uint32Array> {
    return this.raw.readMemory32(BigInt(address), count);
  }
  writeMemory8(address: number | bigint, data: Uint8Array): Promise<void> {
    return this.raw.writeMemory8(BigInt(address), data);
  }
  writeMemory32(address: number | bigint, data: Uint32Array): Promise<void> {
    return this.raw.writeMemory32(BigInt(address), data);
  }

  /**
   * Registers plus the memory in `ranges`, as structured data.
   *
   * Ranges are `[start, end)` pairs. Reading is not free — the memory comes back over the
   * probe — so ask for the regions you care about, typically the stack and any RAM a
   * postmortem needs.
   */
  dumpCore(ranges: [number | bigint, number | bigint][]): Promise<Wire.WireCoreDump> {
    return this.raw.dumpCore(ranges.map(([a, b]) => [BigInt(a), BigInt(b)])) as Promise<Wire.WireCoreDump>;
  }

  /**
   * The same snapshot as a coredump *file*, in the encoding native `probe-rs` reads.
   *
   * Pair it with `downloadBytes` from `@probe-web/artifacts` to save it, then open it with
   * the usual tools — a dump taken in a browser is not a dead end.
   */
  dumpCoreFile(ranges: [number | bigint, number | bigint][]): Promise<Uint8Array> {
    return this.raw.dumpCoreFile(ranges.map(([a, b]) => [BigInt(a), BigInt(b)]));
  }
}

/** Hold a Web Lock for a probe until the returned function is called; `null` if another tab holds it. */
function acquireProbeLock(key: string): Promise<(() => void) | null> {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    void navigator.locks.request(`probe-web:${key}`, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(null); return; }
      resolve(release);
      return held;
    });
  });
}

/** Human-readable operation name from a ProgressEvent, or null. */
export function progressOperation(e: ProgressEvent): Wire.Operation | null {
  if (typeof e === 'string') return null;
  if ('Started' in e) return e.Started;
  if ('Finished' in e) return e.Finished;
  if ('Failed' in e) return e.Failed;
  if ('Progress' in e) return e.Progress.operation;
  if ('AddProgressBar' in e) return e.AddProgressBar.operation;
  return null;
}

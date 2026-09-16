/**
 * @probe-web/client — the headless probe-rs SDK for browsers (and Node over
 * WebSocket). One API, two transports: a native `probe-rs serve` over
 * WebSocket, or probe-rs itself compiled to wasm inside a Web Worker over
 * WebUSB. Wire types are generated from the probe-rs RPC schema (`./wire`).
 */
import init, { ProbeWebClient, ProbeWebSession, ProbeWebCore, rttSymbolAddress } from '../wasm/probe_web_core.js';
import type * as Wire from './wire';

export type { Wire };

let wasmReady: Promise<unknown> | null = null;
/** Instantiate the wasm module once. Called implicitly by `Client.connect`. */
export function ensureWasm(): Promise<unknown> {
  if (!wasmReady) wasmReady = init();
  return wasmReady;
}

export type Transport =
  | { kind: 'websocket'; url: string; token?: string }
  | { kind: 'webusb'; worker?: Worker; /** test-only build with a fake probe (mocked core) */ fake?: boolean };

/** Create the worker that hosts probe-rs for the WebUSB transport. */
export function createLocalWorker(opts: { fake?: boolean } = {}): Worker {
  const url = opts.fake
    ? new URL('../worker/fake/local-worker.js', import.meta.url)
    : new URL('../worker/local-worker.js', import.meta.url);
  return new Worker(url, { type: 'module' });
}

export interface ProbeWebError extends Error {
  kind?: string;
  connectUnderReset?: boolean;
}

export type FormatName = 'target' | 'elf' | 'bin' | 'hex' | 'uf2' | 'idf';

export interface FlashJob {
  /** Image bytes, or something fetchable into bytes. */
  image: Uint8Array | ArrayBuffer | Blob | string;
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

export class Client {
  private constructor(readonly raw: ProbeWebClient, readonly transport: Transport['kind']) {}

  static async connect(transport: Transport): Promise<Client> {
    await ensureWasm();
    if (transport.kind === 'websocket') {
      const raw = await ProbeWebClient.connectWebSocket(transport.url, transport.token ?? '');
      return new Client(raw, 'websocket');
    }
    const worker = transport.worker ?? createLocalWorker({ fake: transport.fake });
    const raw = await ProbeWebClient.connectWorker(worker);
    return new Client(raw, 'webusb');
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

  async attach(opts: AttachOptions): Promise<Session> {
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
    return new Session(raw);
  }
}

export class Session {
  constructor(readonly raw: ProbeWebSession) {}

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
}

export class Core {
  constructor(readonly raw: ProbeWebCore) {}
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

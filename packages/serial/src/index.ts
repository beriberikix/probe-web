/**
 * A WebSerial console for boards whose output goes to a UART bridge (ESP
 * devkits, Nucleo VCP, J-Link VCOM) rather than RTT. Not probe-rs; it sits
 * next to the probe so a page can show both.
 *
 * Chromium-only (WebSerial). {@link requestPort} needs a user gesture; granted
 * ports come back from {@link grantedPorts} on later visits.
 *
 * @example
 * ```ts
 * import { LineDecoder, SerialConnection, requestPort } from '@probe-web/serial';
 *
 * button.onclick = async () => {
 *   const port = await requestPort(); // user gesture: opens the chooser
 *   const lines = new LineDecoder();
 *   const conn = await SerialConnection.open(port, { baudRate: 115200 }, (bytes) => {
 *     for (const line of lines.push(bytes)) console.log(line);
 *   });
 *   await conn.write('help', 'crlf');
 *   conn.closed.then((reason) => console.log(`serial closed: ${reason}`));
 * };
 * ```
 *
 * @packageDocumentation
 */

/** The subset of the WebSerial API this package uses (no `@types` dependency). */
export interface SerialPortLike {
  /** Incoming bytes while open; `null` when closed or after a fatal error. */
  readonly readable: ReadableStream<Uint8Array> | null;
  /** Outgoing bytes while open; `null` when closed. */
  readonly writable: WritableStream<Uint8Array> | null;
  /** Open the port with these line settings. */
  open(options: SerialOpenOptions): Promise<void>;
  /** Close the port. */
  close(): Promise<void>;
  /** Set control lines (DTR, RTS) or send a break. */
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void>;
  /** USB ids of the bridge, when it is a USB device. */
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
  /** Fires `disconnect` when the device is unplugged. */
  addEventListener?(type: 'disconnect', listener: () => void): void;
}

/**
 * Line settings for {@link SerialConnection.open}, as WebSerial's
 * `SerialPort.open()` takes them. Unset fields default to 8N1 without flow
 * control.
 */
export interface SerialOpenOptions {
  /** Bits per second, e.g. one of {@link BAUD_RATES}. */
  baudRate: number;
  /** Data bits per frame (default 8). */
  dataBits?: 7 | 8;
  /** Stop bits per frame (default 1). */
  stopBits?: 1 | 2;
  /** Parity (default `none`). */
  parity?: 'none' | 'even' | 'odd';
  /** `hardware` uses RTS/CTS (default `none`). */
  flowControl?: 'none' | 'hardware';
  /** Size of the browser's read and write buffers, in bytes (browser default if unset). */
  bufferSize?: number;
}

interface SerialLike {
  requestPort(options?: { filters?: { usbVendorId?: number; usbProductId?: number }[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
  addEventListener(type: 'connect' | 'disconnect', listener: (e: Event) => void): void;
  removeEventListener(type: 'connect' | 'disconnect', listener: (e: Event) => void): void;
}

const serial = (): SerialLike | undefined => (globalThis.navigator as { serial?: SerialLike } | undefined)?.serial;

/** Common baud rates, for a rate picker. */
export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000] as const;

/** USB-UART bridges and probe VCOMs commonly found on dev boards. */
export const SERIAL_BRIDGE_FILTERS = [
  { usbVendorId: 0x10c4 }, // Silicon Labs CP210x
  { usbVendorId: 0x1a86 }, // WCH CH34x
  { usbVendorId: 0x0403 }, // FTDI
  { usbVendorId: 0x303a }, // Espressif native USB CDC
  { usbVendorId: 0x1366 }, // SEGGER J-Link VCOM
  { usbVendorId: 0x1915 }, // Nordic (Thingy:91 board controller, nRF USB CDC)
  { usbVendorId: 0x0483 }, // ST-Link VCP
  { usbVendorId: 0x1fc9 }, // NXP MCU-Link VCOM
  { usbVendorId: 0x0d28 }, // DAPLink VCOM
  { usbVendorId: 0x2e8a }, // Raspberry Pi (debugprobe, RP2040 CDC)
];

/** True when the browser exposes WebSerial (`navigator.serial`); Chromium-based desktop browsers only. */
export function hasWebSerial(): boolean {
  return !!serial();
}

/**
 * Open the browser's port chooser (needs a user gesture) and resolve with the
 * port the user picks. The chooser lists {@link SERIAL_BRIDGE_FILTERS}; `any`
 * drops those filters. Rejects if WebSerial is missing or the user cancels.
 */
export async function requestPort(opts: { any?: boolean } = {}): Promise<SerialPortLike> {
  const s = serial();
  if (!s) throw new Error('WebSerial is not available in this browser');
  return s.requestPort(opts.any ? {} : { filters: SERIAL_BRIDGE_FILTERS });
}

/** Ports this origin was granted before; empty without WebSerial. No user gesture needed. */
export async function grantedPorts(): Promise<SerialPortLike[]> {
  return serial()?.getPorts() ?? [];
}

/** Subscribe to port plug/unplug; returns an unsubscribe function. */
export function onPortsChanged(cb: (kind: 'connect' | 'disconnect') => void): () => void {
  const s = serial();
  if (!s) return () => {};
  const on = () => cb('connect');
  const off = () => cb('disconnect');
  s.addEventListener('connect', on);
  s.addEventListener('disconnect', off);
  return () => {
    s.removeEventListener('connect', on);
    s.removeEventListener('disconnect', off);
  };
}

/** A readable label for a port, from its USB ids. */
export function describePort(port: SerialPortLike): string {
  const info = port.getInfo?.() ?? {};
  if (info.usbVendorId === undefined) return 'serial port';
  const hex = (n: number) => n.toString(16).padStart(4, '0');
  return `USB ${hex(info.usbVendorId)}:${hex(info.usbProductId ?? 0)}`;
}

/**
 * Splits a byte stream into lines. Bytes are decoded as UTF-8 across chunk
 * boundaries; `\r\n` and `\n` end a line, a lone `\r` is dropped.
 */
export class LineDecoder {
  private decoder = new TextDecoder();
  private partial = '';

  /** Feed bytes; returns the complete lines they finished. */
  push(bytes: Uint8Array): string[] {
    this.partial += this.decoder.decode(bytes, { stream: true });
    const parts = this.partial.split('\n');
    this.partial = parts.pop() ?? '';
    return parts.map((l) => l.replace(/\r$/, ''));
  }

  /** Text received after the last newline. */
  get pending(): string {
    return this.partial;
  }
}

/** What {@link SerialConnection.write} appends to text: nothing, `\n`, `\r`, or `\r\n`. */
export type LineEnding = 'none' | 'lf' | 'cr' | 'crlf';
const ENDINGS: Record<LineEnding, string> = { none: '', lf: '\n', cr: '\r', crlf: '\r\n' };

/**
 * An open serial port with a read loop. Received bytes go to `onData`;
 * the connection ends on `close()`, on unplug, or on a fatal read error
 * (`closed` resolves with the reason).
 */
export class SerialConnection {
  /** The underlying port. */
  readonly port: SerialPortLike;
  /** Resolves once the connection has ended, with the reason (`closed`, `port closed`, `device disconnected`, `read error: …`). */
  readonly closed: Promise<string>;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private resolveClosed!: (reason: string) => void;
  private closing = false;
  /** Bytes received so far. */
  bytesIn = 0;
  /** Bytes written so far. */
  bytesOut = 0;

  private constructor(port: SerialPortLike) {
    this.port = port;
    this.closed = new Promise((r) => (this.resolveClosed = r));
  }

  /**
   * Open `port` with `options` (8N1, no flow control unless set) and start
   * reading; each received chunk is passed to `onData`.
   */
  static async open(port: SerialPortLike, options: SerialOpenOptions, onData: (bytes: Uint8Array) => void): Promise<SerialConnection> {
    await port.open({ dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', ...options });
    const c = new SerialConnection(port);
    port.addEventListener?.('disconnect', () => void c.finish('device disconnected'));
    void c.readLoop(onData);
    return c;
  }

  private async readLoop(onData: (bytes: Uint8Array) => void) {
    // A non-fatal error (framing/parity/overrun) ends one reader; `readable` comes back.
    while (!this.closing && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length) {
            this.bytesIn += value.length;
            onData(value);
          }
        }
      } catch (e) {
        if (!this.closing && !this.port.readable) {
          await this.finish(`read error: ${(e as Error).message ?? e}`);
          return;
        }
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
    await this.finish(this.closing ? 'closed' : 'port closed');
  }

  /** Write bytes, or text followed by `ending`. */
  async write(data: Uint8Array | string, ending: LineEnding = 'none'): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data + ENDINGS[ending]) : data;
    const w = this.port.writable?.getWriter();
    if (!w) throw new Error('port is not writable');
    try {
      await w.write(bytes);
      this.bytesOut += bytes.length;
    } finally {
      w.releaseLock();
    }
  }

  /** Set the DTR/RTS control lines. Throws if the port does not support control signals. */
  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void> {
    if (!this.port.setSignals) throw new Error('this port does not support control signals');
    await this.port.setSignals(signals);
  }

  /**
   * Pulse the target's reset through the bridge's RTS line, the wiring used
   * by ESP devkits (RTS → EN, DTR → IO0). DTR stays deasserted so the chip
   * boots the application rather than the ROM download mode.
   */
  async resetViaRts(pulseMs = 100): Promise<void> {
    await this.setSignals({ dataTerminalReady: false, requestToSend: true });
    await new Promise((r) => setTimeout(r, pulseMs));
    await this.setSignals({ dataTerminalReady: false, requestToSend: false });
  }

  /** Stop reading and close the port; {@link SerialConnection.closed} resolves with `closed`. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* already released */
    }
    await this.finish('closed');
  }

  private finished = false;
  private async finish(reason: string) {
    if (this.finished) return;
    this.finished = true;
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      await this.port.close();
    } catch {
      /* already closed (unplugged) */
    }
    this.resolveClosed(reason);
  }
}

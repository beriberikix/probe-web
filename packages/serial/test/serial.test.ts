import { describe, expect, it } from 'vitest';
import { LineDecoder, SerialConnection, type SerialOpenOptions, type SerialPortLike } from '../src/index';

describe('LineDecoder', () => {
  it('splits lines across chunks, handles CRLF and multi-byte UTF-8 split mid-character', () => {
    const d = new LineDecoder();
    const enc = new TextEncoder();
    expect(d.push(enc.encode('boot: ok\r\nte'))).toEqual(['boot: ok']);
    const euro = enc.encode('€'); // 3 bytes
    expect(d.push(new Uint8Array([...enc.encode('mp 21'), euro[0]!]))).toEqual([]);
    expect(d.push(new Uint8Array([euro[1]!, euro[2]!, 0x0a, 0x78]))).toEqual(['temp 21€']);
    expect(d.pending).toBe('x');
  });
});

/** A loopback port: whatever is written is echoed back upper-cased. */
function loopbackPort() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const signals: object[] = [];
  let opened: SerialOpenOptions | null = null;
  let closed = false;
  const port: SerialPortLike & { signals: object[]; opened: () => SerialOpenOptions | null; isClosed: () => boolean; emit: (s: string) => void } = {
    readable: new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } }),
    writable: new WritableStream<Uint8Array>({
      write: (chunk) => controller.enqueue(new TextEncoder().encode(new TextDecoder().decode(chunk).toUpperCase())),
    }),
    open: async (o) => { opened = o; },
    close: async () => { closed = true; },
    setSignals: async (s) => { signals.push(s); },
    signals,
    opened: () => opened,
    isClosed: () => closed,
    emit: (s) => controller.enqueue(new TextEncoder().encode(s)),
  };
  return port;
}

describe('SerialConnection', () => {
  it('opens with 8N1 defaults, reads, writes with a line ending, pulses RTS, closes', async () => {
    const port = loopbackPort();
    const d = new LineDecoder();
    const lines: string[] = [];
    const conn = await SerialConnection.open(port, { baudRate: 115200 }, (b) => lines.push(...d.push(b)));
    expect(port.opened()).toMatchObject({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });

    port.emit('hello\r\n');
    await conn.write('ping', 'crlf');
    await new Promise((r) => setTimeout(r, 10));
    expect(lines).toEqual(['hello', 'PING']);
    expect(conn.bytesOut).toBe(6);
    expect(conn.bytesIn).toBe(13);

    await conn.resetViaRts(1);
    expect(port.signals).toEqual([
      { dataTerminalReady: false, requestToSend: true },
      { dataTerminalReady: false, requestToSend: false },
    ]);

    await conn.close();
    expect(await conn.closed).toBe('closed');
    expect(port.isClosed()).toBe(true);
  });
});

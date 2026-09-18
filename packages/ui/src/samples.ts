/**
 * Turning an RTT byte stream into numbers to plot.
 *
 * A `BinaryLE` RTT channel is just bytes: the firmware decides what they mean. This
 * decodes the common cases — 8/16/32-bit integers, signed or not, and 32-bit floats,
 * little-endian, since that is what "BinaryLE" says and what every target this project
 * supports uses.
 *
 * RTT reads do not respect sample boundaries: a poll can return three and a half `u32`s.
 * So the decoder is a small stateful thing that keeps the leftover bytes for next time —
 * getting that wrong shifts every subsequent sample by a byte or two and turns a clean
 * signal into noise, which is exactly the sort of bug that looks like a hardware problem.
 */

/** How to read one sample out of the byte stream. */
export type SampleFormat = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32';

const WIDTH: Record<SampleFormat, number> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
};

/** Bytes per sample in this format. */
export function sampleWidth(format: SampleFormat): number {
  return WIDTH[format];
}

/**
 * Decodes a stream of samples, carrying an incomplete tail between calls.
 *
 * One decoder per channel: they each have their own leftover bytes.
 */
export class SampleDecoder {
  #format: SampleFormat;
  #leftover = new Uint8Array(0);

  constructor(format: SampleFormat = 'u32') {
    this.#format = format;
  }

  get format(): SampleFormat {
    return this.#format;
  }

  /** Changing the format drops any partial sample, which belonged to the old one. */
  set format(format: SampleFormat) {
    if (format === this.#format) return;
    this.#format = format;
    this.#leftover = new Uint8Array(0);
  }

  /** Forget any partial sample, e.g. after a reset. */
  reset() {
    this.#leftover = new Uint8Array(0);
  }

  /** Decode whatever whole samples these bytes complete. */
  push(bytes: Uint8Array | number[]): number[] {
    const incoming = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const buffer = new Uint8Array(this.#leftover.length + incoming.length);
    buffer.set(this.#leftover);
    buffer.set(incoming, this.#leftover.length);

    const width = WIDTH[this.#format];
    const whole = Math.floor(buffer.length / width);
    const out: number[] = new Array(whole);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    for (let i = 0; i < whole; i++) {
      const at = i * width;
      switch (this.#format) {
        case 'u8': out[i] = view.getUint8(at); break;
        case 'i8': out[i] = view.getInt8(at); break;
        case 'u16': out[i] = view.getUint16(at, true); break;
        case 'i16': out[i] = view.getInt16(at, true); break;
        case 'u32': out[i] = view.getUint32(at, true); break;
        case 'i32': out[i] = view.getInt32(at, true); break;
        case 'f32': out[i] = view.getFloat32(at, true); break;
      }
    }

    // Keep the partial sample for the next poll.
    this.#leftover = buffer.slice(whole * width);
    return out;
  }
}

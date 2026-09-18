/** Intel HEX encoding for memory exports (record types 00 data, 04 extended linear address, 01 EOF). */

function record(type: number, address: number, data: Uint8Array | number[]): string {
  const bytes = [data.length, (address >> 8) & 0xff, address & 0xff, type, ...data];
  const sum = bytes.reduce((a, b) => (a + b) & 0xff, 0);
  const checksum = (0x100 - sum) & 0xff;
  return ':' + [...bytes, checksum].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

/**
 * Encode `data` located at `base` as Intel HEX text (lines joined with `\n`, trailing newline).
 * Emits an extended linear address record whenever the upper 16 bits change, never lets a
 * data record cross a 64 KiB boundary, and ends with an EOF record.
 *
 * @param base - Address of `data[0]`.
 * @param recordSize - Maximum data bytes per record.
 */
export function toIntelHex(base: number | bigint, data: Uint8Array, recordSize = 16): string {
  const start = Number(base);
  const lines: string[] = [];
  let upper = -1;
  for (let off = 0; off < data.length; ) {
    const addr = start + off;
    const hi = Math.floor(addr / 0x10000);
    if (hi !== upper) {
      lines.push(record(0x04, 0, [(hi >> 8) & 0xff, hi & 0xff]));
      upper = hi;
    }
    // Do not let a record cross a 64 KiB boundary.
    const toBoundary = 0x10000 - (addr % 0x10000);
    const n = Math.min(recordSize, data.length - off, toBoundary);
    lines.push(record(0x00, addr & 0xffff, data.subarray(off, off + n)));
    off += n;
  }
  lines.push(record(0x01, 0, []));
  return lines.join('\n') + '\n';
}

/**
 * Group bytes into words of `size` bytes with the given endianness. A short tail that does
 * not fill a word becomes `null`.
 */
export function groupBytes(bytes: Uint8Array, size: 1 | 2 | 4 | 8, littleEndian: boolean): (bigint | null)[] {
  const out: (bigint | null)[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    if (i + size > bytes.length) {
      out.push(null);
      continue;
    }
    let v = 0n;
    for (let j = 0; j < size; j++) {
      const b = BigInt(bytes[littleEndian ? i + size - 1 - j : i + j]);
      v = (v << 8n) | b;
    }
    out.push(v);
  }
  return out;
}

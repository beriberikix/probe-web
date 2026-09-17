import { describe, expect, it } from 'vitest';
import { groupBytes, toIntelHex } from '../src/intel-hex.ts';

describe('toIntelHex', () => {
  it('encodes data with an extended linear address and checksums', () => {
    const hex = toIntelHex(0x20000000, Uint8Array.from([0x11, 0x11, 0x22, 0x22]));
    expect(hex).toBe(':020000042000DA\n:040000001111222296\n:00000001FF\n');
  });

  it('splits records at 16 bytes and at 64 KiB boundaries', () => {
    const data = Uint8Array.from({ length: 20 }, (_, i) => i);
    const lines = toIntelHex(0x1fff8, data).trim().split('\n');
    expect(lines[0]).toBe(':020000040001F9');
    expect(lines[1].startsWith(':08FFF800')).toBe(true); // 8 bytes up to 0x20000
    expect(lines[2]).toBe(':020000040002F8');
    expect(lines[3].startsWith(':0C000000')).toBe(true); // remaining 12
    expect(lines.at(-1)).toBe(':00000001FF');
  });
});

describe('groupBytes', () => {
  it('groups with endianness and pads a short tail', () => {
    const b = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04]);
    expect(groupBytes(b, 4, true)).toEqual([0x03020100n, null]);
    expect(groupBytes(b, 2, false)).toEqual([0x0001n, 0x0203n, null]);
  });
});

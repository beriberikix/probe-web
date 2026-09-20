import { describe, expect, it } from 'vitest';
import { elfHasRtt, elfSymbol } from '../src/elf.ts';

/**
 * A minimal but structurally real ELF: null section, `.symtab`, `.strtab`. Built rather than
 * committed so the tests cover both widths and both byte orders, which no firmware we have
 * does — the boards are all 32-bit little-endian.
 */
function buildElf(opts: {
  bits64?: boolean;
  big?: boolean;
  symbols: { name: string; value: bigint }[];
  /** Write 0 for e_shnum and the real count in section 0's sh_size, as a huge ELF does. */
  shnumInSection0?: boolean;
}) {
  const { bits64 = false, big = false, symbols, shnumInSection0 = false } = opts;
  const le = !big;
  const ehSize = bits64 ? 64 : 52;
  const shEnt = bits64 ? 64 : 40;
  const symEnt = bits64 ? 24 : 16;

  // .strtab: a leading NUL, then each name NUL-terminated.
  const names = ['', ...symbols.map((s) => s.name)];
  const strtab: number[] = [];
  const nameOffsets = new Map<string, number>();
  for (const n of names) {
    nameOffsets.set(n, strtab.length);
    for (const c of new TextEncoder().encode(n)) strtab.push(c);
    strtab.push(0);
  }

  const strOff = ehSize;
  const symOff = strOff + strtab.length;
  const symBytes = (symbols.length + 1) * symEnt; // index 0 is the reserved null symbol
  const shOff = symOff + symBytes;
  const total = shOff + 3 * shEnt;

  const buf = new Uint8Array(total);
  const v = new DataView(buf.buffer);
  const u32 = (at: number, n: number) => v.setUint32(at, n, le);
  const u16 = (at: number, n: number) => v.setUint16(at, n, le);
  const usize = (at: number, n: number | bigint) =>
    bits64 ? v.setBigUint64(at, BigInt(n), le) : v.setUint32(at, Number(n), le);

  buf.set([0x7f, 0x45, 0x4c, 0x46, bits64 ? 2 : 1, big ? 2 : 1, 1]);
  u16(16, 2); // e_type = ET_EXEC
  u32(bits64 ? 0x14 : 0x14, 1); // e_version
  usize(bits64 ? 0x28 : 0x20, shOff);
  u16(bits64 ? 0x3a : 0x2e, shEnt);
  u16(bits64 ? 0x3c : 0x30, shnumInSection0 ? 0 : 3);

  buf.set(strtab, strOff);
  symbols.forEach((s, i) => {
    const at = symOff + (i + 1) * symEnt;
    u32(at, nameOffsets.get(s.name)!);
    if (bits64) v.setBigUint64(at + 8, s.value, le);
    else v.setUint32(at + 4, Number(s.value), le);
  });

  const section = (i: number, fields: { type: number; offset: number; size: number; link?: number; entsize?: number }) => {
    const at = shOff + i * shEnt;
    u32(at + 4, fields.type);
    usize(at + (bits64 ? 0x18 : 0x10), fields.offset);
    usize(at + (bits64 ? 0x20 : 0x14), fields.size);
    u32(at + (bits64 ? 0x28 : 0x18), fields.link ?? 0);
    usize(at + (bits64 ? 0x38 : 0x24), fields.entsize ?? 0);
  };
  section(0, { type: 0, offset: 0, size: shnumInSection0 ? 3 : 0 });
  section(1, { type: 2 /* SHT_SYMTAB */, offset: symOff, size: symBytes, link: 2, entsize: symEnt });
  section(2, { type: 3 /* SHT_STRTAB */, offset: strOff, size: strtab.length });
  return buf;
}

const RTT = { name: '_SEGGER_RTT', value: 0x2000_1234n };

describe('elfSymbol', () => {
  for (const bits64 of [false, true]) {
    for (const big of [false, true]) {
      const label = `${bits64 ? '64' : '32'}-bit ${big ? 'big' : 'little'}-endian`;

      it(`finds a symbol and its address (${label})`, () => {
        const elf = buildElf({ bits64, big, symbols: [{ name: 'main', value: 0x8000n }, RTT] });
        expect(elfSymbol(elf, 'main')).toBe(0x8000n);
        expect(elfSymbol(elf, '_SEGGER_RTT')).toBe(RTT.value);
      });

      it(`returns undefined for a symbol that is not there (${label})`, () => {
        const elf = buildElf({ bits64, big, symbols: [{ name: 'main', value: 0x8000n }] });
        expect(elfSymbol(elf, '_SEGGER_RTT')).toBeUndefined();
      });
    }
  }

  it('does not match a name that merely starts the same', () => {
    const elf = buildElf({ symbols: [{ name: '_SEGGER_RTT_extra', value: 0x1n }] });
    expect(elfSymbol(elf, '_SEGGER_RTT')).toBeUndefined();
  });

  it('does not match a name that merely ends the same', () => {
    const elf = buildElf({ symbols: [{ name: 'my_SEGGER_RTT', value: 0x1n }] });
    expect(elfSymbol(elf, '_SEGGER_RTT')).toBeUndefined();
  });

  it('skips an undefined symbol, which has no address', () => {
    const elf = buildElf({ symbols: [{ name: '_SEGGER_RTT', value: 0n }] });
    expect(elfSymbol(elf, '_SEGGER_RTT')).toBeUndefined();
  });

  it('reads the section count from section 0 when e_shnum is 0', () => {
    const elf = buildElf({ symbols: [RTT], shnumInSection0: true });
    expect(elfSymbol(elf, '_SEGGER_RTT')).toBe(RTT.value);
  });
});

describe('elfHasRtt', () => {
  it('is true only when the control block is linked', () => {
    expect(elfHasRtt(buildElf({ symbols: [RTT] }))).toBe(true);
    expect(elfHasRtt(buildElf({ symbols: [{ name: 'main', value: 0x8000n }] }))).toBe(false);
  });
});

// These come from a file picker: whatever a user hands us has to come back false, not throw
// and not hang.
describe('malformed input', () => {
  const cases: Record<string, Uint8Array> = {
    empty: new Uint8Array(0),
    'not an ELF': new TextEncoder().encode('#!/bin/sh\necho hello\n'.padEnd(200, ' ')),
    'header only': buildElf({ symbols: [RTT] }).slice(0, 52),
    truncated: buildElf({ symbols: [RTT] }).slice(0, 100),
    'unknown class': (() => { const e = buildElf({ symbols: [RTT] }); e[4] = 7; return e; })(),
    'unknown endianness': (() => { const e = buildElf({ symbols: [RTT] }); e[5] = 9; return e; })(),
  };

  for (const [name, bytes] of Object.entries(cases)) {
    it(`returns false for ${name}`, () => {
      expect(() => elfHasRtt(bytes)).not.toThrow();
      expect(elfHasRtt(bytes)).toBe(false);
    });
  }

  it('survives section offsets that point outside the file', () => {
    const elf = buildElf({ symbols: [RTT] });
    // e_shoff far past the end.
    new DataView(elf.buffer).setUint32(0x20, 0xffff_0000, true);
    expect(elfHasRtt(elf)).toBe(false);
  });

  it('survives an absurd section count', () => {
    const elf = buildElf({ symbols: [RTT] });
    new DataView(elf.buffer).setUint16(0x30, 0xffff, true);
    expect(elfHasRtt(elf)).toBe(false);
  });
});

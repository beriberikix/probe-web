/**
 * Symbol lookup in an ELF, in plain JavaScript.
 *
 * This is deliberately separate from the rest of the SDK and imports nothing from it. The
 * main entry loads the wasm glue at module scope, and that glue addresses its module with
 * `new URL(..., import.meta.url)`, so a bundler emits the wasm — and the probe-rs worker
 * reachable beside it — for anything that touches the entry at all. Reading two fields out
 * of a symbol table is not a reason to put 10 MB of wasm in someone's build, so it lives
 * here, where importing it costs a few hundred bytes.
 *
 * @packageDocumentation
 */

/** `_SEGGER_RTT`, the control block a target links when it has RTT. */
const RTT_SYMBOL = '_SEGGER_RTT';

const SHT_SYMTAB = 2;
const SHT_DYNSYM = 11;

/** A parsed-enough view: where the symbols are and how to read them. */
interface Elf {
  view: DataView;
  little: boolean;
  bits64: boolean;
}

const u16 = (e: Elf, at: number) => e.view.getUint16(at, e.little);
const u32 = (e: Elf, at: number) => e.view.getUint32(at, e.little);
/** Offsets and sizes are 64-bit in a 64-bit ELF; they index a file, so a Number is plenty. */
const off = (e: Elf, at: number) => (e.bits64 ? Number(e.view.getBigUint64(at, e.little)) : u32(e, at));

function open(elf: Uint8Array): Elf | null {
  if (elf.length < 64 || elf[0] !== 0x7f || elf[1] !== 0x45 || elf[2] !== 0x4c || elf[3] !== 0x46) return null;
  const bits64 = elf[4] === 2;
  const little = elf[5] === 1;
  if ((elf[4] !== 1 && !bits64) || (elf[5] !== 1 && elf[5] !== 2)) return null;
  return { view: new DataView(elf.buffer, elf.byteOffset, elf.byteLength), little, bits64 };
}

/**
 * The address of `name` in `elf`, or `undefined` if it has no such symbol.
 *
 * Reads `.symtab`, falling back to `.dynsym`. Returns the raw `st_value`; for a Cortex-M
 * thumb function that includes the low bit the linker sets, exactly as the symbol table
 * records it.
 */
export function elfSymbol(elf: Uint8Array, name: string): bigint | undefined {
  const e = open(elf);
  if (!e) return undefined;

  const shoff = off(e, e.bits64 ? 0x28 : 0x20);
  const shentsize = u16(e, e.bits64 ? 0x3a : 0x2e);
  let shnum = u16(e, e.bits64 ? 0x3c : 0x30);
  if (!shoff || !shentsize) return undefined;
  // With more than SHN_LORESERVE sections the real count lives in section 0's sh_size.
  if (shnum === 0) shnum = off(e, shoff + (e.bits64 ? 0x20 : 0x14));
  if (shoff + shnum * shentsize > elf.length) return undefined;

  const wanted = new TextEncoder().encode(name);

  for (const type of [SHT_SYMTAB, SHT_DYNSYM]) {
    for (let i = 0; i < shnum; i++) {
      const sh = shoff + i * shentsize;
      if (u32(e, sh + 4) !== type) continue;

      // sh_link names the string table this symbol table's names are in.
      const link = u32(e, sh + (e.bits64 ? 0x28 : 0x18));
      if (link >= shnum) continue;
      const strSh = shoff + link * shentsize;
      const strOff = off(e, strSh + (e.bits64 ? 0x18 : 0x10));
      const strSize = off(e, strSh + (e.bits64 ? 0x20 : 0x14));

      const symOff = off(e, sh + (e.bits64 ? 0x18 : 0x10));
      const symSize = off(e, sh + (e.bits64 ? 0x20 : 0x14));
      const entSize = off(e, sh + (e.bits64 ? 0x38 : 0x24)) || (e.bits64 ? 24 : 16);
      if (symOff + symSize > elf.length || strOff + strSize > elf.length) continue;

      for (let s = 0; s + entSize <= symSize; s += entSize) {
        const sym = symOff + s;
        const nameOff = strOff + u32(e, sym);
        if (nameOff + wanted.length + 1 > strOff + strSize) continue;
        // Compare in place against the string table rather than decoding every name.
        let hit = elf[nameOff + wanted.length] === 0;
        for (let c = 0; hit && c < wanted.length; c++) hit = elf[nameOff + c] === wanted[c];
        if (!hit) continue;

        const value = e.bits64 ? e.view.getBigUint64(sym + 8, e.little) : BigInt(u32(e, sym + 4));
        // A symbol with no value is a reference, not a definition; keep looking.
        if (value !== 0n) return value;
      }
    }
  }
  return undefined;
}

/** Whether an ELF links an RTT control block (`_SEGGER_RTT`). */
export function elfHasRtt(elf: Uint8Array): boolean {
  return elfSymbol(elf, RTT_SYMBOL) !== undefined;
}

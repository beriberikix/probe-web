/**
 * Byte size of a variable from the type name probe-rs reports (Rust or C spelling), for memory
 * highlights. `null` when the size cannot be known from the name alone (structs, enums, `str`).
 */
export function typeSize(type: string | null | undefined, pointerBytes = 4): number | null {
  if (!type) return null;
  const t = type.trim();
  const array = /^\[(.+);\s*(\d+)\]$/.exec(t);
  if (array) {
    const element = typeSize(array[1], pointerBytes);
    return element === null ? null : element * Number(array[2]);
  }
  if (/^(&|\*(const|mut)\s)/.test(t) || t.endsWith('*')) {
    // Slices and `str`/`dyn` references are fat pointers.
    return /^&(mut\s+)?(\[|str\b|dyn\b)/.test(t) || /^\*(const|mut)\s+(\[|str\b|dyn\b)/.test(t) ? 2 * pointerBytes : pointerBytes;
  }
  if (/^fn\s*\(/.test(t)) return pointerBytes;
  if (t === '()') return 0;
  return PRIMITIVES[t] ?? (t === 'usize' || t === 'isize' ? pointerBytes : null);
}

const PRIMITIVES: Record<string, number> = {
  u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, char: 4, u64: 8, i64: 8, f64: 8, u128: 16, i128: 16,
  // C
  'unsigned char': 1, 'signed char': 1, _Bool: 1, short: 2, 'short int': 2, 'unsigned short': 2, 'short unsigned int': 2,
  int: 4, 'unsigned int': 4, 'long long': 8, 'long long int': 8, 'unsigned long long': 8, 'long long unsigned int': 8,
  float: 4, double: 8,
  uint8_t: 1, int8_t: 1, uint16_t: 2, int16_t: 2, uint32_t: 4, int32_t: 4, uint64_t: 8, int64_t: 8,
};

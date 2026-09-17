import { describe, expect, it } from 'vitest';
import { typeSize } from '../src/type-size.ts';

describe('typeSize', () => {
  it('knows primitives, arrays and pointers', () => {
    expect(typeSize('u32')).toBe(4);
    expect(typeSize('[u16; 4]')).toBe(8);
    expect(typeSize('[[u8; 3]; 2]')).toBe(6);
    expect(typeSize('usize', 8)).toBe(8);
    expect(typeSize('&esp32s3::systimer::RegisterBlock')).toBe(4);
    expect(typeSize('&[u8]')).toBe(8);
    expect(typeSize('&str', 8)).toBe(16);
    expect(typeSize('*const u8')).toBe(4);
    expect(typeSize('uint16_t')).toBe(2);
    expect(typeSize('char *')).toBe(4);
  });

  it('is unknown for aggregates and missing types', () => {
    expect(typeSize('Point')).toBeNull();
    expect(typeSize('[Point; 2]')).toBeNull();
    expect(typeSize(null)).toBeNull();
    expect(typeSize('<unknown>')).toBeNull();
  });
});

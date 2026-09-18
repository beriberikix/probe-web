import { describe, expect, it } from 'vitest';
import { SampleDecoder, sampleWidth } from '../src/samples.ts';

describe('SampleDecoder', () => {
  it('decodes little-endian samples of each width', () => {
    expect(new SampleDecoder('u8').push([1, 254])).toEqual([1, 254]);
    expect(new SampleDecoder('i8').push([1, 254])).toEqual([1, -2]);
    expect(new SampleDecoder('u16').push([0x34, 0x12])).toEqual([0x1234]);
    expect(new SampleDecoder('i16').push([0x00, 0x80])).toEqual([-32768]);
    expect(new SampleDecoder('u32').push([0x78, 0x56, 0x34, 0x12])).toEqual([0x12345678]);
    expect(new SampleDecoder('i32').push([0xff, 0xff, 0xff, 0xff])).toEqual([-1]);
    // 1.0f32 is 0x3f800000.
    expect(new SampleDecoder('f32').push([0x00, 0x00, 0x80, 0x3f])).toEqual([1]);
  });

  /**
   * The behaviour the whole class exists for. An RTT read does not respect sample
   * boundaries, and mis-handling the tail shifts every later sample — which looks like a
   * hardware fault rather than a decoding bug.
   */
  it('carries a partial sample across reads', () => {
    const d = new SampleDecoder('u32');
    expect(d.push([0x78, 0x56])).toEqual([]);
    expect(d.push([0x34])).toEqual([]);
    expect(d.push([0x12, 0x01])).toEqual([0x12345678]);
    // One byte of the next sample is still held back.
    expect(d.push([0x00, 0x00, 0x00])).toEqual([1]);
  });

  it('decodes several samples from one read and keeps the remainder', () => {
    const d = new SampleDecoder('u16');
    expect(d.push([1, 0, 2, 0, 3])).toEqual([1, 2]);
    expect(d.push([0])).toEqual([3]);
  });

  it('drops a partial sample when the format changes, since it belonged to the old one', () => {
    const d = new SampleDecoder('u32');
    d.push([1, 2, 3]);
    d.format = 'u8';
    expect(d.push([9])).toEqual([9]);
  });

  it('drops a partial sample on reset', () => {
    const d = new SampleDecoder('u16');
    d.push([0xaa]);
    d.reset();
    expect(d.push([0x01, 0x00])).toEqual([1]);
  });

  it('reports the width each format needs', () => {
    expect(sampleWidth('u8')).toBe(1);
    expect(sampleWidth('i16')).toBe(2);
    expect(sampleWidth('f32')).toBe(4);
  });
});

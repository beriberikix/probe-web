import { describe, expect, it } from 'vitest';
import { progressOperation, type ProgressEvent } from '../src/index';

// The wasm module is not loaded here; these cover the pure helpers.
describe('progressOperation', () => {
  it('extracts the operation from every event variant', () => {
    const cases: [ProgressEvent, string | null][] = [
      [{ Started: 'Erase' }, 'Erase'],
      [{ Finished: 'Program' }, 'Program'],
      [{ Failed: 'Verify' }, 'Verify'],
      [{ Progress: { operation: 'Fill', size: 1n } }, 'Fill'],
      [{ AddProgressBar: { operation: 'Ram', total: null } }, 'Ram'],
      [{ DiagnosticMessage: { message: 'x' } }, null],
      [{ FlashLayoutReady: { flash_layout: [] } }, null],
    ];
    for (const [e, op] of cases) expect(progressOperation(e)).toBe(op);
  });
});

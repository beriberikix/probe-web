import { css } from 'lit';
import { baseStyles } from './base-style.ts';

/** Shared look for the debugger components: dense tables and trees, like VS Code's views. */
export const debugStyles = [
  baseStyles,
  css`
    table { border-collapse: collapse; width: 100%; }
    td, th { padding: 2px 8px; text-align: left; vertical-align: top; line-height: 18px; }
    th {
      position: sticky; top: 0; z-index: 1; background: var(--_bg);
      font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
      color: var(--_text-2); border-bottom: 1px solid var(--_divider);
    }
    tbody tr:hover, tr.clickable:hover { background: var(--_default-soft); }
    tr.selected, tr.selected:hover { background: var(--_brand-soft); box-shadow: inset 2px 0 var(--_brand-3); }
    tr.clickable { cursor: pointer; }
    .changed { color: var(--_yellow-2); font-weight: 600; }
    .stale { opacity: 0.5; }
    input.edit { font-family: var(--_mono); font-size: 12px; width: 12em; }
    .empty, .unavailable { color: var(--_text-2); padding: 12px 4px; }
  `,
];

/** The message of a thrown value, for showing in a panel. */
export const errorText = (e: unknown) => (e as Error)?.message ?? String(e);
/** `0x`-prefixed hex, zero-padded to `width` digits. */
export const hex = (v: bigint | number, width = 8) => '0x' + v.toString(16).padStart(width, '0');

/** Parse user input for a numeric register value: 0x…, 0b…, or decimal. */
export function parseBigInt(text: string): bigint {
  const t = text.trim().replace(/_/g, '');
  if (!/^(0x[0-9a-f]+|0b[01]+|-?\d+)$/i.test(t)) throw new Error(`not a number: ${text}`);
  return BigInt(t);
}

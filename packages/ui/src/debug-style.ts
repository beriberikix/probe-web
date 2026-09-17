import { css } from 'lit';

/** Shared look for the debugger components. */
export const debugStyles = css`
  :host { display: block; font: 13px system-ui, sans-serif; color: #111; }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
  button { font: inherit; padding: 4px 9px; }
  .muted { color: #666; }
  .err { color: #b91c1c; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { padding: 2px 6px; text-align: left; vertical-align: top; }
  th { font-weight: 600; color: #444; border-bottom: 1px solid #ddd; }
  tr.selected { background: #dbeafe; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover { background: #f1f5f9; }
  .changed { color: #b45309; font-weight: 600; }
  .stale { opacity: 0.5; }
  input.edit { font: inherit; font-family: ui-monospace, monospace; font-size: 12px; width: 12em; }
`;

export const errorText = (e: unknown) => (e as Error)?.message ?? String(e);
export const hex = (v: bigint | number, width = 8) => '0x' + v.toString(16).padStart(width, '0');

/** Parse user input for a numeric register value: 0x…, 0b…, or decimal. */
export function parseBigInt(text: string): bigint {
  const t = text.trim().replace(/_/g, '');
  if (!/^(0x[0-9a-f]+|0b[01]+|-?\d+)$/i.test(t)) throw new Error(`not a number: ${text}`);
  return BigInt(t);
}

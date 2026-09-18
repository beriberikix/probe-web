import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Instruction } from '@probe-web/client';
import { DebuggerElement } from './debugger-element.ts';
import { debugStyles, errorText, hex } from './debug-style.ts';

const basename = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;

/**
 * `<probe-disassembly>`: instructions around the PC at each stop (or around a
 * chosen address), with source line markers. Click the gutter to toggle an
 * instruction breakpoint.
 *
 * Needs a disassembler on the connection: the WebSocket transport (`probe-rs serve`)
 * has one, the WebUSB worker does not (see {@link ProbeDisassembly.available}).
 *
 * Fires no events.
 */
@customElement('probe-disassembly')
export class ProbeDisassembly extends DebuggerElement {
  /** @internal */
  static styles = [debugStyles, css`
    .gutter { width: 1.2em; cursor: pointer; color: #dc2626; text-align: center; user-select: none; }
    .gutter:hover::after { content: '○'; color: #f87171; }
    .gutter.bp:hover::after { content: ''; }
    tr.pc { background: #fef9c3; }
    tr.src td { color: #555; font-size: 11px; padding-top: 6px; }
    .bytes { color: #999; }
  `];

  /** Instructions shown before the anchor address (the PC, or the address given to {@link ProbeDisassembly.show}). */
  @property({ type: Number, attribute: 'lines-before' }) linesBefore = 8;
  /** Instructions shown from the anchor address on. */
  @property({ type: Number, attribute: 'lines-after' }) linesAfter = 16;
  @state() private rows: Instruction[] = [];
  @state() private anchor: bigint | null = null;
  @state() private follow = true;
  @state() private error = '';

  protected onAttached() { if (this.debugger?.state === 'halted') void this.refresh(); }
  protected onStopped() { if (this.follow) this.anchor = null; void this.refresh(); }
  protected onBreakpoints() { this.requestUpdate(); }

  /** Show code around `address` and stop following the PC (`null` follows the PC again). */
  async show(address: bigint | null) {
    this.anchor = address;
    this.follow = address === null;
    await this.refresh();
  }

  /** False on connections without a disassembler (the WebUSB worker). */
  get available(): boolean {
    return (this.debugger as { canDisassemble?: boolean } | null)?.canDisassemble !== false;
  }

  /** Disassemble around the anchor address now. */
  async refresh() {
    const d = this.debugger;
    if (!d || !this.available) return;
    const at = this.anchor ?? d.lastStop?.pc;
    if (at === undefined || at === null) return;
    try {
      this.rows = await d.disassemble(at, this.linesBefore + this.linesAfter, -this.linesBefore);
      this.error = '';
    } catch (e) {
      this.error = errorText(e);
    }
  }

  private async toggle(address: bigint) {
    const d = this.debugger;
    if (!d) return;
    const current = d.breakpoints().filter((b) => b.kind === 'instruction').map((b) => b.address!);
    const next = current.includes(address) ? current.filter((a) => a !== address) : [...current, address];
    try {
      await d.setInstructionBreakpoints(next);
    } catch (e) {
      this.error = errorText(e);
    }
  }

  render() {
    const d = this.debugger;
    if (!d) return html`<div class="muted">no debugger</div>`;
    if (!this.available) {
      return html`<div class="muted unavailable">Disassembly is not available on this connection (the WebUSB transport has no disassembler; use probe-rs serve for it).</div>`;
    }
    const pc = d.state === 'halted' ? d.lastStop?.pc : undefined;
    const bps = new Set(d.breakpoints().filter((b) => b.verified && b.address !== null).map((b) => b.address!));
    let lastSource = '';
    return html`
      <div class="row">
        <input class="edit" placeholder="address (0x…)" @keydown=${(e: KeyboardEvent) => {
          if (e.key !== 'Enter') return;
          const v = (e.target as HTMLInputElement).value.trim();
          void this.show(v ? BigInt(v) : null);
        }}>
        <button ?disabled=${this.follow} @click=${() => this.show(null)}>Follow PC</button>
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${this.rows.length === 0 ? html`<div class="muted">halt the core to see code</div>` : nothing}
      <table class="mono">
        ${this.rows.map((r) => {
          const src = r.source?.line ? `${basename(r.source.path)}:${r.source.line}` : '';
          const header = src && src !== lastSource ? html`<tr class="src"><td></td><td colspan="3">${src}</td></tr>` : nothing;
          if (src) lastSource = src;
          return html`${header}<tr data-address=${hex(r.address)} class=${r.address === pc ? 'pc' : ''}>
            <td class="gutter ${bps.has(r.address) ? 'bp' : ''}" @click=${() => this.toggle(r.address)}>${bps.has(r.address) ? '●' : ''}</td>
            <td>${hex(r.address)}</td>
            <td class="bytes">${r.bytes ?? ''}</td>
            <td class="text">${r.text}</td>
          </tr>`;
        })}
      </table>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-disassembly': ProbeDisassembly; } }

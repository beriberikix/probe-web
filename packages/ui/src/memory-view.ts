import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { DebuggerElement } from './debugger-element.ts';
import { debugStyles, errorText, hex } from './debug-style.ts';
import { groupBytes, toIntelHex } from './intel-hex.ts';
import { typeSize } from './type-size.ts';

/**
 * When {@link ProbeMemoryView} re-reads memory: `'on-stop'` at every halt, `'off'` only
 * when asked ({@link ProbeMemoryView.refresh} or the Refresh button).
 */
export type MemoryRefreshMode = 'on-stop' | 'off';

/** A highlighted range, e.g. the bytes of a watched variable. */
export interface MemoryHighlight {
  /** Shown on the chip above the grid; also the key {@link ProbeMemoryView.unwatch} removes by. */
  label: string;
  /** First byte of the range. */
  address: bigint;
  /** Bytes; a range of unknown size is shown as its first byte. */
  size: number;
  /** Set when the size is a guess (the type gives none). */
  sizeUnknown?: boolean;
}

const HIGHLIGHT_COLORS = ['#fde68a', '#bfdbfe', '#bbf7d0', '#fbcfe8', '#ddd6fe', '#fed7aa'];

/**
 * `<probe-memory-view>`: a hex/ASCII view of target memory. Bytes per row,
 * grouping (1/2/4/8 bytes) with endianness, refresh at each stop (or manual),
 * changed values highlighted, byte edit (double-click, 1-byte groups), and
 * Intel HEX export ({@link ProbeMemoryView.exportHex}, or the Export button).
 *
 * Lock view ({@link ProbeMemoryView.locked}) freezes the shown bytes and address:
 * stops, refreshes and {@link ProbeMemoryView.goTo} from other panels leave it alone
 * until it is unlocked. Variable highlights ({@link ProbeMemoryView.highlights}, or
 * type a variable name into "watch") colour the bytes of each watched variable,
 * sized from its type.
 *
 * Fires no events.
 *
 * @example
 * ```html
 * <probe-memory-view length="512" group="4"></probe-memory-view>
 * ```
 * ```ts
 * const mem = document.querySelector('probe-memory-view')!;
 * mem.debugger = session.debugger();
 * await mem.goTo(0x2000_0000n);
 * await mem.watch('COUNTER'); // highlight a static's bytes
 * ```
 */
@customElement('probe-memory-view')
export class ProbeMemoryView extends DebuggerElement {
  /** @internal */
  static styles = [debugStyles, css`
    .grid td { padding: 0 4px; }
    .ascii { color: #555; letter-spacing: 0.5px; }
    .short { color: #bbb; }
    .highlights { gap: 4px; }
    .chip { border-radius: 10px; padding: 0 2px 0 8px; font-size: 12px; }
    .chip .link { border: 0; background: transparent; cursor: pointer; padding: 0 4px; }
    .grid td.hl.changed { outline: 1px solid #d97706; }
    :host([locked]) .grid { opacity: 0.85; }
  `];

  /** First address shown. Set it and call {@link ProbeMemoryView.refresh}, or use {@link ProbeMemoryView.goTo}. */
  @property({ attribute: false }) address: bigint = 0x2000_0000n;
  /** Number of bytes read. */
  @property({ type: Number }) length = 256;
  /** Bytes per row of the grid. */
  @property({ type: Number, attribute: 'bytes-per-row' }) bytesPerRow = 16;
  /** Bytes per displayed word. Bytes can only be edited with 1-byte groups. */
  @property({ type: Number }) group: 1 | 2 | 4 | 8 = 1;
  /** Show grouped words big-endian rather than little-endian. */
  @property({ type: Boolean, attribute: 'big-endian' }) bigEndian = false;
  /** `'on-stop'` re-reads at every halt; `'off'` only on {@link ProbeMemoryView.refresh} or the Refresh button. */
  @property() refreshMode: MemoryRefreshMode = 'on-stop';
  /** Freeze the view: ignore stops, refreshes and `goTo` until unlocked. */
  @property({ type: Boolean, reflect: true }) locked = false;
  /** Ranges to colour, later entries winning where they overlap. {@link ProbeMemoryView.watch} adds to it. */
  @property({ attribute: false }) highlights: MemoryHighlight[] = [];
  /** Pointer size for sizing reference types in highlights. */
  @property({ type: Number, attribute: 'pointer-bytes' }) pointerBytes = 4;
  @state() private bytes: Uint8Array = new Uint8Array();
  @state() private previous: Uint8Array | null = null;
  @state() private editing: number | null = null;
  @state() private error = '';

  protected onAttached() { if (this.debugger?.state === 'halted') void this.refresh(); }
  protected onStopped() { if (this.refreshMode === 'on-stop') void this.refresh(); }

  /** Read the configured range now (no-op while locked). */
  async refresh() {
    const d = this.debugger;
    if (!d || this.locked) return;
    try {
      const next = await d.readMemory(this.address, this.length);
      this.previous = this.bytes.length ? this.bytes : null;
      this.bytes = next;
      this.error = next.length < this.length ? `only ${next.length} of ${this.length} bytes are readable` : '';
    } catch (e) {
      this.error = errorText(e);
    }
  }

  /** Go to an address and read. Returns false (and does nothing) while locked. */
  async goTo(address: bigint, length = this.length): Promise<boolean> {
    if (this.locked) return false;
    this.address = address;
    this.length = length;
    this.previous = null;
    this.bytes = new Uint8Array();
    await this.refresh();
    return true;
  }

  /**
   * Highlight a variable by name (evaluated in the selected frame, or globally). Its size comes
   * from the type; unknown sizes mark the first byte. Returns the highlight.
   */
  async watch(expression: string, frameId?: number): Promise<MemoryHighlight> {
    const d = this.debugger;
    if (!d) throw new Error('no debugger');
    const name = expression.trim();
    const ev = await d.evaluate(name, frameId);
    if (!ev.memoryReference) throw new Error(`${name} has no address (${ev.value})`);
    const size = typeSize(ev.type, this.pointerBytes);
    const h: MemoryHighlight = { label: name, address: BigInt(ev.memoryReference), size: Math.max(size ?? 1, 1), sizeUnknown: size === null };
    this.highlights = [...this.highlights.filter((x) => x.label !== name), h];
    return h;
  }

  /** Remove the highlight with this label. */
  unwatch(label: string) {
    this.highlights = this.highlights.filter((h) => h.label !== label);
  }

  /** The highlight covering `address`, if any (the last one added wins). */
  highlightAt(address: bigint): { highlight: MemoryHighlight; index: number } | null {
    for (let i = this.highlights.length - 1; i >= 0; i--) {
      const h = this.highlights[i];
      if (address >= h.address && address < h.address + BigInt(h.size)) return { highlight: h, index: i };
    }
    return null;
  }

  private async onWatchKey(e: KeyboardEvent) {
    if (e.key !== 'Enter') return;
    const input = e.target as HTMLInputElement;
    try {
      const h = await this.watch(input.value);
      input.value = '';
      this.error = '';
      const end = this.address + BigInt(this.length);
      if (h.address < this.address || h.address >= end) this.error = `${h.label} is at ${hex(h.address)}, outside the shown range`;
    } catch (err) {
      this.error = errorText(err);
    }
  }

  /** Intel HEX of the bytes currently shown. */
  exportHex(): string {
    return toIntelHex(this.address, this.bytes);
  }

  private download() {
    const url = URL.createObjectURL(new Blob([this.exportHex()], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `memory-${this.address.toString(16)}.hex`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async writeByte(offset: number, text: string) {
    this.editing = null;
    try {
      const v = Number(text.trim().startsWith('0x') ? text.trim() : '0x' + text.trim());
      if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`not a byte: ${text}`);
      await this.debugger!.writeMemory(this.address + BigInt(offset), Uint8Array.of(v));
      await this.refresh();
    } catch (e) {
      this.error = errorText(e);
    }
  }

  /** The highlight over any byte of the group starting at `offset`. */
  private groupHighlight(offset: number) {
    if (!this.highlights.length) return null;
    for (let j = 0; j < this.group; j++) {
      const mark = this.highlightAt(this.address + BigInt(offset + j));
      if (mark) return mark;
    }
    return null;
  }

  render() {
    if (!this.debugger) return html`<div class="muted">no debugger</div>`;
    const rows: number[] = [];
    for (let off = 0; off < this.bytes.length; off += this.bytesPerRow) rows.push(off);
    return html`
      <div class="row">
        <input class="edit address" .value=${hex(this.address)} ?disabled=${this.locked} @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter') void this.goTo(BigInt((e.target as HTMLInputElement).value.trim()));
        }}>
        <select aria-label="group" .value=${String(this.group)} @change=${(e: Event) => { this.group = Number((e.target as HTMLSelectElement).value) as 1 | 2 | 4 | 8; }}>
          ${[1, 2, 4, 8].map((g) => html`<option value=${g} ?selected=${g === this.group}>${g} byte${g > 1 ? 's' : ''}</option>`)}
        </select>
        <label><input type="checkbox" .checked=${this.bigEndian} @change=${(e: Event) => { this.bigEndian = (e.target as HTMLInputElement).checked; }}> big-endian</label>
        <select aria-label="refresh" .value=${this.refreshMode} @change=${(e: Event) => { this.refreshMode = (e.target as HTMLSelectElement).value as MemoryRefreshMode; }}>
          <option value="on-stop">refresh on stop</option><option value="off">manual</option>
        </select>
        <button ?disabled=${this.locked} @click=${() => this.refresh()}>Refresh</button>
        <label title="Freeze this view: stops and other panels do not change it"><input type="checkbox" .checked=${this.locked} @change=${(e: Event) => { this.locked = (e.target as HTMLInputElement).checked; }}> lock view</label>
        <input class="edit watch" placeholder="watch variable" aria-label="watch variable" @keydown=${(e: KeyboardEvent) => void this.onWatchKey(e)}>
        <button ?disabled=${!this.bytes.length} @click=${() => this.download()}>Export HEX</button>
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${this.highlights.length ? html`<div class="row highlights">${this.highlights.map((h, i) => html`
        <span class="chip" data-label=${h.label} style="background:${HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length]}"
          title="${hex(h.address)}, ${h.sizeUnknown ? 'size unknown' : `${h.size} byte${h.size === 1 ? '' : 's'}`}">
          ${h.label}${h.sizeUnknown ? ' (?)' : ''}
          <button class="link" aria-label="unwatch ${h.label}" @click=${() => this.unwatch(h.label)}>×</button>
        </span>`)}</div>` : nothing}
      <table class="grid mono">
        ${rows.map((off) => {
          const chunk = this.bytes.subarray(off, off + this.bytesPerRow);
          const words = groupBytes(chunk, this.group, !this.bigEndian);
          return html`<tr data-offset=${off}>
            <td class="muted">${hex(this.address + BigInt(off))}</td>
            ${words.map((w, i) => {
              const at = off + i * this.group;
              const changed = !!this.previous && this.previous.length > at + this.group - 1
                && this.previous.subarray(at, at + this.group).some((b, j) => b !== this.bytes[at + j]);
              if (this.group === 1 && this.editing === at) {
                return html`<td><input class="edit" style="width:2.5em" .value=${chunk[i].toString(16).padStart(2, '0')} autofocus
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') void this.writeByte(at, (e.target as HTMLInputElement).value);
                    if (e.key === 'Escape') this.editing = null;
                  }}></td>`;
              }
              const mark = this.groupHighlight(at);
              return html`<td class="cell ${changed ? 'changed' : ''} ${w === null ? 'short' : ''} ${mark ? 'hl' : ''}"
                data-highlight=${mark ? mark.highlight.label : nothing}
                style=${mark ? `background:${HIGHLIGHT_COLORS[mark.index % HIGHLIGHT_COLORS.length]}` : nothing}
                title=${mark ? mark.highlight.label : nothing}
                @dblclick=${() => { if (this.group === 1 && this.debugger?.state === 'halted') this.editing = at; }}>
                ${w === null ? '··' : w.toString(16).padStart(this.group * 2, '0')}</td>`;
            })}
            <td class="ascii">${Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')}</td>
          </tr>`;
        })}
      </table>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-memory-view': ProbeMemoryView; } }

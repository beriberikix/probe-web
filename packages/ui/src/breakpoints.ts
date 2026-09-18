import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { Breakpoint } from '@probe-web/client';
import { DebuggerElement } from './debugger-element.ts';
import { debugStyles, errorText, hex } from './debug-style.ts';

const basename = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;

/**
 * `<probe-breakpoints>`: all breakpoints with where they were placed, whether
 * a hardware comparator was available, and which one the core stopped at.
 * Add `file:line` (a path suffix such as `src/main.rs:40`) or an address (`0x…`).
 *
 * Fires no events: changes go through the `Debugger`, whose `breakpoints` event
 * keeps every panel (including `<probe-disassembly>`'s gutter) in step.
 */
@customElement('probe-breakpoints')
export class ProbeBreakpoints extends DebuggerElement {
  /** @internal */
  static styles = debugStyles;

  @state() private list: Breakpoint[] = [];
  @state() private hit: number[] = [];
  @state() private error = '';

  protected onAttached() { this.sync(); }
  protected onBreakpoints() { this.sync(); }
  protected onStopped() { this.sync(); }
  protected onContinued() { this.hit = []; }

  private sync() {
    const d = this.debugger;
    if (!d) return;
    this.list = [...d.breakpoints()];
    this.hit = d.lastStop?.breakpoints ?? [];
  }

  /** Add a breakpoint from `file:line` or an address (`0x…` or decimal); errors are shown in the panel. */
  async add(spec: string) {
    const d = this.debugger;
    const text = spec.trim();
    if (!d || !text) return;
    this.error = '';
    try {
      const m = /^(.*):(\d+)$/.exec(text);
      if (/^(0x[0-9a-f]+|\d+)$/i.test(text)) {
        const addrs = this.list.filter((b) => b.kind === 'instruction').map((b) => b.address!);
        await d.setInstructionBreakpoints([...addrs, BigInt(text)]);
      } else if (m) {
        const lines = this.list.filter((b) => b.kind === 'source' && b.path === m[1]).map((b) => ({ line: b.line!, column: b.column ?? undefined }));
        await d.setSourceBreakpoints(m[1], [...lines, { line: Number(m[2]) }]);
      } else {
        throw new Error('use file:line or an address');
      }
    } catch (e) {
      this.error = errorText(e);
    }
    this.sync();
  }

  /** Remove one breakpoint, keeping the others. */
  async removeBreakpoint(bp: Breakpoint) {
    const d = this.debugger;
    if (!d) return;
    this.error = '';
    try {
      if (bp.kind === 'instruction') {
        await d.setInstructionBreakpoints(this.list.filter((b) => b.kind === 'instruction' && b.id !== bp.id).map((b) => b.address!));
      } else {
        const rest = this.list.filter((b) => b.kind === 'source' && b.path === bp.path && b.id !== bp.id);
        await d.setSourceBreakpoints(bp.path!, rest.map((b) => ({ line: b.line!, column: b.column ?? undefined })));
      }
    } catch (e) {
      this.error = errorText(e);
    }
    this.sync();
  }

  /** Remove every breakpoint. */
  async removeAll() {
    try {
      await this.debugger?.clearBreakpoints();
    } catch (e) {
      this.error = errorText(e);
    }
    this.sync();
  }

  render() {
    if (!this.debugger) return html`<div class="muted">no debugger</div>`;
    return html`
      <div class="row">
        <input class="edit" style="width:16em" placeholder="src/main.rs:40 or 0x938" @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter') { void this.add((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).value = ''; }
        }}>
        <button ?disabled=${!this.list.length} @click=${() => this.removeAll()}>Remove all</button>
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${this.list.length === 0 ? html`<div class="muted">no breakpoints</div>` : nothing}
      <table>
        ${this.list.map((b) => {
          const where = b.kind === 'source'
            ? html`${basename(b.path!)}:${b.line}${b.source?.line && b.source.line !== b.line ? html` <span class="muted">→ ${b.source.line}</span>` : nothing}`
            : html`<span class="mono">${hex(b.address!)}</span>${b.source ? html` <span class="muted">${basename(b.source.path)}:${b.source.line}</span>` : nothing}`;
          return html`<tr data-breakpoint=${b.id} class=${this.hit.includes(b.id) ? 'selected' : ''}>
            <td title=${b.verified ? 'set on the target' : b.message ?? ''}>${b.verified ? '●' : html`<span class="err">○</span>`}</td>
            <td class="where">${where}${b.verified ? nothing : html`<div class="err message">${b.message}</div>`}</td>
            <td class="mono muted">${b.kind === 'source' && b.address !== null ? hex(b.address) : ''}</td>
            <td><button title="remove" @click=${() => this.removeBreakpoint(b)}>✕</button></td>
          </tr>`;
        })}
      </table>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-breakpoints': ProbeBreakpoints; } }

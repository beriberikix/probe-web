import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Debugger, RegisterValue } from '@probe-web/client';
import { debugStyles, errorText, hex, parseBigInt } from './debug-style.ts';

type Group = 'Core' | 'System' | 'Floating point';

function groupOf(r: RegisterValue): Group {
  if (r.info.float || r.info.roles.includes('FloatingPointStatus')) return 'Floating point';
  if (r.info.id <= 16) return 'Core';
  return 'System';
}

/** `R13` → `R13 (SP)` using probe-rs register roles. */
function label(r: RegisterValue): string {
  const role = r.info.roles.find((x) => ['ProgramCounter', 'StackPointer', 'ReturnAddress', 'FramePointer'].includes(x));
  const short: Record<string, string> = { ProgramCounter: 'PC', StackPointer: 'SP', ReturnAddress: 'LR', FramePointer: 'FP' };
  return role && short[role] !== r.info.name ? `${r.info.name} (${short[role]})` : r.info.name;
}

/**
 * `<probe-registers>`: the core's registers, grouped (core, system, floating
 * point), refreshed at every stop with changed values highlighted.
 * Double-click a value to edit it while the core is halted.
 */
@customElement('probe-registers')
export class ProbeRegisters extends LitElement {
  static styles = debugStyles;

  @property({ attribute: false }) debugger: Debugger | null = null;
  @state() private values: RegisterValue[] = [];
  @state() private previous = new Map<number, bigint>();
  @state() private stale = true;
  @state() private editing: number | null = null;
  @state() private error = '';
  @state() private collapsed = new Set<Group>(['Floating point']);
  private unlisten: (() => void) | null = null;

  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has('debugger')) this.attach();
  }

  disconnectedCallback() {
    this.unlisten?.();
    this.unlisten = null;
    super.disconnectedCallback();
  }

  private attach() {
    this.unlisten?.();
    this.unlisten = null;
    const d = this.debugger;
    if (!d) return;
    const onStop = () => void this.refresh();
    const onRun = () => { this.stale = true; this.editing = null; };
    d.addEventListener('stopped', onStop);
    d.addEventListener('continued', onRun);
    this.unlisten = () => {
      d.removeEventListener('stopped', onStop);
      d.removeEventListener('continued', onRun);
    };
    if (d.state === 'halted') void this.refresh();
  }

  /** Read all registers now (the core must be halted). */
  async refresh() {
    const d = this.debugger;
    if (!d) return;
    try {
      const next = await d.readRegisters();
      this.previous = new Map(this.values.map((v) => [v.info.id, v.value]));
      this.values = next;
      this.stale = false;
      this.error = '';
    } catch (e) {
      this.error = errorText(e);
    }
  }

  private async commit(r: RegisterValue, text: string) {
    this.editing = null;
    const d = this.debugger;
    if (!d) return;
    try {
      await d.writeRegister(r.info.id, parseBigInt(text));
      const before = this.values;
      await this.refresh();
      this.previous = new Map(before.map((v) => [v.info.id, v.value]));
    } catch (e) {
      this.error = errorText(e);
    }
  }

  private toggle(g: Group) {
    const next = new Set(this.collapsed);
    if (next.has(g)) next.delete(g); else next.add(g);
    this.collapsed = next;
  }

  render() {
    if (!this.debugger) return html`<div class="muted">no debugger</div>`;
    const groups = new Map<Group, RegisterValue[]>();
    for (const v of this.values) {
      const g = groupOf(v);
      groups.set(g, [...(groups.get(g) ?? []), v]);
    }
    const halted = this.debugger.state === 'halted';
    return html`
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${this.values.length === 0 ? html`<div class="muted">halt the core to read registers</div>` : nothing}
      <table class=${this.stale ? 'stale' : ''}>
        ${[...groups.entries()].map(([g, list]) => html`
          <tr class="clickable" @click=${() => this.toggle(g)}><th colspan="2">${this.collapsed.has(g) ? '▸' : '▾'} ${g} <span class="muted">(${list.length})</span></th></tr>
          ${this.collapsed.has(g) ? nothing : list.map((r) => {
            const changed = this.previous.has(r.info.id) && this.previous.get(r.info.id) !== r.value;
            return html`<tr data-register=${r.info.name}>
              <td class="mono">${label(r)}</td>
              <td class="mono value ${changed ? 'changed' : ''}" title=${halted ? 'double-click to edit' : ''}
                  @dblclick=${() => { if (halted && !this.stale) this.editing = r.info.id; }}>
                ${this.editing === r.info.id
                  ? html`<input class="edit" .value=${hex(r.value, Math.ceil(r.info.bits / 4))} autofocus
                      @keydown=${(e: KeyboardEvent) => {
                        if (e.key === 'Enter') void this.commit(r, (e.target as HTMLInputElement).value);
                        if (e.key === 'Escape') this.editing = null;
                      }}>`
                  : r.info.float ? `${hex(r.value, Math.ceil(r.info.bits / 4))}` : hex(r.value, Math.ceil(r.info.bits / 4))}
              </td>
            </tr>`;
          })}
        `)}
      </table>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-registers': ProbeRegisters; } }

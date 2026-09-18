import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Debugger, Frame } from '@probe-web/client';
import { debugStyles, errorText, hex } from './debug-style.ts';

const basename = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;

/**
 * `<probe-callstack>`: the stack at the current stop. Inlined frames are shown
 * but the first real (non-inlined) frame is selected by default.
 *
 * @fires frame-selected - A frame was selected, by a click or automatically at each stop.
 *   `detail` is the `Frame`; set it as `<probe-variables>`' `frame` to show that
 *   frame's variables.
 */
@customElement('probe-callstack')
export class ProbeCallstack extends LitElement {
  /** @internal */
  static styles = debugStyles;

  /** The debugger whose stack is shown. */
  @property({ attribute: false }) debugger: Debugger | null = null;
  @state() private frames: Frame[] = [];
  @state() private selected: number | null = null;
  @state() private stale = true;
  @state() private error = '';
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
    const onRun = () => { this.stale = true; };
    d.addEventListener('stopped', onStop);
    d.addEventListener('continued', onRun);
    this.unlisten = () => {
      d.removeEventListener('stopped', onStop);
      d.removeEventListener('continued', onRun);
    };
    if (d.state === 'halted') void this.refresh();
  }

  /** Read the stack now (the core must be halted) and select its first non-inlined frame. */
  async refresh() {
    const d = this.debugger;
    if (!d) return;
    try {
      this.frames = await d.stackTrace();
      this.stale = false;
      this.error = '';
      const first = this.frames.find((f) => !f.inlined) ?? this.frames[0];
      if (first) this.select(first);
    } catch (e) {
      this.error = errorText(e);
    }
  }

  /** The selected frame, if any. */
  get selectedFrame(): Frame | null {
    return this.frames.find((f) => f.id === this.selected) ?? null;
  }

  /** Select `frame` and fire `frame-selected`. */
  select(frame: Frame) {
    this.selected = frame.id;
    this.dispatchEvent(new CustomEvent('frame-selected', { detail: frame, bubbles: true, composed: true }));
  }

  render() {
    return html`
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${this.frames.length === 0 ? html`<div class="muted">halt the core to see the stack</div>` : nothing}
      <table class=${this.stale ? 'stale' : ''}>
        ${this.frames.map((f) => html`
          <tr class="clickable ${f.id === this.selected ? 'selected' : ''}" data-frame=${f.functionName} @click=${() => this.select(f)}>
            <td>${f.functionName}${f.inlined ? html` <span class="muted">(inlined)</span>` : nothing}</td>
            <td class="muted">${f.source ? `${basename(f.source.path)}:${f.source.line ?? '?'}` : ''}</td>
            <td class="mono muted">${hex(f.pc)}</td>
          </tr>`)}
      </table>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-callstack': ProbeCallstack; } }

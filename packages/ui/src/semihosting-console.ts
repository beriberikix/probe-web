import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { MonitorEvent, Wire } from '@probe-web/client';
import { baseStyles } from './base-style.ts';
import { icon } from './icons.ts';

/**
 * `<probe-semihosting-console>`: shows the target's semihosting stdout and
 * stderr and its exit status. Feed it from whatever runs the monitor loop:
 * point {@link ProbeSemihostingConsole.source} at an element that dispatches
 * `monitor-event` and `monitor-exit` events (`<probe-rtt-terminal>` does), or
 * call {@link ProbeSemihostingConsole.push} and
 * {@link ProbeSemihostingConsole.setExit} directly.
 *
 * Fires no events of its own. Keeps the last 2000 output chunks.
 */
@customElement('probe-semihosting-console')
export class ProbeSemihostingConsole extends LitElement {
  /** @internal */
  static styles = [baseStyles, css`
    :host { display: flex; flex-direction: column; }
    .head { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; }
    .spacer { flex: 1; }
    pre {
      flex: 1 1 auto; box-sizing: border-box; min-height: 4em; max-height: var(--pw-console-max-height, 240px);
      margin: 0; padding: 6px 10px; overflow: auto; white-space: pre-wrap;
      font: 12px/1.45 var(--_mono); color: var(--_text-1); background: var(--_bg);
      border: 1px solid var(--_divider); border-radius: var(--_radius);
    }
    .err { color: var(--_red-1); } .status { color: var(--_text-2); font-size: 12px; }
    .exit-ok, .exit-bad { margin-top: 6px; padding: 4px 10px; border-radius: var(--_radius); font-weight: 500; }
    .exit-ok { color: var(--_green-1); background: var(--_green-soft); }
    .exit-bad { color: var(--_red-1); background: var(--_red-soft); }
  `];


  /** An element (usually a `<probe-rtt-terminal>`) whose `monitor-event` / `monitor-exit` events are shown. */
  @property({ attribute: false }) source: EventTarget | null = null;
  @state() private lines: { stream: string; text: string }[] = [];
  @state() private exit: string | null = null;
  private off: (() => void) | null = null;

  updated(changed: Map<string, unknown>) {
    if (changed.has('source')) this.bind();
  }
  disconnectedCallback() { this.off?.(); super.disconnectedCallback(); }

  private bind() {
    this.off?.();
    const src = this.source;
    if (!src) return;
    const onEvent = (e: Event) => this.push((e as CustomEvent<MonitorEvent>).detail);
    const onExit = (e: Event) => this.setExit((e as CustomEvent<Wire.MonitorExitReason>).detail);
    src.addEventListener('monitor-event', onEvent);
    src.addEventListener('monitor-exit', onExit);
    this.off = () => { src.removeEventListener('monitor-event', onEvent); src.removeEventListener('monitor-exit', onExit); };
  }

  /** Append the output of a semihosting monitor event; other kinds are ignored. */
  push(e: MonitorEvent) {
    if (e.kind !== 'semihosting') return;
    this.lines = [...this.lines, { stream: e.stream, text: e.data }].slice(-2000);
  }

  /** Show how the monitor loop ended; only a semihosting exit is displayed, anything else clears it. */
  setExit(reason: Wire.MonitorExitReason) {
    if (typeof reason === 'object' && 'SemihostingExit' in reason) {
      const r = reason.SemihostingExit;
      this.exit = 'Ok' in r ? 'target exited: success' : `target exited with error: ${JSON.stringify(r.Err)}`;
    } else this.exit = null;
  }

  /** Clear the output and exit status. */
  clear() { this.lines = []; this.exit = null; }

  render() {
    return html`
      <div class="head">
        <span class="status">semihosting ${this.lines.length ? `(${this.lines.length} chunk${this.lines.length === 1 ? '' : 's'})` : '(no output yet)'}</span>
        <span class="spacer"></span>
        <button class="ghost" title="Clear the output" @click=${this.clear}>${icon('trash', 13)}Clear</button>
      </div>
      <pre>${this.lines.map((l) => html`<span class=${l.stream === 'stderr' ? 'err' : ''}>${l.text}</span>`)}</pre>
      ${this.exit ? html`<div class=${this.exit.includes('success') ? 'exit-ok' : 'exit-bad'}>${this.exit}</div>` : nothing}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-semihosting-console': ProbeSemihostingConsole; } }

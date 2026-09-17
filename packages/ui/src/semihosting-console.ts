import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { MonitorEvent, Wire } from '@probe-web/client';

/**
 * `<probe-semihosting-console>`: shows the target's semihosting stdout and
 * stderr and its exit status. Feed it from whatever runs the monitor loop:
 * point `source` at an element that dispatches `monitor-event` (the RTT
 * terminal does) and `monitor-exit` events, or call `push()` directly.
 */
@customElement('probe-semihosting-console')
export class ProbeSemihostingConsole extends LitElement {
  static styles = css`
    :host { display: block; font: 13px system-ui, sans-serif; }
    pre { background: #111; color: #eee; padding: 8px; border-radius: 6px; min-height: 4em; max-height: 240px; overflow: auto; font-size: 12px; margin: 4px 0; white-space: pre-wrap; }
    .err { color: #f87171; } .status { color: #666; } .exit-ok { color: #15803d; } .exit-bad { color: #b91c1c; }
    button { font: inherit; padding: 4px 8px; }
  `;

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

  push(e: MonitorEvent) {
    if (e.kind !== 'semihosting') return;
    this.lines = [...this.lines, { stream: e.stream, text: e.data }].slice(-2000);
  }

  setExit(reason: Wire.MonitorExitReason) {
    if (typeof reason === 'object' && 'SemihostingExit' in reason) {
      const r = reason.SemihostingExit;
      this.exit = 'Ok' in r ? 'target exited: success' : `target exited with error: ${JSON.stringify(r.Err)}`;
    } else this.exit = null;
  }

  clear() { this.lines = []; this.exit = null; }

  render() {
    return html`
      <div class="status">semihosting ${this.lines.length ? `(${this.lines.length} chunk${this.lines.length === 1 ? '' : 's'})` : '(no output yet)'} <button @click=${this.clear}>Clear</button></div>
      <pre>${this.lines.map((l) => html`<span class=${l.stream === 'stderr' ? 'err' : ''}>${l.text}</span>`)}</pre>
      ${this.exit ? html`<div class=${this.exit.includes('success') ? 'exit-ok' : 'exit-bad'}>${this.exit}</div>` : nothing}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-semihosting-console': ProbeSemihostingConsole; } }

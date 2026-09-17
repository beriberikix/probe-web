import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Debugger, RunState, StoppedDetail } from '@probe-web/client';
import { debugStyles, errorText, hex } from './debug-style.ts';

/** Describe a halt reason for people. */
export function describeStop(stop: StoppedDetail | null): string {
  if (!stop) return '';
  const r = stop.reason;
  if (typeof r === 'string') return r === 'Request' ? 'paused' : r === 'Step' ? 'step' : r.toLowerCase();
  if ('Breakpoint' in r) {
    const cause = r.Breakpoint;
    if (typeof cause === 'object' && 'Semihosting' in cause) return 'semihosting';
    return stop.breakpoints.length ? `breakpoint ${stop.breakpoints.join(', ')}` : 'breakpoint';
  }
  return JSON.stringify(r);
}

/**
 * `<probe-core-controls>`: run control for one core — continue, pause, step
 * (over / into / out / instruction), reset, reset-and-halt, vector catch —
 * and the core's state. Events: `debug-error` (detail: Error).
 */
@customElement('probe-core-controls')
export class ProbeCoreControls extends LitElement {
  static styles = debugStyles;

  @property({ attribute: false }) debugger: Debugger | null = null;
  @state() private runState: RunState = 'unknown';
  @state() private stop: StoppedDetail | null = null;
  @state() private busy = false;
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

  connectedCallback() {
    super.connectedCallback();
    if (this.debugger && !this.unlisten) this.attach();
  }

  private attach() {
    this.unlisten?.();
    this.unlisten = null;
    const d = this.debugger;
    if (!d) return;
    const sync = () => {
      this.runState = d.state;
      this.stop = d.lastStop;
    };
    const events = ['state', 'stopped', 'continued', 'locked-up'];
    for (const e of events) d.addEventListener(e, sync);
    this.unlisten = () => events.forEach((e) => d.removeEventListener(e, sync));
    sync();
  }

  private async act(fn: (d: Debugger) => Promise<unknown>) {
    const d = this.debugger;
    if (!d || this.busy) return;
    this.busy = true;
    this.error = '';
    try {
      await fn(d);
    } catch (e) {
      this.error = errorText(e);
      this.dispatchEvent(new CustomEvent('debug-error', { detail: e, bubbles: true, composed: true }));
    } finally {
      this.busy = false;
      this.runState = d.state;
      this.stop = d.lastStop;
    }
  }

  render() {
    const d = this.debugger;
    const halted = this.runState === 'halted';
    const running = this.runState === 'running' || this.runState === 'sleeping';
    const off = !d || this.busy;
    return html`
      <div class="row">
        <button title="Continue" ?disabled=${off || !halted} @click=${() => this.act((x) => x.continue())}>▶ Continue</button>
        <button title="Pause" ?disabled=${off || !running} @click=${() => this.act((x) => x.pause())}>⏸ Pause</button>
        <button title="Step over" ?disabled=${off || !halted} @click=${() => this.act((x) => x.step('over'))}>Step over</button>
        <button title="Step into" ?disabled=${off || !halted} @click=${() => this.act((x) => x.step('into'))}>Step into</button>
        <button title="Step out" ?disabled=${off || !halted} @click=${() => this.act((x) => x.step('out'))}>Step out</button>
        <button title="Step one instruction" ?disabled=${off || !halted} @click=${() => this.act((x) => x.step('instruction'))}>Step instr.</button>
        <button title="Reset and run" ?disabled=${off} @click=${() => this.act((x) => x.reset())}>Reset</button>
        <button title="Reset and halt at the reset vector" ?disabled=${off} @click=${() => this.act((x) => x.resetAndHalt())}>Reset + halt</button>
      </div>
      <div class="row">
        <span class="state"><b>${this.runState}</b>${halted && this.stop ? html` — ${describeStop(this.stop)} at <span class="mono">${hex(this.stop.pc)}</span>` : nothing}</span>
        <span class="muted">catch:</span>
        <button ?disabled=${off} @click=${() => this.act((x) => x.enableVectorCatch('HardFault'))}>HardFault</button>
        <button ?disabled=${off} @click=${() => this.act((x) => x.enableVectorCatch('CoreReset'))}>Reset</button>
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-core-controls': ProbeCoreControls; } }

import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Debugger, RunState, StoppedDetail } from '@probe-web/client';
import { debugStyles, errorText, hex } from './debug-style.ts';
import { icon, type IconName } from './icons.ts';

/**
 * Describe a halt reason for people: `paused`, `step`, `breakpoint 1, 2`,
 * `semihosting`, and so on. Returns `''` for `null`.
 */
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
 * and the core's state, with the halt reason and PC when halted.
 *
 * Like the other debugger panels it takes a `Debugger` (from
 * `session.debugger()`) and follows its events; any number of panels can share one.
 *
 * @fires debug-error - A run-control command failed. `detail` is the error; the message
 *   is also shown in the panel.
 *
 * @example
 * ```html
 * <probe-core-controls></probe-core-controls>
 * <probe-callstack></probe-callstack>
 * <probe-variables></probe-variables>
 * ```
 * ```ts
 * const d = session.debugger();
 * await d.loadDebugInfo(elf, 'firmware.elf');
 * for (const el of document.querySelectorAll('probe-core-controls, probe-callstack, probe-variables')) {
 *   (el as ProbeCoreControls | ProbeCallstack | ProbeVariables).debugger = d;
 * }
 * const vars = document.querySelector('probe-variables')!;
 * document.querySelector('probe-callstack')!.addEventListener('frame-selected', (e) => {
 *   vars.frame = (e as CustomEvent<Frame>).detail;
 * });
 * ```
 */
@customElement('probe-core-controls')
export class ProbeCoreControls extends LitElement {
  /** @internal */
  static styles = [debugStyles, css`
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
    .toolbar {
      display: inline-flex; align-items: center; gap: 1px; padding: 2px;
      border: 1px solid var(--_divider); border-radius: var(--_radius-lg); background: var(--_bg);
      box-shadow: var(--pw-shadow-1, 0 1px 2px rgba(0, 0, 0, 0.06));
    }
    .toolbar button { width: 28px; min-height: 26px; padding: 0; background: transparent; color: var(--_text-2); }
    .toolbar button:hover:not(:disabled) { background: var(--_default-soft); color: var(--_text-1); }
    .toolbar button.go:not(:disabled) { color: var(--_green-1); }
    .toolbar button.pause:not(:disabled) { color: var(--_brand-1); }
    .toolbar button.reset:not(:disabled) { color: var(--_yellow-2); }
    .toolbar button:disabled { opacity: 0.35; }
    .toolbar .sep { height: 16px; align-self: center; margin: 0 3px; }
    .state {
      display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px 2px 8px;
      border-radius: 999px; background: var(--_default-soft); white-space: nowrap;
    }
    .state::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--_text-3); }
    .state[data-state='halted']::before { background: var(--_yellow-2); }
    .state[data-state='running']::before, .state[data-state='sleeping']::before { background: var(--_green-1); }
    .state[data-state='locked-up']::before { background: var(--_red-2); }
    .catch { display: inline-flex; align-items: center; gap: 4px; }
    .catch button { min-height: 22px; padding: 0 8px; font-size: 12px; }
    .err { margin-top: 6px; }
  `];

  /** The debugger to control; the buttons are disabled without one. */
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
    // Icon buttons like VS Code's debug toolbar. `title` names each for tooltips and
    // aria-label for assistive tech (the labels predate the icons and tests use them).
    const btn = (label: string, title: string, name: IconName, cls: string, disabled: boolean, fn: (x: Debugger) => Promise<unknown>) =>
      html`<button class=${cls} title=${title} aria-label=${label} ?disabled=${disabled} @click=${() => this.act(fn)}>${icon(name)}</button>`;
    return html`
      <div class="bar">
        <div class="toolbar" role="toolbar" aria-label="Run control">
          ${btn('Continue', 'Continue', 'play', 'go', off || !halted, (x) => x.continue())}
          ${btn('Pause', 'Pause', 'pause', 'pause', off || !running, (x) => x.pause())}
          <span class="sep"></span>
          ${btn('Step over', 'Step over', 'step-over', '', off || !halted, (x) => x.step('over'))}
          ${btn('Step into', 'Step into', 'step-into', '', off || !halted, (x) => x.step('into'))}
          ${btn('Step out', 'Step out', 'step-out', '', off || !halted, (x) => x.step('out'))}
          ${btn('Step instr.', 'Step one instruction', 'step-instruction', '', off || !halted, (x) => x.step('instruction'))}
          <span class="sep"></span>
          ${btn('Reset', 'Reset and run', 'restart', 'reset', off, (x) => x.reset())}
          ${btn('Reset + halt', 'Reset and halt at the reset vector', 'restart-halt', 'reset', off, (x) => x.resetAndHalt())}
        </div>
        <span class="state" data-state=${this.runState}><b>${this.runState}</b>${halted && this.stop ? html` — ${describeStop(this.stop)} at <span class="mono">${hex(this.stop.pc)}</span>` : nothing}</span>
        <span class="catch" title="Halt when the core takes this exception">
          <span class="muted">catch:</span>
          <button ?disabled=${off} @click=${() => this.act((x) => x.enableVectorCatch('HardFault'))}>HardFault</button>
          <button ?disabled=${off} @click=${() => this.act((x) => x.enableVectorCatch('CoreReset'))}>Reset</button>
        </span>
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-core-controls': ProbeCoreControls; } }

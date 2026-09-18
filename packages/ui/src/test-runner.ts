import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { MonitorEvent, Session, Wire } from '@probe-web/client';

interface Row {
  test: Wire.Test;
  state: 'pending' | 'running' | 'pass' | 'fail' | 'ignored';
  detail?: string;
  ms?: number;
}

/**
 * `<probe-test-runner>`: list and run an `embedded-test` suite on the attached target.
 * Needs a server that provides the `tests/*` endpoints and a
 * {@link ProbeTestRunner.bootInfo} from flashing the test firmware.
 *
 * Takes a `session` rather than a `debugger`, because the tests endpoints belong to the
 * session — running a suite is not a debug activity, and the panel is useful without one.
 *
 * Each test is run on its own, resetting the target in between. That is how
 * `embedded-test` works and it is the reason a failure is attributable to one test rather
 * than to whatever ran before it; the cost is a reset per test, which is why the run is
 * sequential and shows progress as it goes.
 *
 * @fires tests-finished - {@link ProbeTestRunner.runAll} finished, including when it
 *   stopped early on an error. `detail` is {@link ProbeTestRunner.summary}:
 *   `{ total, passed, failed, ignored }`.
 */
@customElement('probe-test-runner')
export class ProbeTestRunner extends LitElement {
  /** @internal */
  static styles = css`
    :host { display: block; font: 13px system-ui, sans-serif; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
    button { font: inherit; padding: 5px 9px; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    td, th { padding: 3px 8px; text-align: left; border-bottom: 1px solid #eee; }
    th { color: #666; font-weight: 500; }
    .name { font-family: ui-monospace, monospace; }
    .pass { color: #15803d; } .fail { color: #b91c1c; } .muted, .ignored { color: #666; }
    .running { color: #1d4ed8; }
    .detail { color: #b91c1c; font-size: 11px; }
    output { display: block; margin-top: 6px; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 11px; max-height: 140px; overflow: auto; color: #444; }
  `;

  /** The attached session whose `tests/*` endpoints run the suite. */
  @property({ attribute: false }) session: Session | null = null;
  /** How to get the firmware running, as `monitor` takes it. Set after flashing. */
  @property({ attribute: false }) bootInfo: Wire.BootInfo | null = null;
  @state() private rows: Row[] = [];
  @state() private busy = false;
  @state() private error: string | null = null;
  @state() private output = '';

  /**
   * Called for every monitor event while listing or running; collects semihosting and RTT
   * text into the output shown under the table. Overridable so a test or an automated
   * check can watch the console traffic.
   */
  onEvent(e: MonitorEvent) {
    if (e.kind === 'semihosting' || e.kind === 'text') {
      this.output = (this.output + ('data' in e ? e.data : '')).slice(-4000);
    }
  }

  private get supported(): boolean {
    return this.session?.supports('tests/list') ?? false;
  }

  /** Ask the firmware what tests it has (boots it with {@link ProbeTestRunner.bootInfo}) and reset the results table. */
  async list() {
    if (!this.session || !this.bootInfo) return;
    this.busy = true;
    this.error = null;
    this.output = '';
    try {
      const tests = await this.session.listTests(this.bootInfo, (e) => this.onEvent(e));
      this.rows = tests.tests.map((test) => ({ test, state: test.ignored ? 'ignored' : 'pending' }));
    } catch (e) {
      this.error = String((e as Error).message ?? e);
    } finally {
      this.busy = false;
    }
  }

  /** Run every test that is not ignored, in order. */
  async runAll() {
    if (!this.session) return;
    this.busy = true;
    this.error = null;
    try {
      for (const row of this.rows) {
        if (row.state === 'ignored') continue;
        await this.runRow(row);
      }
    } finally {
      this.busy = false;
      this.dispatchEvent(new CustomEvent('tests-finished', { detail: this.summary, bubbles: true, composed: true }));
    }
  }

  private async runRow(row: Row) {
    row.state = 'running';
    row.detail = undefined;
    this.rows = [...this.rows];
    const started = performance.now();
    try {
      const result = await this.session!.runTest(row.test, (e) => this.onEvent(e));
      // `Success` is a bare string; a failure carries its reason.
      if (result === 'Success') row.state = 'pass';
      else if (typeof result === 'object' && 'Failed' in result) {
        row.state = 'fail';
        row.detail = result.Failed;
      } else {
        row.state = 'fail';
        row.detail = 'cancelled';
      }
    } catch (e) {
      row.state = 'fail';
      row.detail = String((e as Error).message ?? e);
    } finally {
      row.ms = Math.round(performance.now() - started);
      this.rows = [...this.rows];
    }
  }

  /** Result counts for the current table, for the caller and for an automated check. */
  get summary() {
    const count = (s: Row['state']) => this.rows.filter((r) => r.state === s).length;
    return { total: this.rows.length, passed: count('pass'), failed: count('fail'), ignored: count('ignored') };
  }

  render() {
    if (!this.session) return html`<div class="muted">no session</div>`;
    if (!this.supported) {
      return html`<div class="muted">the connected server does not provide the embedded-test endpoints</div>`;
    }
    const s = this.summary;
    return html`
      <div class="row">
        <button id="list" @click=${this.list} ?disabled=${this.busy || !this.bootInfo}>List tests</button>
        <button id="run-all" @click=${this.runAll} ?disabled=${this.busy || this.rows.length === 0}>Run all</button>
        ${this.rows.length ? html`<span class="muted" id="summary">${s.passed} passed, ${s.failed} failed, ${s.ignored} ignored of ${s.total}</span>` : nothing}
      </div>
      ${!this.bootInfo ? html`<div class="muted">flash an embedded-test firmware first</div>` : nothing}
      ${this.error ? html`<div class="fail">${this.error}</div>` : nothing}
      ${this.rows.length ? html`
        <table>
          <tr><th>test</th><th>result</th><th>ms</th></tr>
          ${this.rows.map((r) => html`
            <tr data-test=${r.test.name} data-state=${r.state}>
              <td class="name">${r.test.name}${r.test.expected_outcome === 'Panic' ? html` <span class="muted">(should panic)</span>` : nothing}</td>
              <td class=${r.state}>${r.state}${r.detail ? html`<div class="detail">${r.detail}</div>` : nothing}</td>
              <td class="muted">${r.ms ?? ''}</td>
            </tr>`)}
        </table>` : nothing}
      ${this.output ? html`<output>${this.output}</output>` : nothing}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-test-runner': ProbeTestRunner; } }

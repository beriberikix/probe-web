import { css, html } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { DebuggerElement } from './debugger-element.ts';
import { SampleDecoder, type SampleFormat } from './samples.ts';

/**
 * `<probe-rtt-plot>`: plot the numbers coming out of a binary RTT channel.
 *
 * `cargo-embed` has had this for years as `probe-rs trace` writing pairs to stdout for an
 * external `plot.py`; in a browser there is no reason to leave the page. A firmware that
 * writes samples to a `BinaryLE` channel gets a live trace with no extra tooling.
 *
 * Drawn on a canvas rather than with a charting library: a rolling line plot is about a
 * hundred lines, and the alternative is a dependency and its licence for every visitor who
 * loads the workbench. `<probe-memory-view>` made the same call about hex rendering.
 *
 * Fires `channel-changed` when the user picks a different channel. A host has to act on it:
 * a channel only yields bytes if it was configured as `BinaryLE` when RTT was set up, which
 * happens once, at the start of a run.
 */
@customElement('probe-rtt-plot')
export class ProbeRttPlot extends DebuggerElement {
  static styles = css`
    :host { display: block; font: 13px system-ui, sans-serif; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
    select, input { font: inherit; padding: 3px 5px; }
    input[type=number] { width: 6em; }
    button { font: inherit; padding: 4px 8px; }
    canvas { width: 100%; height: 160px; display: block; border: 1px solid #ddd; border-radius: 6px; background: #fff; }
    .muted { color: #666; }
    .stat { font-family: ui-monospace, monospace; font-size: 11px; color: #444; }
  `;

  /** Which up channel to plot. */
  @property({ type: Number }) channel = 1;
  /** How to read the bytes. */
  @property() format: SampleFormat = 'u32';
  /** How many samples to keep on screen. */
  @property({ type: Number }) window = 400;

  @state() private count = 0;
  @state() private last: number | null = null;

  @query('canvas') private canvas!: HTMLCanvasElement;

  /** The visible samples, oldest first. */
  #samples: number[] = [];
  #decoder = new SampleDecoder('u32');
  #onBytes = (e: Event) => this.#take(e as CustomEvent<{ channel: number; bytes: Uint8Array }>);

  connectedCallback() {
    super.connectedCallback();
    this.#decoder.format = this.format;
    this.debugger?.addEventListener('rtt-bytes', this.#onBytes);
  }

  disconnectedCallback() {
    this.debugger?.removeEventListener('rtt-bytes', this.#onBytes);
    super.disconnectedCallback();
  }

  /** Feed bytes in directly. Used by the tests, and by anything not driving a `Debugger`. */
  push(channel: number, bytes: Uint8Array) {
    this.#take(new CustomEvent('rtt-bytes', { detail: { channel, bytes } }));
  }

  #take(e: CustomEvent<{ channel: number; bytes: Uint8Array }>) {
    const { channel, bytes } = e.detail;
    if (channel !== this.channel) return;
    const values = this.#decoder.push(bytes);
    if (values.length === 0) return;
    this.#samples.push(...values);
    // A rolling window: older samples are dropped rather than kept for ever.
    if (this.#samples.length > this.window) this.#samples.splice(0, this.#samples.length - this.window);
    this.count += values.length;
    this.last = values[values.length - 1];
    this.draw();
  }

  /** Throw away what is on screen, e.g. after a reset. */
  clear() {
    this.#samples = [];
    this.#decoder.reset();
    this.count = 0;
    this.last = null;
    this.draw();
  }

  /** The samples currently shown, for tests and for export. */
  get samples(): readonly number[] {
    return this.#samples;
  }

  updated(changed: Map<string, unknown>) {
    super.updated?.(changed);
    // `DebuggerElement` re-subscribes its own events when the debugger changes but has no
    // detach hook, so the byte listener is moved here by hand — otherwise it would stay
    // bound to the previous debugger and quietly plot a dead session.
    if (changed.has('debugger')) {
      (changed.get('debugger') as EventTarget | null)?.removeEventListener('rtt-bytes', this.#onBytes);
      this.debugger?.addEventListener('rtt-bytes', this.#onBytes);
      this.clear();
    }
    if (changed.has('format')) {
      this.#decoder.format = this.format;
      this.#samples = [];
    }
    this.draw();
  }

  /** Redraw the trace. Cheap enough to do on every poll at RTT rates. */
  draw() {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Match the backing store to the displayed size so the line is not blurred.
    const ratio = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.clearRect(0, 0, width, height);
    const samples = this.#samples;
    if (samples.length < 2) return;

    let min = Infinity;
    let max = -Infinity;
    for (const v of samples) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // A flat trace would divide by zero; give it a band so it draws down the middle.
    if (min === max) {
      min -= 1;
      max += 1;
    }

    const pad = 4 * ratio;
    const x = (i: number) => (i / (samples.length - 1)) * (width - 2 * pad) + pad;
    const y = (v: number) => height - pad - ((v - min) / (max - min)) * (height - 2 * pad);

    ctx.strokeStyle = '#1d4ed8';
    ctx.lineWidth = Math.max(1, ratio);
    ctx.beginPath();
    ctx.moveTo(x(0), y(samples[0]));
    for (let i = 1; i < samples.length; i++) ctx.lineTo(x(i), y(samples[i]));
    ctx.stroke();

    // The range, so the trace means something without axes.
    ctx.fillStyle = '#666';
    ctx.font = `${11 * ratio}px ui-monospace, monospace`;
    ctx.fillText(String(max), pad, 12 * ratio);
    ctx.fillText(String(min), pad, height - 3 * ratio);
  }

  render() {
    const formats: SampleFormat[] = ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32'];
    return html`
      <div class="row">
        <label>channel <input type="number" min="0" .value=${String(this.channel)}
          @change=${(e: Event) => {
            this.channel = Number((e.target as HTMLInputElement).value);
            this.clear();
            // Which channel is binary is decided when RTT is set up, so a host that
            // configures the session needs to know, and the change only takes hold on the
            // next run.
            this.dispatchEvent(new CustomEvent('channel-changed', { detail: this.channel, bubbles: true, composed: true }));
          }}></label>
        <label>format <select .value=${this.format}
          @change=${(e: Event) => (this.format = (e.target as HTMLSelectElement).value as SampleFormat)}>
          ${formats.map((f) => html`<option value=${f} ?selected=${f === this.format}>${f}</option>`)}
        </select></label>
        <label>window <input type="number" min="2" .value=${String(this.window)}
          @change=${(e: Event) => (this.window = Number((e.target as HTMLInputElement).value))}></label>
        <button @click=${this.clear}>Clear</button>
        <span class="stat" id="stat">${this.count} sample${this.count === 1 ? '' : 's'}${this.last === null ? '' : `, last ${this.last}`}</span>
      </div>
      <canvas></canvas>
      ${this.count === 0 ? html`<div class="muted">waiting for bytes on channel ${this.channel} — the firmware must write to it, and the channel must be set up as BinaryLE when the session starts</div>` : ''}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-rtt-plot': ProbeRttPlot; } }

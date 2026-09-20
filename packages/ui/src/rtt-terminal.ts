import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { elfHasRtt, type MonitorEvent, type Session, type Wire } from '@probe-web/client';
import { baseStyles } from './base-style.ts';
import { LazyTerminal } from './lazy-terminal.ts';
import { icon } from './icons.ts';

/**
 * `<probe-rtt-terminal>`: runs the monitor loop and shows RTT (String or
 * defmt-decoded) and semihosting output in an xterm.js terminal. Typed
 * input goes to RTT down channel 0, a line at a time. Setting
 * {@link ProbeRttTerminal.bootInfo} (from `flash-done`) makes *Run + monitor*
 * start the flashed image; otherwise it attaches to the already running target.
 *
 * Pair it with `<probe-semihosting-console>` by setting that element's `source`
 * to this one.
 *
 * @fires monitor-event - For every event from the monitor loop (RTT discovery, text,
 *   defmt lines, raw bytes, semihosting output). `detail` is the `MonitorEvent`.
 * @fires monitor-exit - The monitor loop ended. `detail` is the `Wire.MonitorExitReason`.
 *   Not fired if the loop failed with an error.
 *
 * @example
 * ```html
 * <probe-rtt-terminal id="rtt"></probe-rtt-terminal>
 * ```
 * ```ts
 * const rtt = document.querySelector('probe-rtt-terminal')!;
 * rtt.session = session;
 * rtt.bootInfo = bootInfo; // from <probe-flash-panel>'s flash-done
 * rtt.elf = rtt.defmtElf = elfBytes; // exact RTT address, and defmt decoding
 * const exit = await rtt.start();
 * ```
 */
@customElement('probe-rtt-terminal')
export class ProbeRttTerminal extends LitElement {
  /** @internal */
  static styles = [baseStyles, css`
    :host { display: flex; flex-direction: column; }
    .row { margin: 0 0 6px; }
    .term {
      flex: 1 1 auto; height: var(--pw-terminal-height, 320px); min-height: 80px; box-sizing: border-box;
      padding: 4px 0 4px 8px; background: var(--_bg);
      border: 1px solid var(--_divider); border-radius: var(--_radius);
    }
    .status { color: var(--_text-2); font-size: 12px; }
    .spacer { flex: 1; }
  `];

  /** The attached session to monitor; the buttons are disabled without one. */
  @property({ attribute: false }) session: Session | null = null;
  /** How to start the flashed firmware (from `flash-done`); `null` attaches to it as it runs. */
  @property({ attribute: false }) bootInfo: Wire.BootInfo | null = null;
  /** ELF of the running firmware; its `_SEGGER_RTT` symbol gives an exact scan region. */
  @property({ attribute: false }) elf: Uint8Array | null = null;
  /** ELF whose defmt table decodes the channels (usually the same file). */
  @property({ attribute: false }) defmtElf: Uint8Array | null = null;
  @state() private running = false;
  @state() private status = 'idle';
  @state() private channels: Wire.ChannelInfo[] = [];
  private term = new LazyTerminal();
  private line = '';

  disconnectedCallback() {
    this.term.unfollow();
    super.disconnectedCallback();
  }

  connectedCallback() {
    super.connectedCallback();
    this.term.follow();
  }

  firstUpdated() {
    this.term.onData((d) => this.onInput(d));
    void this.term.open(this.renderRoot as ShadowRoot, this.renderRoot.querySelector('.term')!);
  }

  private onInput(d: string) {
    if (!this.session || !this.running) return;
    if (d === '\r') {
      const text = this.line + '\n';
      this.line = '';
      this.term.write('\r\n');
      void this.session.rttWrite(0, text).catch((e) => this.term.writeln(`\x1b[31m[rtt write failed: ${e}]\x1b[0m`));
    } else if (d === '\x7f') {
      if (this.line) { this.line = this.line.slice(0, -1); this.term.write('\b \b'); }
    } else {
      this.line += d;
      this.term.write(d);
    }
  }

  /**
   * Set up RTT and run the monitor loop until the target exits or {@link ProbeRttTerminal.stop} is called.
   * Resolves with the monitor's exit reason, or `null` if it failed or was not started
   * (no session, or already running).
   */
  async start(): Promise<Wire.MonitorExitReason | null> {
    if (!this.session || this.running) return null;
    this.running = true;
    this.status = 'attaching RTT…';
    try {
      const elf = this.elf ?? this.defmtElf ?? undefined;
      // An ELF without `_SEGGER_RTT` (e.g. semihosting-only firmware) gets no RTT
      // client: otherwise the server rescans all of RAM on every poll.
      const useRtt = !elf || elfHasRtt(elf);
      if (useRtt) await this.session.createRttClient({ elf, defaults: { dataFormat: this.defmtElf ? 'Defmt' : 'String' } });
      else {
        this.session.clearRttClient();
        this.term.writeln('\x1b[90m[ELF has no RTT control block; monitoring semihosting only]\x1b[0m');
      }
      if (useRtt && this.defmtElf) {
        const ok = this.session.setDefmtElf(this.defmtElf);
        if (!ok) this.term.writeln('\x1b[33m[ELF has no defmt table; showing raw bytes]\x1b[0m');
      }
      const exit = await this.session.monitor(this.bootInfo ?? 'attach', (e) => this.onEvent(e));
      this.status = `stopped: ${typeof exit === 'string' ? exit : JSON.stringify(exit)}`;
      this.dispatchEvent(new CustomEvent('monitor-exit', { detail: exit, bubbles: true, composed: true }));
      return exit;
    } catch (e) {
      this.status = `error: ${(e as Error).message ?? e}`;
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Cancel the running monitor loop; {@link ProbeRttTerminal.start} then resolves. */
  async stop() {
    await this.session?.cancel();
  }

  /**
   * Called for every monitor event: fires `monitor-event` and writes the event to the
   * terminal. Overridable for tests and automation.
   */
  onEvent(e: MonitorEvent) {
    this.dispatchEvent(new CustomEvent('monitor-event', { detail: e, bubbles: true, composed: true }));
    const t = this.term;
    switch (e.kind) {
      case 'rtt-discovered':
        this.channels = e.up;
        this.status = `RTT: ${e.up.length} up / ${e.down.length} down channel(s)`;
        t.writeln(`\x1b[36m[RTT up: ${e.up.map((c) => c.name || '?').join(', ')}]\x1b[0m`);
        break;
      case 'text':
        t.write(e.text);
        break;
      case 'defmt':
        for (const l of e.lines) t.writeln(`${levelColor(l.level)}${(l.level ?? '').padEnd(5)}\x1b[0m ${l.message}`);
        if (e.malformed) t.writeln('\x1b[31m[malformed defmt frame]\x1b[0m');
        break;
      case 'bytes':
        t.writeln(`\x1b[90m[ch${e.channel} ${e.bytes.length} bytes] ${e.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}\x1b[0m`);
        break;
      case 'semihosting':
        t.write(e.data);
        break;
    }
  }

  render() {
    return html`
      <div class="row">
        <button class="primary" @click=${this.start} ?disabled=${this.running || !this.session}>${icon('play', 12)}${this.bootInfo ? 'Run + monitor' : 'Attach + monitor'}</button>
        <button @click=${this.stop} ?disabled=${!this.running}>${icon('stop', 12)}Stop</button>
        <span class="status">${this.status}</span>
        ${this.channels.length ? html`<span class="status">${this.channels.map((c) => c.name).join(' · ')}</span>` : nothing}
        <span class="spacer"></span>
        <button class="ghost" title="Clear the terminal" @click=${() => this.term.clear()}>${icon('trash', 13)}Clear</button>
      </div>
      <div class="term"></div>
    `;
  }
}

function levelColor(level: string | null) {
  switch (level) {
    case 'error': return '\x1b[31m';
    case 'warn': return '\x1b[33m';
    case 'info': return '\x1b[32m';
    case 'debug': return '\x1b[34m';
    default: return '\x1b[90m';
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-rtt-terminal': ProbeRttTerminal; } }

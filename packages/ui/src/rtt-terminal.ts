import { LitElement, css, html, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import xtermCss from '@xterm/xterm/css/xterm.css?inline';
import type { MonitorEvent, Session, Wire } from '@probe-web/client';

/**
 * `<probe-rtt-terminal>`: runs the monitor loop and shows RTT (String or
 * defmt-decoded) and semihosting output in an xterm.js terminal. Typed
 * input goes to RTT down channel 0. `boot-info` (from a flash) selects
 * run mode; otherwise it attaches to the running target.
 */
@customElement('probe-rtt-terminal')
export class ProbeRttTerminal extends LitElement {
  static styles = [unsafeCSS(xtermCss), css`
    :host { display: block; font: 13px system-ui, sans-serif; }
    .row { display: flex; gap: 8px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
    button { font: inherit; padding: 6px 10px; }
    .term { height: 320px; background: #000; padding: 4px; border-radius: 6px; }
    .status { color: #666; }
  `];

  @property({ attribute: false }) session: Session | null = null;
  @property({ attribute: false }) bootInfo: Wire.BootInfo | null = null;
  @property({ attribute: false }) defmtElf: Uint8Array | null = null;
  @state() private running = false;
  @state() private status = 'idle';
  @state() private channels: Wire.ChannelInfo[] = [];
  private term: Terminal | null = null;
  private fit = new FitAddon();
  private line = '';

  firstUpdated() {
    this.term = new Terminal({ convertEol: true, fontSize: 12, scrollback: 5000, theme: { background: '#000000' } });
    this.term.loadAddon(this.fit);
    this.term.open(this.renderRoot.querySelector('.term')!);
    this.fit.fit();
    this.term.onData((d) => this.onInput(d));
    new ResizeObserver(() => this.fit.fit()).observe(this.renderRoot.querySelector('.term')!);
  }

  private onInput(d: string) {
    if (!this.session || !this.running) return;
    if (d === '\r') {
      const text = this.line + '\n';
      this.line = '';
      this.term?.write('\r\n');
      void this.session.rttWrite(0, text).catch((e) => this.term?.writeln(`\x1b[31m[rtt write failed: ${e}]\x1b[0m`));
    } else if (d === '\x7f') {
      if (this.line) { this.line = this.line.slice(0, -1); this.term?.write('\b \b'); }
    } else {
      this.line += d;
      this.term?.write(d);
    }
  }

  async start() {
    if (!this.session || this.running) return;
    this.running = true;
    this.status = 'attaching RTT…';
    try {
      await this.session.createRttClient({ elf: this.defmtElf ?? undefined, defaults: { dataFormat: this.defmtElf ? 'Defmt' : 'String' } });
      if (this.defmtElf) {
        const ok = this.session.setDefmtElf(this.defmtElf);
        if (!ok) this.term?.writeln('\x1b[33m[ELF has no defmt table; showing raw bytes]\x1b[0m');
      }
      const exit = await this.session.monitor(this.bootInfo ?? 'attach', (e) => this.onEvent(e));
      this.status = `stopped: ${typeof exit === 'string' ? exit : JSON.stringify(exit)}`;
    } catch (e) {
      this.status = `error: ${(e as Error).message ?? e}`;
    } finally {
      this.running = false;
    }
  }

  async stop() {
    await this.session?.cancel();
  }

  /** Called for every monitor event; overridable for tests/automation. */
  onEvent(e: MonitorEvent) {
    const t = this.term;
    if (!t) return;
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
        <button @click=${this.start} ?disabled=${this.running || !this.session}>${this.bootInfo ? 'Run + monitor' : 'Attach + monitor'}</button>
        <button @click=${this.stop} ?disabled=${!this.running}>Stop</button>
        <button @click=${() => this.term?.clear()}>Clear</button>
        <span class="status">${this.status}</span>
        ${this.channels.length ? html`<span class="status">${this.channels.map((c) => c.name).join(' · ')}</span>` : nothing}
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

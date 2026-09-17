import { LitElement, css, html, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import xtermCss from '@xterm/xterm/css/xterm.css?inline';
import {
  BAUD_RATES, LineDecoder, SerialConnection, describePort, grantedPorts, hasWebSerial, onPortsChanged, requestPort,
  type LineEnding, type SerialPortLike,
} from '@probe-web/serial';

/**
 * `<probe-serial-monitor>`: a WebSerial console (baud picker, send line with
 * a chosen line ending, RTS reset pulse, clear) in an xterm.js terminal.
 * For boards whose console is a UART bridge rather than RTT.
 *
 * Events: `serial-line` (detail: string, one per received line),
 * `serial-state` (detail: { connected, reason? }).
 */
@customElement('probe-serial-monitor')
export class ProbeSerialMonitor extends LitElement {
  static styles = [unsafeCSS(xtermCss), css`
    :host { display: block; font: 13px system-ui, sans-serif; }
    .row { display: flex; gap: 8px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
    button, select, input { font: inherit; padding: 6px 10px; }
    input.send { flex: 1; min-width: 12em; }
    .term { height: 260px; background: #000; padding: 4px; border-radius: 6px; }
    .status { color: #666; }
  `];

  /** The port to use; set it, or let the user pick one with *Choose port…*. */
  @property({ attribute: false }) port: SerialPortLike | null = null;
  @property({ type: Number }) baudRate = 115200;
  @property({ attribute: 'line-ending' }) lineEnding: LineEnding = 'crlf';
  @state() private connection: SerialConnection | null = null;
  @state() private status = '';
  private term: Terminal | null = null;
  private fit = new FitAddon();
  private lines = new LineDecoder();
  private decoder = new TextDecoder();
  private unsubscribe: (() => void) | null = null;

  connectedCallback() {
    super.connectedCallback();
    if (!hasWebSerial()) {
      this.status = 'WebSerial is not available in this browser (use Chrome or Edge)';
      return;
    }
    void this.adoptGranted();
    this.unsubscribe = onPortsChanged(() => void this.adoptGranted());
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    void this.connection?.close();
    super.disconnectedCallback();
  }

  /** Preselect the first previously granted port (a board may expose several, e.g. two CDC UARTs). */
  private async adoptGranted() {
    if (this.port || this.connection) return;
    const ports = await grantedPorts();
    if (ports.length > 0) {
      this.port = ports[0]!;
      this.status = `granted: ${describePort(this.port)}${ports.length > 1 ? ` (first of ${ports.length}; Choose port… to switch)` : ''}`;
    }
  }

  firstUpdated() {
    this.term = new Terminal({ convertEol: true, fontSize: 12, scrollback: 5000, theme: { background: '#000000' } });
    this.term.loadAddon(this.fit);
    const el = this.renderRoot.querySelector('.term')!;
    this.term.open(el as HTMLElement);
    this.fit.fit();
    new ResizeObserver(() => this.fit.fit()).observe(el);
  }

  async choosePort() {
    try {
      this.port = await requestPort({ any: (this.renderRoot.querySelector('#any') as HTMLInputElement)?.checked });
      this.status = `selected: ${describePort(this.port)}`;
    } catch (e) {
      if ((e as Error).name !== 'NotFoundError') this.status = `failed: ${(e as Error).message}`;
    }
  }

  async connect() {
    if (!this.port || this.connection) return;
    this.lines = new LineDecoder();
    this.decoder = new TextDecoder();
    try {
      const conn = await SerialConnection.open(this.port, { baudRate: this.baudRate }, (bytes) => this.onData(bytes));
      this.connection = conn;
      this.status = `connected: ${describePort(this.port)} @ ${this.baudRate}`;
      this.emitState(true);
      void conn.closed.then((reason) => {
        if (this.connection !== conn) return;
        this.connection = null;
        this.status = `disconnected: ${reason}`;
        this.term?.writeln(`\x1b[90m[${reason}]\x1b[0m`);
        this.emitState(false, reason);
      });
    } catch (e) {
      this.status = `open failed: ${(e as Error).message}`;
    }
  }

  async disconnect() {
    await this.connection?.close();
  }

  private onData(bytes: Uint8Array) {
    this.term?.write(this.decoder.decode(bytes, { stream: true }));
    for (const line of this.lines.push(bytes)) {
      this.dispatchEvent(new CustomEvent('serial-line', { detail: line, bubbles: true, composed: true }));
    }
  }

  /** Send a line with the selected line ending. */
  async send(text: string) {
    if (!this.connection) return;
    await this.connection.write(text, this.lineEnding);
  }

  private async onSend(e: Event) {
    e.preventDefault();
    const input = this.renderRoot.querySelector('input.send') as HTMLInputElement;
    const text = input.value;
    input.value = '';
    try {
      await this.send(text);
    } catch (err) {
      this.status = `write failed: ${(err as Error).message}`;
    }
  }

  private async reset() {
    try {
      await this.connection?.resetViaRts();
    } catch (e) {
      this.status = `reset failed: ${(e as Error).message}`;
    }
  }

  private emitState(connected: boolean, reason?: string) {
    this.dispatchEvent(new CustomEvent('serial-state', { detail: { connected, reason }, bubbles: true, composed: true }));
  }

  render() {
    const supported = hasWebSerial();
    const connected = !!this.connection;
    return html`
      <div class="row">
        ${supported ? html`
          <button @click=${this.choosePort} ?disabled=${connected}>Choose port…</button>
          <label><input id="any" type="checkbox"> any device</label>
          <select aria-label="baud rate" .value=${String(this.baudRate)} ?disabled=${connected}
            @change=${(e: Event) => (this.baudRate = Number((e.target as HTMLSelectElement).value))}>
            ${BAUD_RATES.map((b) => html`<option value=${b} ?selected=${b === this.baudRate}>${b}</option>`)}
          </select>
          ${connected
            ? html`<button @click=${this.disconnect}>Disconnect</button>
                   <button @click=${this.reset} title="Pulse RTS (EN on ESP devkits)">Reset</button>`
            : html`<button @click=${this.connect} ?disabled=${!this.port}>Connect</button>`}
        ` : nothing}
        <button @click=${() => this.term?.clear()}>Clear</button>
        <span class="status">${this.status}</span>
      </div>
      <div class="term"></div>
      ${supported ? html`
        <form class="row" @submit=${this.onSend}>
          <input class="send" placeholder="send a line" ?disabled=${!connected}>
          <select aria-label="line ending" .value=${this.lineEnding}
            @change=${(e: Event) => (this.lineEnding = (e.target as HTMLSelectElement).value as LineEnding)}>
            <option value="none">no ending</option><option value="lf">LF</option><option value="cr">CR</option><option value="crlf">CR LF</option>
          </select>
          <button type="submit" ?disabled=${!connected}>Send</button>
        </form>` : nothing}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-serial-monitor': ProbeSerialMonitor; } }

import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Client, Wire } from '@probe-web/client';
import { describe, grantedDevices, hasWebUsb, onDevicesChanged, requestProbe } from '@probe-web/devices';

/**
 * `<probe-device-picker>`: lists probes the connected client can see and
 * lets the user grant a new WebUSB device. Fires `probe-selected` with the
 * chosen `DebugProbeEntry` in `detail`.
 */
@customElement('probe-device-picker')
export class ProbeDevicePicker extends LitElement {
  static styles = css`
    :host { display: block; font: 13px system-ui, sans-serif; }
    ul { list-style: none; padding: 0; margin: 8px 0; }
    li { display: flex; gap: 8px; align-items: center; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; margin-bottom: 6px; cursor: pointer; }
    li.selected { border-color: #2563eb; background: #eff6ff; }
    .id { color: #666; font-family: ui-monospace, monospace; font-size: 12px; }
    button { font: inherit; padding: 6px 10px; }
    .empty { color: #666; }
    .warn { color: #b45309; }
  `;

  @property({ attribute: false }) client: Client | null = null;
  @state() private probes: Wire.DebugProbeEntry[] = [];
  @state() private granted = 0;
  @state() private selected: string | null = null;
  @state() private error: string | null = null;
  private unsub: (() => void) | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.unsub = onDevicesChanged(() => this.refresh());
    void this.refresh();
  }
  disconnectedCallback() {
    this.unsub?.();
    super.disconnectedCallback();
  }
  updated(changed: Map<string, unknown>) {
    if (changed.has('client')) void this.refresh();
  }

  async refresh() {
    this.error = null;
    try {
      this.granted = (await grantedDevices()).length;
      this.probes = this.client ? await this.client.listProbes() : [];
      if (this.probes.length === 1 && !this.selected) this.select(this.probes[0]);
    } catch (e) {
      this.error = String((e as Error).message ?? e);
    }
  }

  async authorize() {
    try {
      const d = await requestProbe();
      this.error = null;
      const desc = describe(d);
      this.dispatchEvent(new CustomEvent('device-authorized', { detail: desc }));
      await this.refresh();
    } catch (e) {
      this.error = String((e as Error).message ?? e);
    }
  }

  select(p: Wire.DebugProbeEntry) {
    this.selected = key(p);
    this.dispatchEvent(new CustomEvent('probe-selected', { detail: p, bubbles: true, composed: true }));
  }

  render() {
    const local = this.client?.transport === 'webusb';
    return html`
      <div>
        ${local && hasWebUsb() ? html`<button @click=${this.authorize}>Authorize device…</button>` : nothing}
        <button @click=${this.refresh}>Refresh</button>
        ${local && !hasWebUsb() ? html`<span class="warn">WebUSB is not available in this browser; use the WebSocket transport.</span>` : nothing}
      </div>
      ${this.probes.length === 0
        ? html`<p class="empty">${this.client ? (local ? `No probes (${this.granted} granted device${this.granted === 1 ? '' : 's'}). Authorize one, or check the probe's firmware supports CMSIS-DAP v2.` : 'No probes on the server.') : 'Not connected.'}</p>`
        : html`<ul>${this.probes.map((p) => html`
            <li class=${key(p) === this.selected ? 'selected' : ''} @click=${() => this.select(p)}>
              <span>${p.identifier}</span>
              <span class="id">${hex(p.vendor_id)}:${hex(p.product_id)}${p.serial_number ? ':' + p.serial_number : ''}</span>
              ${p.inaccessible ? html`<span class="warn">no access</span>` : nothing}
            </li>`)}</ul>`}
      ${this.error ? html`<p class="warn">${this.error}</p>` : nothing}
    `;
  }
}

function hex(n: number) { return n.toString(16).padStart(4, '0'); }
function key(p: Wire.DebugProbeEntry) { return `${p.vendor_id}:${p.product_id}:${p.serial_number}`; }

declare global { interface HTMLElementTagNameMap { 'probe-device-picker': ProbeDevicePicker; } }

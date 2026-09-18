import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Client, Wire } from '@probe-web/client';
import { describe, grantedDevices, hasWebUsb, onDevicesChanged, requestProbe } from '@probe-web/devices';
import { baseStyles } from './base-style.ts';
import { icon } from './icons.ts';

/**
 * `<probe-device-picker>`: lists the probes the connected `Client` can see
 * and, on the WebUSB transport, lets the user grant access to a new device.
 * When exactly one probe is visible it is selected automatically.
 *
 * @fires probe-selected - A probe was chosen (by a click, or automatically when it is
 *   the only one). `detail` is the `Wire.DebugProbeEntry`; pass it to `client.attach()`.
 * @fires device-authorized - The user granted a new WebUSB device through the browser's
 *   chooser. `detail` is its `ProbeDescription` from `@probe-web/devices`.
 *
 * @example
 * ```html
 * <probe-device-picker id="picker"></probe-device-picker>
 * ```
 * ```ts
 * const client = await Client.connect({ kind: 'webusb', worker });
 * const picker = document.querySelector('probe-device-picker')!;
 * picker.client = client;
 * picker.addEventListener('probe-selected', async (e) => {
 *   const probe = (e as CustomEvent<Wire.DebugProbeEntry>).detail;
 *   const session = await client.attach({ probe, chip: 'nRF52840_xxAA' });
 * });
 * ```
 */
@customElement('probe-device-picker')
export class ProbeDevicePicker extends LitElement {
  /** @internal */
  static styles = [baseStyles, css`
    .actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    ul { list-style: none; padding: 0; margin: 8px 0 0; display: grid; gap: 4px; }
    li {
      display: grid; grid-template-columns: auto 1fr auto; gap: 0 10px; align-items: center;
      padding: 6px 10px; border: 1px solid var(--_divider); border-radius: var(--_radius-lg);
      background: var(--_bg); cursor: pointer; transition: border-color 0.15s, background-color 0.15s;
    }
    li:hover { border-color: var(--_border); }
    li.selected { border-color: var(--_brand-2); background: var(--_brand-soft); }
    li > svg { grid-row: span 2; color: var(--_text-2); }
    li.selected > svg { color: var(--_brand-1); }
    .name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .id { grid-column: 2; color: var(--_text-2); font-family: var(--_mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
    .check { grid-row: span 2; color: var(--_brand-1); visibility: hidden; }
    li.selected .check { visibility: visible; }
    li .warn { grid-column: 2; font-size: 12px; }
    .empty { color: var(--_text-2); margin: 8px 0 0; padding: 10px 12px; border: 1px dashed var(--_divider); border-radius: var(--_radius-lg); }
    p.warn { margin: 8px 0 0; }
  `];


  /** The connection whose probes are listed; `null` shows "Not connected." */
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

  /** Re-read the granted WebUSB devices and the client's probe list. */
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

  /**
   * Open the browser's WebUSB chooser to grant a new probe, then refresh the list.
   * Must run from a user gesture (the *Authorize device…* button does this).
   */
  async authorize() {
    try {
      const d = await requestProbe();
      this.error = null;
      const desc = describe(d);
      this.dispatchEvent(new CustomEvent('device-authorized', { detail: desc, bubbles: true, composed: true }));
      await this.refresh();
    } catch (e) {
      this.error = String((e as Error).message ?? e);
    }
  }

  /** Mark `p` as selected and fire `probe-selected`. */
  select(p: Wire.DebugProbeEntry) {
    this.selected = key(p);
    this.dispatchEvent(new CustomEvent('probe-selected', { detail: p, bubbles: true, composed: true }));
  }

  render() {
    const local = this.client?.transport === 'webusb';
    return html`
      <div class="actions">
        ${local && hasWebUsb() ? html`<button class="primary" @click=${this.authorize}>${icon('plus', 14)}Authorize device…</button>` : nothing}
        <button @click=${this.refresh}>${icon('refresh', 14)}Refresh</button>
        ${local && !hasWebUsb() ? html`<span class="warn">WebUSB is not available in this browser; use the WebSocket transport.</span>` : nothing}
      </div>
      ${this.probes.length === 0
        ? html`<p class="empty">${this.client ? (local ? `No probes (${this.granted} granted device${this.granted === 1 ? '' : 's'}). Authorize one, or check the probe's firmware supports CMSIS-DAP v2.` : 'No probes on the server.') : 'Not connected.'}</p>`
        : html`<ul>${this.probes.map((p) => html`
            <li class=${key(p) === this.selected ? 'selected' : ''} tabindex="0" @click=${() => this.select(p)}
                @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(p); } }}>
              ${icon('plug', 18)}
              <span class="name">${p.identifier}</span>
              <span class="check">${icon('check', 16)}</span>
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

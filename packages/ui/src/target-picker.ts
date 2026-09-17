import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Client, Wire } from '@probe-web/client';

/**
 * `<probe-target-picker>`: search the connected server's chip registry,
 * show a chip's cores and memory map, and import extra chip families from
 * probe-rs target YAML (`chips/load`). Fires `chip-selected` with the chip
 * name in `detail`.
 */
@customElement('probe-target-picker')
export class ProbeTargetPicker extends LitElement {
  static styles = css`
    :host { display: block; font: 13px system-ui, sans-serif; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
    input[type=text] { font: inherit; padding: 5px 8px; width: 16em; }
    button { font: inherit; padding: 5px 9px; }
    ul { list-style: none; margin: 4px 0; padding: 0; max-height: 180px; overflow: auto; border: 1px solid #ddd; border-radius: 6px; }
    li { padding: 4px 8px; cursor: pointer; display: flex; justify-content: space-between; }
    li:hover { background: #f3f4f6; } li.selected { background: #eff6ff; }
    .fam { color: #666; font-size: 12px; }
    table { border-collapse: collapse; font-size: 12px; margin-top: 6px; }
    td, th { padding: 2px 8px; text-align: left; border-bottom: 1px solid #eee; }
    .mono { font-family: ui-monospace, monospace; }
    .muted { color: #666; } .err { color: #b91c1c; } .ok { color: #15803d; }
  `;

  @property({ attribute: false }) client: Client | null = null;
  @property() value = '';
  @state() private families: Wire.ChipFamily[] = [];
  @state() private query = '';
  @state() private info: Wire.ChipData | null = null;
  @state() private status: string | null = null;
  @state() private error: string | null = null;

  updated(changed: Map<string, unknown>) {
    if (changed.has('client')) void this.refresh();
  }

  async refresh() {
    this.error = null;
    try {
      this.families = this.client ? await this.client.listChipFamilies() : [];
    } catch (e) {
      this.error = String((e as Error).message ?? e);
    }
  }

  /** Chips matching the query: `Family/Chip` rows, capped for the DOM. */
  get results(): { family: string; chip: string }[] {
    const q = this.query.trim().toLowerCase();
    const out: { family: string; chip: string }[] = [];
    for (const f of this.families) {
      for (const v of f.variants) {
        if (!q || v.name.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)) out.push({ family: f.name, chip: v.name });
        if (out.length >= 200) return out;
      }
    }
    return out;
  }

  async select(chip: string) {
    this.value = chip;
    this.dispatchEvent(new CustomEvent('chip-selected', { detail: chip, bubbles: true, composed: true }));
    this.info = null;
    if (!this.client) return;
    try {
      this.info = await this.client.chipInfo(chip);
    } catch (e) {
      this.error = String((e as Error).message ?? e);
    }
  }

  private async importYaml(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !this.client) return;
    this.status = `importing ${file.name}…`;
    this.error = null;
    try {
      const before = this.families.length;
      await this.client.loadChipFamily(await file.text());
      await this.refresh();
      this.status = `imported ${file.name}: ${this.families.length - before} new famil${this.families.length - before === 1 ? 'y' : 'ies'} (${this.families.length} total)`;
      this.dispatchEvent(new CustomEvent('family-imported', { detail: file.name, bubbles: true, composed: true }));
    } catch (err) {
      this.status = null;
      this.error = `import failed: ${(err as Error).message ?? err}`;
    } finally {
      input.value = '';
    }
  }

  render() {
    const m = this.results;
    return html`
      <div class="row">
        <input type="text" placeholder="search chips (e.g. nRF52, MCXA153)" .value=${this.query} @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)}>
        <span class="muted">${this.families.length} families</span>
        <label>import target YAML <input type="file" accept=".yaml,.yml" @change=${this.importYaml} ?disabled=${!this.client}></label>
      </div>
      ${this.status ? html`<div class="ok">${this.status}</div>` : nothing}
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${this.query ? html`<ul>${m.map((r) => html`<li class=${r.chip === this.value ? 'selected' : ''} @click=${() => this.select(r.chip)}><span>${r.chip}</span><span class="fam">${r.family}</span></li>`)}${m.length === 0 ? html`<li class="muted">no match</li>` : nothing}</ul>` : nothing}
      ${this.info ? html`
        <div class="muted">${this.value}: ${this.info.cores.map((c) => `${c.name} (${c.core_type})`).join(', ')}</div>
        <table><tr><th>region</th><th>kind</th><th>range</th></tr>
          ${this.info.memory_map.map((r) => { const [kind, x] = Object.entries(r)[0] as [string, Wire.RamRegion]; return html`<tr><td>${x.name ?? ''}</td><td>${kind}</td><td class="mono">0x${x.range[0].toString(16)}…0x${x.range[1].toString(16)}</td></tr>`; })}
        </table>` : nothing}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-target-picker': ProbeTargetPicker; } }

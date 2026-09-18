import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Client, Wire } from '@probe-web/client';
import { baseStyles } from './base-style.ts';
import { icon } from './icons.ts';

/** A chip family read out of a pack, waiting for the user to choose whether to load it. */
interface PendingFamily {
  name: string;
  variants: number;
  yaml: string;
}

/**
 * `<probe-target-picker>`: search the connected server's chip registry,
 * show a chip's cores and memory map, and import extra chip families from
 * probe-rs target YAML, a CMSIS `.pack`, or a `.FLM` flash algorithm
 * (all of which end up at `chips/load`).
 *
 * A pack routinely describes dozens of families, so those are listed for the user to
 * choose from rather than being pushed into the registry wholesale. Any SVDs the pack
 * carries are announced with a `svds-found` event, so a page that has a Peripherals view
 * can offer them without a second download.
 *
 * @fires chip-selected - The user picked a chip from the search results. `detail` is the
 *   chip name (a string), as `client.attach({ chip })` takes it.
 * @fires family-imported - Chip families were loaded into the registry. `detail` is a
 *   label for what was imported: the file name, or `Family (file.pack)` for one family
 *   from a pack.
 * @fires svds-found - A picked `.pack` contains SVD files. `detail` is an array of
 *   `{ name, xml }` from `packSvds()`.
 */
@customElement('probe-target-picker')
export class ProbeTargetPicker extends LitElement {
  /** @internal */
  static styles = [baseStyles, css`
    .row { gap: 8px; margin: 0 0 6px; }
    .search { position: relative; display: flex; flex: 1 1 14em; }
    .search svg { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); color: var(--_text-3); pointer-events: none; }
    .search input { width: 100%; padding-left: 28px; }
    .meta { font-size: 12px; color: var(--_text-2); gap: 4px 10px; }
    .import { position: relative; cursor: pointer; color: var(--_brand-1); font-weight: 500; }
    .import:hover { text-decoration: underline; text-underline-offset: 2px; }
    .import input { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
    .import:has(input:disabled) { color: var(--_text-3); cursor: default; text-decoration: none; }
    ul {
      list-style: none; margin: 6px 0; padding: 2px; max-height: 200px; overflow: auto;
      border: 1px solid var(--_divider); border-radius: var(--_radius-lg); background: var(--_bg);
    }
    li { display: flex; justify-content: space-between; gap: 8px; padding: 3px 8px; border-radius: 4px; cursor: pointer; }
    li:hover { background: var(--_default-soft); }
    li.selected { background: var(--_brand-soft); color: var(--_brand-1); font-weight: 500; }
    li.muted { cursor: default; background: none; }
    .fam { color: var(--_text-2); font-size: 12px; font-weight: 400; }
    .info { margin-top: 8px; font-size: 12px; }
    table { border-collapse: collapse; font-size: 12px; margin-top: 4px; width: 100%; }
    td, th { padding: 2px 8px 2px 0; text-align: left; border-bottom: 1px solid var(--_divider); }
    th { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--_text-2); }
    .ok, .err { font-size: 12px; margin: 4px 0; }
  `];


  /** The connection whose chip registry is searched and extended. */
  @property({ attribute: false }) client: Client | null = null;
  /** The selected chip name; set by {@link ProbeTargetPicker.select}, and settable to preselect one. */
  @property() value = '';
  @state() private families: Wire.ChipFamily[] = [];
  @state() private query = '';
  @state() private info: Wire.ChipData | null = null;
  @state() private status: string | null = null;
  @state() private error: string | null = null;
  /** Families read out of a pack, awaiting the user's choice. */
  @state() private pending: PendingFamily[] = [];
  @state() private pendingFrom = '';
  @state() private svdCount = 0;

  updated(changed: Map<string, unknown>) {
    if (changed.has('client')) void this.refresh();
  }

  /** Re-read the list of chip families from the server. */
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

  /** Select `chip`, fire `chip-selected`, and load its cores and memory map for display. */
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

  /** Load one family's YAML and report how much the registry grew. */
  private async loadFamily(yaml: string, label: string) {
    if (!this.client) return;
    const before = this.families.length;
    await this.client.loadChipFamily(yaml);
    await this.refresh();
    const added = this.families.length - before;
    this.status = `imported ${label}: ${added} new famil${added === 1 ? 'y' : 'ies'} (${this.families.length} total)`;
    this.dispatchEvent(new CustomEvent('family-imported', { detail: label, bubbles: true, composed: true }));
  }

  private async importFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !this.client) return;
    const extension = file.name.toLowerCase().split('.').pop() ?? '';
    this.status = `reading ${file.name}…`;
    this.error = null;
    this.pending = [];
    try {
      if (extension === 'pack') {
        // The pack reader is a separate ~860 KB wasm bundle; importing it here rather
        // than at the top of the module is what keeps it off pages that never import a
        // pack. It is fetched once, the first time someone picks one.
        const { packToYaml, packSvds } = await import('@probe-web/client/targets');
        const bytes = new Uint8Array(await file.arrayBuffer());
        this.pending = await packToYaml(bytes);
        this.pendingFrom = file.name;
        this.status = `${file.name}: ${this.pending.length} famil${this.pending.length === 1 ? 'y' : 'ies'} — choose what to load`;

        const svds = await packSvds(bytes);
        if (svds.length) {
          this.svdCount = svds.length;
          this.dispatchEvent(new CustomEvent('svds-found', { detail: svds, bubbles: true, composed: true }));
        }
      } else if (extension === 'flm') {
        const { flmToYaml } = await import('@probe-web/client/targets');
        const yaml = await flmToYaml(new Uint8Array(await file.arrayBuffer()), file.name);
        await this.loadFamily(yaml, file.name);
        // The family it produces is a placeholder: the algorithm is real, the chip name
        // and memory map are not, so say so rather than letting it look ready to flash.
        this.status += ' — placeholder chip and memory map; edit before flashing';
      } else {
        await this.loadFamily(await file.text(), file.name);
      }
    } catch (err) {
      this.status = null;
      // Errors from the importer carry a `kind`, and their message is already written
      // for a person to read, so it is shown as-is.
      this.error = `import failed: ${(err as Error).message ?? err}`;
    } finally {
      input.value = '';
    }
  }

  /** Load one of the families found in a pack. */
  private async loadPending(family: PendingFamily) {
    this.error = null;
    try {
      await this.loadFamily(family.yaml, `${family.name} (${this.pendingFrom})`);
      this.pending = this.pending.filter((f) => f !== family);
    } catch (err) {
      this.error = `import failed: ${(err as Error).message ?? err}`;
    }
  }

  private async loadAllPending() {
    this.error = null;
    const all = this.pending;
    try {
      for (const family of all) await this.client?.loadChipFamily(family.yaml);
      await this.refresh();
      this.status = `imported ${all.length} famil${all.length === 1 ? 'y' : 'ies'} from ${this.pendingFrom} (${this.families.length} total)`;
      this.dispatchEvent(new CustomEvent('family-imported', { detail: this.pendingFrom, bubbles: true, composed: true }));
      this.pending = [];
    } catch (err) {
      this.error = `import failed: ${(err as Error).message ?? err}`;
    }
  }

  render() {
    const m = this.results;
    return html`
      <div class="row">
        <span class="search">${icon('search', 14)}<input type="text" placeholder="search chips (e.g. nRF52, MCXA153)" .value=${this.query} @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)}></span>
      </div>
      <div class="row meta">
        <span>${this.families.length} families</span>
        <span aria-hidden="true">·</span>
        <label class="import" title="Add chips from a target YAML, a CMSIS .pack or an .FLM">import <input type="file" accept=".yaml,.yml,.pack,.flm,.FLM" @change=${this.importFile} ?disabled=${!this.client}></label>
        <span>target YAML, CMSIS .pack or .FLM</span>
      </div>
      ${this.status ? html`<div class="ok">${this.status}</div>` : nothing}
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${this.svdCount ? html`<div class="muted">${this.svdCount} SVD${this.svdCount === 1 ? '' : 's'} found in the pack</div>` : nothing}
      ${this.pending.length ? html`
        <div class="row">
          <button @click=${this.loadAllPending}>load all ${this.pending.length}</button>
          <button @click=${() => { this.pending = []; this.status = null; }}>cancel</button>
        </div>
        <ul id="pending">${this.pending.map((f) => html`
          <li data-family=${f.name} @click=${() => this.loadPending(f)}>
            <span>${f.name}</span><span class="fam">${f.variants} chip${f.variants === 1 ? '' : 's'}</span>
          </li>`)}
        </ul>` : nothing}
      ${this.query ? html`<ul>${m.map((r) => html`<li class=${r.chip === this.value ? 'selected' : ''} @click=${() => this.select(r.chip)}><span>${r.chip}</span><span class="fam">${r.family}</span></li>`)}${m.length === 0 ? html`<li class="muted">no match</li>` : nothing}</ul>` : nothing}
      ${this.info ? html`
        <div class="muted info">${this.value}: ${this.info.cores.map((c) => `${c.name} (${c.core_type})`).join(', ')}</div>
        <table><tr><th>region</th><th>kind</th><th>range</th></tr>
          ${this.info.memory_map.map((r) => { const [kind, x] = Object.entries(r)[0] as [string, Wire.RamRegion]; return html`<tr><td>${x.name ?? ''}</td><td>${kind}</td><td class="mono">0x${x.range[0].toString(16)}…0x${x.range[1].toString(16)}</td></tr>`; })}
        </table>` : nothing}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-target-picker': ProbeTargetPicker; } }

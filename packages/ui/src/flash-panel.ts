import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { FlashJob, FormatName, Session, Wire } from '@probe-web/client';
import { FileArtifact, forgetHandle, hasFileSystemAccess, pickFile, recallHandle, rememberHandle } from '@probe-web/artifacts';

interface Bar { operation: string; total: number | null; done: number; state: 'pending' | 'running' | 'done' | 'failed'; startedAt: number }

/**
 * `<probe-flash-panel>`: picks an image (a file, a watched file, or a preset
 * `FlashJob`), shows the per-operation progress probe-rs reports
 * (fill/erase/program/verify), and offers verify-only and erase-all.
 *
 * With the File System Access API, *Pick file & watch…* keeps a handle to the
 * file (remembered across reloads under {@link ProbeFlashPanel.rememberAs}) and
 * re-flashes whenever it changes on disk.
 *
 * @fires flash-done - Flashing succeeded. `detail` is `{ bootInfo, ms }`: the
 *   `Wire.BootInfo` to hand to `<probe-rtt-terminal>` / `<probe-test-runner>`, and the
 *   duration in milliseconds.
 * @fires flash-failed - Flashing threw. `detail` is the error.
 * @fires verify-done - A verify-only run finished. `detail` is the `Wire.VerifyResult`
 *   (`'Ok'` or `'Mismatch'`).
 * @fires erase-done - An erase-all finished. No `detail`.
 * @fires artifact-changed - The watched file changed on disk. `detail` is the
 *   `ArtifactChange` from `@probe-web/artifacts` (`name`, `bytes`, `lastModified`).
 *   Fired before the automatic re-flash starts.
 *
 * @example
 * ```html
 * <probe-flash-panel id="flash" chip-erase></probe-flash-panel>
 * ```
 * ```ts
 * const flash = document.querySelector('probe-flash-panel')!;
 * flash.session = session;
 * flash.addEventListener('flash-done', (e) => {
 *   const { bootInfo, ms } = (e as CustomEvent<{ bootInfo: Wire.BootInfo; ms: number }>).detail;
 *   rtt.bootInfo = bootInfo;
 * });
 * ```
 */
@customElement('probe-flash-panel')
export class ProbeFlashPanel extends LitElement {
  /** @internal */
  static styles = css`
    :host { display: block; font: 13px system-ui, sans-serif; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
    label { display: inline-flex; gap: 4px; align-items: center; }
    input[type=text] { font: inherit; width: 9em; }
    select, button, input { font: inherit; }
    button.primary { background: #2563eb; color: white; border: 0; padding: 7px 14px; border-radius: 6px; }
    button[disabled] { opacity: .5; }
    .bar { display: grid; grid-template-columns: 6em 1fr 8em; gap: 8px; align-items: center; margin: 4px 0; }
    progress { width: 100%; }
    .done { color: #15803d; } .failed { color: #b91c1c; } .diag { color: #666; font-family: ui-monospace, monospace; white-space: pre-wrap; }
    .layout { font-size: 12px; color: #444; }
  `;

  /** The attached session to flash through; the buttons are disabled without one. */
  @property({ attribute: false }) session: Session | null = null;
  /**
   * Optional preset job (e.g. from a manifest). A chosen or watched file overrides its
   * image; its format, base address, skip and options are kept.
   */
  @property({ attribute: false }) job: FlashJob | null = null;
  /** Verify the flash contents after programming. */
  @property({ type: Boolean }) verify = true;
  /** Erase the whole chip rather than only the sectors being written. */
  @property({ type: Boolean, attribute: 'chip-erase' }) chipErase = false;
  /** Preserve the bytes of partially written sectors instead of leaving them erased. */
  @property({ type: Boolean, attribute: 'keep-unwritten' }) keepUnwritten = false;

  @state() private file: File | null = null;
  /** A watched file picked with the File System Access API. */
  @state() private artifact: FileArtifact | null = null;
  @state() private autoReflash = true;
  @state() private watching = false;
  private stopWatch: (() => void) | null = null;
  /**
   * Key under which the picked file handle is remembered (in IndexedDB) across reloads.
   * Give each panel on a page its own key.
   */
  @property({ attribute: 'remember-as' }) rememberAs = 'flash-panel';
  @state() private format: FormatName = 'target';
  @state() private baseAddress = '';
  @state() private bars: Bar[] = [];
  @state() private busy = false;
  @state() private diagnostics: string[] = [];
  @state() private result: string | null = null;
  @state() private layout: string | null = null;

  updated(changed: Map<string, unknown>) {
    if (changed.has('job') && this.job) {
      this.format = this.job.format ?? 'target';
      if (this.job.baseAddress !== undefined) this.baseAddress = '0x' + BigInt(this.job.baseAddress).toString(16);
    }
  }

  private onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    this.file = input.files?.[0] ?? null;
    if (this.file && this.format === 'target') {
      const ext = this.file.name.split('.').pop()?.toLowerCase();
      if (ext === 'bin') this.format = 'bin';
      else if (ext === 'hex' || ext === 'ihex') this.format = 'hex';
      else if (ext === 'uf2') this.format = 'uf2';
      else if (ext === 'elf' || ext === 'axf' || !ext) this.format = 'elf';
    }
  }

  connectedCallback() {
    super.connectedCallback();
    void this.restoreArtifact();
  }
  disconnectedCallback() {
    this.stopWatch?.();
    super.disconnectedCallback();
  }

  /** A handle remembered from a previous visit whose permission has lapsed; resumed by a click. */
  @state() private remembered: FileArtifact | null = null;

  private async restoreArtifact() {
    const a = await recallHandle(this.rememberAs);
    if (!a) return;
    // Only take over silently when the browser still grants read access; otherwise
    // an explicitly provided `job` (e.g. a manifest image) must keep working and
    // re-granting needs a user gesture anyway.
    if (await a.hasPermission()) this.useArtifact(a);
    else this.remembered = a;
  }

  /**
   * Resume watching the file remembered from a previous visit, asking the browser for read
   * permission again. Needs a user gesture (the *Resume watching* button).
   */
  async resumeWatch() {
    const a = this.remembered;
    if (!a) return;
    try {
      if (!(await a.ensurePermission())) throw new Error('read permission for the remembered file was not granted');
      this.remembered = null;
      this.useArtifact(a);
    } catch (e) {
      this.result = `Failed: ${(e as Error).message ?? e}`;
    }
  }

  /** Drop the remembered file handle so it is not offered again. */
  async forgetRemembered() {
    this.remembered = null;
    await forgetHandle(this.rememberAs);
  }

  /**
   * Pick a file with the File System Access API, remember it, and watch it: each change
   * fires `artifact-changed` and, while *re-flash on change* is ticked, flashes it.
   */
  async pickAndWatch() {
    try {
      const a = await pickFile();
      await rememberHandle(this.rememberAs, a.handle);
      this.useArtifact(a);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.result = `Failed: ${(e as Error).message ?? e}`;
    }
  }

  private useArtifact(a: FileArtifact) {
    this.stopWatch?.();
    this.artifact = a;
    this.file = null;
    if (this.format === 'target') {
      const ext = a.name.split('.').pop()?.toLowerCase();
      if (ext === 'bin') this.format = 'bin';
      else if (ext === 'hex' || ext === 'ihex') this.format = 'hex';
      else if (ext === 'uf2') this.format = 'uf2';
      else this.format = 'elf';
    }
    this.stopWatch = a.watch((change) => {
      this.dispatchEvent(new CustomEvent('artifact-changed', { detail: change, bubbles: true, composed: true }));
      if (this.autoReflash && this.session && !this.busy) void this.flash();
    });
    this.watching = true;
  }

  /** Stop watching and forget the picked file. */
  clearArtifact() {
    this.stopWatch?.();
    this.stopWatch = null;
    this.artifact = null;
    this.watching = false;
  }

  /**
   * The job the *Flash* button would run: the chosen file, else the watched file, else
   * {@link ProbeFlashPanel.job}'s image, combined with the panel's format, address and option settings.
   * `null` when there is no image.
   */
  get effectiveJob(): FlashJob | null {
    const image = this.file ?? (this.artifact ? this.artifactBytes : undefined) ?? this.job?.image;
    if (!image) return null;
    const addr = this.baseAddress.trim();
    return {
      image,
      name: this.file?.name ?? this.artifact?.name ?? this.job?.name,
      format: this.format,
      baseAddress: addr ? BigInt(addr) : this.job?.baseAddress,
      skip: this.job?.skip,
      options: { ...this.job?.options, verify: this.verify, doChipErase: this.chipErase, keepUnwrittenBytes: this.keepUnwritten },
    };
  }

  /** Lazily read the watched file so `effectiveJob` stays synchronous. */
  private get artifactBytes(): Promise<Uint8Array> | undefined {
    const a = this.artifact;
    if (!a) return undefined;
    return (async () => {
      if (!(await a.ensurePermission())) throw new Error('read permission for the watched file was not granted');
      return a.bytes();
    })();
  }

  private onProgress = (e: Wire.ProgressEvent) => {
    if (typeof e === 'string') return;
    if ('FlashLayoutReady' in e) {
      const l = e.FlashLayoutReady.flash_layout;
      const sectors = l.reduce((n, x) => n + x.sectors.length, 0);
      const pages = l.reduce((n, x) => n + x.pages.length, 0);
      const bytes = l.reduce((n, x) => n + x.data_blocks.reduce((m, d) => m + Number(d.size), 0), 0);
      this.layout = `${bytes} bytes in ${pages} page${pages === 1 ? '' : 's'}, ${sectors} sector${sectors === 1 ? '' : 's'}`;
    } else if ('AddProgressBar' in e) {
      const { operation, total } = e.AddProgressBar;
      this.bars = [...this.bars.filter((b) => b.operation !== operation), { operation, total: total === null ? null : Number(total), done: 0, state: 'pending', startedAt: 0 }];
    } else if ('Started' in e) {
      this.patch(e.Started, { state: 'running', startedAt: performance.now() });
    } else if ('Progress' in e) {
      const b = this.bars.find((x) => x.operation === e.Progress.operation);
      this.patch(e.Progress.operation, { done: (b?.done ?? 0) + Number(e.Progress.size) });
    } else if ('Finished' in e) {
      this.patch(e.Finished, { state: 'done' });
    } else if ('Failed' in e) {
      this.patch(e.Failed, { state: 'failed' });
    } else if ('DiagnosticMessage' in e) {
      this.diagnostics = [...this.diagnostics, e.DiagnosticMessage.message];
    }
  };

  private patch(operation: string, p: Partial<Bar>) {
    this.bars = this.bars.map((b) => (b.operation === operation ? { ...b, ...p } : b));
  }

  /** Flash {@link ProbeFlashPanel.effectiveJob}; fires `flash-done` or `flash-failed`. No-op without a session or image. */
  async flash() {
    const job = this.effectiveJob;
    if (!this.session || !job) return;
    this.busy = true;
    this.bars = [];
    this.diagnostics = [];
    this.result = null;
    this.layout = null;
    const t0 = performance.now();
    try {
      const bootInfo = await this.session.flash(job, this.onProgress);
      const ms = Math.round(performance.now() - t0);
      this.result = `Flashed in ${(ms / 1000).toFixed(2)} s`;
      this.dispatchEvent(new CustomEvent('flash-done', { detail: { bootInfo, ms }, bubbles: true, composed: true }));
    } catch (e) {
      this.result = `Failed: ${(e as Error).message ?? e}`;
      this.dispatchEvent(new CustomEvent('flash-failed', { detail: e, bubbles: true, composed: true }));
    } finally {
      this.busy = false;
    }
  }

  private begin() {
    this.busy = true;
    this.bars = [];
    this.diagnostics = [];
    this.result = null;
    this.layout = null;
  }

  /** Compare the flash with {@link ProbeFlashPanel.effectiveJob}'s image without writing; fires `verify-done`. */
  async verifyOnly() {
    const job = this.effectiveJob;
    if (!this.session || !job) return;
    this.begin();
    try {
      const r = await this.session.verify(job, this.onProgress);
      this.result = r === 'Ok' ? 'Verify: flash matches the image' : 'Verify: mismatch';
      this.dispatchEvent(new CustomEvent('verify-done', { detail: r, bubbles: true, composed: true }));
    } catch (e) {
      this.result = `Failed: ${(e as Error).message ?? e}`;
    } finally {
      this.busy = false;
    }
  }

  /** Erase the whole flash; fires `erase-done`. */
  async eraseAll() {
    if (!this.session) return;
    this.begin();
    const t0 = performance.now();
    try {
      await this.session.eraseAll(this.onProgress);
      this.result = `Erased all flash in ${((performance.now() - t0) / 1000).toFixed(2)} s`;
      this.dispatchEvent(new CustomEvent('erase-done', { bubbles: true, composed: true }));
    } catch (e) {
      this.result = `Failed: ${(e as Error).message ?? e}`;
    } finally {
      this.busy = false;
    }
  }

  render() {
    const job = this.effectiveJob;
    return html`
      <div class="row">
        <input type="file" @change=${this.onFile} ?disabled=${this.busy}>
        ${hasFileSystemAccess() ? html`<button @click=${this.pickAndWatch} ?disabled=${this.busy}>Pick file & watch…</button>` : nothing}
        ${this.remembered && !this.artifact ? html`<span>last watched <b>${this.remembered.name}</b>
          <button @click=${this.resumeWatch} ?disabled=${this.busy}>Resume watching</button>
          <button @click=${this.forgetRemembered}>✕</button></span>` : nothing}
        ${this.artifact ? html`<span>watching <b>${this.artifact.name}</b>${this.watching ? '' : ' (click Flash to re-grant access)'}
          <label><input type="checkbox" .checked=${this.autoReflash} @change=${(e: Event) => (this.autoReflash = (e.target as HTMLInputElement).checked)}> re-flash on change</label>
          <button @click=${this.clearArtifact}>✕</button></span>` : nothing}
        ${this.job && !this.file && !this.artifact ? html`<span>preset: ${this.job.name ?? 'image'}</span>` : nothing}
        <label>format
          <select .value=${this.format} @change=${(e: Event) => (this.format = (e.target as HTMLSelectElement).value as FormatName)} ?disabled=${this.busy}>
            ${(['target', 'elf', 'bin', 'hex', 'uf2', 'idf'] as FormatName[]).map((f) => html`<option value=${f} ?selected=${f === this.format}>${f}</option>`)}
          </select></label>
        ${this.format === 'bin' ? html`<label>address <input type="text" placeholder="0x08000000" .value=${this.baseAddress} @input=${(e: Event) => (this.baseAddress = (e.target as HTMLInputElement).value)}></label>` : nothing}
      </div>
      <div class="row">
        <label><input type="checkbox" .checked=${this.verify} @change=${(e: Event) => (this.verify = (e.target as HTMLInputElement).checked)}> verify</label>
        <label><input type="checkbox" .checked=${this.chipErase} @change=${(e: Event) => (this.chipErase = (e.target as HTMLInputElement).checked)}> full chip erase</label>
        <label><input type="checkbox" .checked=${this.keepUnwritten} @change=${(e: Event) => (this.keepUnwritten = (e.target as HTMLInputElement).checked)}> keep unwritten bytes</label>
        <button class="primary" @click=${this.flash} ?disabled=${this.busy || !this.session || !job}>${this.busy ? 'Working…' : 'Flash'}</button>
        <button @click=${this.verifyOnly} ?disabled=${this.busy || !this.session || !job}>Verify only</button>
        <button @click=${this.eraseAll} ?disabled=${this.busy || !this.session}>Erase all</button>
      </div>
      ${this.layout ? html`<div class="layout">${this.layout}</div>` : nothing}
      ${this.bars.map((b) => html`
        <div class="bar">
          <span class=${b.state}>${b.operation}</span>
          <progress max=${b.total ?? 1} value=${b.state === 'done' ? (b.total ?? 1) : b.done}></progress>
          <span>${b.total !== null ? `${fmt(b.done)} / ${fmt(b.total)}` : b.state}</span>
        </div>`)}
      ${this.diagnostics.map((d) => html`<div class="diag">${d}</div>`)}
      ${this.result ? html`<p class=${this.result.startsWith('Failed') ? 'failed' : 'done'}>${this.result}</p>` : nothing}
    `;
  }
}

function fmt(n: number) { return n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`; }

declare global { interface HTMLElementTagNameMap { 'probe-flash-panel': ProbeFlashPanel; } }

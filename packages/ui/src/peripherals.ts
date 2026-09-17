import { css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { Variable } from '@probe-web/client';
import { DebuggerElement } from './debugger-element.ts';
import { debugStyles, errorText } from './debug-style.ts';

interface Node {
  path: string;
  name: string;
  value: string;
  type: string | null;
  reference: number;
  depth: number;
  children: Node[] | null;
}

/**
 * `<probe-peripherals>`: peripherals from a CMSIS-SVD file (loaded through the
 * debugger; the server parses it and reads registers live), as a tree of
 * peripherals → registers → fields, with a name filter. Refreshed at each stop.
 */
@customElement('probe-peripherals')
export class ProbePeripherals extends DebuggerElement {
  static styles = [debugStyles, css`
    .node { display: flex; gap: 6px; align-items: baseline; white-space: nowrap; padding: 1px 0; }
    .twisty { width: 1em; cursor: pointer; user-select: none; color: #555; }
    .name { color: #0f766e; }
    .type { color: #888; font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
  `];

  @state() private svdName = '';
  @state() private roots: Node[] = [];
  @state() private filter = '';
  @state() private error = '';
  private open = new Set<string>();
  private generation = 0;

  protected onAttached() { if (this.svdName && this.debugger?.state === 'halted') void this.refresh(); }
  protected onStopped() { if (this.svdName) void this.refresh(); }

  /** Load an SVD (bytes of the .svd/.xml file) and show its peripherals. */
  async loadSvd(bytes: Uint8Array, name: string) {
    const d = this.debugger;
    if (!d) return;
    this.error = '';
    try {
      await d.loadSvd(bytes, name);
      this.svdName = name;
      this.open.clear();
      if (d.state === 'halted') await this.refresh();
    } catch (e) {
      this.svdName = '';
      this.error = errorText(e);
    }
  }

  private toNode(v: Variable, parent: string, depth: number): Node {
    return { path: `${parent}/${v.name}`, name: v.name, value: v.value, type: v.type, reference: v.reference, depth, children: null };
  }

  private async load(n: Node, generation: number) {
    const vars = await this.debugger!.variables(n.reference);
    if (generation !== this.generation) return;
    n.children = vars.map((v) => this.toNode(v, n.path, n.depth + 1));
    for (const c of n.children) if (c.reference && this.open.has(c.path)) await this.load(c, generation);
  }

  async refresh() {
    const d = this.debugger;
    if (!d || d.state !== 'halted') return;
    const generation = ++this.generation;
    try {
      const frames = await d.stackTrace();
      const frame = frames.find((f) => !f.inlined) ?? frames[0];
      if (!frame) return;
      const scope = (await d.scopes(frame.id)).find((s) => s.name === 'Peripherals');
      if (!scope) {
        this.roots = [];
        this.error = 'the server reports no Peripherals scope (load an SVD, and debug info is required)';
        return;
      }
      const vars = await d.variables(scope.reference);
      const roots = vars.map((v) => this.toNode(v, '', 0));
      for (const r of roots) if (r.reference && this.open.has(r.path)) await this.load(r, generation);
      if (generation !== this.generation) return;
      this.roots = roots;
      this.error = '';
    } catch (e) {
      if (generation === this.generation) this.error = errorText(e);
    }
  }

  private async toggle(n: Node) {
    if (!n.reference) return;
    if (this.open.has(n.path)) {
      this.open.delete(n.path);
    } else {
      this.open.add(n.path);
      if (!n.children) {
        try { await this.load(n, this.generation); } catch (e) { this.error = errorText(e); }
      }
    }
    this.requestUpdate();
  }

  private renderNode(n: Node): unknown {
    const isOpen = this.open.has(n.path);
    return html`
      <div class="node" style="padding-left:${n.depth * 14}px" data-path=${n.path}>
        <span class="twisty" @click=${() => this.toggle(n)}>${n.reference ? (isOpen ? '▾' : '▸') : ''}</span>
        <span class="name">${n.name.split('.').pop()}</span>
        <span class="value mono">${n.value}</span>
        ${n.type ? html`<span class="type">${n.type}</span>` : nothing}
      </div>
      ${isOpen && n.children ? n.children.map((c) => this.renderNode(c)) : nothing}`;
  }

  render() {
    if (!this.debugger) return html`<div class="muted">no debugger</div>`;
    const f = this.filter.toLowerCase();
    const shown = f ? this.roots.filter((r) => r.name.toLowerCase().includes(f)) : this.roots;
    return html`
      <div class="row">
        <input type="file" accept=".svd,.xml" @change=${async (e: Event) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (file) await this.loadSvd(new Uint8Array(await file.arrayBuffer()), file.name);
        }}>
        <input class="edit filter" placeholder="filter peripherals" @input=${(e: Event) => { this.filter = (e.target as HTMLInputElement).value; }}>
        ${this.svdName ? html`<span class="muted">${this.svdName}</span>` : nothing}
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${!this.svdName ? html`<div class="muted">load an SVD file to see peripherals</div>` : nothing}
      ${shown.map((r) => this.renderNode(r))}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-peripherals': ProbePeripherals; } }

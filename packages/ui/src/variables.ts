import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Debugger, Frame, Variable } from '@probe-web/client';
import { debugStyles, errorText } from './debug-style.ts';

interface Node {
  /** Stable across stops: scope name / variable names, used to keep expansion state. */
  path: string;
  name: string;
  value: string;
  type: string | null;
  reference: number;
  parent: number;
  depth: number;
  children: Node[] | null;
}

interface Watch {
  expression: string;
  value: string;
  type: string | null;
  error: boolean;
}

/** Scopes expanded by default. The rest (Static, Peripherals, Registers) can be large. */
const DEFAULT_OPEN = new Set(['Variables']);

/**
 * `<probe-variables>`: scopes and variables of a frame (Variables, Static,
 * Registers, Peripherals with an SVD), children loaded on expand, expansion
 * kept across stops, leaf values editable (double-click), and watch
 * expressions (probe-rs evaluates names, not arbitrary expressions).
 * Set `frame` (e.g. from `<probe-callstack>`'s `frame-selected`); without it
 * the first non-inlined frame of each stop is used.
 */
@customElement('probe-variables')
export class ProbeVariables extends LitElement {
  static styles = [debugStyles, css`
    .node { display: flex; gap: 6px; align-items: baseline; padding: 1px 0; white-space: nowrap; }
    .twisty { width: 1em; display: inline-block; cursor: pointer; user-select: none; color: #555; }
    .name { color: #7c3aed; }
    .scope > .name { color: #111; font-weight: 600; }
    .value { overflow: hidden; text-overflow: ellipsis; }
    .type { color: #888; font-size: 11px; }
    .watch-add { font: inherit; width: 14em; }
  `];

  @property({ attribute: false }) debugger: Debugger | null = null;
  @property({ attribute: false }) frame: Frame | null = null;
  @state() private scopes: Node[] = [];
  @state() private watches: Watch[] = [];
  @state() private stale = true;
  @state() private editing: string | null = null;
  @state() private error = '';
  private open = new Set<string>(DEFAULT_OPEN);
  private unlisten: (() => void) | null = null;
  private generation = 0;

  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has('debugger')) this.attach();
    else if (changed.has('frame') && this.debugger?.state === 'halted') void this.refresh();
  }

  disconnectedCallback() {
    this.unlisten?.();
    this.unlisten = null;
    super.disconnectedCallback();
  }

  private attach() {
    this.unlisten?.();
    this.unlisten = null;
    const d = this.debugger;
    if (!d) return;
    const onStop = () => { this.frame = null; void this.refresh(); };
    const onRun = () => { this.stale = true; this.editing = null; };
    d.addEventListener('stopped', onStop);
    d.addEventListener('continued', onRun);
    this.unlisten = () => {
      d.removeEventListener('stopped', onStop);
      d.removeEventListener('continued', onRun);
    };
    if (d.state === 'halted') void this.refresh();
  }

  private toNode(v: Variable, parentPath: string, depth: number): Node {
    return { path: `${parentPath}/${v.name}`, name: v.name, value: v.value, type: v.type, reference: v.reference, parent: v.parent, depth, children: null };
  }

  private async load(node: Node, generation: number): Promise<void> {
    const d = this.debugger!;
    const vars = await d.variables(node.reference);
    if (generation !== this.generation) return;
    node.children = vars.map((v) => this.toNode(v, node.path, node.depth + 1));
    for (const child of node.children) {
      if (child.reference && this.open.has(child.path)) await this.load(child, generation);
    }
  }

  /** Reload scopes, expanded variables and watches for the current frame. */
  async refresh() {
    const d = this.debugger;
    if (!d || d.state !== 'halted') return;
    const generation = ++this.generation;
    try {
      const frames = await d.stackTrace();
      const frame = this.frame && frames.some((f) => f.id === this.frame!.id)
        ? this.frame
        : frames.find((f) => !f.inlined) ?? frames[0];
      if (!frame) return;
      const scopes = await d.scopes(frame.id);
      const nodes: Node[] = scopes.map((s) => ({ path: s.name, name: s.name, value: '', type: null, reference: s.reference, parent: 0, depth: 0, children: null }));
      for (const n of nodes) {
        if (n.reference && this.open.has(n.path)) await this.load(n, generation);
      }
      const watches: Watch[] = [];
      for (const w of this.watches) {
        try {
          const r = await d.evaluate(w.expression, frame.id);
          watches.push({ expression: w.expression, value: r.value, type: r.type, error: r.value.startsWith('<invalid expression') });
        } catch (e) {
          watches.push({ expression: w.expression, value: errorText(e), type: null, error: true });
        }
      }
      if (generation !== this.generation) return;
      this.scopes = nodes;
      this.watches = watches;
      this.stale = false;
      this.error = '';
    } catch (e) {
      if (generation === this.generation) this.error = errorText(e);
    }
  }

  private async toggle(node: Node) {
    if (!node.reference || this.stale) return;
    if (this.open.has(node.path)) {
      this.open.delete(node.path);
      this.requestUpdate();
      return;
    }
    this.open.add(node.path);
    if (!node.children) {
      try {
        await this.load(node, this.generation);
      } catch (e) {
        this.error = errorText(e);
      }
    }
    this.requestUpdate();
  }

  private async commit(node: Node, text: string) {
    this.editing = null;
    try {
      await this.debugger!.setVariable({ name: node.name, parent: node.parent }, text);
      await this.refresh();
    } catch (e) {
      this.error = errorText(e);
    }
  }

  /** Add a watch expression (a variable, static or register name). */
  addWatch(expression: string) {
    const e = expression.trim();
    if (!e || this.watches.some((w) => w.expression === e)) return;
    this.watches = [...this.watches, { expression: e, value: '…', type: null, error: false }];
    void this.refresh();
  }

  private renderNode(n: Node): unknown {
    const expandable = n.reference !== 0;
    const isOpen = this.open.has(n.path);
    const isScope = n.depth === 0;
    return html`
      <div class="node ${isScope ? 'scope' : ''}" style="padding-left:${n.depth * 14}px" data-path=${n.path}>
        <span class="twisty" @click=${() => this.toggle(n)}>${expandable ? (isOpen ? '▾' : '▸') : ''}</span>
        <span class="name">${n.name}</span>
        ${isScope ? nothing : html`
          ${this.editing === n.path
            ? html`<input class="edit" .value=${n.value} autofocus @keydown=${(e: KeyboardEvent) => {
                if (e.key === 'Enter') void this.commit(n, (e.target as HTMLInputElement).value);
                if (e.key === 'Escape') this.editing = null;
              }}>`
            : html`<span class="value mono" title=${expandable ? '' : 'double-click to edit'}
                @dblclick=${() => { if (!expandable && !this.stale) this.editing = n.path; }}>${n.value}</span>`}
          ${n.type ? html`<span class="type">${n.type}</span>` : nothing}`}
      </div>
      ${expandable && isOpen && n.children ? n.children.map((c) => this.renderNode(c)) : nothing}
    `;
  }

  render() {
    if (!this.debugger) return html`<div class="muted">no debugger</div>`;
    return html`
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      <div class=${this.stale ? 'stale' : ''}>
        ${this.scopes.length === 0 ? html`<div class="muted">halt the core to see variables</div>` : nothing}
        ${this.scopes.map((s) => this.renderNode(s))}
        <div class="node scope"><span class="twisty"></span><span class="name">Watch</span></div>
        ${this.watches.map((w) => html`
          <div class="node" style="padding-left:14px" data-watch=${w.expression}>
            <span class="twisty"></span><span class="name">${w.expression}</span>
            <span class="value mono ${w.error ? 'err' : ''}">${w.value}</span>
            ${w.type ? html`<span class="type">${w.type}</span>` : nothing}
            <button title="remove" @click=${() => { this.watches = this.watches.filter((x) => x !== w); }}>✕</button>
          </div>`)}
        <div class="node" style="padding-left:14px">
          <input class="watch-add" placeholder="add watch (name)" @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') { this.addWatch((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).value = ''; }
          }}>
        </div>
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'probe-variables': ProbeVariables; } }

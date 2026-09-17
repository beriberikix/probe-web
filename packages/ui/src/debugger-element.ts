import { LitElement } from 'lit';
import { property } from 'lit/decorators.js';
import type { Debugger } from '@probe-web/client';

/** Base for components driven by a `Debugger`: subscribes to its events while connected. */
export abstract class DebuggerElement extends LitElement {
  @property({ attribute: false }) debugger: Debugger | null = null;
  private unlisten: (() => void) | null = null;

  protected onStopped(): void {}
  protected onContinued(): void {}
  protected onBreakpoints(): void {}
  /** Called when a debugger is attached (and the core may already be halted). */
  protected onAttached(): void {}

  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has('debugger')) this.subscribe();
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.debugger && !this.unlisten) this.subscribe();
  }

  disconnectedCallback() {
    this.unlisten?.();
    this.unlisten = null;
    super.disconnectedCallback();
  }

  private subscribe() {
    this.unlisten?.();
    this.unlisten = null;
    const d = this.debugger;
    if (!d) return;
    const handlers: [string, () => void][] = [
      ['stopped', () => this.onStopped()],
      ['continued', () => this.onContinued()],
      ['breakpoints', () => this.onBreakpoints()],
    ];
    for (const [t, h] of handlers) d.addEventListener(t, h);
    this.unlisten = () => handlers.forEach(([t, h]) => d.removeEventListener(t, h));
    this.onAttached();
  }
}

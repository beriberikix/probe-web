import type { DebugProtocol as DP } from '@vscode/debugprotocol';
import type { ProbeDebugAdapter } from '@probe-web/dap';

/** A DAP client talking to an inline adapter in the same page. Events are re-dispatched as `dap:<event>`. */
export class DapClient extends EventTarget {
  private seq = 1;
  private pending = new Map<number, { resolve: (r: DP.Response) => void; reject: (e: Error) => void }>();
  readonly adapter: ProbeDebugAdapter;

  constructor(adapter: ProbeDebugAdapter) {
    super();
    this.adapter = adapter;
    adapter.onDidSendMessage((m) => {
      if (m.type === 'response') {
        const r = m as DP.Response;
        const p = this.pending.get(r.request_seq);
        this.pending.delete(r.request_seq);
        if (!p) return;
        if (r.success) p.resolve(r);
        else p.reject(Object.assign(new Error(r.message ?? `${r.command} failed`), { response: r }));
      } else if (m.type === 'event') {
        const e = m as DP.Event;
        this.dispatchEvent(new CustomEvent(`dap:${e.event}`, { detail: e.body }));
      }
    });
  }

  request<T extends DP.Response>(command: string, args?: unknown): Promise<T> {
    const seq = this.seq++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as (r: DP.Response) => void, reject });
      this.adapter.handleMessage({ seq, type: 'request', command, arguments: args } as DP.Request);
    });
  }

  on<T = unknown>(event: string, listener: (body: T) => void): () => void {
    const h = (e: Event) => listener((e as CustomEvent<T>).detail);
    this.addEventListener(`dap:${event}`, h);
    return () => this.removeEventListener(`dap:${event}`, h);
  }
}

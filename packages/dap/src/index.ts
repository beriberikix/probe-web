/**
 * A Debug Adapter Protocol (DAP) adapter for probe-rs that runs in the page, a
 * worker, or Node, on top of `@probe-web/client`'s `Debugger`.
 *
 * {@link ProbeDebugAdapter} has the shape VS Code web's
 * `DebugAdapterInlineImplementation` expects: requests go in through
 * `handleMessage()`, responses and events come out through
 * `onDidSendMessage()`. Any DAP client can drive it the same way. By default
 * `launch` / `attach` connect with {@link connectProbeRs}, which opens a
 * probe-rs session over a `probe-rs serve` WebSocket or over WebUSB in this
 * page, flashes the program on `launch`, and loads its debug info.
 *
 * @example
 * ```ts
 * import type { DebugProtocol as DP } from '@vscode/debugprotocol';
 * import { ProbeDebugAdapter } from '@probe-web/dap';
 *
 * const adapter = new ProbeDebugAdapter(); // connects with connectProbeRs
 * adapter.onDidSendMessage((m) => console.log(m)); // responses and events
 *
 * let seq = 1;
 * const send = (command: string, args?: unknown) =>
 *   adapter.handleMessage({ seq: seq++, type: 'request', command, arguments: args } as DP.Request);
 *
 * send('initialize', { adapterID: 'probe-rs', linesStartAt1: true, columnsStartAt1: true });
 * send('launch', { url: 'ws://127.0.0.1:3000', token: 'secret', chip: 'MCXA153', program: '/firmware/app.elf' });
 * // After the `initialized` event: setBreakpoints, then configurationDone to run.
 * ```
 *
 * @packageDocumentation
 */
export { ProbeDebugAdapter, connectProbeRs } from './adapter.ts';
export type { AdapterOptions, ConnectResult, DebuggerLike, Listener, ProbeLaunchArguments } from './adapter.ts';

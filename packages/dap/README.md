# @probe-web/dap

A Debug Adapter Protocol adapter for probe-rs that runs in the page, a worker,
or Node, on top of `@probe-web/client`'s `Debugger`. `ProbeDebugAdapter` takes
DAP requests through `handleMessage()` and sends responses and events to
`onDidSendMessage()` listeners, the shape VS Code web's
`DebugAdapterInlineImplementation` expects, so an editor can debug firmware
without a native adapter process.

```ts
import type { DebugProtocol as DP } from '@vscode/debugprotocol';
import { ProbeDebugAdapter } from '@probe-web/dap';

const adapter = new ProbeDebugAdapter(); // connects with connectProbeRs by default
adapter.onDidSendMessage((m) => console.log(m)); // responses and events
let seq = 1;
const send = (command: string, args?: unknown) =>
  adapter.handleMessage({ seq: seq++, type: 'request', command, arguments: args } as DP.Request);

send('initialize', { adapterID: 'probe-rs', linesStartAt1: true, columnsStartAt1: true });
send('launch', { url: 'ws://127.0.0.1:3000', token: 'secret', chip: 'MCXA153', program: '/firmware/app.elf' });
// On the `initialized` event: setBreakpoints, then configurationDone to run.
```

- `launch` / `attach` connect to `probe-rs serve` over WebSocket by default;
  `transport: 'webusb'` runs probe-rs in a worker instead (Chromium only, the
  probe must already be granted, and there is no disassembly).
- `launch` flashes `program` and resets the target; `attach` leaves it as it is.
- One core, reported as thread 1. Pass `connect` to supply your own debugger.

See `examples/monaco-ide` and `examples/node-ci/dap.ts` for complete clients.

API reference: https://beriberikix.github.io/probe-web/api/dap/

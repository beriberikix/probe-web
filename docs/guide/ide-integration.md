# IDE integration (DAP)

`@probe-web/dap` is a [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
adapter that runs in the page, in a worker or in Node. It turns DAP requests into calls on
the SDK's `Debugger`, so an editor that speaks DAP can debug firmware without a native
adapter process. That includes VS Code for the Web, Theia, or your own Monaco-based IDE.

```ts
import type { DebugProtocol as DP } from '@vscode/debugprotocol';
import { ProbeDebugAdapter } from '@probe-web/dap';

const adapter = new ProbeDebugAdapter();
adapter.onDidSendMessage((message) => {
  // responses to your requests, and events: initialized, stopped, output, terminated…
});

let seq = 1;
const send = (command: string, args?: unknown) =>
  adapter.handleMessage({ seq: seq++, type: 'request', command, arguments: args } as DP.Request);

send('initialize', { adapterID: 'probe-rs', linesStartAt1: true, columnsStartAt1: true });
send('launch', {
  transport: 'webusb',                // or the default 'websocket' with url and token
  chip: 'MCXA153',
  program: '/firmware/app.elf',       // bytes or a URL; flashed on launch
  svd: '/svd/MCXA153.svd',            // optional: the Peripherals scope
  rttChannels: [{ channelNumber: 0, dataFormat: 'Defmt' }],
});
// After the `initialized` event: setBreakpoints for each file, then configurationDone.
```

`ProbeDebugAdapter` has the shape of VS Code's `vscode.DebugAdapter`, so a web extension can
return it from a `DebugAdapterInlineImplementation`.

## Launch arguments

The arguments follow probe-rs's own `launch.json` where they overlap:

| Argument | Meaning |
|---|---|
| `transport` | `websocket` (default) to `probe-rs serve`, or `webusb` for probe-rs in the page |
| `url`, `token` | The `probe-rs serve` WebSocket URL and token |
| `probe` | Substring of the probe's identifier or serial number; the first probe if omitted |
| `chip`, `protocol` | The target and `Swd` or `Jtag` |
| `program` | The firmware ELF, as bytes or a URL. Loaded for debug info, and flashed on `launch` unless `flash: false` |
| `format` | Image format for flashing; defaults to the chip's own |
| `svd` | A CMSIS-SVD file, as bytes or a URL |
| `rtt`, `rttChannels` | RTT output as DAP `output` events; per-channel formats |
| `stopOnEntry` | Halt at the reset vector instead of running |

`attach` takes the same arguments and leaves the running firmware alone.

## What is supported

Breakpoints (source and instruction), stepping (over, into, out, instruction), pause and
continue, stack traces, scopes and variables (including SVD peripherals), `evaluate` and
`setVariable`, registers, `readMemory` and `writeMemory`, disassembly (when the server has
it), and RTT and semihosting output. One core is debugged, reported as thread 1.

To supply your own debugger, for example a `FakeDebugger` in tests, pass a `connect`
function to the constructor.

## Importing existing configuration

Projects that already use probe-rs have an `Embed.toml` or a `.vscode/launch.json`.
`importConfig` reads either into the same settings:

```ts
import { importConfig } from '@probe-web/client';

const config = importConfig('launch.json', text);
// { chip, probe, protocol, speed, connectUnderReset, url, token, programBinary, svdFile, applied }
```

`applied` lists which settings were found. The workbench offers this as *Import config…*.

## Examples

- `examples/monaco-ide`: a minimal IDE driven only through DAP, with Monaco, gutter
  breakpoints and an xterm console. [Try it](/monaco-ide/){target="_self"}.
- `examples/node-ci/dap.ts`: a DAP client in Node that checks the adapter against real
  hardware.

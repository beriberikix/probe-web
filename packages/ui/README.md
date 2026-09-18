# @probe-web/ui

Framework-agnostic web components (Lit) for flashing and debugging embedded targets
from a browser, built on [`@probe-web/client`](https://github.com/beriberikix/probe-web/tree/main/packages/client). Each element takes a
`client`, `session` or `debugger` property, works on its own, and reports what happens
through DOM events, which bubble and cross shadow roots.

| Element | Purpose | Key events |
|---|---|---|
| `<probe-device-picker>` | List the client's probes; authorize a new WebUSB device | `probe-selected`, `device-authorized` |
| `<probe-target-picker>` | Search the chip registry; import target YAML, CMSIS `.pack` or `.FLM` | `chip-selected`, `family-imported`, `svds-found` |
| `<probe-flash-panel>` | Pick or watch an image, flash with live progress, verify, erase | `flash-done`, `flash-failed`, `verify-done`, `erase-done`, `artifact-changed` |
| `<probe-rtt-terminal>` | xterm.js terminal running the monitor loop: RTT (String or defmt), semihosting; typed input to down channel 0 | `monitor-event`, `monitor-exit` |
| `<probe-semihosting-console>` | Semihosting stdout/stderr and exit status, fed from an RTT terminal | none |
| `<probe-serial-monitor>` | WebSerial console for UART-bridge boards | `serial-line`, `serial-state` |
| `<probe-core-controls>` | Continue, pause, step, reset, vector catch; core state | `debug-error` |
| `<probe-registers>` | Core registers, changes highlighted, editable when halted | none |
| `<probe-callstack>` | Stack at the current stop | `frame-selected` |
| `<probe-variables>` | Scopes, variables and watches for a frame, editable | none |
| `<probe-breakpoints>` | Source and address breakpoints | none |
| `<probe-disassembly>` | Instructions around the PC; gutter toggles breakpoints | none |
| `<probe-memory-view>` | Hex/ASCII memory, grouping, edit, variable highlights, Intel HEX export | none |
| `<probe-peripherals>` | CMSIS-SVD peripherals → registers → fields, read live | none |
| `<probe-test-runner>` | List and run an `embedded-test` suite | `tests-finished` |
| `<probe-rtt-plot>` | Live line plot of a binary RTT channel | `channel-changed` |

## Usage

```ts
import '@probe-web/ui'; // or one element: import '@probe-web/ui/flash-panel'
import { Client, type Wire } from '@probe-web/client';

const client = await Client.connect({ kind: 'webusb' });
const picker = document.querySelector('probe-device-picker')!;
picker.client = client;
picker.addEventListener('probe-selected', async (e) => {
  const session = await client.attach({ probe: (e as CustomEvent<Wire.DebugProbeEntry>).detail });
  document.querySelector('probe-flash-panel')!.session = session;
  document.querySelector('probe-core-controls')!.debugger = session.debugger();
});
```

## Bundling

The package ships TypeScript source. Bundlers must compile it with
`experimentalDecorators` (and `useDefineForClassFields: false`); a `tsconfig.json`
ships in the package for Vite/esbuild.

## Documentation

- [Components guide](https://beriberikix.github.io/probe-web/guide/components)
- [API reference](https://beriberikix.github.io/probe-web/api/ui/): every element's
  properties, methods and events

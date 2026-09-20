# probe-web

Flash and debug embedded targets from a browser tab, on top of
[probe-rs](https://probe.rs).

**[Documentation](https://beriberikix.github.io/probe-web/)** ·
**[Flasher](https://beriberikix.github.io/probe-web/flash/)** ·
**[Workbench](https://beriberikix.github.io/probe-web/workbench/)** ·
**[API reference](https://beriberikix.github.io/probe-web/api/)**

One client API, two transports:

- **WebUSB**: probe-rs itself, compiled to WebAssembly and running in a Web Worker, talks to
  the probe over WebUSB. You need a web page and a USB debug probe; nothing to install, no server.
- **WebSocket**: the same API against a native `probe-rs serve`, for browsers without
  WebUSB (Firefox, Safari), a probe on another machine, or Node.

Everything above the transport works the same either way:
- flashing with progress and verify;
- RTT with defmt decoded in the browser;
- semihosting and memory access;
- embedded-test suites;
- CMSIS-Pack import;
- a full debugger: breakpoints, stepping, call stack, variables, registers and SVD peripherals.

## Try it

Open the [flasher](https://beriberikix.github.io/probe-web/flash/) in Chrome or Edge with a
debug probe attached. Pick a demo image (the site ships firmware for the FRDM-MCXA153 and
the Thingy:91), select your probe and flash. Then open the
[workbench](https://beriberikix.github.io/probe-web/workbench/) to set a breakpoint.

## Use the SDK

```sh
npm install @probe-web/client @probe-web/ui @probe-web/devices
```

```ts
import { Client } from '@probe-web/client';
import { requestProbe } from '@probe-web/devices';

await requestProbe();                                    // in a click handler
const client = await Client.connect({ kind: 'webusb' }); // or { kind: 'websocket', url, token }
const [probe] = await client.listProbes();
const session = await client.attach({ probe, chip: 'MCXA153', protocol: 'Swd' });

const boot = await session.flash({ image: elfBytes, format: 'elf' });
await session.monitor(boot, (event) => console.log(event)); // RTT, defmt, semihosting
```

Or drop in the components:

```html
<probe-device-picker></probe-device-picker>
<probe-flash-panel></probe-flash-panel>
<probe-rtt-terminal></probe-rtt-terminal>
```

`@probe-web/ui` ships compiled JavaScript; the rest ship TypeScript source, which a bundler
compiles along with your own code. The
[guide](https://beriberikix.github.io/probe-web/guide/getting-started) has the one Vite
setting they need, and covers each part of the API.

## What is here

| | |
|---|---|
| [`packages/client`](packages/client) | The SDK: probes, chips, flashing, RTT, memory, and a `Debugger` for one core. Runs in the browser and in Node. |
| [`packages/ui`](packages/ui) | Sixteen Lit web components: device and target pickers, flash panel, RTT terminal and plot, test runner, serial monitor, and the debugger panels. |
| [`packages/dap`](packages/dap) | A Debug Adapter Protocol adapter over the SDK, for VS Code for the Web, Theia or a Monaco editor. |
| [`packages/devices`](packages/devices), [`packages/artifacts`](packages/artifacts), [`packages/serial`](packages/serial) | WebUSB probe lifecycle; firmware files with watch-and-reflash; a WebSerial console. |
| [`crates/probe-web-core`](crates/probe-web-core) | probe-rs's RPC client compiled to wasm, plus defmt decoding. |
| [`crates/probe-web-local`](crates/probe-web-local) | probe-rs in a Worker: the server the WebUSB transport talks to. |
| [`crates/probe-web-targets`](crates/probe-web-targets) | CMSIS-Pack and `.FLM` import: a vendor pack becomes probe-rs target YAML in the browser. |
| [`apps/`](apps) | The flasher, the workbench (dockable debugger with Monaco) and the inspector (`probe-rs info` in a page). |
| [`examples/`](examples) | A minimal flashing page, a Monaco IDE driven only through DAP, and Node scripts for hardware-in-the-loop CI. |
| [`hardware-tests/`](hardware-tests) | Test firmware and the checks run against real boards. |
| [`tools/wire-gen`](tools/wire-gen) | Generates the TypeScript wire types from probe-rs's RPC schema. |
| [`docs/`](docs) | The documentation site. |

## Status

probe-web is verified on an FRDM-MCXA153 (CMSIS-DAP), an nRF9160 on a Thingy:91 (J-Link) and
an ESP32-S3 (built-in USB-JTAG): flashing, RTT, and debugging, over both transports. See
[Supported hardware](https://beriberikix.github.io/probe-web/reference/hardware).

Worth knowing:

- **WebUSB is Chromium-only.** Firefox and Safari can use the WebSocket transport.
- **It builds on forks of probe-rs.** probe-rs upstream is synchronous and has no wasm
  support. The WebUSB transport uses an async port (`beriberikix/probe-rs`, branch
  `webusb/nusb-0.2.7`), and `probe-rs serve` needs the `wasm-rpc-client` branch. Cargo
  fetches both. The intent is to follow upstream as that work lands.
- **No disassembly over WebUSB.** probe-rs disassembles with capstone, a C library.

More in [Browser support and limitations](https://beriberikix.github.io/probe-web/reference/limitations).

## Build from source

```sh
cargo install wasm-bindgen-cli --version 0.2.128   # must match Cargo.lock
npm install
./scripts/build-wasm.sh       # needs the Rust toolchain in rust-toolchain.toml
./scripts/build-firmware.sh   # optional: the demo firmware (needs thumbv8m.main-none-eabi)
npm run dev -w apps/flash     # http://127.0.0.1:5173
```

The development server serves the flasher at `/`, the workbench at `/workbench/`, the
inspector at `/inspect/`, and the examples at `/monaco-ide/` and `/minimal-flash/`.

```sh
npm test                 # vitest: SDK, DAP adapter, helpers
npx playwright test      # every app and component against a fake probe, no hardware
npm run docs:dev         # the documentation site, with the API reference
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how the pieces fit and how to work on them, and
[CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## License

MIT or Apache-2.0, at your option, matching probe-rs.

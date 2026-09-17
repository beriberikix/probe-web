# probe-web

Flash and debug embedded targets from a browser tab, on top of
[probe-rs](https://probe.rs).

One client API, two transports:

- **WebUSB** — probe-rs itself, compiled to wasm and running in a Web Worker,
  talking to the probe over WebUSB. No server, no install: a web page and a
  USB debug probe.
- **WebSocket** — the same API against a native `probe-rs serve`, for browsers
  without WebUSB (Firefox, Safari) or a probe on another machine.

Everything above the transport is the same either way: flashing with progress,
RTT and defmt, semihosting, memory, and a full debugger — breakpoints,
stepping, call stack, variables, registers, SVD peripherals.

## What is here

| | |
|---|---|
| `packages/client` | The SDK: probes, chips, flashing, RTT, memory, and a `Debugger` that owns one core's debug state. Runs in the browser and in Node. |
| `packages/ui` | Lit components — device picker, flash panel, RTT terminal, core controls, registers, call stack, variables, breakpoints, disassembly, memory view, peripherals. Each works on its own. |
| `packages/dap` | A Debug Adapter Protocol adapter over the SDK, for VS Code web, Theia, or a Monaco editor. |
| `packages/devices`, `packages/artifacts`, `packages/serial` | WebUSB device lifecycle, firmware files (including File System Access with re-flash on rebuild), and a WebSerial monitor. |
| `crates/probe-web-core` | The RPC client compiled to wasm, plus defmt decoding. |
| `crates/probe-web-local` | probe-rs in a Worker: the RPC server the WebUSB transport talks to. |
| `apps/flash` | A single-target flasher page. |
| `apps/workbench` | Flash and debug in one page: dockable panels, Monaco, xterm. |
| `apps/inspect` | probe-rs `info` in a page: DP, APs, ROM tables. |
| `examples/` | A minimal Monaco IDE driven only through DAP, and Node scripts that run the same SDK against hardware in CI. |

## Status

Works today, verified on an FRDM-MCXA153 (CMSIS-DAP), an nRF9160 on a
Thingy:91 (J-Link) and an ESP32-S3 (built-in USB-JTAG). See
`spikes/README.md` for the per-phase log and the hardware matrix.

Worth knowing before you try it:

- **WebUSB is Chromium-only.** Firefox and Safari can still use the WebSocket
  transport against `probe-rs serve`.
- **The WebUSB transport needs the forks.** probe-rs upstream is synchronous
  and has no wasm support; this builds on a fork with an async port
  (`beriberikix/probe-rs`, branches `webusb/nusb-0.2.7` and
  `wasm-rpc-client`), fetched by Cargo. The intent is to repoint at upstream
  when the async work lands.
- **No disassembly over WebUSB.** probe-rs disassembles with capstone, a C
  library; the panel and the DAP adapter report it as unavailable there.
- **Xtensa stepping has a gap.** On ESP32-S3, step out lands in the entry
  trampoline and frames past the first caller repeat. Everything else on that
  chip works.
- Nothing is published to npm yet; the API still moves.

## Try it

```sh
npm install
./scripts/build-wasm.sh      # needs the Rust toolchain in rust-toolchain.toml
npm run dev -w apps/flash    # http://127.0.0.1:5173
```

Open the page in Chrome, pick a probe when asked, choose a chip and a
firmware file, and flash. The workbench is at `/workbench/`, the inspector at
`/inspect/`, and the Monaco IDE example at `/monaco-ide/`.

For the WebSocket transport, run `probe-rs serve` from a checkout of the
`wasm-rpc-client` branch and point the page at it.

## Tests

```sh
npm test                     # vitest: pure helpers, DAP protocol
npx playwright test          # browser tests against a fake probe, no hardware
```

`examples/node-ci` holds hardware-in-the-loop scripts that drive a real probe
through `probe-rs serve` and exit non-zero on failure.

## License

MIT or Apache-2.0, at your option, matching probe-rs.

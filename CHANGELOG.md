# Changelog

Notable changes to probe-web. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.5.0 - 2026-09-19

The first released version, and the first on npm: `@probe-web/client`, `@probe-web/ui`,
`@probe-web/dap`, `@probe-web/devices`, `@probe-web/artifacts` and `@probe-web/serial`,
all at 0.5.0. They ship TypeScript source rather than a build, so a consuming bundler
compiles them and needs the settings in
[Getting started](https://beriberikix.github.io/probe-web/guide/getting-started).

Not 1.0: WebUSB is Chromium-only, and probe-web builds on branches of probe-rs that are not
upstream yet, so the API may still move as that work lands.

### Transports

- WebUSB: probe-rs compiled to wasm and hosted in a Web Worker, with per-probe Web Locks,
  crash reporting (`worker-crashed`) and probe recovery on attach.
- WebSocket: the same client against `probe-rs serve`, in the browser and in Node.
- Capability negotiation, so a client knows which endpoints its server implements.

### SDK (`@probe-web/client`)

- Probes, chips, attach (including under reset), flashing with progress, verify and
  erase, and boot.
- RTT up and down channels, with defmt decoded in the browser from the ELF and exact
  control-block addresses taken from the ELF.
- Semihosting output and exit codes, and `embedded-test` list and run.
- A `Debugger` for one core:
  - run control and stepping, including Xtensa step out;
  - source and instruction breakpoints;
  - stack traces, scopes, variables, `evaluate` and `setVariable`;
  - registers, memory, SVD peripherals, disassembly (over `probe-rs serve`), and RTT and
    semihosting while debugging.
- Coredumps in the format native probe-rs reads.
- `Embed.toml` and `launch.json` import.
- Source mapping from debug-info paths to a directory or a URL.
- CMSIS-Pack and `.FLM` import into probe-rs target YAML (`@probe-web/client/targets`).
- Test helpers: `FakeDebugger` and a fake-probe worker (`@probe-web/client/testing`).

### Components (`@probe-web/ui`)

- 16 elements:
  - flashing and output: device picker, target picker, flash panel with watch-and-reflash,
    RTT terminal, RTT plot, semihosting console, test runner and serial monitor;
  - debugging: core controls, registers, call stack, variables, breakpoints, disassembly,
    memory view and peripherals.

### Other packages

- `@probe-web/dap`: a Debug Adapter Protocol adapter over the SDK.
- `@probe-web/devices`, `@probe-web/artifacts`, `@probe-web/serial`: WebUSB probe
  lifecycle, firmware files and a WebSerial console.

### Apps

- Flasher, workbench, inspector, a Monaco IDE example and a minimal flashing example,
  deployed with the documentation to GitHub Pages.

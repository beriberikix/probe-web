# Changelog

Notable changes to probe-web. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Performance

`@probe-web/ui` no longer loads xterm.js until an element actually shows a terminal.
`<probe-rtt-terminal>` and `<probe-serial-monitor>` imported it at module scope, and because
`index.ts` is a barrel that registers every element, a plain `import '@probe-web/ui'` paid
for xterm on a page with no terminal on it. It is now fetched on first render, together with
its stylesheet, which is adopted into the element's shadow root rather than baked into
`static styles`.

Output that arrives while xterm is still downloading is buffered and replayed, so a monitor
loop or a serial port that starts producing immediately loses nothing.

Measured against a production build: the flasher's first load went from **136 kB to 65 kB**
gzipped and the React example's from **176 kB to 106 kB**. In a consumer that installs the
tarball and imports `@probe-web/ui/serial-monitor`, the entry chunk is 13.7 kB and xterm is a
separate 71.7 kB chunk that is only fetched when the element renders.

### Fixed

`npm run release:pack` packed every workspace, including the `apps/` and `examples/` ones
that have no `version`, and failed with "Invalid package, must have name and version". It now
names the six published packages.

## 0.5.1 - 2026-09-20

No changes to the packages: their source is identical to 0.5.0.

What is different is how they got here. 0.5.0 was published by hand from a laptop, which
cannot produce an attestation. This version is published by
[`release.yml`](https://github.com/beriberikix/probe-web/blob/main/.github/workflows/release.yml)
over [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), so each package
carries provenance linking it to the commit and the workflow run that built it. If you are
choosing between the two, install this one.

## 0.5.0 - 2026-09-20

The first released version, and the first on npm.

```sh
npm install @probe-web/client @probe-web/ui @probe-web/devices
```

Six packages, all at 0.5.0: [`@probe-web/client`](https://www.npmjs.com/package/@probe-web/client)
(the SDK), [`@probe-web/ui`](https://www.npmjs.com/package/@probe-web/ui) (the components),
[`@probe-web/dap`](https://www.npmjs.com/package/@probe-web/dap) (a Debug Adapter Protocol
adapter), and [`@probe-web/devices`](https://www.npmjs.com/package/@probe-web/devices),
[`@probe-web/artifacts`](https://www.npmjs.com/package/@probe-web/artifacts) and
[`@probe-web/serial`](https://www.npmjs.com/package/@probe-web/serial). Or try it with
nothing installed: the [flasher](https://beriberikix.github.io/probe-web/flash/) and the
[workbench](https://beriberikix.github.io/probe-web/workbench/) run from the docs site.

The packages ship TypeScript source rather than a build, so a consuming bundler compiles
them and needs the Vite and `tsconfig.json` settings in
[Getting started](https://beriberikix.github.io/probe-web/guide/getting-started). In Node
they need `tsx` or another loader.

Not 1.0: WebUSB is Chromium-only, probe-web builds on branches of probe-rs that are not
upstream yet, and there is no disassembly over WebUSB. The API may still move as that work
lands. See [Browser support and limitations](https://beriberikix.github.io/probe-web/reference/limitations).

Verified on an FRDM-MCXA153 (CMSIS-DAP), an nRF9160 on a Thingy:91 (J-Link) and an ESP32-S3
(built-in USB-JTAG), over both transports.

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

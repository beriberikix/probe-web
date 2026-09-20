# Changelog

Notable changes to probe-web. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

The hosted site installs a service worker. Every asset is content-hashed and therefore
immutable, but GitHub Pages caps `Cache-Control` at ten minutes and offers no way to
configure headers, so past that window each asset costs a revalidation round trip before
anything can start. Hashed assets are now served cache-first from the Cache API, and
documents network-first so a deploy is always picked up.

The more useful half is that the apps keep working with no network once warm, including the
9.8 MB probe-rs worker. Nothing is precached, so a first visit is exactly as fast as before.

No package changed: this is the deployed apps only.

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

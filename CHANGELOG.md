# Changelog

Notable changes to probe-web. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

`prefetchWasm()` in `@probe-web/client`. Nothing requests the WebUSB worker's module — about
2.8 MB over the wire — until `Client.connect` runs, so the whole download used to land inside
the wait after the user clicked connect. `prefetchWasm()` issues a `rel=prefetch` hint
instead: the browser fetches at idle priority into its HTTP cache, and nothing is
instantiated or held in memory. Compiling costs about 30 ms whether the bytes came from the
network or the cache, so it is the download that is worth moving, not the compile.

It is deliberately not called on import. The flasher, the inspector and the workbench call it
when a probe is likely to be used: when the pointer reaches the connect button, and when
`grantedDevices()` shows this origin has been granted a probe before.

### Performance

Monaco Editor is no longer part of the workbench's or the Monaco IDE example's first load.
It is fetched the first time there is a source file to show — for the workbench, the first
stop in code with debug info. The workbench went from **1231 kB to 238 kB** gzipped and the
Monaco IDE example from **769 kB to 80 kB**. Nothing about either app's behaviour changed;
the source panel's element still exists from the moment the dock mounts it, and breakpoint
marks or a PC line that arrive before the editor does are replayed onto it.

`@probe-web/ui` no longer loads xterm.js until an element actually shows a terminal.
`<probe-rtt-terminal>` and `<probe-serial-monitor>` imported it at module scope, and because
`index.ts` is a barrel that registers every element, a plain `import '@probe-web/ui'` paid
for xterm on a page with no terminal on it. It is now fetched on first render, together with
its stylesheet, which is adopted into the element's shadow root rather than baked into
`static styles`. Output that arrives while xterm is still downloading is buffered and
replayed, so a monitor loop or a serial port that starts producing immediately loses nothing.

The flasher's first load went from **136 kB to 65 kB** gzipped and the React example's from
**176 kB to 106 kB**. In a consumer that installs the tarball and imports
`@probe-web/ui/serial-monitor`, the entry chunk is 13.7 kB and xterm is a separate 71.7 kB
chunk that is only fetched when the element renders.

`scripts/first-load.mjs` is new: it reports what each app downloads before it is interactive,
and labels every chunk by what is actually inside it rather than by the name Vite gave it.

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

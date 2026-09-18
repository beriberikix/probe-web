# Minimal flash

The smallest complete flashing page: grant a probe over WebUSB, attach with probe-rs
running in a Worker in the tab, flash a demo image with progress, reset and run. All of it
is in [`src/main.ts`](src/main.ts), about 50 lines.

Run it from the repository root, after `./scripts/build-wasm.sh` and
`./scripts/build-firmware.sh`:

```sh
npm run dev -w apps/flash
# open http://127.0.0.1:5173/minimal-flash/ in Chrome or Edge
```

The flasher's development server serves the examples too, so they share its origin and its
WebUSB grants. The deployed copy is at
https://beriberikix.github.io/probe-web/minimal-flash/.

The guide walks through each step:
[Getting started](https://beriberikix.github.io/probe-web/guide/getting-started) and
[Flashing](https://beriberikix.github.io/probe-web/guide/flashing).

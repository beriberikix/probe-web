# Getting started

probe-web flashes and debugs microcontrollers from a web page. It is built on
[probe-rs](https://probe.rs): the same flash algorithms, target descriptions, RTT and
debugger, compiled to WebAssembly so they run in the browser.

## Try it without writing code

You need Chrome or Edge (WebUSB is Chromium-only), a USB debug probe and a board.

1. Open the [flasher](/flash/){target="_self"}.
2. Pick a demo image. Firmware for the FRDM-MCXA153 and the Thingy:91 (nRF9160) ships with
   the site. For another board, choose a chip and a file of your own.
3. Click **Authorize device…** and select your probe. The grant is remembered for the site.
4. Flash. Progress, verification and then RTT output appear in the page.
5. Open the [workbench](/workbench/){target="_self"} to set a breakpoint, step, and inspect
   variables, registers, memory and peripherals.

Nothing is installed and no server is involved: probe-rs runs in a Web Worker in the tab.
See [Supported hardware](/reference/hardware) for the boards and probes that have been
verified.

## Use the SDK in your own page

```sh
npm install @probe-web/client @probe-web/ui @probe-web/devices
```

`@probe-web/ui` ships compiled JavaScript. The other five ship TypeScript source, so your
bundler compiles them along with your own code. With Vite, the whole configuration is one
exclusion:

```ts
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // probe-rs's Worker and wasm are addressed with `new URL(..., import.meta.url)`,
    // which does not survive dependency pre-bundling.
    exclude: ['@probe-web/client'],
  },
  worker: { format: 'es' },
});
```

Your `tsconfig.json` needs to resolve the source the packages ship:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["vite/client", "w3c-web-usb"]
  }
}
```

In Node, use [tsx](https://tsx.is) or another loader — Node's own type stripping refuses
files under `node_modules`. See [Node and CI](./node-and-ci). To work against the packages
themselves instead, use them from a clone (see [Building from source](#building-from-source)).

```ts
import { Client } from '@probe-web/client';
import { requestProbe } from '@probe-web/devices';

// In a click handler: the browser's device chooser needs a user gesture.
await requestProbe();

const client = await Client.connect({ kind: 'webusb' }); // probe-rs in a Worker
const [probe] = await client.listProbes();
const session = await client.attach({ probe, chip: 'MCXA153', protocol: 'Swd' });

const boot = await session.flash({ image: '/firmware/app.elf', format: 'elf', options: { verify: true } });
await session.boot(boot); // reset and run
```

`examples/minimal-flash` in the repository is this flow as a complete page. The
[hosted copy](/minimal-flash/){target="_self"} flashes the demo firmware.

From here:

- [Transports](./transports): WebUSB or a native `probe-rs serve`, and when to use which.
- [Flashing](./flashing), [RTT and defmt](./rtt-defmt), [Debugging](./debugging).
- [Web components](./components) if you want UI rather than an SDK.

## Building from source

You need Node 22 or newer and the Rust toolchain named in `rust-toolchain.toml`, which rustup
installs on first use along with the `wasm32-unknown-unknown` target. You also need
`wasm-bindgen-cli` at the version pinned in `Cargo.lock`:

```sh
git clone https://github.com/beriberikix/probe-web && cd probe-web
cargo install wasm-bindgen-cli --version 0.2.128
npm install
./scripts/build-wasm.sh       # probe-rs → wasm, into packages/client
./scripts/build-firmware.sh   # optional: the demo firmware (needs thumbv8m.main-none-eabi)
npm run dev -w apps/flash     # http://127.0.0.1:5173
```

The development server serves the flasher at `/`, the workbench at `/workbench/`, the
inspector at `/inspect/` and the examples at `/monaco-ide/` and `/minimal-flash/`. They
share one origin, so a probe granted to one page is available to all of them.

The first `build-wasm.sh` compiles probe-rs from source and takes several minutes. Cargo
fetches probe-rs from the forks described in [Architecture](./architecture#the-probe-rs-forks).

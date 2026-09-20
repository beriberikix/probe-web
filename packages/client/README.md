# @probe-web/client

The headless probe-rs SDK for browsers (and Node). List probes, attach to a chip,
flash firmware, stream RTT, defmt and semihosting output, run `embedded-test`
suites and debug — with one API over two transports.

```sh
npm install @probe-web/client
```

## Transports

| | `webusb` | `websocket` |
| --- | --- | --- |
| Where probe-rs runs | In this tab: probe-rs compiled to wasm, in a Web Worker | A native `probe-rs serve`, on this machine or another |
| Browsers | Chromium only | Any browser, and Node |
| Install | Nothing | probe-rs on the host |
| Disassembly | No (probe-rs's disassembler is C) | Yes |

```ts
import { Client } from '@probe-web/client';

// probe-rs running in this tab, over WebUSB …
const client = await Client.connect({ kind: 'webusb' });
// … or a native `probe-rs serve`
const remote = await Client.connect({ kind: 'websocket', url: 'ws://127.0.0.1:3000', token: 'secret' });
```

On WebUSB the probe must be granted to the page on the main thread first (for
example with `requestProbe` from `@probe-web/devices`); the worker only sees
granted probes. The `worker` option of the `webusb` transport replaces the
default worker: pass `createLocalWorker({ log: 'debug' })` to raise probe-rs's
log level, or the fake-probe worker to run without hardware (see below).

More: [Transports](https://beriberikix.github.io/probe-web/guide/transports).

## Flash and monitor

```ts
import { Client, elfHasRtt } from '@probe-web/client';

const [probe] = await client.listProbes();
const session = await client.attach({ probe, chip: 'MCXA153', protocol: 'Swd' });

const bootInfo = await session.flash({ image: elf, name: 'app.elf', format: 'elf' }, (e) => console.log(e));

if (elfHasRtt(elf)) {
  await session.createRttClient({ elf, defaults: { dataFormat: 'Defmt' } });
  session.setDefmtElf(elf);
}
const exit = await session.monitor(bootInfo, (ev) => {
  if (ev.kind === 'defmt') ev.lines.forEach((l) => console.log(l.level, l.message));
  if (ev.kind === 'semihosting') console.log(ev.data);
});
```

`openSession({ transport, probe, chip })` does the connect, pick-a-probe and
attach steps in one call.

More: [Getting started](https://beriberikix.github.io/probe-web/guide/getting-started),
[Flashing](https://beriberikix.github.io/probe-web/guide/flashing),
[RTT and defmt](https://beriberikix.github.io/probe-web/guide/rtt-defmt),
[Testing](https://beriberikix.github.io/probe-web/guide/testing).

## Debug

`session.debugger()` returns a `Debugger` for one core: run control,
breakpoints, stepping, stack traces, variables, registers and memory. It works
over both transports (disassembly needs `probe-rs serve`).

```ts
const dbg = session.debugger();
dbg.addEventListener('stopped', async () => {
  const [frame] = await dbg.stackTrace();
  console.log(`stopped in ${frame.functionName} at ${frame.source?.path}:${frame.source?.line}`);
});
dbg.start(); // poll the core, so `stopped` fires on its own

await dbg.loadDebugInfo(elf, 'app.elf');
await dbg.setSourceBreakpoints('src/main.rs', [{ line: 42 }]);
await dbg.continue();
```

`DirectorySourceProvider` and `UrlSourceProvider` map the build-time paths in
the debug info to source text in the browser.

More: [Debugging](https://beriberikix.github.io/probe-web/guide/debugging).

## Subpath exports

| Import | What |
| --- | --- |
| `@probe-web/client` | `Client`, `Session`, `Core`, `Debugger`, `openSession`, source providers, config import. |
| `@probe-web/client/wire` | The probe-rs RPC types (`Wire.*`), generated from probe-rs's schema by `tools/wire-gen`. Values cross the wasm boundary as described at the top of `src/wire.ts`: externally tagged enums, `bigint` for 64-bit integers, `null` for `None`. |
| `@probe-web/client/targets` | Reading CMSIS packs and `.FLM` flash algorithms into target YAML for `client.loadChipFamily`. It has its own wasm module, so import it dynamically. |
| `@probe-web/client/testing` | `FakeDebugger`, a scripted `Debugger` for UI and adapter tests. |
| `@probe-web/client/testing/worker` | `createFakeLocalWorker()`, a worker with a fake probe and a mocked core, for driving the WebUSB transport without hardware. It pulls in a second wasm module, so keep it out of production bundles. |

```ts
const { createFakeLocalWorker } = await import('@probe-web/client/testing/worker');
const client = await Client.connect({ kind: 'webusb', worker: createFakeLocalWorker() });
```

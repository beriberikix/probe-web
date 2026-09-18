# Node and CI

`@probe-web/client` runs in Node over the WebSocket transport, against a `probe-rs serve` on
a machine with boards attached. The same code that drives a browser UI then drives
hardware-in-the-loop tests.

```ts
import { Client } from '@probe-web/client';

const client = await Client.connect({ kind: 'websocket', url: 'ws://127.0.0.1:3000', token: process.env.PROBE_RS_TOKEN });
const [probe] = await client.listProbes();
const session = await client.attach({ probe, chip: 'nRF9160_xxAA', protocol: 'Swd' });
```

The packages ship TypeScript source written to be runnable with Node's type stripping, so
Node 22.18 or newer runs a `.ts` script directly:

```sh
node run.ts --elf firmware.elf --chip nRF9160_xxAA
```

In Node the client loads its wasm from disk. WebUSB is not available there.

## A hardware-in-the-loop runner

`examples/node-ci/run.ts` flashes a firmware, verifies it, and then monitors RTT and
semihosting until the firmware exits, halts or times out. It exits 0 only if the firmware
succeeded and printed every `--expect` string, so a CI job's status is the firmware's:

```sh
node examples/node-ci/run.ts --elf firmware.elf --chip nRF9160_xxAA \
  --url ws://127.0.0.1:3000 --probe j-link \
  --timeout 20 --expect "exiting with success"
```

The token comes from `--token`, or the `PROBE_RS_TOKEN` environment variable.

The same directory holds the debugger checks this project runs against real boards:

| Script | Checks |
|---|---|
| `debug.ts` | The SDK `Debugger`: run control, registers, memory, debug info, variables, breakpoints, stepping |
| `dap.ts` | The same through `@probe-web/dap` |
| `debug-basic.ts` | Run control without an ELF (any chip) |
| `semihosting.ts` | Semihosting through the debugger and through the monitor |
| `robustness.ts` | Bad requests come back as errors and leave `probe-rs serve` usable |
| `rtt-scan-pacing.ts` | RTT control-block scans do not starve other work |

Each prints PASS/FAIL per check and exits non-zero on any failure. The hardware tests
README in the repository has the command line for each board.

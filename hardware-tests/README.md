# Hardware tests

End-to-end checks against real boards, and the firmware they run. The hardware-free suites
(`npm test`, `npx playwright test`) cover the same code paths against a fake probe; these
checks are what proves them on silicon. The last verified results are on the docs site's
[Supported hardware](https://beriberikix.github.io/probe-web/reference/hardware) page.

Boards used: FRDM-MCXA153 (MCU-Link, CMSIS-DAP v2), Thingy:91 nRF9160 (J-Link) and
ESP32-S3-DevKitC (built-in USB-JTAG).

## Setup

```sh
./scripts/build-wasm.sh                          # probe-rs → wasm, into packages/client
./scripts/build-firmware.sh                      # firmware below → apps/flash/public/firmware/
npm run dev -w apps/flash                        # all apps on http://127.0.0.1:5173
(cd hardware-tests/serve && probe-rs serve)      # WebSocket transport: 127.0.0.1:3000, token probe-web
```

The WebUSB checks need only the dev server; grant the probe once with *Authorize device…* on
any page of that origin. The WebSocket checks need `probe-rs serve` built from the fork (see
[Transports](https://beriberikix.github.io/probe-web/guide/transports#websocket)):

```sh
cargo install probe-rs-tools --locked --git https://github.com/beriberikix/probe-rs --branch wasm-rpc-client
```

## Firmware

`scripts/build-firmware.sh` builds all Cortex-M images (it adds the `thumbv8m.main-none-eabi`
target) and copies them, with their sources, into `apps/flash/public/firmware/`. Add
`--esp32s3` for the Xtensa image.

| Firmware | Boards | What it does |
|---|---|---|
| `cm33-debug` | MCXA153, nRF9160 (feature per board) | The debug target: `main` calls `step_a(n)` → `step_b(point, mode)` about twice a second, with locals `point = {n, 2n}` and `mode`, statics `COUNTER` and `TABLE` (`[u16; 4] = 0x1111…0x4444`), text RTT on channel 0 and samples on binary channel 1. `src/main.rs:40` is the first statement in `step_b`. |
| `esp32s3-debug` | ESP32-S3 | The same program for Xtensa; `src/bin/main.rs:39` is the first statement in `step_b`. |
| `cm33-tests` | MCXA153, nRF9160 | An `embedded-test` suite with passing, should-panic and ignored tests. |
| `mcxa153-rtt` | MCXA153 | defmt over RTT. |
| `nrf9160-rtt-echo` | nRF9160 | A String up channel and a down channel; echoes lines upper-cased. |
| `nrf9160-semihosting` | nRF9160 | stdout and stderr over semihosting, then `SYS_EXIT` success. |
| `nrf9160-uart-echo` | nRF9160 | Banner and ticks on UARTE0 (the Thingy:91 board controller's serial port), echoes lines. |

Release builds use `opt-level = 1` and full DWARF, so lines and locals stay meaningful.

**Xtensa toolchain:** `cargo install espup && espup install --targets esp32s3`, then
`. ~/export-esp.sh` in the shell that runs `build-firmware.sh --esp32s3`. ESP32 images flash
in the ESP-IDF format, which the tools select with `format: 'target'`.

`svd/cortex-m-scb.svd` is a small Cortex-M SVD for the peripherals checks, also served at
`/svd/cortex-m-scb.svd`.

## Flash manifests

The flasher loads these from `apps/flash/public/` with `?manifest=<name>`:

| Manifest | Board | Image |
|---|---|---|
| `flash-manifest.json` | MCXA153 | 4 KiB test pattern at 0x1F000 (the default) |
| `rtt-manifest.json` | MCXA153 | `mcxa153-rtt` |
| `mcxa153-debug-manifest.json`, `mcxa153-tests-manifest.json` | MCXA153 | debug target, test suite |
| `nrf-manifest.json` | nRF9160 | 4 KiB test pattern at 0xF0000 |
| `nrf-rtt-manifest.json`, `nrf-semi-manifest.json` | nRF9160 | RTT echo, semihosting |
| `nrf9160-debug-manifest.json`, `nrf9160-tests-manifest.json` | nRF9160 | debug target, test suite |
| `esp-manifest.json` | ESP32-S3 | 4 KiB test pattern at 0x7F0000 (a spare region) |

`demos.json` lists the ones the deployed site offers.

## Browser checks

Open the URL in Chrome on `http://127.0.0.1:5173`. Each check logs PASS/FAIL lines and a
result marker to the page and the console. Add `&transport=webusb` for the in-page
worker, or `&transport=websocket&token=probe-web` for `probe-rs serve`. With several
probes attached, `&probe=<substring>` picks one.

### Flasher (`/`)

| Check | URL | Marker |
|---|---|---|
| Flash a tagged pattern | `/?auto=1&tag=<unique>` | `FLASH_RESULT` |
| RTT + defmt, 4 s | `/?auto=1&manifest=rtt-manifest.json&monitor=4` | `RTT_RESULT` |
| RTT down channel (nRF9160) | `/?auto=1&manifest=nrf-rtt-manifest.json&monitor=6&send=hello` | `RTT_RESULT` |
| Verify only, or erase all | `/?auto=1&op=verify` or `op=erase` | the page log |
| Flash → verify → erase → verify → flash → verify | `/?auto=1&op=cycle` | `CYCLE_RESULT` |
| Run an `embedded-test` suite | `/?auto=1&manifest=mcxa153-tests-manifest.json&op=tests` | `TESTS_RESULT` |
| Coredump | `/?auto=1&manifest=mcxa153-debug-manifest.json&op=dump` | `DUMP_RESULT` |
| Scan DP/APs/ROM tables | `/?auto=1&op=info` | `INFO_RESULT` |
| Serial echo (Thingy:91 UART) | `/?serialtest=<text>` | `SERIAL_RESULT` |

Verify a pattern out of band after the tab releases the probe, e.g. on the MCXA153:

```sh
probe-rs read --chip MCXA153 --protocol swd b8 0x1F000 32   # the first 21 bytes are the tag
```

### Debugger

| Page | URL (MCXA153; for the nRF9160 use `probe=j-link&chip=nRF9160_xxAA&elf=/firmware/nrf9160-debug.elf`) | Marker |
|---|---|---|
| Workbench | `/workbench/?fresh=1&auto=1&probe=mcu&chip=MCXA153&protocol=Swd&elf=/firmware/mcxa153-debug.elf&bp=40&bp2=43` | `WORKBENCH_RESULT` |
| Workbench, ESP32-S3 | `/workbench/?fresh=1&auto=1&probe=jtag&chip=esp32s3&protocol=Jtag&elf=/firmware/esp32s3-debug.elf&srcPath=bin/main.rs&bp=39&bp2=42` | `WORKBENCH_RESULT` |
| Workbench test runner | `…&tests=1` with a `*-tests.elf` | `WORKBENCH_RESULT` |
| Components | `/debug.html?auto=1&probe=mcu&chip=MCXA153&elf=/firmware/mcxa153-debug.elf&line=40&table=<TABLE address>&svd=/svd/cortex-m-scb.svd` | `DEBUGUI_RESULT` |
| SDK `Debugger` over WebUSB | `/debug.html?check=webusb-src&probe=mcu&chip=MCXA153&elf=/firmware/mcxa153-debug.elf&src=/@fs/<repo>/hardware-tests/firmware/cm33-debug/src/main.rs` | `SRC_RESULT` |
| Worker stack trace (raw calls) | `/debug.html?check=webusb&probe=mcu&chip=MCXA153&elf=/firmware/mcxa153-debug.elf` | `STACK_RESULT`, `VARS_RESULT` |
| Semihosting while debugging (nRF9160) | `/debug.html?check=webusb-semi&probe=j-link&chip=nRF9160_xxAA&elf=/firmware/nrf9160-semihosting.elf` | `SEMI_RESULT` |
| Binary RTT channel | `/debug.html?check=plot&probe=mcu&chip=MCXA153&elf=/firmware/mcxa153-debug.elf` | `PLOT_RESULT` |
| Monaco IDE (DAP) | `/monaco-ide/?auto=1&probe=mcu&chip=MCXA153&elf=/firmware/mcxa153-debug.elf` | `MONACO_IDE_RESULT` |

The workbench remembers the last protocol, so pass `protocol=` explicitly. `fresh=1` starts
from the default layout.

Not automated: the workbench's ELF watch (pick the ELF with **ELF…**, rebuild, and the
workbench re-flashes and restarts debugging) and **Reopen** after a reload, which need a real
file pick.

## Node checks

The scripts in `examples/node-ci` drive `probe-rs serve` from Node (`node <script>.ts …`).
Each prints PASS/FAIL per check and exits non-zero on failure. `--url` (default
`ws://127.0.0.1:3000`) and `--token` (default `$PROBE_RS_TOKEN`, else `probe-web`) apply to
all. Paths are relative to `examples/node-ci`.

| Script | MCXA153 | nRF9160 | ESP32-S3 |
|---|---|---|---|
| `run.ts`: flash, verify, monitor until exit | — | `--elf …/nrf9160-semihosting.elf --chip nRF9160_xxAA --expect "exiting with success"` | — |
| `debug.ts`: the SDK `Debugger` (Cortex-M) | `--elf ../../apps/flash/public/firmware/mcxa153-debug.elf --chip MCXA153 --probe mcu-link` | `--elf …/nrf9160-debug.elf --chip nRF9160_xxAA --probe j-link` | — |
| `dap.ts`: `@probe-web/dap` | `--elf …/mcxa153-debug.elf --chip MCXA153 --probe mcu-link` | `--elf …/nrf9160-debug.elf --chip nRF9160_xxAA --probe j-link` | `--elf …/esp32s3-debug.elf --chip esp32s3 --probe jtag --protocol Jtag --srcPath bin/main.rs --firmwareSrc ../../hardware-tests/firmware/esp32s3-debug/src/bin/main.rs --noDisassembly` |
| `debug-basic.ts`: run control without an ELF | `--chip MCXA153 --probe mcu-link` | `--chip nRF9160_xxAA --probe j-link` | `--chip esp32s3 --protocol Jtag --probe jtag` |
| `robustness.ts`: bad requests come back as errors | any | any | `--chip esp32s3 --protocol Jtag --probe jtag` |
| `semihosting.ts`: `--mode debugger` or `--mode monitor` | — | defaults | — |
| `rtt-scan-pacing.ts`: RTT scans with no control block; run serve with `--log-file` and count `control block not found` | — | — | `--chip esp32s3 --protocol Jtag --probe jtag --size 0x400 --seconds 8` |

`probe-rs serve` has no Xtensa disassembler, hence `--noDisassembly` on the ESP32-S3.

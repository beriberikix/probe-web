# Hardware tests

Manual/automated end-to-end runs against real boards. All results are logged in
`../spikes/README.md` (Phase 1 log) until a proper harness exists.

## Setup

```sh
./scripts/build-wasm.sh                              # wasm crates → packages/client
(cd spikes/rpc-ws/serve && probe-rs serve)           # remote transport; user `spike`, token `spike`
(cd apps/flash && npx vite --port 5173)              # the flasher
```

`probe-rs serve` must be built from the `wasm-rpc-client` worktree (it sends
the auth challenge as a frame and survives clients disconnecting mid-monitor).

## Runs

Manifests: `flash-manifest.json` (MCXA153 pattern), `rtt-manifest.json` (MCXA153 defmt-RTT firmware), `esp-manifest.json` (ESP32-S3, spare region 0x7F0000, esptool readback), `nrf-manifest.json` (nRF9160, 0xF0000), `nrf-rtt-manifest.json` (nRF9160 RTT echo firmware; add `&monitor=6&send=hello` to test the down channel). Add `&manifest=/<name>.json`, `&op=verify|erase|cycle` (default flash), and, with several probes attached, `&probe=<substring>`. Hardware-free: `npm run test:e2e` runs the fake-probe suite under Playwright.

### FRDM-MCXA153, MCU-Link CMSIS-DAP v2

| What | URL |
|---|---|
| Flash 4 KiB pattern, WebSocket | `http://127.0.0.1:5173/?auto=1&transport=websocket&token=spike&tag=<unique>` |
| Flash, WebUSB (grant the device once via *Authorize device…*) | `http://127.0.0.1:5173/?auto=1&transport=webusb&tag=<unique>` |
| defmt-RTT firmware + 4 s monitor | `…&manifest=/rtt-manifest.json&monitor=4` |

Verify a pattern flash out-of-band after the tab releases the probe:

```sh
probe-rs read --chip MCXA153 --protocol swd b8 0x1F000 32   # first 21 bytes = the tag
```

Rebuild the test firmware (`firmware/mcxa153-rtt`, defmt-RTT; `firmware/nrf9160-rtt-echo`, rtt-target with a down channel): `cargo build --release` in the firmware directory, then copy the ELF to `apps/flash/public/firmware/<name>.elf` (ELFs are gitignored).

## Debugging (Phase 3)

Debugging needs the WebSocket transport: `probe-rs serve` from the `wasm-rpc-client`
worktree (`~/code/probers-wasm/prs-wasm-rpc`, `cargo build -p probe-rs-tools --bin probe-rs`),
started from `spikes/rpc-ws/serve` (token `spike`). The WebUSB worker has no debug endpoints;
`session.debugger()` refuses with `kind: 'unsupported'` there.

### Debug-target firmware

Both firmwares run the same program, so every check can expect exact values: `main` calls
`step_a(n)` → `step_b(point, mode)` about twice a second, with locals `point = {n, 2n}` and
`mode`, statics `COUNTER` (u32, incremented in `step_b`) and `TABLE` (`[u16; 4] = 0x1111…0x4444`),
and RTT output `n=… result=…`. Release builds use `opt-level = 1` and full DWARF, so lines and
locals stay meaningful. ELFs are gitignored; copy them into `apps/flash/public/firmware/`.

| Firmware | Boards | Build | Copy to |
|---|---|---|---|
| `firmware/cm33-debug` | FRDM-MCXA153, Thingy:91 (nRF9160) | `CARGO_TARGET_DIR=target/mcxa153 cargo build --release --features mcxa153` (or `nrf9160`) | `target/<board>/thumbv8m.main-none-eabi/release/cm33-debug` → `mcxa153-debug.elf` / `nrf9160-debug.elf` |
| `firmware/esp32s3-debug` | ESP32-S3 (built-in USB-JTAG) | `. ~/export-esp.sh && cargo build --release` | `target/xtensa-esp32s3-none-elf/release/esp32s3-debug` → `esp32s3-debug.elf` |

`cm33-debug` needs the `thumbv8m.main-none-eabi` target (`rustup target add thumbv8m.main-none-eabi`);
the separate target directories keep the two memory layouts from overwriting each other.
The sources' line numbers are used by the checks: `src/main.rs:40` (`cm33-debug`) and
`src/bin/main.rs:39` (`esp32s3-debug`) are the first statement in `step_b`.

**Xtensa toolchain for `esp32s3-debug`:** `cargo install espup && espup install --targets esp32s3`
installs the `esp` Rust toolchain (the crate's `rust-toolchain.toml` selects it) and writes
`~/export-esp.sh` (sets `LIBCLANG_PATH` and the Xtensa GCC path; source it in each shell).
The crate was scaffolded with `esp-generate --chip esp32s3 --headless -o probe-rs -o panic-rtt-target`
(esp-hal 1.1, esp-bootloader-esp-idf). ESP32 images flash in the IDF format, which the
tools pick with `format: 'target'`.

A Cortex-M SVD for the Peripherals checks: `svd/cortex-m-scb.svd` (also served at `/svd/cortex-m-scb.svd`).

### Checks

Node scripts (in `examples/node-ci`, run with `node <script>.ts …`; each prints PASS/FAIL per check and exits non-zero on failure):

| Check | MCXA153 (MCU-Link) | nRF9160 (J-Link) | ESP32-S3 (USB-JTAG) |
|---|---|---|---|
| `debug.ts` — the SDK `Debugger`: run control, registers, memory, breakpoints, stepping, stack, variables, SVD (41 checks, Cortex-M only) | `--elf ../../apps/flash/public/firmware/mcxa153-debug.elf --chip MCXA153 --probe mcu-link [--svd ../../hardware-tests/svd/cortex-m-scb.svd]` | `--elf …/nrf9160-debug.elf --chip nRF9160_xxAA --probe j-link` | — |
| `dap.ts` — `@probe-web/dap` through DAP messages only (13 checks, incl. RTT output events) | `--elf …/mcxa153-debug.elf --chip MCXA153 --probe mcu-link` | `--elf …/nrf9160-debug.elf --chip nRF9160_xxAA --probe j-link` | `--elf …/esp32s3-debug.elf --chip esp32s3 --probe jtag --protocol Jtag --srcPath bin/main.rs --firmwareSrc ../../hardware-tests/firmware/esp32s3-debug/src/bin/main.rs --noDisassembly` |
| `debug-basic.ts` — run control without an ELF (any firmware) | `--chip MCXA153 --probe mcu-link` | `--chip nRF9160_xxAA --probe j-link` | `--chip esp32s3 --protocol Jtag --probe jtag` |
| `robustness.ts` — serve answers errors (bad core index) and keeps the connection | any | any | `--chip esp32s3 --protocol Jtag --probe jtag` |
| `semihosting.ts` — firmware `nrf9160-semihosting.elf`: `--mode debugger` (the `Debugger` services semihosting halts while debugging), `--mode monitor [--scan ram\|none]` (monitor with an RTT client scanning all RAM) | — | defaults (`--chip nRF9160_xxAA --probe j-link`) | — |
| `rtt-scan-pacing.ts` — monitor with an RTT scan region that holds no control block; start serve with `--log-file` and count `control block not found` lines | — | — | `--chip esp32s3 --protocol Jtag --probe jtag --size 0x400 --seconds 8` |

`--url` (default `ws://127.0.0.1:3000`) and `--token` (default `spike`) apply to all. Disassembly is not implemented by `probe-rs serve` for Xtensa, hence `--noDisassembly`.

Browser checks (vite on 5173; open in Chrome, results in the page log / `window.*Result`):

| Page | URL (MCXA153; swap `probe`, `chip`, `elf` for the other boards) | Result marker |
|---|---|---|
| Workbench (nRF9160: `probe=j-link&chip=nRF9160_xxAA&elf=/firmware/nrf9160-debug.elf`) | `/workbench/?fresh=1&auto=1&token=spike&probe=mcu&chip=MCXA153&protocol=Swd&elf=/firmware/mcxa153-debug.elf&bp=40&bp2=43` (the workbench remembers the last protocol, so pass it) | `WORKBENCH_RESULT`, `window.workbenchResult` (11 checks) |
| Workbench, ESP32-S3 | `/workbench/?fresh=1&auto=1&token=spike&probe=jtag&chip=esp32s3&protocol=Jtag&elf=/firmware/esp32s3-debug.elf&srcPath=bin/main.rs&bp=39&bp2=42` | same |
| Components page (Cortex-M) | `/debug.html?auto=1&token=spike&probe=mcu&chip=MCXA153&elf=/firmware/mcxa153-debug.elf&line=40&table=<TABLE address>&svd=/svd/cortex-m-scb.svd` | `DEBUGUI_RESULT` |
| Monaco IDE example | `/monaco-ide/?auto=1&token=spike&probe=mcu&chip=MCXA153&elf=/firmware/mcxa153-debug.elf` | `MONACO_IDE_RESULT` |

Hardware-free: `npx vitest run` (SDK `Debugger`, DAP adapter, helpers) and `npx playwright test`
(components, workbench and IDE against `FakeDebugger` from `@probe-web/client/testing`).

Not automated: the workbench's ELF watch (pick the ELF with **ELF…**, rebuild the firmware, the
workbench re-flashes and restarts debugging) and **Reopen** after a reload need a real file pick.

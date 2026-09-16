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

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

## Runs (FRDM-MCXA153, MCU-Link CMSIS-DAP v2)

| What | URL |
|---|---|
| Flash 4 KiB pattern, WebSocket | `http://127.0.0.1:5173/?auto=1&transport=websocket&token=spike&tag=<unique>` |
| Flash, WebUSB (grant the device once via *Authorize device…*) | `http://127.0.0.1:5173/?auto=1&transport=webusb&tag=<unique>` |
| defmt-RTT firmware + 4 s monitor | `…&manifest=/rtt-manifest.json&monitor=4` |

Verify a pattern flash out-of-band after the tab releases the probe:

```sh
probe-rs read --chip MCXA153 --protocol swd b8 0x1F000 32   # first 21 bytes = the tag
```

Rebuild the RTT firmware: `cd firmware/mcxa153-rtt && cargo build --release`
and copy the ELF to `apps/flash/public/firmware/mcxa153-rtt.elf`.

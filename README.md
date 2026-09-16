# probe-web

Composable browser libraries for flashing and debugging embedded targets with
[probe-rs](https://probe.rs). One client API, two transports: a WebSocket
client to a native `probe-rs serve`, and probe-rs itself compiled to wasm in a
Web Worker over WebUSB.

Status: Phase 0 spikes. See `spikes/`.

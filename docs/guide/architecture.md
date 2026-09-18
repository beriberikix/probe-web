# Architecture

probe-web does not reimplement probe-rs. It runs probe-rs itself, either in the browser or
as a native server, and talks to it over probe-rs's own RPC protocol. The browser side is a
thin client on top.

```
 your page ─ @probe-web/ui components ─┐
            @probe-web/dap adapter ────┤
                                       ▼
                         @probe-web/client  (TypeScript SDK)
                                       │
                         probe-web-core (wasm): probe-rs RPC client, defmt decoder
                         ┌─────────────┴──────────────┐
                 postMessage                       WebSocket
                         │                            │
     Web Worker: probe-web-local (wasm)        probe-rs serve (native)
     probe-rs + nusb over WebUSB               probe-rs + native USB
                         │                            │
                     debug probe                  debug probe
```

## The pieces

| | What it is |
|---|---|
| `@probe-web/client` | The TypeScript SDK: `Client`, `Session`, `Core`, `Debugger`. Wraps the wasm client with typed, promise-based calls. |
| `crates/probe-web-core` | probe-rs's unmodified `probe-rs-rpc-client`, compiled to wasm, plus defmt decoding, ELF symbol lookup and the coredump encoder. It runs on the page's thread (or in Node). |
| `crates/probe-web-local` | probe-rs compiled to wasm, running in a dedicated Web Worker and serving the same RPC protocol over `postMessage`. USB goes through [nusb](https://github.com/kevinmehall/nusb)'s WebUSB backend. |
| `crates/probe-web-targets` | CMSIS-Pack and `.FLM` parsing, compiled to a separate wasm module that loads only when a user imports a pack. |
| `tools/wire-gen` | Generates `packages/client/src/wire.ts` from probe-rs-rpc's schema. |

Because the WebUSB worker and `probe-rs serve` speak the same protocol, one client serves
both transports, and a fix in the SDK applies to both.

## The wire contract

probe-rs's RPC messages are Rust types serialized with postcard. The client deserializes
them in wasm and hands them to JavaScript through serde-wasm-bindgen with fixed settings:

- enums are externally tagged: a unit variant is a string (`"Ok"`), others are an object
  with one key (`{ Halted: … }`);
- 64-bit integers are `bigint`, so addresses never lose precision;
- `None` and unit are `null`;
- `Vec<u8>` is a plain `number[]` (the SDK converts to `Uint8Array` where it matters).

`wire.ts` describes those values. It is generated from the same postcard-schema model the
wire uses, so the TypeScript types cannot drift from probe-rs. CI regenerates it and fails
if the committed file differs. Most code uses the SDK's own types; `Wire.*` types appear
where the SDK passes probe-rs values through, such as probe entries, progress events and
boot info.

## Capability negotiation

The client reads the server's schema report on connect and compares it with its own. A
server may implement a subset: the WebUSB worker leaves out disassembly, for example.
The client records what is missing instead of refusing to connect, and fails only if an
endpoint both sides have disagrees in its types. `client.supports(path)` exposes the
result.

## The worker

The worker hosts probe-rs's async core. In the browser it cannot block: every USB transfer
is awaited, and timing uses browser timers, not threads. That shapes a few behaviours:

- **Crashes are contained.** A panic inside the worker posts a `fatal:` message before the
  worker dies. The transport then rejects every pending and later call with
  `kind: 'worker-crashed'`, rather than leaving promises hanging.
- **Recovery on attach.** A page that goes away mid-command can leave a probe in the
  middle of a transfer. The worker's attach reopens the probe and retries once, and
  CMSIS-DAP probes are resynchronized and health-checked when opened.
- **RTT scans are targeted.** Scanning all of RAM for the RTT control block over WebUSB
  takes hundreds of milliseconds. The SDK reads the `_SEGGER_RTT` address from the ELF
  when it has one, and the worker remembers where it found the block.

## The probe-rs forks

probe-rs upstream is synchronous and does not build for wasm. probe-web builds on two
branches of [beriberikix/probe-rs](https://github.com/beriberikix/probe-rs), which Cargo
fetches as git dependencies (`Cargo.lock` pins the commits):

| Branch | Used by | What it changes |
|---|---|---|
| `webusb/nusb-0.2.7` | `probe-web-local`, `probe-web-targets` | An async port of probe-rs and probe-rs-debug on nusb, with a WebUSB backend. |
| `wasm-rpc-client` | `probe-web-core`, `tools/wire-gen`, `probe-rs serve` | probe-rs-rpc and its client building for wasm32; `serve` accepting browser WebSocket clients and surviving clients that disconnect mid-operation. |

A third fork, of [cmsis-pack-manager](https://github.com/beriberikix/cmsis-pack-manager)
(`wasm/optional-network`), makes its `.pdsc` parser build without networking.

The intent is to follow upstream as the async work lands there. To build against local
checkouts of the forks, uncomment the `paths` override in `.cargo/config.toml`.

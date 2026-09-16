#!/bin/sh
# Build the spike for wasm32 and emit a web-target bundle into www/pkg.
set -e
cd "$(dirname "$0")"
cargo build --target wasm32-unknown-unknown --release -p spike-rpc-ws
wasm-bindgen --target web --out-dir www/pkg --out-name spike_rpc_ws \
  ../../target/wasm32-unknown-unknown/release/spike_rpc_ws.wasm
ls -la www/pkg/*.wasm

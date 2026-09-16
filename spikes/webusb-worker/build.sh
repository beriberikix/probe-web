#!/bin/sh
set -e
cd "$(dirname "$0")"
cargo build --target wasm32-unknown-unknown --release -p spike-webusb-worker
wasm-bindgen --target web --out-dir www/pkg --out-name spike_webusb_worker \
  ../../target/wasm32-unknown-unknown/release/spike_webusb_worker.wasm
ls -la www/pkg/*.wasm

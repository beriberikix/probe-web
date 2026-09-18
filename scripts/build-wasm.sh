#!/bin/sh
# Build the three wasm crates and bindgen them into @probe-web/client, and
# regenerate the wire types from the RPC schema.
set -e
cd "$(dirname "$0")/.."
cargo build --release --target wasm32-unknown-unknown -p probe-web-core -p probe-web-local -p probe-web-targets
wasm-bindgen --target web --out-dir packages/client/wasm --out-name probe_web_core \
  target/wasm32-unknown-unknown/release/probe_web_core.wasm
wasm-bindgen --target web --out-dir packages/client/worker --out-name probe_web_local \
  target/wasm32-unknown-unknown/release/probe_web_local.wasm
# Pack/FLM import. Its own bundle because only the target picker ever loads it, and
# only once a user actually picks a .pack -- see @probe-web/client/targets.
wasm-bindgen --target web --out-dir packages/client/targets --out-name probe_web_targets \
  target/wasm32-unknown-unknown/release/probe_web_targets.wasm
# Test-only worker with a fake probe (no hardware needed).
cargo build --release --target wasm32-unknown-unknown -p probe-web-local --features fake --target-dir target/fake
wasm-bindgen --target web --out-dir packages/client/worker/fake --out-name probe_web_local \
  target/fake/wasm32-unknown-unknown/release/probe_web_local.wasm
cp packages/client/worker/local-worker.js packages/client/worker/fake/local-worker.js
cargo run -q -p probe-web-wire-gen > packages/client/src/wire.ts
ls -la packages/client/wasm/*.wasm packages/client/worker/*.wasm packages/client/targets/*.wasm

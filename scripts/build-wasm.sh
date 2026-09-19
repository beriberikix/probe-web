#!/bin/sh
# Build the three wasm crates and bindgen them into @probe-web/client, and
# regenerate the wire types from the RPC schema.
#
# Each module ships without its function names (a quarter to two fifths of the file); a copy
# with them is kept in target/wasm-symbols/ to look up a `wasm-function[N]` from a stack
# trace (see CONTRIBUTING.md). wasm-opt is deliberately not run: measured on these modules it
# trims the raw size by about 5% but makes the compressed download larger, and flashing and
# compile times did not change.
set -e
cd "$(dirname "$0")/.."
mkdir -p target/wasm-symbols

cargo build --release --target wasm32-unknown-unknown -p probe-web-core -p probe-web-local -p probe-web-targets
wasm-bindgen --target web --out-dir packages/client/wasm --out-name probe_web_core \
  target/wasm32-unknown-unknown/release/probe_web_core.wasm
node scripts/wasm-names.mjs strip packages/client/wasm/probe_web_core_bg.wasm target/wasm-symbols/probe_web_core.wasm
wasm-bindgen --target web --out-dir packages/client/worker --out-name probe_web_local \
  target/wasm32-unknown-unknown/release/probe_web_local.wasm
node scripts/wasm-names.mjs strip packages/client/worker/probe_web_local_bg.wasm target/wasm-symbols/probe_web_local.wasm
# Pack/FLM import. Its own bundle because only the target picker ever loads it, and
# only once a user actually picks a .pack -- see @probe-web/client/targets.
wasm-bindgen --target web --out-dir packages/client/targets --out-name probe_web_targets \
  target/wasm32-unknown-unknown/release/probe_web_targets.wasm
node scripts/wasm-names.mjs strip packages/client/targets/probe_web_targets_bg.wasm target/wasm-symbols/probe_web_targets.wasm
# Test-only worker with a fake probe (no hardware needed). Stripped like the real one, so the
# browser tests run what the site ships.
cargo build --release --target wasm32-unknown-unknown -p probe-web-local --features fake --target-dir target/fake
wasm-bindgen --target web --out-dir packages/client/worker/fake --out-name probe_web_local \
  target/fake/wasm32-unknown-unknown/release/probe_web_local.wasm
node scripts/wasm-names.mjs strip packages/client/worker/fake/probe_web_local_bg.wasm target/wasm-symbols/probe_web_local_fake.wasm
cp packages/client/worker/local-worker.js packages/client/worker/fake/local-worker.js
cargo run -q -p probe-web-wire-gen > packages/client/src/wire.ts
ls -la packages/client/wasm/*.wasm packages/client/worker/*.wasm packages/client/targets/*.wasm

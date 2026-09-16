#!/bin/sh
# Decode the QEMU fixture natively and in wasm (Node), diff the outputs.
set -e
cd "$(dirname "$0")"
ELF=../defmt-fixture/target/thumbv7m-none-eabi/release/defmt-fixture
BIN=../defmt-fixture/frames.bin
cargo build -q --release -p spike-defmt-wasm --target wasm32-unknown-unknown
wasm-bindgen --target nodejs --out-dir pkg --out-name spike_defmt_wasm ../../target/wasm32-unknown-unknown/release/spike_defmt_wasm.wasm
cargo run -q --release -p spike-defmt-wasm --bin defmt-native -- $ELF $BIN > native.txt
node -e '
const fs = require("fs"); const m = require("./pkg/spike_defmt_wasm.js");
const elf = fs.readFileSync(process.argv[1]); const bin = fs.readFileSync(process.argv[2]);
const t0 = performance.now(); const out = m.decode(elf, bin);
process.stdout.write(out); process.stderr.write("wasm decode " + (performance.now()-t0).toFixed(1) + "ms\n");
' $ELF $BIN > wasm.txt
echo "--- native"; cat native.txt; echo "--- diff native vs wasm"; diff native.txt wasm.txt && echo "IDENTICAL" && echo "SPIKE_E_RESULT=PASS"

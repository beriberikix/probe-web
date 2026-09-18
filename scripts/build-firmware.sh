#!/bin/sh
# Build the demo firmware into apps/flash/public/firmware/, so the deployed site can flash and
# debug a board without the visitor supplying an ELF. The images are the same ones the hardware
# checks use (hardware-tests/README.md describes what they do).
#
#   ./scripts/build-firmware.sh            Cortex-M images only
#   ./scripts/build-firmware.sh --esp32s3  also the ESP32-S3 image (needs the Xtensa toolchain)
#
# ELFs are gitignored; this is what CI runs before building the site.
set -e
cd "$(dirname "$0")/.."
root=$(pwd)
out=$root/apps/flash/public/firmware
mkdir -p "$out" "$out/src"

# Build one firmware crate with its paths remapped:
#   - its own sources to /probe-web-firmware/<crate>, where the workbench looks for the sources
#     shipped alongside the images;
#   - the registry and the sysroot, whose paths would otherwise carry the build machine's home
#     directory into a published binary.
#
# RUSTFLAGS *replaces* a crate's configured rustflags rather than adding to them, and those carry
# the linker scripts (-Tlink.x, -Tdefmt.x) — so read them out of the crate's own config and pass
# them along. Without that the image links against a default layout and comes out empty.
build_firmware() {  # <crate> [extra cargo args…]
  crate=$1
  shift
  configured=$(cd "hardware-tests/firmware/$crate" && python3 - <<'PY'
import pathlib, shlex, tomllib
config = pathlib.Path('.cargo/config.toml')
data = tomllib.loads(config.read_text()) if config.exists() else {}
target = data.get('build', {}).get('target')
# A target name contains dots, so TOML nests it: [target.thumbv8m.main-none-eabi] is
# target -> thumbv8m -> main-none-eabi.
node = data.get('target', {})
for part in (target or '').split('.'):
    node = node.get(part, {}) if isinstance(node, dict) else {}
print(shlex.join(node.get('rustflags', [])))
PY
)
  RUSTFLAGS="$configured \
    --remap-path-prefix=$root/hardware-tests/firmware/$crate=/probe-web-firmware/$crate \
    --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo \
    --remap-path-prefix=$(rustc --print sysroot)=/rust" \
    sh -c "cd '$root/hardware-tests/firmware/$crate' && cargo build --release $*"
}

# Cortex-M33 (FRDM-MCXA153 and Thingy:91/nRF9160): one crate, one memory layout per feature,
# built into separate target directories so the layouts do not overwrite each other.
rustup target add thumbv8m.main-none-eabi
for board in mcxa153 nrf9160; do
  build_firmware cm33-debug --features "$board" --target-dir "target/$board"
  cp "hardware-tests/firmware/cm33-debug/target/$board/thumbv8m.main-none-eabi/release/cm33-debug" \
    "$out/$board-debug.elf"
done

# The embedded-test suite, for the test runner. It is a `cargo test` binary, not a normal
# one, so it lands in deps/ under a hashed name -- take the newest and drop the .d file.
for board in mcxa153 nrf9160; do
  build_firmware cm33-tests --features "$board" --target-dir "target/$board" --tests
  suite=$(ls -t "hardware-tests/firmware/cm33-tests/target/$board/thumbv8m.main-none-eabi/release/deps/suite-"* \
    | grep -v '\.d$' | head -1)
  cp "$suite" "$out/$board-tests.elf"
done

# The RTT, semihosting and UART-echo images the other demo manifests point at.
for fw in mcxa153-rtt nrf9160-rtt-echo nrf9160-semihosting nrf9160-uart-echo; do
  build_firmware "$fw"
  cp "hardware-tests/firmware/$fw/target/thumbv8m.main-none-eabi/release/$fw" "$out/$fw.elf"
done

# Xtensa needs the esp toolchain (espup), so it is opt-in.
if [ "$1" = "--esp32s3" ]; then
  build_firmware esp32s3-debug
  cp hardware-tests/firmware/esp32s3-debug/target/xtensa-esp32s3-none-elf/release/esp32s3-debug \
    "$out/esp32s3-debug.elf"
fi

# The sources those remapped DWARF paths name, so the deployed workbench can show code.
for crate in cm33-debug cm33-tests esp32s3-debug mcxa153-rtt nrf9160-rtt-echo nrf9160-semihosting nrf9160-uart-echo; do
  for dir in src tests; do
    [ -d "hardware-tests/firmware/$crate/$dir" ] || continue
    mkdir -p "$out/src/$crate"
    cp -R "hardware-tests/firmware/$crate/$dir" "$out/src/$crate/"
  done
done

ls -la "$out"

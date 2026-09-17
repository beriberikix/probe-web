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
out=$(pwd)/apps/flash/public/firmware
mkdir -p "$out"

# Cortex-M33 (FRDM-MCXA153 and Thingy:91/nRF9160): one crate, one memory layout per feature,
# built into separate target directories so the layouts do not overwrite each other.
rustup target add thumbv8m.main-none-eabi
for board in mcxa153 nrf9160; do
  (cd hardware-tests/firmware/cm33-debug &&
    CARGO_TARGET_DIR="target/$board" cargo build --release --features "$board")
  cp "hardware-tests/firmware/cm33-debug/target/$board/thumbv8m.main-none-eabi/release/cm33-debug" \
    "$out/$board-debug.elf"
done

# The RTT, semihosting and UART-echo images the other demo manifests point at.
for fw in mcxa153-rtt nrf9160-rtt-echo nrf9160-semihosting nrf9160-uart-echo; do
  (cd "hardware-tests/firmware/$fw" && cargo build --release)
  cp "hardware-tests/firmware/$fw/target/thumbv8m.main-none-eabi/release/$fw" "$out/$fw.elf"
done

# Xtensa needs the esp toolchain (espup), so it is opt-in.
if [ "$1" = "--esp32s3" ]; then
  (cd hardware-tests/firmware/esp32s3-debug && cargo build --release)
  cp hardware-tests/firmware/esp32s3-debug/target/xtensa-esp32s3-none-elf/release/esp32s3-debug \
    "$out/esp32s3-debug.elf"
fi

ls -la "$out"

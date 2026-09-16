//! Emits a small, varied defmt stream over semihosting under QEMU so the
//! decoder can be checked in wasm against the native decoder on identical
//! input. Exits QEMU when done.
#![no_std]
#![no_main]

use cortex_m_rt::entry;
use cortex_m_semihosting::debug;
use defmt_semihosting as _;
use panic_probe as _;

#[derive(defmt::Format)]
struct Point {
    x: i32,
    y: i32,
}

#[entry]
fn main() -> ! {
    defmt::info!("hello from qemu {}", 42u32);
    let bytes = [1u8, 2, 3, 250];
    defmt::warn!("bytes={:?} f={} s={}", bytes, 1.5f32, "str");
    defmt::debug!("point {:?} big={:#x}", Point { x: -7, y: 9 }, 0xDEAD_BEEF_u64);
    defmt::trace!("neg={} bool={}", -1i16, true);
    defmt::error!("done");
    debug::exit(debug::EXIT_SUCCESS);
    loop {}
}

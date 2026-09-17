//! Test firmware: logs a counter over defmt-RTT so the browser RTT terminal
//! (and its in-browser defmt decoding) can be verified on real hardware.
#![no_std]
#![no_main]

use cortex_m_rt::entry;
use defmt_rtt as _;
use panic_probe as _;

#[entry]
fn main() -> ! {
    defmt::info!("mcxa153-rtt: hello from the FRDM-MCXA153");
    let mut n: u32 = 0;
    loop {
        defmt::info!("tick {} ({:#x})", n, n * 0x1111);
        if n % 5 == 4 {
            defmt::warn!("five more ticks");
        }
        n = n.wrapping_add(1);
        // ~0.25 s at the 12 MHz FRO reset clock (no clock setup on purpose).
        cortex_m::asm::delay(3_000_000);
    }
}

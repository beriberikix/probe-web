//! Semihosting test firmware: prints a few lines on the host's stdout and
//! stderr through the debugger, then exits via SYS_EXIT. The monitor loop
//! must service each semihosting breakpoint and report the exit.
#![no_std]
#![no_main]

use cortex_m_rt::entry;
use cortex_m_semihosting::{debug, heprintln, hprintln};
use panic_halt as _;

#[entry]
fn main() -> ! {
    hprintln!("nrf9160-semihosting: hello over semihosting");
    for i in 0..3 {
        hprintln!("stdout line {}", i);
        cortex_m::asm::delay(3_200_000);
    }
    heprintln!("stderr line");
    hprintln!("exiting with success");
    debug::exit(debug::EXIT_SUCCESS);
    loop {}
}

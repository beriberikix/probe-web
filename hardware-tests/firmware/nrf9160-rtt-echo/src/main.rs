//! RTT echo test firmware: a String up channel that prints a tick every
//! second and echoes, uppercased, every line received on down channel 0.
//! Exercises the browser RTT terminal's input path end to end.
#![no_std]
#![no_main]

use core::fmt::Write;
use cortex_m_rt::entry;
use panic_halt as _;
use rtt_target::rtt_init;

#[entry]
fn main() -> ! {
    let channels = rtt_init! {
        up: { 0: { size: 1024, name: "Terminal" } }
        down: { 0: { size: 64, name: "Terminal" } }
    };
    let mut up = channels.up.0;
    let mut down = channels.down.0;
    writeln!(up, "nrf9160-rtt-echo: type a line, it comes back uppercased").ok();

    let mut line = [0u8; 64];
    let mut len = 0usize;
    let mut buf = [0u8; 16];
    let mut n: u32 = 0;
    let mut slices: u32 = 0;
    loop {
        // Poll the down channel every ~10 ms (64 MHz after reset).
        let got = down.read(&mut buf);
        for &b in &buf[..got] {
            if b == b'\n' || b == b'\r' {
                if len > 0 {
                    for c in line[..len].iter_mut() {
                        *c = c.to_ascii_uppercase();
                    }
                    write!(up, "echo: ").ok();
                    up.write_str(core::str::from_utf8(&line[..len]).unwrap_or("?")).ok();
                    writeln!(up).ok();
                    len = 0;
                }
            } else if len < line.len() {
                line[len] = b;
                len += 1;
            }
        }
        slices += 1;
        if slices == 100 {
            slices = 0;
            writeln!(up, "tick {n}").ok();
            n = n.wrapping_add(1);
        }
        cortex_m::asm::delay(640_000);
    }
}

//! Debug-target firmware for the debugger checks (breakpoints, stepping, variables).
//!
//! The call chain `main → step_a → step_b` runs once per loop iteration, so a
//! breakpoint in `step_b` stops with a three-frame stack. Values are exact:
//! on the n-th call (n starting at 1)
//!   step_a: n, point = Point { x: n, y: 2n }, mode = Idle if n % 3 == 0 else Counting(n)
//!   step_b: sum = 3n, scaled = 9n, COUNTER == n after its increment,
//!           returns 9n + (0 for Idle, n for Counting(n))
//! Statics: COUNTER (u32, mutable), TABLE ([u16; 4] = 0x1111..0x4444), GREETING (&str).
#![no_std]
#![no_main]

use core::fmt::Write;
use core::hint::black_box;
use cortex_m_rt::entry;
use panic_halt as _;
use rtt_target::rtt_init;

#[derive(Clone, Copy, Debug)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug)]
pub enum Mode {
    Idle,
    Counting(u32),
}

#[no_mangle]
pub static mut COUNTER: u32 = 0;
#[no_mangle]
pub static TABLE: [u16; 4] = [0x1111, 0x2222, 0x3333, 0x4444];
pub static GREETING: &str = "probe-web debug target";

#[inline(never)]
#[no_mangle]
pub fn step_b(point: Point, mode: Mode) -> i32 {
    let sum = point.x + point.y;
    let scaled = sum.wrapping_mul(3);
    unsafe {
        COUNTER = COUNTER.wrapping_add(1);
    }
    let extra = match mode {
        Mode::Idle => 0,
        Mode::Counting(n) => n as i32,
    };
    black_box(scaled + extra)
}

#[inline(never)]
#[no_mangle]
pub fn step_a(n: u32) -> i32 {
    let point = Point { x: n as i32, y: 2 * n as i32 };
    let mode = if n % 3 == 0 { Mode::Idle } else { Mode::Counting(n) };
    let result = step_b(black_box(point), black_box(mode));
    black_box(result)
}

#[entry]
fn main() -> ! {
    let channels = rtt_init! {
        up: {
            0: { size: 512, name: "Terminal" }
            // A second, binary channel carrying one `u32` per iteration, little-endian,
            // so `<probe-rtt-plot>` has a real signal to draw. A triangle wave rather
            // than a counter: a wrong sample width or a dropped byte is obvious on a
            // shape that goes up and down, and invisible on one that only climbs.
            1: { size: 256, name: "Samples" }
        }
    };
    let mut up = channels.up.0;
    let mut samples = channels.up.1;
    writeln!(up, "{}: n, step_a(n) every ~0.5 s; TABLE[1] = {:#x}", black_box(GREETING), TABLE[1]).ok();
    let mut n: u32 = 0;
    loop {
        n = n.wrapping_add(1);
        let result = step_a(black_box(n));
        writeln!(up, "n={} result={}", n, result).ok();
        // 0, 1, … 7, 8, 7, … 1, 0, 1, … — period 16, amplitude 8. Short on purpose: a
        // check that only ever sees the rising edge cannot tell a triangle from a plain
        // counter, and the turn is what proves the samples are being framed correctly.
        let phase = n % 16;
        let wave: u32 = if phase <= 8 { phase } else { 16 - phase };
        samples.write(&wave.to_le_bytes());
        cortex_m::asm::delay(4_000_000);
    }
}

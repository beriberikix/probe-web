//! Debug-target firmware for the ESP32-S3 (Xtensa), the same program as `cm33-debug`:
//! `main → step_a(n) → step_b(point, mode)` once per ~0.5 s, with exact values
//! (on the n-th call: point = {n, 2n}, mode = Idle if n % 3 == 0 else Counting(n),
//! COUNTER == n after step_b's increment), statics COUNTER and TABLE, and RTT output.
#![no_std]
#![no_main]

use core::hint::black_box;
use esp_hal::{
    clock::CpuClock,
    main,
    time::{Duration, Instant},
};
use panic_rtt_target as _;
use rtt_target::rprintln;

esp_bootloader_esp_idf::esp_app_desc!();

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

#[unsafe(no_mangle)]
pub static mut COUNTER: u32 = 0;
#[unsafe(no_mangle)]
pub static TABLE: [u16; 4] = [0x1111, 0x2222, 0x3333, 0x4444];

#[inline(never)]
#[unsafe(no_mangle)]
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
#[unsafe(no_mangle)]
pub fn step_a(n: u32) -> i32 {
    let point = Point { x: n as i32, y: 2 * n as i32 };
    let mode = if n % 3 == 0 { Mode::Idle } else { Mode::Counting(n) };
    let result = step_b(black_box(point), black_box(mode));
    black_box(result)
}

#[main]
fn main() -> ! {
    rtt_target::rtt_init_print!();
    let _peripherals = esp_hal::init(esp_hal::Config::default().with_cpu_clock(CpuClock::max()));
    rprintln!("esp32s3-debug: n, step_a(n) every ~0.5 s; TABLE[1] = {:#x}", TABLE[1]);
    let mut n: u32 = 0;
    loop {
        n = n.wrapping_add(1);
        let result = step_a(black_box(n));
        rprintln!("n={} result={}", n, result);
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(500) {}
    }
}

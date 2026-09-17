//! UART test firmware for `<probe-serial-monitor>` on the Thingy:91: prints a
//! banner and a tick every ~2 s on UARTE0 (115200 8N1, P0.18 TX / P0.19 RX,
//! which the board controller exposes as the "Thingy_91 UART" USB CDC port),
//! and echoes each received line upper-cased. Raw register access, no HAL.
#![no_std]
#![no_main]

use core::ptr::{read_volatile, write_volatile};
use cortex_m_rt::entry;
use panic_halt as _;

const UARTE0: usize = 0x5000_8000; // secure alias
const TASKS_STARTRX: usize = 0x000;
const TASKS_STARTTX: usize = 0x008;
const EVENTS_ENDRX: usize = 0x110;
const EVENTS_ENDTX: usize = 0x120;
const ENABLE: usize = 0x500;
const PSEL_RTS: usize = 0x508;
const PSEL_TXD: usize = 0x50C;
const PSEL_CTS: usize = 0x510;
const PSEL_RXD: usize = 0x514;
const BAUDRATE: usize = 0x524;
const RXD_PTR: usize = 0x534;
const RXD_MAXCNT: usize = 0x538;
const TXD_PTR: usize = 0x544;
const TXD_MAXCNT: usize = 0x548;
const CONFIG: usize = 0x56C;

fn reg(off: usize) -> *mut u32 {
    (UARTE0 + off) as *mut u32
}
fn w(off: usize, v: u32) {
    unsafe { write_volatile(reg(off), v) }
}
fn r(off: usize) -> u32 {
    unsafe { read_volatile(reg(off)) }
}

/// EasyDMA needs the TX buffer in RAM, so copy through a static buffer.
static mut TX: [u8; 128] = [0; 128];
static mut RX: [u8; 1] = [0];

fn send(bytes: &[u8]) {
    for chunk in bytes.chunks(128) {
        let buf = &raw mut TX;
        unsafe { core::ptr::copy_nonoverlapping(chunk.as_ptr(), buf.cast::<u8>(), chunk.len()) };
        w(EVENTS_ENDTX, 0);
        w(TXD_PTR, buf as u32);
        w(TXD_MAXCNT, chunk.len() as u32);
        w(TASKS_STARTTX, 1);
        while r(EVENTS_ENDTX) == 0 {}
    }
}

fn start_rx() {
    w(EVENTS_ENDRX, 0);
    w(RXD_PTR, (&raw mut RX) as u32);
    w(RXD_MAXCNT, 1);
    w(TASKS_STARTRX, 1);
}

fn send_num(mut n: u32) {
    let mut digits = [0u8; 10];
    let mut i = digits.len();
    loop {
        i -= 1;
        digits[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    send(&digits[i..]);
}

#[entry]
fn main() -> ! {
    w(ENABLE, 0);
    w(PSEL_TXD, 18);
    w(PSEL_RXD, 19);
    w(PSEL_RTS, 0xFFFF_FFFF);
    w(PSEL_CTS, 0xFFFF_FFFF);
    w(BAUDRATE, 0x01D7_E000); // 115200
    w(CONFIG, 0); // no parity, no flow control
    w(ENABLE, 8);

    send(b"\r\nnrf9160-uart-echo: type a line\r\n");
    start_rx();

    let mut line = [0u8; 64];
    let mut len = 0usize;
    let mut tick = 0u32;
    let mut idle = 0u32;
    loop {
        if r(EVENTS_ENDRX) != 0 {
            let b = unsafe { read_volatile((&raw const RX).cast::<u8>()) };
            start_rx();
            match b {
                b'\r' | b'\n' => {
                    if len > 0 {
                        send(b"echo: ");
                        let mut up = line;
                        up[..len].make_ascii_uppercase();
                        send(&up[..len]);
                        send(b"\r\n");
                        len = 0;
                    }
                }
                _ if len < line.len() => {
                    line[len] = b;
                    len += 1;
                }
                _ => {}
            }
        }
        idle += 1;
        if idle >= 2_000_000 {
            idle = 0;
            send(b"tick ");
            send_num(tick);
            send(b"\r\n");
            tick += 1;
        }
    }
}

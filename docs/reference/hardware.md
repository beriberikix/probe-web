# Supported hardware

probe-web runs probe-rs, so in principle it supports the probes and chips probe-rs does.
In practice, what a browser can reach depends on the probe's USB interface, and the async
port that WebUSB needs has been verified on the boards below.

## Verified boards

Flashing, RTT and the debugger were verified on every board over both transports: WebUSB
in Chrome, and WebSocket to `probe-rs serve`. Pack import and embedded-test were verified
over WebUSB, and the MCXA153 test suite over WebSocket as well. Flashing was checked out of
band by reading the image back with native tools after the browser released the probe
(`probe-rs read`, or `esptool.py read-flash` for the ESP32-S3).

| Board | Probe | Core | Flash and verify | RTT and defmt | Debugger | Semihosting | Pack import | embedded-test |
|---|---|---|---|---|---|---|---|---|
| NXP FRDM-MCXA153 | MCU-Link (CMSIS-DAP v2), SWD | Cortex-M33 | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| Nordic Thingy:91 (nRF9160) | J-Link, SWD | Cortex-M33 | ✓ | ✓ (with down channel) | ✓ | ✓ | ✓ | ✓ |
| Espressif ESP32-S3-DevKitC | Built-in USB-JTAG, JTAG | Xtensa LX7 ×2 | ✓ | ✓ | ✓ (no disassembly) | — | n/a | — |

— means not tested on that board; n/a means it does not apply (Espressif does not
publish CMSIS packs).

What "Debugger ✓" covers: source breakpoints, stepping over, into and out of functions,
stack traces, scopes, variables, `evaluate` and `setVariable`, registers, memory, RTT
while debugging, the debugger components, the workbench and the DAP adapter.

Flash times for a 4 KiB image with verify, as a rough guide:

| Board | WebUSB | `probe-rs serve` |
|---|---|---|
| FRDM-MCXA153 | 1.25 s | 1.99 s |
| Thingy:91 | 1.24 s | 1.28 s |
| ESP32-S3 | 0.71 s | 1.69 s |

WebUSB is no slower than native USB here. The worker skips a network hop, and USB transfer
overhead in Chrome is small (about 15 % above native, measured per transfer).

## Probes

| Probe family | WebUSB | Notes |
|---|---|---|
| CMSIS-DAP v2 (MCU-Link, DAPLink, Pico probe, …) | ✓ | Verified. Detected by USB interface, so any vendor ID works. |
| SEGGER J-Link | ✓ | Verified. |
| Espressif USB-JTAG (ESP32-S3, C3, C6, …) | ✓ | Verified on the ESP32-S3. |
| CMSIS-DAP v1 (HID-only) | ✗ | WebUSB cannot claim HID interfaces. Use `probe-rs serve`. |
| ST-Link | Untested | Should work. The WebUSB-specific changes are not verified on hardware yet. |
| WCH-Link | Untested | Same as ST-Link. |
| FTDI-based JTAG | Untested | |

Any probe `probe-rs serve` supports works over the WebSocket transport.

On Linux, WebUSB needs the same udev rules as probe-rs so the browser can open the device.
See [probe-rs's setup guide](https://probe.rs/docs/getting-started/probe-setup/).
On Windows, the probe's interface needs the WinUSB driver, as for probe-rs.

## Chips

Any chip probe-rs has a target description for can be flashed and debugged, subject to the
probe support above. For a chip probe-rs does not ship, [import its CMSIS pack](../guide/custom-targets).

Auto-detection (attaching without naming the chip) works where the chip identifies itself.
It works for the ESP32-S3 but not for the nRF9160 or the MCXA153. That matches native
probe-rs.

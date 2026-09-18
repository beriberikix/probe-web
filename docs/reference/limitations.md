# Browser support and limitations

## Browsers

| | Chrome, Edge, Opera (desktop) | Firefox | Safari |
|---|---|---|---|
| WebUSB transport | ✓ | ✗ | ✗ |
| WebSocket transport | ✓ | ✓ | ✓ |
| Serial monitor (WebSerial) | ✓ | ✗ | ✗ |
| Watching files (File System Access) | ✓ | ✗ | ✗ |

Firefox and Safari do not implement WebUSB, WebSerial or the File System Access API. They
can use everything else over the WebSocket transport. Chrome on Android has WebUSB but is
not tested.

WebUSB needs a secure context: `https://`, or `http://localhost` and `http://127.0.0.1`
during development.

## Known limitations

- **No disassembly over WebUSB.** probe-rs disassembles with capstone, a C library, which
  the in-browser build does not include. The disassembly panel and the DAP adapter report
  it as unavailable. `probe-rs serve` provides it for Arm and RISC-V. It has no Xtensa
  disassembler.
- **Semihosting in the browser is console-only.** Output to stdout and stderr and exit
  codes work. File operations are refused, because a page has no host filesystem.
- **No SWO or trace.** probe-web has no SWO or ITM viewer.
- **One tab per probe.** A second tab cannot open a probe another tab holds. It gets a
  `probe-in-use-other-tab` error. Native tools also cannot use the probe while a tab holds
  it.
- **CMSIS-DAP v1 (HID) probes** do not work over WebUSB. Browsers do not let WebUSB claim
  HID interfaces. Use `probe-rs serve`.
- **ST-Link and WCH-Link** are untested over WebUSB. See [Supported hardware](./hardware#probes).
- **Chip auto-detection** only works for chips whose debug ROM tables identify them, as
  with native probe-rs. Name the chip otherwise.
- **Xtensa stack traces** continue past the entry trampoline into unnamed ROM frames. The
  named frames above them are correct.
- **probe-rs forks.** The WebUSB transport and `probe-rs serve` build from forks of
  probe-rs until the async and wasm work is upstream. See [Architecture](../guide/architecture#the-probe-rs-forks).
- **Not on npm yet.** Use the packages from a clone of the repository.

# Node hardware-in-the-loop runner

The same `@probe-web/client` SDK the browser apps use, driven from Node over
the WebSocket transport to a `probe-rs serve` instance. Suitable for CI jobs
on a machine with boards attached.

```sh
# Node 22.18+ / 23.6+ runs the TypeScript directly (type stripping).
node run.ts --elf firmware.elf --chip nRF9160_xxAA \
  --url ws://127.0.0.1:3000 --token spike --probe j-link \
  --timeout 20 --expect "exiting with success"
```

It flashes with verify, runs an independent verify, then monitors RTT (when the
ELF links `_SEGGER_RTT`) and semihosting until the firmware exits via
semihosting, halts, or the timeout cancels the run. It exits 0 when every
`--expect` string was printed and the firmware did not report a failure;
otherwise 1. A semihosting `SYS_EXIT` from the firmware therefore becomes the
job's result.

## Debugging checks

`debug.ts` (SDK `Debugger`), `dap.ts` (`@probe-web/dap`), `debug-basic.ts` (run control without an
ELF), `robustness.ts` and `rtt-scan-pacing.ts` (`probe-rs serve` behaviour) run against the
debug-target firmware. Build instructions and the per-board command lines are in
[`hardware-tests/README.md`](../../hardware-tests/README.md#debugging-phase-3).

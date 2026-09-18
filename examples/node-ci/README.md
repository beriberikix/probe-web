# Node hardware-in-the-loop runner

The same `@probe-web/client` SDK the browser apps use, driven from Node over the WebSocket
transport to a `probe-rs serve` instance. It is meant for CI jobs on a machine with boards
attached.

```sh
# Node 22.18+ runs the TypeScript directly (type stripping).
node run.ts --elf firmware.elf --chip nRF9160_xxAA \
  --url ws://127.0.0.1:3000 --probe j-link \
  --timeout 20 --expect "exiting with success"
```

The runner:

1. flashes with verify, then runs an independent verify;
2. monitors RTT (when the ELF links `_SEGGER_RTT`) and semihosting, until the firmware exits
   through semihosting, the core halts, or the timeout cancels the run;
3. exits 0 when every `--expect` string was printed and the firmware did not report a
   failure, and 1 otherwise.

So a semihosting `SYS_EXIT` from the firmware becomes the job's result.

`--token` defaults to the `PROBE_RS_TOKEN` environment variable, and then to `probe-web`,
the token in `hardware-tests/serve/.probe-rs.toml`.

## Other checks

The other scripts are the checks this project runs against real boards, with the
firmware in `hardware-tests/firmware`:

| Script | Checks |
|---|---|
| `debug.ts` | The SDK `Debugger`: run control, registers, memory, debug info, variables, breakpoints, stepping (Cortex-M) |
| `dap.ts` | The same through `@probe-web/dap`'s DAP messages |
| `debug-basic.ts` | Run control without an ELF, on any firmware |
| `semihosting.ts` | Semihosting through the debugger (`--mode debugger`) and the monitor (`--mode monitor`) |
| `robustness.ts` | Bad requests come back from `probe-rs serve` as errors and leave it usable |
| `rtt-scan-pacing.ts` | RTT control-block scans do not starve the monitor |

The per-board command lines are in
[`hardware-tests/README.md`](../../hardware-tests/README.md#node-checks). The guide is
[Node and CI](https://beriberikix.github.io/probe-web/guide/node-and-ci).

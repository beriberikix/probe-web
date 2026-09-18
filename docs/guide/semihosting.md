# Semihosting

Semihosting lets firmware call into the debugger: print to the host console, and exit with a
status code. It is how `defmt-semihosting`, `cortex-m-semihosting`'s `hprintln!`, and test
harnesses report results without a UART or RTT.

## While monitoring

`session.monitor` services semihosting requests and reports them as events. A
`SYS_EXIT` from the firmware ends the monitor:

```ts
const exit = await session.monitor(boot, (event) => {
  if (event.kind === 'semihosting') console.log(`[${event.stream}] ${event.data}`); // stdout or stderr
});
// exit: { SemihostingExit: { Ok: null } } or { SemihostingExit: { Err: … } } when the firmware exits
```

A firmware without an RTT control block does not need an RTT client. Skip
`createRttClient` for it (`elfHasRtt(elf)` tells you), so the monitor does not scan RAM for
a block that is not there.

`<probe-semihosting-console>` shows the output and the exit status. Point its `source` at
an `<probe-rtt-terminal>`, which runs the monitor.

## While debugging

A `Debugger` services semihosting halts as they happen and resumes the core, so they do not
show up as stops. Output arrives as `output` events:

```ts
dbg.addEventListener('output', (e) => {
  const out = (e as CustomEvent).detail;
  if (out.source === 'semihosting') console.log(out.text);
});
```

An exit is reported as a stop, with the halt reason naming the exit.

## In the browser

Over WebUSB the worker implements console semihosting: opening `:tt` (stdout and stderr),
writing to it, and exit codes. A browser has no host filesystem, so file operations are
refused. Through `probe-rs serve`, semihosting behaves as it does natively.

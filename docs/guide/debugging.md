# Debugging

`session.debugger()` returns a `Debugger` for one core. It works over both
[transports](./transports) and is what the debugger components and the DAP adapter use.

```ts
const dbg = session.debugger();   // core 0; pass { core: 1 } for another
dbg.start();                      // poll the core so events fire on their own

dbg.addEventListener('stopped', async (e) => {
  const { reason, pc } = (e as CustomEvent).detail;
  const [top] = await dbg.stackTrace();
  console.log(`stopped (${JSON.stringify(reason)}) in ${top.functionName} at ${top.source?.path}:${top.source?.line}`);
});

await dbg.loadDebugInfo(elf, 'app.elf');
await dbg.resetAndHalt();
await dbg.setSourceBreakpoints('src/main.rs', [{ line: 42 }]);
await dbg.continue();
```

Call `dbg.dispose()` when you are done. It stops polling; it does not detach or resume the
core.

## Events

The `Debugger` is an `EventTarget`. Its events are `CustomEvent`s:

| Event | `detail` |
|---|---|
| `stopped` | `{ reason, pc, breakpoints }`: why and where the core halted, and which breakpoint ids are at `pc` |
| `continued` | none |
| `state` | the new `RunState`: `running`, `halted`, `sleeping`, `locked-up` or `unknown` |
| `breakpoints` | the current `Breakpoint[]`, after any change |
| `output` | `{ source: 'rtt', channel, text }` or `{ source: 'semihosting', text }` |
| `rtt-bytes` | `{ channel, bytes }` from a binary RTT channel |
| `locked-up` | none: the core is in lockup |
| `error` | a polling error |

The target sends no events of its own, so the debugger polls the core: every 50 ms while it
runs and every 200 ms while it is halted, by default. `DebuggerOptions` sets the intervals.

## Run control

```ts
await dbg.pause();          // resolves with the stop
await dbg.continue();
await dbg.step('over');     // 'instruction' | 'over' | 'into' | 'out'
await dbg.reset();          // reset and run
await dbg.resetAndHalt();   // reset and stop at the reset vector
await dbg.enableVectorCatch('HardFault');
```

## Breakpoints

```ts
const set = await dbg.setSourceBreakpoints('src/main.rs', [{ line: 40 }, { line: 57 }]);
await dbg.setInstructionBreakpoints([0x0000_1a2c]);
dbg.breakpoints();          // everything, with verified locations
await dbg.clearBreakpoints();
```

Source breakpoints replace the previous set for that file, as in DAP. The path is matched
against the paths in the debug info, so a path relative to the project or a file name
alone works. Breakpoints use hardware comparators, and cores have only a few (between 2
and 8 on Cortex-M parts). A breakpoint that does not fit comes back unverified with a message.

After loading a new ELF, call `reapplyBreakpoints()` to set them again at the new
addresses. `reset()` and `resetAndHalt()` do this themselves, because some cores (the MCX
family, the ESP32-S3) lose their comparators on reset.

## Stack, scopes and variables

```ts
const frames = await dbg.stackTrace();
const scopes = await dbg.scopes(frames[0].id);          // Locals, Statics, Registers, Peripherals…
const locals = await dbg.variables(scopes[0].reference);
const child = await dbg.variables(locals[0].reference);  // expand a struct (reference > 0)

await dbg.evaluate('point.x', frames[0].id);
await dbg.setVariable(locals[0], '7');
```

Results are tied to the stop they were taken at. After the core runs, old frame and
variable references are refused rather than passed on, and `dbg.epoch` tells you which
stop a result belongs to.

## Registers and memory

```ts
const regs = await dbg.readRegisters();                 // { info: { name, bits, … }, value: bigint }[]
await dbg.writeRegister('R0', 0x2an);
const bytes = await dbg.readMemory(0x2000_0000, 64);
await dbg.writeMemory(0x2000_0000, new Uint8Array([0xde, 0xad]));
```

## Peripherals (SVD)

```ts
await dbg.loadSvd(svdBytes, 'MCXA153.svd');
```

After loading an SVD, a *Peripherals* scope appears in `scopes()`. Its registers and fields
are read live when expanded. `<probe-peripherals>` shows them as a tree. CMSIS packs carry
SVDs; [`packSvds`](./custom-targets#svds-from-a-pack) extracts them.

## Source code

The debug info names source files by the paths they had at build time. A `SourceProvider`
turns those into text in the browser:

- `DirectorySourceProvider`: a folder the user picks (File System Access), searched by path suffix;
- `UrlSourceProvider`: a web server, with a path prefix mapped to a base URL.

```ts
import { DirectorySourceProvider } from '@probe-web/client';

const dir = await showDirectoryPicker();
const sources = new DirectorySourceProvider(dir);
const text = await sources.read(frame.source!.path);
```

Build with `--remap-path-prefix` so the paths are stable across machines. The demo firmware
maps its sources to `/probe-web-firmware/`, and the hosted workbench serves them from
there.

## Disassembly

```ts
if (dbg.canDisassemble) {
  const instructions = await dbg.disassemble(pc, 20);
}
```

Disassembly needs `probe-rs serve`: probe-rs uses capstone, a C library that the WebUSB
worker does not include.

## Architecture notes

- **Xtensa (ESP32-S3):** step out uses the caller's return address from the stack trace
  (`DebuggerOptions.stepOut: 'auto'`) instead of probe-rs's own step out, which does not
  handle the windowed register file. Stack traces continue past the entry trampoline into
  unnamed ROM frames, and the named frames above them are correct.
- **Multi-core chips:** one `Debugger` per core. Parked secondary cores do not stall the
  first core's run loop.

## Testing UIs without hardware

`FakeDebugger` from `@probe-web/client/testing` implements the same interface with a
scripted target. The component tests in this repository use it. See [Firmware tests](./testing#testing-your-ui).

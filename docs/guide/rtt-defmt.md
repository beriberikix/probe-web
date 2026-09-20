# RTT and defmt

[RTT](https://wiki.segger.com/RTT) moves data between the target and the host through
ring buffers in the target's RAM, read by the probe while the firmware runs.
[defmt](https://defmt.ferrous-systems.com/) is a compact logging format on top of it.
probe-web decodes defmt in the browser, from the firmware's ELF.

## Monitor a running target

```ts
// Also on `@probe-web/client/elf`, which loads no wasm if a symbol lookup is all you need.
import { elfHasRtt } from '@probe-web/client';

if (elfHasRtt(elf)) {
  // The ELF's _SEGGER_RTT symbol gives the exact address, so no RAM scan is needed.
  await session.createRttClient({ elf, defaults: { dataFormat: 'Defmt' } });
  session.setDefmtElf(elf); // the defmt string table
}

const boot = await session.flash({ image: elf, format: 'elf' });
const exit = await session.monitor(boot, (event) => {
  switch (event.kind) {
    case 'rtt-discovered': console.log('channels', event.up, event.down); break;
    case 'text':           console.log(event.channel, event.text); break;
    case 'defmt':          event.lines.forEach((l) => console.log(l.level, l.message, l.location)); break;
    case 'bytes':          plot(event.channel, event.bytes); break;
    case 'semihosting':    console.log(event.stream, event.data); break;
  }
});
```

`monitor(boot, …)` resets into the image and streams output until you call
`session.cancel()`, the firmware exits through semihosting, or the core stops. It resolves
with the reason. To attach to firmware that is already running without resetting it, pass
`'attach'` instead of the boot info.

Call `createRttClient` before flashing if the image contains the control block, so the
flash does not leave a stale one behind.

### Channel formats

Each up channel has a data format, set through `defaults` or per channel:

```ts
await session.createRttClient({
  elf,
  channels: [
    { channelNumber: 0, dataFormat: 'Defmt' },
    { channelNumber: 1, dataFormat: 'BinaryLE' }, // raw bytes: 'bytes' events
  ],
});
```

| Format | Events | Use |
|---|---|---|
| `String` (default) | `text` | Plain logging, `rtt-target`'s `rprintln!` |
| `Defmt` | `defmt` | defmt logging; needs `setDefmtElf` |
| `BinaryLE` | `bytes` | Samples, telemetry, anything not text |

## Send data to the target

Down channels carry data to the firmware:

```ts
await session.rttWrite(0, 'hello\n');
```

`<probe-rtt-terminal>` sends what the user types to down channel 0.

## While debugging

With a [`Debugger`](./debugging), RTT keeps flowing across halts:

```ts
await dbg.enableRtt({ elf, channels: [{ channelNumber: 1, dataFormat: 'BinaryLE' }] });
dbg.addEventListener('output', (e) => console.log((e as CustomEvent).detail));    // text
dbg.addEventListener('rtt-bytes', (e) => console.log((e as CustomEvent).detail)); // binary channels
```

## Plot a binary channel

`SampleDecoder` from `@probe-web/ui` turns a byte stream into numbers (`u8` through `f32`,
little-endian) across chunk boundaries. `<probe-rtt-plot>` draws them live:

```ts
import { SampleDecoder } from '@probe-web/ui';

const decoder = new SampleDecoder('i16');
dbg.addEventListener('rtt-bytes', (e) => chart.push(...decoder.push((e as CustomEvent).detail.bytes)));
```

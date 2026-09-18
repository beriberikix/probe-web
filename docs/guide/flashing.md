# Flashing

## Attach

```ts
import { Client } from '@probe-web/client';

const client = await Client.connect({ kind: 'webusb' });
const probes = await client.listProbes();
const session = await client.attach({
  probe: probes[0],
  chip: 'MCXA153',          // a probe-rs target name; omit to auto-detect
  protocol: 'Swd',          // or 'Jtag'
  speedKhz: 4000,           // optional
  connectUnderReset: false, // optional
});
```

`client.listChipFamilies()` returns every target probe-rs knows, and `client.chipInfo(name)`
returns one chip's cores and memory map. Auto-detection (no `chip`) works for chips whose
ROM tables identify them, such as the ESP32-S3. Most chips need to be named.

Errors carry a `kind`. A failed attach is `attach-failed`, and its `connectUnderReset`
says whether that attempt was already made under reset. If it was not, retrying with
`connectUnderReset: true` helps with firmware that sleeps or disables the debug port. For a
chip that is locked, `allowEraseAll: true` lets probe-rs mass-erase it in order to attach,
which destroys its contents.

## Flash an image

```ts
const boot = await session.flash(
  {
    image: elfBytes,          // Uint8Array, ArrayBuffer, Blob, or a URL to fetch
    name: 'app.elf',
    format: 'elf',            // 'elf' | 'bin' | 'hex' | 'uf2' | 'idf' | 'target'
    options: { verify: true },
  },
  (event) => console.log(event),
);
await session.boot(boot);     // reset and run the image
```

- `format: 'bin'` needs a `baseAddress` (and optionally `skip`, bytes to skip at the start).
- `format: 'target'` uses the chip's default. That is ESP-IDF images on ESP32 chips.
- `options` covers probe-rs's download options: `verify`, `doChipErase`, `skipErase`,
  `keepUnwrittenBytes`, `disableDoubleBuffering`, `preferredAlgos`.

### Progress

The listener receives probe-rs's progress events: operations (`Erase`, `Program`, `Verify`,
`Fill`, `Ram`) starting, advancing and finishing. `progressOperation(event)` tells you which
operation an event belongs to:

```ts
import { progressOperation } from '@probe-web/client';

session.flash(job, (event) => {
  const op = progressOperation(event);
  if (op && typeof event === 'object' && 'Progress' in event) bar(op).advance(event.Progress.size);
});
```

`<probe-flash-panel>` renders all of this for you; see [Web components](./components).

## Verify and erase

```ts
const result = await session.verify({ image: elfBytes, format: 'elf' }); // 'Ok' | 'Mismatch'
await session.eraseAll();
```

## Memory and cores

`session.core(index)` gives direct access to a core, outside the debugger:

```ts
const core = session.core(0);
await core.halt();
const words = await core.readMemory32(0x2000_0000, 4);
await core.writeMemory8(0x2000_1000, new Uint8Array([1, 2, 3]));
await core.run();
```

`core.dumpCoreFile(ranges)` captures registers and memory as a coredump file that
`probe-rs` and its debugger can open later. It is the same format `probe-rs run` writes.
`downloadBytes` from `@probe-web/artifacts` saves it from a browser.

## Manifests

The hosted flasher and `examples/minimal-flash` describe demo images with a small JSON
manifest, which you can reuse for your own deployment:

```json
{
  "name": "FRDM-MCXA153 debug target",
  "chip": "MCXA153",
  "protocol": "Swd",
  "images": [{ "url": "firmware/mcxa153-debug.elf", "format": "elf", "name": "mcxa153-debug.elf" }],
  "options": { "verify": true }
}
```

The flasher loads one with `?manifest=<url>`. Image URLs resolve relative to the manifest.

## Re-flash on rebuild

With [`@probe-web/artifacts`](./artifacts), a page can watch the ELF your build writes and
re-flash each time it changes. The flash panel's *Pick file & watch…* option does this.

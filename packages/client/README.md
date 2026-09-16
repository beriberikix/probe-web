# @probe-web/client

The headless probe-rs SDK for browsers. One API, two transports:

```ts
import { Client } from '@probe-web/client';

// probe-rs running in this tab (WebUSB, Chromium only) …
const client = await Client.connect({ kind: 'webusb' });
// … or a native `probe-rs serve` anywhere (any browser, Node too)
const remote = await Client.connect({ kind: 'websocket', url: 'ws://127.0.0.1:3000', token: 'secret' });

const [probe] = await client.listProbes();
const session = await client.attach({ probe, chip: 'MCXA153', protocol: 'Swd' });
const bootInfo = await session.flash({ image: '/firmware/app.elf', format: 'elf' }, (e) => console.log(e));

await session.createRttClient({ defaults: { dataFormat: 'Defmt' } });
session.setDefmtElf(elfBytes);
await session.monitor(bootInfo, (ev) => { if (ev.kind === 'defmt') ev.lines.forEach((l) => console.log(l.level, l.message)); });
```

Wire types (`./wire`) are generated from probe-rs's RPC schema by
`spikes/schema-ts`; the values cross the wasm boundary as documented at the
top of `src/wire.ts` (externally tagged enums, `bigint` for 64-bit integers,
`null` for `None`).

The WebUSB transport needs the device to be granted on the main thread first
(`@probe-web/devices`); the worker only sees granted devices.

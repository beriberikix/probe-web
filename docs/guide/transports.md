# Transports

Everything in probe-web goes through a `Client`, and a client connects over one of two
transports. The API above the transport is the same.

| | WebUSB | WebSocket |
|---|---|---|
| Where probe-rs runs | In the page, compiled to wasm, in a Web Worker | A native `probe-rs serve`, on this machine or another |
| Browsers | Chrome, Edge and other Chromium browsers | Any browser, and Node |
| Install | Nothing | probe-rs, built from the fork branch below |
| Probe access | WebUSB: the user grants the device to the site once | The server's USB access |
| Disassembly | Not available | Available (Arm and RISC-V) |
| Semihosting | Console output and exit codes; no host files | As probe-rs handles it natively |

## WebUSB

```ts
import { Client } from '@probe-web/client';
import { requestProbe, grantedDevices } from '@probe-web/devices';

if ((await grantedDevices()).length === 0) await requestProbe(); // in a user gesture
const client = await Client.connect({ kind: 'webusb' });
```

`Client.connect` starts a Worker running probe-rs. The worker can only open devices the page
has been granted, so the grant happens on the main thread with `requestProbe()`. Grants are
per origin and persist, which is why all the hosted apps live on one site.

The worker loads a wasm module of about 10 MB (under 2 MB compressed), which the browser caches after the first visit.

Things to know:

- **One tab per probe.** The SDK takes a [Web Lock](https://developer.mozilla.org/docs/Web/API/Web_Locks_API)
  per probe, so a second tab gets a `probe-in-use-other-tab` error instead of a stuck
  device. Call `client.close()` when you are done, or on `pagehide`, to release it.
- **Native tools are locked out while a tab holds the probe.** Close the tab, or call
  `client.close()`, before running `probe-rs` on the command line.
- **Worker crashes are reported.** If probe-rs panics inside the worker, pending and later
  calls reject with `kind: 'worker-crashed'`, and `client.crashReason` says why.
- **Logging.** `createLocalWorker({ log: 'debug' })`, passed as `worker`, raises probe-rs's
  tracing level inside the worker and mirrors it to the page console. The hosted apps take
  `?workerLog=debug`.

```ts
import { Client, createLocalWorker } from '@probe-web/client';
const client = await Client.connect({ kind: 'webusb', worker: createLocalWorker({ log: 'debug' }) });
```

## WebSocket

```ts
const client = await Client.connect({ kind: 'websocket', url: 'ws://127.0.0.1:3000', token: 'probe-web' });
```

This connects to `probe-rs serve`, probe-rs's own RPC server. Use it for Firefox and Safari,
for a probe attached to another machine, for disassembly, or from Node.

probe-web needs a few changes to `probe-rs serve` that are not upstream yet: a handshake a
browser WebSocket can perform, and fixes for clients that disconnect mid-operation. Build it
from the fork's `wasm-rpc-client` branch:

```sh
cargo install probe-rs-tools --locked \
  --git https://github.com/beriberikix/probe-rs --branch wasm-rpc-client
```

`probe-rs serve` reads its users and tokens from a `.probe-rs.toml` in the directory it is
started from. The repository has one for local development, in
`hardware-tests/serve/.probe-rs.toml`, which listens on `127.0.0.1:3000` with the token
`probe-web`:

```sh
cd hardware-tests/serve && probe-rs serve
```

::: warning
A `probe-rs serve` token gives full control of every probe on that machine. The
development config listens on localhost only. Choose your own token before exposing a
server anywhere else.
:::

## Capabilities

The two servers do not implement exactly the same endpoints. Instead of failing on first
use, a client negotiates on connect:

```ts
client.supports('core/disassemble'); // false over WebUSB
client.capabilities();               // { unsupportedEndpoints, unsupportedTopics }
```

The components use this to hide or disable what the server cannot do. For example, the
disassembly panel reports that disassembly is unavailable over WebUSB.

## One call to connect and attach

`openSession` connects, picks a probe by substring and attaches:

```ts
import { openSession } from '@probe-web/client';

const { client, session, probe } = await openSession({
  transport: 'webusb',       // or 'websocket' with url and token
  probe: 'j-link',           // substring of the identifier or serial number; first probe if empty
  chip: 'nRF9160_xxAA',
  protocol: 'Swd',
});
```

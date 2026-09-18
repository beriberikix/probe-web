# Firmware tests

## Running an embedded-test suite

[embedded-test](https://github.com/probe-rs/embedded-test) runs `#[test]` functions on the
target, one per reset, and reports over semihosting. probe-web runs such a suite from the
browser, over either transport:

```ts
const boot = await session.flash({ image: testElf, format: 'elf' });
const { tests } = await session.listTests(boot);

for (const test of tests) {
  if (test.ignored) continue;
  const result = await session.runTest(test);           // 'Success' | { Failed: message } | 'Cancelled'
  console.log(result === 'Success' ? `ok ${test.name}` : `FAILED ${test.name}: ${JSON.stringify(result)}`);
}
```

Each test resets the target and runs alone, so a failure belongs to that test and not to
whatever ran before it. `Success` means the test did what it was expected to do: a
`#[should_panic]` test (`expected_outcome: 'Panic'`) succeeds by panicking.

`<probe-test-runner>` does this with a results table and progress. Give it the `session`
and the `bootInfo` from flashing the test firmware. The firmware in
`hardware-tests/firmware/cm33-tests` is a small suite with passing, should-panic and
ignored tests.

## Testing your UI

Two stand-ins let you test UI and integration code without hardware.

**`FakeDebugger`** (`@probe-web/client/testing`) has the `Debugger`'s methods and events and
models a tiny program: `main → step_a → step_b`, with locals, statics and registers. It
records every call:

```ts
import { FakeDebugger } from '@probe-web/client/testing';

const dbg = new FakeDebugger();
panel.debugger = dbg;           // any debugger component
await dbg.continue();
dbg.hit();                      // the "firmware" reaches a breakpoint: `stopped` fires
expect(dbg.calls).toEqual(['continue']);
```

**The fake-probe worker** (`@probe-web/client/testing/worker`) is the real WebUSB worker
built with a fake probe and a mocked core. It exercises the actual transport, RPC and SDK
code:

```ts
import { Client } from '@probe-web/client';
const { createFakeLocalWorker } = await import('@probe-web/client/testing/worker');

const client = await Client.connect({ kind: 'webusb', worker: createFakeLocalWorker() });
const [probe] = await client.listProbes();       // the fake probe, ffff:ffff
const session = await client.attach({ probe, chip: 'MCXA153' });
```

The mocked core supports run control, registers, memory and breakpoints. It cannot run
flash algorithms, so flashing still needs hardware. The worker carries its own 12 MB wasm
module. Import it only from tests, so bundlers keep it out of production builds.

This repository's Playwright suite (`npx playwright test`) drives every app and component
this way, with no hardware attached.

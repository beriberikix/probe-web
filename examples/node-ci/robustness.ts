/**
 * `probe-rs serve` robustness: requests with a bad core index must come back as errors
 * and leave the connection usable (they used to be able to panic it).
 *
 *   node robustness.ts --chip esp32s3 --protocol Jtag --probe jtag
 *   node robustness.ts --chip nRF9160_xxAA --probe j-link --address 0x20000000
 */
import { parseArgs } from 'node:util';
import { Client } from '@probe-web/client';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:3000' },
    token: { type: 'string', default: 'spike' },
    chip: { type: 'string' },
    probe: { type: 'string' },
    protocol: { type: 'string', default: 'Swd' },
    /** A readable RAM address on the target (ESP32-S3: 0x3fc80000, Cortex-M: 0x20000000). */
    address: { type: 'string', default: '0x3fc80000' },
  },
});
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const message = (e: unknown) => (e as Error).message ?? String(e);

const client = await Client.connect({ kind: 'websocket', url: args.url, token: args.token });
try {
  const probes = await client.listProbes();
  const want = args.probe?.toLowerCase();
  const probe = want ? probes.find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want)) : probes[0];
  if (!probe) throw new Error(`no probe matching ${args.probe}`);
  const session = await client.attach({ probe, chip: args.chip || undefined, protocol: args.protocol as 'Swd' | 'Jtag' });
  const cores = (await session.targetMetadata()).cores.length;
  const address = BigInt(args.address);

  for (const [name, op] of [
    ['memory/read32', () => session.core(cores + 7).readMemory32(address, 1)],
    ['memory/write8', () => session.core(cores + 7).writeMemory8(address, new Uint8Array([0]))],
  ] as const) {
    const result = await Promise.race([
      op().then(() => 'resolved', (e) => `error: ${message(e)}`),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 5000)),
    ]);
    check(`${name} on core ${cores + 7} is an error`, result.startsWith('error'), result);
  }

  const words = await session.core(0).readMemory32(address, 1);
  check('connection still serves core 0', words.length === 1, `0x${words[0].toString(16)}`);
  const meta = await session.targetMetadata();
  check('session still valid', meta.cores.length === cores, meta.target_name);
} catch (e) {
  console.error(`error: ${(e as Error).stack ?? e}`);
  failures++;
} finally {
  client.close();
}
console.log(`ROBUSTNESS_RESULT=${failures ? `FAIL (${failures})` : 'PASS'}`);
process.exit(failures ? 1 : 0);

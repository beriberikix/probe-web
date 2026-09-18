/**
 * Flash, then monitor with an RTT client whose scan region holds no control block, for a fixed time.
 * Run `probe-rs serve --log-file <file>` and count "control block not found" lines to see
 * how often the server scanned.
 *
 *   node rtt-scan-pacing.ts --chip esp32s3 --protocol Jtag --probe jtag --start 0x3fcb0000 --size 0x10000 --seconds 6
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from '@probe-web/client';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:3000' },
    token: { type: 'string', default: process.env.PROBE_RS_TOKEN ?? 'probe-web' },
    chip: { type: 'string' },
    probe: { type: 'string' },
    protocol: { type: 'string', default: 'Swd' },
    start: { type: 'string', default: '0x3fcb0000' },
    size: { type: 'string', default: '0x10000' },
    seconds: { type: 'string', default: '6' },
    elf: { type: 'string', default: '../../apps/flash/public/firmware/esp32s3-debug.elf' },
  },
});

const client = await Client.connect({ kind: 'websocket', url: args.url, token: args.token });
try {
  const probes = await client.listProbes();
  const want = args.probe?.toLowerCase();
  const probe = want ? probes.find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want)) : probes[0];
  if (!probe) throw new Error(`no probe matching ${args.probe}`);
  const session = await client.attach({ probe, chip: args.chip || undefined, protocol: args.protocol as 'Swd' | 'Jtag' });
  // Start the firmware the way the Debugger does (reset and halt, then continue): a previous
  // debug session may have left the cores halted, and on the ESP32-S3 the monitor's own reset
  // path stops at a ROM breakpoint (0x400003c0), either of which ends the monitor at once.
  const dbg = session.debugger();
  await dbg.resetAndHalt();
  await dbg.continue();
  dbg.dispose();
  const start = BigInt(args.start);
  await session.createRttClient({ scanRegion: { Ranges: [[start, start + BigInt(args.size)]] } });
  let discovered = false;
  const t0 = performance.now();
  const done = session.monitor('attach', (e) => { if (e.kind === 'rtt-discovered') discovered = true; });
  await new Promise((r) => setTimeout(r, Number(args.seconds) * 1000));
  const cancelAt = performance.now();
  await session.cancel();
  const exit = await done;
  console.log(`monitored ${((cancelAt - t0) / 1000).toFixed(1)} s; cancel took ${(performance.now() - cancelAt).toFixed(0)} ms; exit ${JSON.stringify(exit)}; discovered=${discovered}`);
} finally {
  client.close();
}

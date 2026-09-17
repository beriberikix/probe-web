/**
 * Hardware-in-the-loop runner for CI, using the same SDK as the browser apps
 * over the WebSocket transport (Node 22+ has a global WebSocket).
 *
 *   node --experimental-transform-types run.ts --elf fw.elf --chip nRF9160_xxAA \
 *     [--url ws://127.0.0.1:3000] [--token spike] [--probe j-link] [--protocol Swd] \
 *     [--timeout 20] [--expect "text that must appear"]
 *
 * Exit code: 0 when flash + verify pass, every --expect string was seen, and
 * the firmware did not report a semihosting failure; 1 otherwise.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Client, elfHasRtt, type MonitorEvent, type Wire } from '@probe-web/client';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:3000' },
    token: { type: 'string', default: '' },
    elf: { type: 'string' },
    chip: { type: 'string' },
    probe: { type: 'string' },
    protocol: { type: 'string', default: 'Swd' },
    timeout: { type: 'string', default: '20' },
    expect: { type: 'string', multiple: true, default: [] },
  },
});
if (!args.elf || !args.chip) {
  console.error('usage: run.ts --elf <file> --chip <name> [--url ws://…] [--token …] [--probe <substring>] [--expect <text>]…');
  process.exit(2);
}

const t0 = performance.now();
const since = () => `${((performance.now() - t0) / 1000).toFixed(2)}s`;
const elf = new Uint8Array(await readFile(args.elf));

const client = await Client.connect({ kind: 'websocket', url: args.url, token: args.token });
let failed = false;
try {
  const probes = await client.listProbes();
  const want = args.probe?.toLowerCase();
  const probe = want ? probes.find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want)) : probes[0];
  if (!probe) throw new Error(`no probe matching ${JSON.stringify(args.probe)} (found: ${probes.map((p) => p.identifier).join(', ') || 'none'})`);
  console.log(`[${since()}] probe ${probe.identifier} ${probe.serial_number ?? ''}`);

  const session = await client.attach({ probe, chip: args.chip, protocol: args.protocol as 'Swd' | 'Jtag' });
  console.log(`[${since()}] attached ${args.chip}`);

  let lastOp = '';
  const bootInfo = await session.flash({ image: elf, name: args.elf, format: 'elf', options: { verify: true } }, (e) => {
    if (typeof e === 'object' && e && 'Started' in e) {
      const op = JSON.stringify((e as { Started: unknown }).Started);
      if (op !== lastOp) console.log(`[${since()}] ${op.replaceAll('"', '').toLowerCase()}…`);
      lastOp = op;
    }
  });
  console.log(`[${since()}] flashed + verified`);

  const verdict = await session.verify({ image: elf, name: args.elf, format: 'elf' });
  console.log(`[${since()}] independent verify: ${verdict}`);
  if (verdict !== 'Ok') failed = true;

  // Monitor: RTT when the firmware links it, semihosting always.
  if (elfHasRtt(elf)) await session.createRttClient({ elf });
  let output = '';
  const onEvent = (e: MonitorEvent) => {
    let text = '';
    if (e.kind === 'text') text = e.text;
    else if (e.kind === 'semihosting') text = e.data;
    else if (e.kind === 'defmt') text = e.lines.map((l) => l.message + '\n').join('');
    else if (e.kind === 'rtt-discovered') console.log(`[${since()}] RTT: ${e.up.length} up channel(s)`);
    if (text) {
      output += text;
      // Output arrives in fragments (semihosting writes one format piece at a time); print whole lines.
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) console.log(`  | ${l}`);
    }
  };
  let pending = '';
  const timer = setTimeout(() => void session.cancel(), Number(args.timeout) * 1000);
  const exit: Wire.MonitorExitReason = await session.monitor(bootInfo, onEvent);
  clearTimeout(timer);
  if (pending) console.log(`  | ${pending}`);
  console.log(`[${since()}] monitor exit: ${JSON.stringify(exit)}`);

  if (typeof exit === 'object' && 'SemihostingExit' in exit && !('Ok' in exit.SemihostingExit)) failed = true;
  if (typeof exit === 'object' && 'Halted' in exit) failed = true;
  for (const want of args.expect) {
    const seen = output.includes(want);
    console.log(`[${since()}] expect ${JSON.stringify(want)}: ${seen ? 'seen' : 'MISSING'}`);
    if (!seen) failed = true;
  }
} catch (e) {
  console.error(`[${since()}] error: ${(e as Error).message ?? e}`);
  failed = true;
} finally {
  client.close();
}
console.log(failed ? 'HIL_RESULT=FAIL' : 'HIL_RESULT=PASS');
process.exit(failed ? 1 : 0);

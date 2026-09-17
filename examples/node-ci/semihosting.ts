/**
 * Semihosting over `probe-rs serve`, two ways, against hardware-tests/firmware/nrf9160-semihosting
 * (banner, three stdout lines, one stderr line, SYS_EXIT success):
 *
 * - `--mode debugger`: the SDK `Debugger` services semihosting halts while debugging and reports
 *   the output as `output` events; the exit is reported as a stop.
 * - `--mode monitor`: `session.monitor` with an RTT client that scans all of RAM although the
 *   firmware has no RTT control block (serve used to rescan RAM on every poll and starve
 *   semihosting; follow-up 4).
 *
 *   node semihosting.ts --mode debugger --elf ../../apps/flash/public/firmware/nrf9160-semihosting.elf --chip nRF9160_xxAA --probe j-link
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from '@probe-web/client';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:3000' },
    token: { type: 'string', default: 'spike' },
    elf: { type: 'string', default: '../../apps/flash/public/firmware/nrf9160-semihosting.elf' },
    chip: { type: 'string', default: 'nRF9160_xxAA' },
    probe: { type: 'string', default: 'j-link' },
    protocol: { type: 'string', default: 'Swd' },
    mode: { type: 'string', default: 'debugger' },
    timeout: { type: 'string', default: '20' },
    /** monitor mode: `ram` creates an RTT client scanning all of RAM, `none` monitors without RTT. */
    scan: { type: 'string', default: 'ram' },
  },
});

const t0 = performance.now();
const since = () => `${((performance.now() - t0) / 1000).toFixed(2)}s`;
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`[${since()}] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const expected = ['nrf9160-semihosting: hello over semihosting', 'stdout line 0', 'stdout line 1', 'stdout line 2', 'stderr line', 'exiting with success'];

const client = await Client.connect({ kind: 'websocket', url: args.url, token: args.token });
try {
  const probes = await client.listProbes();
  const want = args.probe.toLowerCase();
  const probe = probes.find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want));
  if (!probe) throw new Error(`no probe matching ${args.probe}`);
  const session = await client.attach({ probe, chip: args.chip, protocol: args.protocol as 'Swd' | 'Jtag' });
  const elf = new Uint8Array(readFileSync(args.elf));
  const bootInfo = await session.flash({ image: elf, name: 'semihosting.elf', format: 'elf', options: { verify: true } });
  console.log(`[${since()}] flashed`);
  const timeoutMs = Number(args.timeout) * 1000;
  let text = '';
  const arrivals: string[] = [];
  const note = (chunk: string) => {
    text += chunk;
    for (const line of chunk.split('\n').filter(Boolean)) arrivals.push(`${since()} ${line}`);
  };

  if (args.mode === 'debugger') {
    const d = session.debugger();
    d.addEventListener('output', (e) => {
      const o = (e as CustomEvent).detail as { source: string; text: string };
      if (o.source === 'semihosting') note(o.text);
    });
    const exited = new Promise<{ reason: unknown }>((resolve) => d.addEventListener('stopped', (e) => resolve((e as CustomEvent).detail), { once: false }));
    d.start();
    await d.resetAndHalt();
    const stop = new Promise<unknown>((resolve) => {
      d.addEventListener('stopped', (e) => resolve((e as CustomEvent).detail.reason));
    });
    await d.continue();
    const reason = await Promise.race([stop, new Promise((r) => setTimeout(() => r('timeout'), timeoutMs))]);
    void exited;
    check('every semihosting line arrived as a Debugger output event', expected.every((l) => text.includes(l)), arrivals.join(' | '));
    check('no stop was reported for the serviced semihosting calls, only the exit', reason !== 'timeout', JSON.stringify(reason));
    d.dispose();
  } else {
    if (args.scan === 'ram') await session.createRttClient({ scanRegion: 'Ram' });
    else session.clearRttClient();
    let exit: unknown = null;
    const run = session.monitor(bootInfo, (e) => { if (e.kind === 'semihosting') note(e.data); }).then((r) => { exit = r; });
    await Promise.race([run, new Promise((r) => setTimeout(r, timeoutMs))]);
    if (exit === null) await session.cancel();
    await run.catch(() => {});
    check(`every semihosting line arrived (RTT scan: ${args.scan})`, expected.every((l) => text.includes(l)), arrivals.join(' | '));
    check('the monitor ended with the firmware exit, not the timeout', exit !== null && JSON.stringify(exit).includes('Semihosting'), JSON.stringify(exit));
  }
} catch (e) {
  console.error(`[${since()}] error: ${(e as Error).stack ?? e}`);
  failures++;
} finally {
  client.close();
}
console.log(`SEMIHOSTING_RESULT=${failures ? `FAIL (${failures})` : 'PASS'}`);
process.exit(failures ? 1 : 0);

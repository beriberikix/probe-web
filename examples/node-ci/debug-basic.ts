/**
 * Run control and inspection without an ELF (any target, whatever firmware it runs):
 * attach, pause, registers, memory, instruction step, continue. For boards without a
 * debug-test firmware (e.g. the ESP32-S3: no Xtensa Rust toolchain here).
 *
 *   node debug-basic.ts --chip esp32s3 --protocol Jtag --probe jtag [--memory 0x40000000]
 */
import { parseArgs } from 'node:util';
import { Client } from '@probe-web/client';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:3000' },
    token: { type: 'string', default: process.env.PROBE_RS_TOKEN ?? 'probe-web' },
    chip: { type: 'string' },
    probe: { type: 'string' },
    protocol: { type: 'string', default: 'Swd' },
    memory: { type: 'string' },
  },
});
const t0 = performance.now();
const since = () => `${((performance.now() - t0) / 1000).toFixed(2)}s`;
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`[${since()}] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const hex = (v: bigint | number) => '0x' + v.toString(16);

const client = await Client.connect({ kind: 'websocket', url: args.url, token: args.token });
try {
  const probes = await client.listProbes();
  const want = args.probe?.toLowerCase();
  const probe = want ? probes.find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want)) : probes[0];
  if (!probe) throw new Error(`no probe matching ${args.probe}`);
  const session = await client.attach({ probe, chip: args.chip || undefined, protocol: args.protocol as 'Swd' | 'Jtag' });
  const meta = await session.targetMetadata();
  console.log(`[${since()}] attached ${meta.target_name} (${meta.cores.map((c) => c.core_type).join(', ')}) via ${probe.identifier}`);
  const dbg = session.debugger();
  const stop = await dbg.pause();
  check('pause', dbg.state === 'halted', `pc ${hex(stop.pc)}`);
  const regs = await dbg.readRegisters();
  const pcReg = regs.find((r) => r.info.roles.includes('ProgramCounter'));
  check('registers readable, PC matches the stop', regs.length > 4 && pcReg?.value === stop.pc, `${regs.length} registers; ${regs.slice(0, 6).map((r) => `${r.info.name}=${hex(r.value)}`).join(' ')}`);
  const address = args.memory ? BigInt(args.memory) : stop.pc;
  const bytes = await dbg.readMemory(address, 16);
  check('memory read', bytes.length === 16, `${hex(address)}: ${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  const step = await dbg.step('instruction');
  check('instruction step moves the PC', step.pc !== stop.pc, `${hex(stop.pc)} -> ${hex(step.pc)}`);
  const insns = await dbg.disassemble(step.pc, 3).catch((e) => { console.log(`  (disassemble: ${(e as Error).message})`); return []; });
  if (insns.length) console.log(`[${since()}] disassembly: ${insns.map((i) => `${hex(i.address)} ${i.text}`).join(' | ')}`);
  await dbg.continue();
  check('continue', (await dbg.refresh()) !== 'halted', dbg.state);
  dbg.dispose();
} catch (e) {
  console.error(`[${since()}] error: ${(e as Error).stack ?? e}`);
  failures++;
} finally {
  client.close();
}
console.log(failures ? `DEBUG_BASIC_RESULT=FAIL (${failures})` : 'DEBUG_BASIC_RESULT=PASS');
process.exit(failures ? 1 : 0);

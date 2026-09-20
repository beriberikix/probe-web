/**
 * Hardware-in-the-loop test for the SDK `Debugger`, over WebSocket to
 * `probe-rs serve`, against hardware-tests/firmware/cm33-debug.
 *
 *   node debug.ts --elf ../../apps/flash/public/firmware/mcxa153-debug.elf --chip MCXA153 \
 *     [--url ws://127.0.0.1:3000] [--token probe-web] [--probe mcu-link] [--svd <file>]
 *
 * Each check prints PASS/FAIL; the process exits 0 only if all pass.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Client, elfSymbol, type Debugger, type Variable } from '@probe-web/client';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:3000' },
    token: { type: 'string', default: process.env.PROBE_RS_TOKEN ?? 'probe-web' },
    elf: { type: 'string' },
    chip: { type: 'string' },
    probe: { type: 'string' },
    svd: { type: 'string', default: '../../hardware-tests/svd/cortex-m-scb.svd' },
    firmwareSrc: { type: 'string', default: '../../hardware-tests/firmware/cm33-debug/src/main.rs' },
  },
});
if (!args.elf || !args.chip) {
  console.error('usage: debug.ts --elf <file> --chip <name> [--probe <substring>] [--url ws://…] [--token …]');
  process.exit(2);
}

const t0 = performance.now();
const since = () => `${((performance.now() - t0) / 1000).toFixed(2)}s`;
let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`[${since()}] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
const hex = (v: bigint | number) => '0x' + v.toString(16);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const elf = new Uint8Array(await readFile(args.elf));
const addr = (name: string) => {
  const a = elfSymbol(elf, name);
  if (a === undefined) throw new Error(`symbol ${name} not in ${args.elf}`);
  return a;
};

const client = await Client.connect({ kind: 'websocket', url: args.url, token: args.token });
let dbg: Debugger | null = null;
try {
  const probes = await client.listProbes();
  const want = args.probe?.toLowerCase();
  const probe = want ? probes.find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want)) : probes[0];
  if (!probe) throw new Error(`no probe matching ${JSON.stringify(args.probe)} (found: ${probes.map((p) => p.identifier).join(', ') || 'none'})`);
  const session = await client.attach({ probe, chip: args.chip, protocol: 'Swd' });
  const boot = await session.flash({ image: elf, name: args.elf, format: 'elf', options: { verify: true } });
  console.log(`[${since()}] flashed ${args.elf} on ${probe.identifier}; boot ${JSON.stringify(boot)}`);

  dbg = session.debugger();
  const stops: string[] = [];
  dbg.addEventListener('stopped', (e) => stops.push(JSON.stringify((e as CustomEvent).detail.reason)));

  // Start the firmware and let it run a few iterations.
  await dbg.resetAndHalt();
  await dbg.continue();
  await sleep(1500);
  check('core runs after continue', (await dbg.refresh()) === 'running', dbg.state);

  // ---- run control, registers, memory
  const stop = await dbg.pause();
  check('pause halts with reason Request', dbg.state === 'halted' && stop.reason === 'Request', `pc ${hex(stop.pc)}`);
  check('pause reported a stopped event', stops.at(-1) === '"Request"', stops.join(', '));

  const regs = await dbg.readRegisters();
  const reg = (n: string) => regs.find((r) => r.info.name === n)?.value;
  const pc = reg('R15') ?? -1n;
  const sp = reg('R13') ?? -1n;
  check('registers: PC is in flash and matches the stop', pc > 0n && pc < 0x0010_0000n && pc === stop.pc, hex(pc));
  check('registers: SP is in RAM', sp >= 0x2000_0000n && sp < 0x3000_0000n, hex(sp));
  check('registers: xPSR has the Thumb bit', ((reg('XPSR') ?? 0n) & 0x0100_0000n) !== 0n, hex(reg('XPSR') ?? 0n));
  console.log(`[${since()}] ${regs.length} registers readable: ${regs.map((r) => r.info.name).join(' ')}`);

  const table = await dbg.readMemory(addr('TABLE'), 8);
  check('memory: TABLE bytes', Array.from(table).join(',') === [0x11, 0x11, 0x22, 0x22, 0x33, 0x33, 0x44, 0x44].join(','), Array.from(table, (b) => b.toString(16)).join(' '));

  const counterAt = addr('COUNTER');
  const readCounter = async () => new DataView((await dbg!.readMemory(counterAt, 4)).buffer).getUint32(0, true);
  const c1 = await readCounter();
  await dbg.continue();
  await sleep(1200);
  await dbg.pause();
  const c2 = await readCounter();
  check('memory: COUNTER advances while running', c2 > c1 && c1 > 0, `${c1} -> ${c2}`);

  // Register write round trip (R12 is scratch at a halt between calls; restore it).
  const r12 = (await dbg.readRegisters()).find((r) => r.info.name === 'R12')!.value;
  await dbg.writeRegister('R12', 0xa5a5_5a5an);
  const r12b = (await dbg.readRegisters()).find((r) => r.info.name === 'R12')!.value;
  await dbg.writeRegister('R12', r12);
  check('registers: write/read R12', r12b === 0xa5a5_5a5an, hex(r12b));

  // Memory write round trip in RAM: write COUNTER, read back, restore.
  const before = await dbg.readMemory(counterAt, 4);
  await dbg.writeMemory(counterAt, new Uint8Array([0xef, 0xbe, 0xad, 0xde]));
  const written = await readCounter();
  await dbg.writeMemory(counterAt, before);
  check('memory: write/read COUNTER', written === 0xdeadbeef, hex(written));

  const s1 = await dbg.step('instruction');
  check('step instruction moves PC', s1.pc !== pc && dbg.state === 'halted' && stops.at(-1) === '"Step"', `${hex(pc)} -> ${hex(s1.pc)}`);

  const rh = await dbg.resetAndHalt();
  const vtor = new DataView((await dbg.readMemory(4n, 4)).buffer).getUint32(0, true);
  check('reset-and-halt stops at the reset handler', rh.pc === BigInt(vtor & ~1), `pc ${hex(rh.pc)}, reset vector ${hex(vtor)}`);

  // Poller: continue, then let the poller (not our own call) observe a halt from outside.
  dbg.start();
  await dbg.continue();
  await sleep(300);
  await session.core(0).halt(); // bypasses the Debugger, as another tool would
  await sleep(500);
  check('poller reports an external halt', dbg.state === 'halted' && stops.at(-1) === '"Request"', `state ${dbg.state}, stops ${stops.join(', ')}`);
  await dbg.continue();

  // ---- debug info, stack trace, scopes/variables/evaluate/set_variable, SVD
  await dbg.loadDebugInfo(elf, args.elf);
  const stepB = addr('step_b') & ~1n;
  const bp = await session.core(0).raw.setHwBreakpoints(new BigUint64Array([stepB])); // raw call: the Debugger's breakpoint API is checked below
  check('hardware breakpoint set on step_b', JSON.stringify(bp) === '[{"Ok":null}]', JSON.stringify(bp));
  const nextStop = () => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no stop within 5 s')), 5000);
    dbg!.addEventListener('stopped', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  let stopped = nextStop();
  await stopped;
  check('breakpoint hit reported as a stop', typeof dbg.lastStop?.reason === 'object' && 'Breakpoint' in dbg.lastStop.reason && dbg.lastStop.pc === stepB, JSON.stringify(dbg.lastStop?.reason) + ' pc ' + hex(dbg.lastStop?.pc ?? 0n));

  const frames = await dbg.stackTrace();
  const names = frames.map((f) => f.functionName);
  check('stack: step_b <- step_a <- main', names[0] === 'step_b' && names[1] === 'step_a' && names[2] === '__cortex_m_rt_main', names.join(' <- '));
  check('stack: frame 0 source is main.rs', !!frames[0].source?.path.endsWith('cm33-debug/src/main.rs') && frames[0].source?.line !== null, JSON.stringify(frames[0].source));

  const scopeRef = async (frameId: number, name: string) => {
    const sc = (await dbg!.scopes(frameId)).find((x) => x.name === name);
    if (!sc) throw new Error(`no ${name} scope`);
    return sc.reference;
  };
  const child = async (ref: number, name: string): Promise<Variable> => {
    const v = (await dbg!.variables(ref)).find((x) => x.name === name);
    if (!v) throw new Error(`no ${name} under ${ref}`);
    return v;
  };
  const mainVars = await scopeRef(frames[2].id, 'Variables');
  const nVar = await child(mainVars, 'n');
  const n = Number(nVar.value);
  const bLocals = await scopeRef(frames[0].id, 'Variables');
  const point = await child(bLocals, 'point');
  const px = Number((await child(point.reference, 'x')).value);
  const py = Number((await child(point.reference, 'y')).value);
  check('variables: step_b point == {n, 2n}', n >= 1 && px === n && py === 2 * n, `n=${n} point={${px}, ${py}}`);
  const modeKids = (await dbg.variables((await child(bLocals, 'mode')).reference)).map((v) => v.name);
  const wantMode = n % 3 === 0 ? 'Idle' : 'Counting';
  check('variables: step_b mode variant', modeKids.includes(wantMode), `${modeKids.join(',')} (want ${wantMode})`);

  const statics = await scopeRef(frames[0].id, 'Static');
  const crate = await child(statics, 'cm33_debug');
  const counter = await child(crate.reference, 'COUNTER');
  check('statics: COUNTER == n - 1 at step_b entry', Number(counter.value) === n - 1, counter.value);
  const tableVals = (await dbg.variables((await child(crate.reference, 'TABLE')).reference)).map((v) => Number(v.value));
  check('statics: TABLE elements', tableVals.join(',') === '4369,8738,13107,17476', tableVals.join(','));

  const evCounter = await dbg.evaluate('COUNTER');
  const evR0 = await dbg.evaluate('R0');
  check('evaluate: COUNTER and R0 (= point.x)', Number(evCounter.value) === n - 1 && BigInt(evR0.value) === BigInt(n), `COUNTER=${evCounter.value} R0=${evR0.value}`);

  // Writes, proven on the next hit: main's n drives point.x; COUNTER is incremented by this call.
  await dbg.setVariable(nVar, '30');
  await dbg.setVariable(counter, '100');
  const nAfter = await child(mainVars, 'n');
  check('set_variable: main n reads back 30', nAfter.value === '30', nAfter.value);

  const staleRef = bLocals;
  stopped = nextStop();
  await dbg.continue();
  await stopped;
  const staleErr = await dbg.variables(staleRef).then(() => 'no error', (e) => (e as { kind?: string }).kind);
  check('stale variables reference refused after resuming', staleErr === 'stale-reference', staleErr);
  const frames2 = await dbg.stackTrace();
  const point2 = await child(await scopeRef(frames2[0].id, 'Variables'), 'point');
  const px2 = Number((await child(point2.reference, 'x')).value);
  const counter2 = Number((await dbg.evaluate('COUNTER')).value);
  // COUNTER is a static in RAM, so the firmware sees the write. main's `n` read back 30 above, but in an
  // unwound caller frame of optimised code its DWARF location is a stack slot while the loop keeps the
  // live value in a register, so the next call still gets n + 1 (a probe-rs/DWARF limitation).
  check('set_variable took effect in the firmware (static COUNTER)', counter2 === 101, `COUNTER=${counter2}, next point.x=${px2}`);

  // SVD: a two-register SCB subset; CPUID is readable on every Cortex-M.
  await dbg.loadSvd(new Uint8Array(await readFile(args.svd!)), args.svd);
  const periph = await scopeRef(frames2[0].id, 'Peripherals');
  const scb = await child(periph, 'SCB');
  const cpuid = await child(scb.reference, 'SCB.CPUID');
  const implementer = await child(cpuid.reference, 'SCB.CPUID.IMPLEMENTER');
  const cpuidWord = new DataView((await dbg.readMemory(0xe000ed00n, 4)).buffer).getUint32(0, true);
  check('SVD: Peripherals scope reads SCB.CPUID', BigInt(cpuid.value) === BigInt(cpuidWord), `${cpuid.value} vs memory ${hex(cpuidWord)}`);
  check('SVD: CPUID.IMPLEMENTER is Arm (0x41)', implementer.value.startsWith('01000001'), implementer.value);

  await session.core(0).raw.clearHwBreakpoints(new BigUint64Array([stepB]));

  // ---- breakpoints, stepping, disassembly, source locations
  const source = (await readFile(args.firmwareSrc!, 'utf8')).split('\n');
  const lineOf = (needle: string) => {
    const i = source.findIndex((l) => l.includes(needle));
    if (i < 0) throw new Error(`"${needle}" not in firmware source`);
    return i + 1;
  };
  const sumLine = lineOf('let sum = point.x + point.y;');
  const callLine = lineOf('let result = step_b(');
  const frame0 = async () => (await dbg!.stackTrace())[0];
  // Stepping can stop inside code inlined from core (wrapping_mul, black_box), which probe-rs reports as
  // its own frames; the enclosing real function is the first frame that is not inlined.
  const realFrame = async () => (await dbg!.stackTrace()).find((fr) => !fr.inlined)!;

  const [bpSum] = await dbg.setSourceBreakpoints('src/main.rs', [{ line: sumLine }]);
  check('source breakpoint verified at the requested line', bpSum.verified && bpSum.source?.line === sumLine && bpSum.address !== null, `line ${bpSum.source?.line} @ ${hex(bpSum.address ?? 0n)} ${bpSum.message ?? ''}`);
  stopped = nextStop();
  await dbg.continue();
  await stopped;
  let f = await frame0();
  check('continue stops at the source breakpoint', f.source?.line === sumLine && (dbg.lastStop?.breakpoints ?? []).includes(bpSum.id), `${f.functionName}:${f.source?.line} bps ${dbg.lastStop?.breakpoints}`);

  const beforeOver = dbg.lastStop!.pc;
  await dbg.step('over');
  f = await frame0();
  const fr = await realFrame();
  check('step over advances within step_b', fr.functionName === 'step_b' && dbg.lastStop!.pc !== beforeOver, `in ${fr.functionName} (top frame ${f.functionName}${f.inlined ? ', inlined' : ''}:${f.source?.line})`);

  await dbg.setSourceBreakpoints('src/main.rs', [{ line: callLine }]);
  check('replacing a file\'s breakpoints leaves one', dbg.breakpoints().length === 1 && dbg.breakpoints()[0].line === callLine, JSON.stringify(dbg.breakpoints().map((b) => b.line)));
  stopped = nextStop();
  await dbg.continue();
  await stopped;
  f = await frame0();
  check('stops at the call site in step_a', f.functionName === 'step_a' && f.source?.line === callLine, `${f.functionName}:${f.source?.line}`);
  await dbg.step('into');
  f = await realFrame();
  check('step into enters step_b', f.functionName === 'step_b', `${f.functionName}:${f.source?.line}`);
  await dbg.step('out');
  f = await realFrame();
  check('step out returns to step_a', f.functionName === 'step_a', `${f.functionName}:${f.source?.line}`);

  await dbg.setSourceBreakpoints('src/main.rs', []);
  const stepA = addr('step_a') & ~1n;
  const [ibp] = await dbg.setInstructionBreakpoints([stepA]);
  check('instruction breakpoint has a source location', ibp.verified && !!ibp.source?.path.endsWith('main.rs'), JSON.stringify(ibp.source));
  stopped = nextStop();
  await dbg.continue();
  await stopped;
  check('continue stops at the instruction breakpoint', dbg.lastStop?.pc === stepA && dbg.lastStop.breakpoints.includes(ibp.id), `pc ${hex(dbg.lastStop?.pc ?? 0n)}`);

  const insns = await dbg.disassemble(stepA, 6);
  check('disassembly starts at pc with text and source lines', insns[0]?.address === stepA && insns.every((i) => i.text.length > 0) && insns.some((i) => i.source?.line), insns.map((i) => `${hex(i.address)} ${i.text}${i.source?.line ? ` (:${i.source.line})` : ''}`).join(' | '));
  const back = await dbg.disassemble(stepA, 3, -2);
  // DAP semantics: offset -2, count 3 = the two instructions before the address, then the address itself.
  check('disassembly with a negative instruction offset', back.length === 3 && back[2].address === stepA && back[0].address < back[1].address && back[1].address < stepA, back.map((i) => hex(i.address)).join(' '));

  const [loc] = await dbg.resolveSourceLocations([stepB]);
  check('resolve source location of step_b', !!loc?.path.endsWith('main.rs') && Math.abs((loc?.line ?? 0) - lineOf('pub fn step_b(')) <= 1, JSON.stringify(loc));

  // Comparator budget: ask for more hardware breakpoints than the core has.
  const many = Array.from({ length: 10 }, (_, i) => stepA + BigInt(2 * i));
  const placed = await dbg.setInstructionBreakpoints(many);
  const ok = placed.filter((b) => b.verified).length;
  check('comparator budget reported per breakpoint', ok >= 2 && ok < 10 && placed.filter((b) => !b.verified).every((b) => !!b.message), `${ok}/10 verified; first failure: ${placed.find((b) => !b.verified)?.message}`);

  await dbg.clearBreakpoints();
  await dbg.continue();
  await sleep(800);
  check('no breakpoints left: the core keeps running', (await dbg.refresh()) === 'running', dbg.state);
} catch (e) {
  console.error(`[${since()}] error: ${(e as Error).stack ?? e}`);
  failures++;
} finally {
  dbg?.dispose();
  client.close();
}
console.log(failures ? `DEBUG_RESULT=FAIL (${failures})` : 'DEBUG_RESULT=PASS');
process.exit(failures ? 1 : 0);

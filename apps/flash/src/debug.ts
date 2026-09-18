// Test page for the Phase 3 debugger components.
//   ?fake=1                     scripted FakeDebugger (Playwright)
//   ?auto=1&token=spike&probe=mcu&chip=MCXA153&elf=/firmware/mcxa153-debug.elf&line=40
//                               real target over WebSocket to probe-rs serve: flash, break at src/main.rs:<line>
import '@probe-web/ui';
import { Client, openSession, type Debugger } from '@probe-web/client';
import { createFakeLocalWorker } from '@probe-web/client/testing/worker';
import { FakeDebugger } from '@probe-web/client/testing';
import type { Frame } from '@probe-web/client';
import type { ProbeBreakpoints, ProbeCallstack, ProbeCoreControls, ProbeDisassembly, ProbeMemoryView, ProbePeripherals, ProbeRegisters, ProbeVariables } from '@probe-web/ui';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $('log');
const log = (m: string) => { logEl.textContent += m + '\n'; console.log('[debug-ui] ' + m); };
const qs = new URLSearchParams(location.search);

const controls = $<ProbeCoreControls>('controls');
const stack = $<ProbeCallstack>('stack');
const vars = $<ProbeVariables>('vars');
const regs = $<ProbeRegisters>('regs');
const bps = $<ProbeBreakpoints>('bps');
const dis = $<ProbeDisassembly>('dis');
const periph = $<ProbePeripherals>('periph');
const mem = $<ProbeMemoryView>('mem');
stack.addEventListener('frame-selected', (e) => { vars.frame = (e as CustomEvent<Frame>).detail; });

function use(d: Debugger) {
  controls.debugger = d;
  stack.debugger = d;
  vars.debugger = d;
  regs.debugger = d;
  bps.debugger = d;
  dis.debugger = d;
  periph.debugger = d;
  mem.debugger = d;
  d.addEventListener('stopped', (e) => log(`stopped: ${JSON.stringify((e as CustomEvent).detail, (_, v) => (typeof v === 'bigint' ? '0x' + v.toString(16) : v))}`));
  d.addEventListener('continued', () => log('continued'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shadow = (el: Element) => el.shadowRoot!;

if (qs.get('webusb-fake') === 'core') {
  // Phase 4: the worker's core endpoints against the fake probe's mocked core (raw calls).
  void (async () => {
    const checks: [string, boolean, string][] = [];
    const check = (name: string, ok: boolean, detail: unknown) => { checks.push([name, ok, JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? `0x${v.toString(16)}` : v))]); log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${checks.at(-1)![2]}`); };
    const attempt = async <T,>(name: string, fn: () => Promise<T>, ok: (v: T) => boolean) => {
      try { const v = await fn(); check(name, ok(v), v); } catch (e) { check(name, false, `threw: ${(e as Error).message ?? e}`); }
    };
    try {
      const client = await Client.connect({ kind: 'webusb', worker: createFakeLocalWorker() });
      const probe = (await client.listProbes()).find((p) => p.serial_number === 'fake')!;
      const session = await client.attach({ probe, chip: 'MCXA153' });
      for (const path of ['cores/halt', 'cores/resume', 'cores/status', 'core/step', 'core/write_reg', 'core/set_hw_bps', 'core/clear_hw_bps', 'core/enable_vc', 'core/metadata', 'core/read_registers', 'debug_state/load_debug_info', 'stack_trace/rich', 'stack_trace/scopes', 'stack_trace/variables', 'stack_trace/evaluate', 'stack_trace/set_variable', 'debug_state/clear_core', 'debug_state/resolve_source_breakpoints', 'debug_state/resolve_source_locations', 'debug_state/load_svd', 'core/dump'] as const) {
        check(`worker advertises ${path}`, session.supports(path), session.supports(path));
      }
      const raw = session.raw;
      const core = raw.core(0);
      await attempt('cores/halt reports the core halted', () => raw.haltCores(null, 500) as Promise<{ statuses: [number, unknown][] }>, (r) => r.statuses.length === 1 && JSON.stringify(r.statuses[0][1]).includes('Halted'));
      await attempt('core/step (instruction) returns a status', () => raw.step(0, 'StepInstruction') as Promise<{ status: unknown }>, (r) => !!r.status);
      await attempt('core/metadata reports Thumb-2', () => core.metadata() as Promise<{ instruction_set: string }>, (r) => r.instruction_set === 'Thumb2');
      await attempt('core/read_registers answers one result per register', () => core.readRegisters(new Uint16Array([0, 1, 15])) as Promise<unknown[]>, (r) => r.length === 3);
      await attempt('core/set_hw_bps answers one result per address', () => core.setHwBreakpoints(new BigUint64Array([0x1000n, 0x1000n])) as Promise<unknown[]>, (r) => r.length === 2);
      await attempt('core/clear_hw_bps on an address without a breakpoint succeeds', () => core.clearHwBreakpoints(new BigUint64Array([0x2000n])), () => true);
      await attempt('stack_trace/rich without debug info is an error, not a crash', () => raw.richStackTrace(0, 10).then(() => 'resolved', (e) => `error: ${(e as Error).message}`), (r) => String(r).startsWith('error: no debug info'));
      await attempt('core/dump returns registers and the requested memory', () => core.dumpCore([[0x20000000n, 0x20000010n]]) as Promise<{ registers: unknown[]; data: [unknown, number[]][] }>, (r) => r.registers.length > 10 && r.data.length === 1 && r.data[0][1].length === 16);
      // The coredump *file*: a MessagePack map whose keys are probe-rs's field names. If
      // those drift, a dump taken here stops opening in probe-rs, and only the shape of
      // the bytes can catch that without hardware (`cargo run -p probe-web-local
      // --example check-coredump` is the full check).
      await attempt('core/dump encodes a probe-rs coredump file', () => core.dumpCoreFile([[0x20000000n, 0x20000010n]]) as Promise<Uint8Array>, (bytes) => {
        const text = new TextDecoder('latin1').decode(bytes);
        return bytes.length > 64 && bytes[0] === 0x87 && ['registers', 'data', 'instruction_set', 'supports_native_64bit_access', 'core_type', 'floating_point_register_count', 'fpu_support'].every((k) => text.includes(k));
      });
      check('worker does not advertise core/disassemble', !session.supports('core/disassemble'), session.supports('core/disassemble'));
      await attempt('cores/resume reports the core running', () => raw.resumeCores(null) as Promise<{ statuses: [number, unknown][] }>, (r) => r.statuses.length === 1 && JSON.stringify(r.statuses[0][1]).includes('Running'));
      await attempt('cores/status still answers afterwards', () => raw.coresStatus(null) as Promise<{ statuses: unknown[] }>, (r) => r.statuses.length === 1);
      client.close();
    } catch (e) {
      check('no errors', false, (e as Error).stack ?? String(e));
    }
    log(`CORE_RESULT=${checks.length && checks.every((c) => c[1]) ? 'PASS' : 'FAIL'}`);
  })();
} else if (qs.has('webusb-fake')) {
  // The WebUSB worker (fake probe) serves the debug endpoints: debugger() is available there too.
  void (async () => {
    const client = await Client.connect({ kind: 'webusb', worker: createFakeLocalWorker() });
    const probe = (await client.listProbes()).find((p) => p.serial_number === 'fake')!;
    const session = await client.attach({ probe, chip: 'MCXA153' });
    try {
      const d = session.debugger();
      use(d);
      const stop = await d.pause();
      log(`debugger(): available; pause → ${JSON.stringify(stop.reason)}`);
      await sleep(300);
      log(`disassembly panel: ${shadow(dis).querySelector('.unavailable')?.textContent?.trim() ?? '(no notice)'}`);
      d.dispose();
      log('DEBUGGER_RESULT=PASS');
    } catch (e) {
      const err = e as { kind?: string; message: string };
      log(`debugger(): ${err.kind}: ${err.message}`);
      log('DEBUGGER_RESULT=FAIL');
    }
    client.close();
  })();
} else if (qs.get('spike') === 'webusb-src') {
  // Phase 4 slice 4: the SDK Debugger over WebUSB — source breakpoints, stack, variables, stepping.
  //   ?spike=webusb-src&probe=mcu&chip=MCXA153&elf=/firmware/mcxa153-debug.elf&src=/@fs/…/cm33-debug/src/main.rs
  void (async () => {
    const checks: [string, boolean, string][] = [];
    const check = (name: string, ok: boolean, detail: string) => { checks.push([name, ok, detail]); log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`); };
    try {
      const t0 = performance.now();
      const client = await Client.connect({ kind: 'webusb' });
      addEventListener('pagehide', () => client.close());
      const want = (qs.get('probe') ?? '').toLowerCase();
      const probe = (await client.listProbes()).find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want));
      if (!probe) throw new Error(`no granted probe matching ${want}`);
      const session = await client.attach({ probe, chip: qs.get('chip') ?? undefined, protocol: (qs.get('protocol') as 'Swd' | 'Jtag') ?? 'Swd' });
      log(`attached ${probe.identifier}`);
      const elfUrl = qs.get('elf')!;
      const elf = new Uint8Array(await (await fetch(elfUrl)).arrayBuffer());
      await session.flash({ image: elf, name: elfUrl, format: (qs.get('format') as 'elf') ?? 'elf', options: { verify: true } });
      log('flashed');
      const source = (await (await fetch(qs.get('src')!)).text()).split('\n');
      const srcPath = qs.get('srcPath') ?? 'src/main.rs';
      const lineOf = (needle: string) => source.findIndex((l) => l.includes(needle)) + 1;
      const sumLine = lineOf('let sum = point.x + point.y;');
      const callLine = lineOf('let result = step_b(');
      const d = session.debugger();
      (window as unknown as { dbg: Debugger }).dbg = d;
      const nextStop = () => new Promise<void>((r) => d.addEventListener('stopped', () => r(), { once: true }));
      let t = performance.now();
      await d.loadDebugInfo(elf, elfUrl);
      log(`debug info loaded in ${Math.round(performance.now() - t)} ms`);
      // Slice 7: RTT output while debugging (rtt/poll_up in the worker).
      let rttText = '';
      d.addEventListener('output', (e) => { const o = (e as CustomEvent).detail as { source: string; text: string }; if (o.source === 'rtt') rttText += o.text; });
      await d.enableRtt({ elf });
      d.start();
      await d.resetAndHalt();

      const [bp] = await d.setSourceBreakpoints(srcPath, [{ line: sumLine }]);
      check('source breakpoint verified at the requested line', bp.verified && bp.source?.line === sumLine, `line ${bp.source?.line} @ 0x${bp.address?.toString(16)} ${bp.message ?? ''}`);
      let stopped = nextStop();
      t = performance.now();
      await d.continue();
      await stopped;
      const frames = await d.stackTrace();
      log(`stopped in ${Math.round(performance.now() - t)} ms; stack trace: ${frames.map((f) => `${f.functionName}${f.inlined ? '(inlined)' : ''}:${f.source?.line}`).join(' <- ')}`);
      const real = frames.filter((f) => !f.inlined);
      check('stops at the breakpoint in step_b, called from step_a', real[0]?.functionName === 'step_b' && frames[0].source?.line === sumLine && real[1]?.functionName === 'step_a', real.slice(0, 3).map((f) => f.functionName).join(' <- '));
      const scopes = await d.scopes(real[0].id);
      const localsRef = scopes.find((sc) => sc.name === 'Variables')!.reference;
      const locals = await d.variables(localsRef);
      const point = locals.find((v) => v.name === 'point');
      const fields = point ? await d.variables(point.reference) : [];
      const x = Number(fields.find((v) => v.name === 'x')?.value);
      const y = Number(fields.find((v) => v.name === 'y')?.value);
      check('point = {n, 2n} in step_b', !!point && x > 0 && y === 2 * x, `point.x=${x} point.y=${y}; locals ${locals.map((v) => `${v.name}: ${v.type}`).join(', ')}`);

      // Slice 6: evaluate and set_variable (a static in RAM, so the firmware sees the write).
      const staticsRef = (await d.scopes(real[0].id)).find((sc) => sc.name === 'Static')!.reference;
      const crate = (await d.variables(staticsRef)).find((v) => v.name.includes('debug'));
      const counterVar = crate ? (await d.variables(crate.reference)).find((v) => v.name === 'COUNTER') : undefined;
      const evCounter = await d.evaluate('COUNTER');
      // The first argument register holds point.x under the Cortex-M ABI; on Xtensa the argument
      // has already been moved out of a2 by this point, so only require that the register reads.
      const table = await d.registerTable();
      const argReg = table.find((r) => r.roles.includes('Argument'));
      const evReg = await d.evaluate(argReg?.name ?? 'R0');
      const regValue = /^(0x)?[0-9a-f]+$/i.test(evReg.value.trim()) ? BigInt(evReg.value) : null;
      const regOk = argReg?.name === 'R0' ? regValue === BigInt(x) : regValue !== null;
      check(`evaluate COUNTER (static) and ${argReg?.name ?? 'R0'} (register)`, counterVar !== undefined && evCounter.value === counterVar.value && regOk, `COUNTER=${evCounter.value} (Static scope ${counterVar?.value}) ${argReg?.name}=${evReg.value}`);
      if (counterVar) {
        await d.setVariable(counterVar, '100');
        const after = await d.evaluate('COUNTER');
        check('set_variable COUNTER reads back', Number(after.value) === 100, after.value);
      }

      const before = d.lastStop!.pc;
      await d.step('over');
      const afterOver = (await d.stackTrace()).find((f) => !f.inlined)!;
      check('step over stays in step_b and moves the PC', afterOver.functionName === 'step_b' && d.lastStop!.pc !== before, `${afterOver.functionName}:${afterOver.source?.line}`);

      await d.setSourceBreakpoints(srcPath, [{ line: callLine }]);
      stopped = nextStop();
      await d.continue();
      await stopped;
      const atCall = (await d.stackTrace())[0];
      check('stops at the call site in step_a', atCall.functionName === 'step_a' && atCall.source?.line === callLine, `${atCall.functionName}:${atCall.source?.line}`);
      await d.step('into');
      const into = (await d.stackTrace()).find((f) => !f.inlined)!;
      check('step into enters step_b', into.functionName === 'step_b', `${into.functionName}:${into.source?.line}`);
      await d.step('out');
      const out = (await d.stackTrace()).find((f) => !f.inlined)!;
      check('step out returns to step_a', out.functionName === 'step_a', `${out.functionName}:${out.source?.line}`);

      await d.setSourceBreakpoints(srcPath, []);
      await d.continue();
      await sleep(1000);
      check('continue without breakpoints keeps running', (await d.refresh()) !== 'halted', d.state);
      await sleep(2500);
      const rttLines = rttText.split('\n').filter((l) => /^n=\d+ result=/.test(l));
      check('RTT output arrives as Debugger output events while running', rttLines.length >= 2, rttLines.slice(-3).join(' | '));
      d.dispose();
      log(`SRC_RESULT=${checks.every((c) => c[1]) ? 'PASS' : 'FAIL'} (${checks.filter((c) => c[1]).length}/${checks.length}) in ${Math.round(performance.now() - t0)} ms`);
      client.close();
    } catch (e) {
      log(`error: ${(e as Error).stack ?? e}`);
      log('SRC_RESULT=FAIL');
    }
  })();
} else if (qs.get('spike') === 'webusb-semi') {
  // Phase 4 slice 7: semihosting serviced by the worker while the SDK `Debugger` runs the target.
  //   ?spike=webusb-semi&probe=j-link&chip=nRF9160_xxAA&elf=/firmware/nrf9160-semihosting.elf
  void (async () => {
    const checks: [string, boolean, string][] = [];
    const check = (name: string, ok: boolean, detail: string) => { checks.push([name, ok, detail]); log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`); };
    try {
      const t0 = performance.now();
      const client = await Client.connect({ kind: 'webusb' });
      addEventListener('pagehide', () => client.close());
      const want = (qs.get('probe') ?? '').toLowerCase();
      const probe = (await client.listProbes()).find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want));
      if (!probe) throw new Error(`no granted probe matching ${want}`);
      const session = await client.attach({ probe, chip: qs.get('chip') ?? undefined, protocol: (qs.get('protocol') as 'Swd' | 'Jtag') ?? 'Swd' });
      const elfUrl = qs.get('elf')!;
      const elf = new Uint8Array(await (await fetch(elfUrl)).arrayBuffer());
      // `&flash=0` reuses what is already on the target (to tell a flashing side effect from a
      // debugging one).
      if (qs.get('flash') !== '0') {
        await session.flash({ image: elf, name: elfUrl, format: (qs.get('format') as 'elf') ?? 'elf', options: { verify: true } });
        log('flashed');
      }

      const d = session.debugger();
      (window as unknown as { dbg: Debugger }).dbg = d;
      let text = '';
      d.addEventListener('output', (e) => {
        const o = (e as CustomEvent).detail as { source: string; text: string };
        if (o.source === 'semihosting') text += o.text;
      });
      d.start();
      const afterReset = await d.resetAndHalt();
      log(`reset and halt: pc 0x${afterReset.pc.toString(16)}`);
      // Only stops after the program is running count; reset-and-halt is a stop of its own.
      const stopped = new Promise<string>((r) => d.addEventListener('stopped', (e) => {
        const detail = (e as CustomEvent).detail as { reason: unknown; pc?: bigint };
        r(`${JSON.stringify(detail.reason)} @ 0x${(detail.pc ?? 0n).toString(16)}`);
      }, { once: true }));
      await d.continue();
      const reason = await Promise.race([stopped, sleep(Number(qs.get('timeout') ?? 20) * 1000).then(() => 'timeout')]);
      // If the halt was not recognised as semihosting, ask the worker to service it directly: that
      // separates "the worker cannot service semihosting" from "the halt reason did not say it is".
      if (!text) {
        const raw = (session.core(0) as unknown as { raw: { handleSemihosting(): Promise<unknown> } }).raw;
        const serviced = (await raw.handleSemihosting()) as { status: unknown; events: unknown[] };
        log(`handle_semihosting directly: ${JSON.stringify(serviced).slice(0, 300)}`);
      }
      const expected = ['nrf9160-semihosting: hello over semihosting', 'stdout line 0', 'stdout line 1', 'stdout line 2', 'stderr line', 'exiting with success'];
      const missing = expected.filter((l) => !text.includes(l));
      check('every semihosting line arrived as a Debugger output event', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : text.split('\n').filter(Boolean).join(' | '));
      check('the run ended with the firmware exit, not a timeout', reason !== 'timeout', reason);
      d.dispose();
      log(`SEMI_RESULT=${checks.every((c) => c[1]) ? 'PASS' : 'FAIL'} (${checks.filter((c) => c[1]).length}/${checks.length}) in ${Math.round(performance.now() - t0)} ms`);
      client.close();
    } catch (e) {
      log(`error: ${(e as Error).stack ?? e}`);
      log('SEMI_RESULT=FAIL');
    }
  })();
} else if (qs.get('spike') === 'webusb') {
  // Phase 4 spike: DWARF + rich stack trace inside the WebUSB worker (raw calls; no Debugger yet).
  //   ?spike=webusb&probe=mcu&chip=MCXA153&elf=/firmware/mcxa153-debug.elf
  void (async () => {
    try {
      const client = await Client.connect({ kind: 'webusb' });
      addEventListener('pagehide', () => client.close());
      const want = (qs.get('probe') ?? '').toLowerCase();
      const probe = (await client.listProbes()).find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want));
      if (!probe) throw new Error(`no granted probe matching ${want}`);
      const session = await client.attach({ probe, chip: qs.get('chip') ?? undefined, protocol: (qs.get('protocol') as 'Swd' | 'Jtag') ?? 'Swd' });
      const elfUrl = qs.get('elf')!;
      const elf = new Uint8Array(await (await fetch(elfUrl)).arrayBuffer());
      let t = performance.now();
      await session.flash({ image: elf, name: elfUrl, format: (qs.get('format') as 'elf') ?? 'elf', options: { verify: true } });
      log(`flashed in ${Math.round(performance.now() - t)} ms`);
      const core = session.core(0);
      await core.resetAndHalt();
      await core.run();
      await sleep(1500);
      await core.halt();
      if (qs.has('core')) {
        // Slice 2: run control, registers and a hardware breakpoint on `step_b` through the worker.
        const { elfSymbol } = await import('@probe-web/client');
        const rawCore = session.raw.core(0);
        const meta = (await rawCore.metadata()) as { instruction_set: string };
        log(`metadata: ${JSON.stringify(meta)}`);
        const stepB = elfSymbol(elf, 'step_b');
        if (stepB === undefined) throw new Error('no step_b symbol');
        const set = (await rawCore.setHwBreakpoints(new BigUint64Array([stepB]))) as unknown[];
        log(`set_hw_bps ${stepB.toString(16)}: ${JSON.stringify(set)}`);
        await session.raw.resumeCores(null);
        let st: unknown = null;
        for (let i = 0; i < 30; i++) { await sleep(100); st = await core.status(); if (JSON.stringify(st).includes('Halted')) break; }
        const regs = (await rawCore.readRegisters(new Uint16Array([0, 1]))) as { result: unknown }[];
        const pcReg = (await session.raw.step(0, 'StepInstruction')) as { program_counter: bigint };
        log(`status after continue: ${JSON.stringify(st)}; registers 0,1: ${JSON.stringify(regs.map((r) => r.result))}; instruction step → pc 0x${pcReg.program_counter.toString(16)}`);
        const halted = JSON.stringify(st).includes('Breakpoint');
        await rawCore.clearHwBreakpoints(new BigUint64Array([stepB]));
        const cleared = (await session.raw.resumeCores(null)) as { statuses: [number, unknown][] };
        await sleep(1500);
        const stillRunning = JSON.stringify(await core.status()).includes('Running');
        log(`cleared; running after resume: ${stillRunning} (${JSON.stringify(cleared)})`);
        log(`CORE_HW_RESULT=${set.every((r) => JSON.stringify(r).includes('Ok')) && halted && stillRunning ? 'PASS' : 'FAIL'}`);
        await core.halt();
      }
      t = performance.now();
      await session.raw.loadDebugInfo(elf, elfUrl);
      log(`loadDebugInfo (${elf.length} bytes, upload + parse) in ${Math.round(performance.now() - t)} ms`);
      t = performance.now();
      const traces = (await session.raw.richStackTrace(0, 50)) as { cores: { core: number; frames: { function_name: string; id: number; location: { file: string; line: bigint | null } | null; registers: unknown[] }[] }[] };
      const frames = traces.cores[0]?.frames ?? [];
      log(`richStackTrace in ${Math.round(performance.now() - t)} ms: ${frames.map((f) => `${f.function_name}${f.location ? `:${f.location.line}` : ''} #${f.id}`).join(' <- ')}`);
      // The innermost frames must be named and reach `main`; the fork's older Xtensa unwinder may
      // continue past the entry trampoline into unnamed ROM frames (tracked for Phase 4 slice 10).
      const mainAt = frames.findIndex((f) => /main/.test(f.function_name));
      const ok = mainAt >= 0 && frames.slice(0, mainAt + 1).every((f) => !f.function_name.startsWith('<unknown')) && frames.every((f) => f.id > 0 && f.registers.length > 0);
      log(`SPIKE_RESULT=${ok ? 'PASS' : 'FAIL'}`);
      if (qs.has('vars')) {
        // Slice 3: stop in step_b, then scopes, variables, struct expansion and clear_core.
        const { elfSymbol } = await import('@probe-web/client');
        const rawCore = session.raw.core(0);
        type V = { name: string; value: string; variables_reference: bigint | number; type_: string | null };
        type S = { name: string; variables_reference: bigint | number };
        const stepB = elfSymbol(elf, 'step_b')!;
        log('vars step: clear_core');
        await session.raw.clearCoreDebugState(0);
        log('vars step: set bp');
        await rawCore.setHwBreakpoints(new BigUint64Array([stepB]));
        log('vars step: run');
        await core.run();
        await sleep(200); // the status can still read the old halt right after `run`
        for (let i = 0; i < 30 && !JSON.stringify(await core.status()).includes('Breakpoint'); i++) await sleep(100);
        log('vars step: clear bp');
        await rawCore.clearHwBreakpoints(new BigUint64Array([stepB]));
        // The symbol address is the function's first instruction; on Xtensa its `entry` has not
        // rotated the register window yet, so the DWARF argument locations (a2, a3) are not valid
        // until one instruction later (source breakpoints land after the prologue anyway).
        await session.raw.step(0, 'StepInstruction');
        log('vars step: trace');
        const trace = (await session.raw.richStackTrace(0, 20)) as { cores: { frames: { function_name: string; id: number }[] }[] };
        const tframes = trace.cores[0].frames;
        log(`stopped: ${tframes.slice(0, 4).map((f) => `${f.function_name} #${f.id}`).join(' <- ')}`);
        const frame = tframes.find((f) => f.function_name === 'step_b')!;
        log('vars step: scopes');
        const scopes = (await session.raw.scopes(0, frame.id)) as S[];
        log(`scopes: ${scopes.map((sc) => `${sc.name}=${sc.variables_reference}`).join(', ')}`);
        const registersScope = scopes.find((sc) => sc.name === 'Registers');
        log('vars step: registers');
        const regs = (await session.raw.variables(0, Number(registersScope!.variables_reference), null)) as V[];
        const localsScope = scopes.find((sc) => sc.name === 'Variables')!;
        log('vars step: locals');
        const locals = (await session.raw.variables(0, Number(localsScope.variables_reference), null)) as V[];
        log(`registers: ${regs.length} (${regs.map((v) => `${v.name}=${v.value}`).join(' ')}); locals: ${locals.map((v) => `${v.name}: ${v.type_} = ${v.value}`).join('; ')}`);
        const point = locals.find((v) => v.name === 'point');
        log('vars step: fields');
        const fields = point && Number(point.variables_reference) ? ((await session.raw.variables(0, Number(point.variables_reference), null)) as V[]) : [];
        log(`point fields: ${fields.map((v) => `${v.name}=${v.value}`).join(' ')}`);
        const staticScope = scopes.find((sc) => sc.name === 'Static');
        await session.raw.clearCoreDebugState(0);
        const afterClear = await (session.raw.scopes(0, frame.id) as Promise<unknown>).then((r) => `resolved ${JSON.stringify(r)}`, (e) => `error: ${(e as Error).message}`);
        const again = (await session.raw.richStackTrace(0, 20)) as { cores: { frames: { function_name: string }[] }[] };
        log(`after clear_core: scopes → ${afterClear}; new trace top ${again.cores[0].frames[0]?.function_name}`);
        const x = fields.find((v) => v.name === 'x')?.value;
        const y = fields.find((v) => v.name === 'y')?.value;
        const varsOk = !!registersScope && Number(registersScope.variables_reference) === frame.id && regs.length > 4 && !!staticScope
          && !!point && x !== undefined && y !== undefined && Number(y) === 2 * Number(x) && (afterClear.startsWith('error') || afterClear === 'resolved []') && again.cores[0].frames.length > 0;
        log(`VARS_RESULT=${varsOk ? 'PASS' : 'FAIL'}`);
      }
      await core.run();
      client.close();
    } catch (e) {
      log(`spike error: ${(e as Error).stack ?? e}`);
      log('SPIKE_RESULT=FAIL');
    }
  })();
} else if (qs.has('fake')) {
  const fake = new FakeDebugger();
  (window as unknown as { fake: FakeDebugger }).fake = fake;
  use(fake as unknown as Debugger);
  log('fake debugger ready');
} else if (qs.has('auto')) {
  void (async () => {
    const t0 = performance.now();
    try {
      // `transport=webusb` debugs through the in-page worker (the probe must be granted to this
      // origin); otherwise through probe-rs serve over WebSocket.
      const transport = qs.get('transport') === 'webusb' ? 'webusb' : 'websocket';
      const { client, session, probe } = await openSession({
        transport,
        url: qs.get('url') ?? undefined,
        token: qs.get('token') ?? '',
        probe: qs.get('probe') ?? '',
        chip: qs.get('chip') ?? undefined,
        protocol: (qs.get('protocol') as 'Swd' | 'Jtag' | null) ?? 'Swd',
      });
      // Close the connection when the page goes away (reloads included), so the probe is released.
      addEventListener('pagehide', () => client.close());
      log(`attached via ${transport}: ${probe.identifier}`);
      const elfUrl = qs.get('elf')!;
      const elf = new Uint8Array(await (await fetch(elfUrl)).arrayBuffer());
      await session.flash({ image: elf, name: elfUrl, format: (qs.get('format') as 'elf' | null) ?? 'elf', options: { verify: true } });
      const d = session.debugger();
      (window as unknown as { dbg: Debugger }).dbg = d;
      use(d);
      await d.loadDebugInfo(elf, elfUrl);
      d.start();
      await d.resetAndHalt();
      const line = Number(qs.get('line') ?? 40);
      const [bp] = await d.setSourceBreakpoints('src/main.rs', [{ line }]);
      log(`breakpoint: ${bp.verified ? `line ${bp.source?.line}` : bp.message}`);
      const hit = new Promise<void>((r) => d.addEventListener('stopped', () => r(), { once: true }));
      await d.continue();
      await hit;
      await sleep(1500);

      const frames = [...shadow(stack).querySelectorAll('tr[data-frame]')].map((r) => r.getAttribute('data-frame'));
      const selected = shadow(stack).querySelector('tr.selected')?.getAttribute('data-frame');
      const pointRow = shadow(vars).querySelector('[data-path="Variables/point"]');
      // Expand point through the UI.
      (pointRow?.querySelector('.twisty') as HTMLElement | null)?.click();
      await sleep(800);
      const x = shadow(vars).querySelector('[data-path="Variables/point/x"] .value')?.textContent?.trim();
      const pcRow = shadow(regs).querySelector('tr[data-register="R15"] .value')?.textContent?.trim();
      const state = shadow(controls).querySelector('.state')?.textContent?.replace(/\s+/g, ' ').trim();
      const pc = d.lastStop!.pc;
      const checks: [string, boolean, string][] = [
        ['callstack lists step_b, step_a', frames.includes('step_b') && frames.includes('step_a'), frames.join(' <- ')],
        ['callstack selects the first real frame', selected === 'step_b', String(selected)],
        ['variables show point and expand to x', !!pointRow && x !== undefined && Number(x) >= 1, `x=${x}`],
        ['registers show PC at the stop', pcRow === '0x' + pc.toString(16).padStart(8, '0'), `${pcRow} vs ${pc.toString(16)}`],
        ['controls show the breakpoint stop', !!state && state.includes('halted') && state.includes('breakpoint'), String(state)],
      ];
      // Step over from the controls and check the panels follow.
      (shadow(controls).querySelector('button[title="Step over"]') as HTMLButtonElement).click();
      await sleep(1500);
      const pcAfter = shadow(regs).querySelector('tr[data-register="R15"] .value');
      checks.push(['step over (button) updates registers with a change mark', !!pcAfter && pcAfter.classList.contains('changed') && pcAfter.textContent!.trim() !== pcRow, `${pcAfter?.textContent?.trim()}`]);
      // Slice 5 components.
      const bpRow = shadow(bps).querySelector(`tr[data-breakpoint="${bp.id}"]`);
      checks.push(['breakpoints panel lists the verified breakpoint with its address', !!bpRow && bpRow.textContent!.includes('●') && bpRow.textContent!.includes(`main.rs:${line}`) && bpRow.textContent!.includes(bp.address!.toString(16)), bpRow?.textContent?.replace(/\s+/g, ' ').trim() ?? 'missing']);
      if (d.canDisassemble) {
        const pcNow = d.lastStop!.pc;
        const pcHex = '0x' + pcNow.toString(16).padStart(8, '0');
        await dis.refresh();
        await sleep(300);
        const pcLine = shadow(dis).querySelector('tr.pc');
        checks.push(['disassembly highlights the PC row', pcLine?.getAttribute('data-address') === pcHex, `${pcLine?.getAttribute('data-address')} vs ${pcHex}: ${pcLine?.querySelector('.text')?.textContent}`]);
        // Toggle an instruction breakpoint from the gutter on the row after the PC, then remove it again.
        const nextRow = pcLine?.nextElementSibling?.classList.contains('src') ? pcLine.nextElementSibling.nextElementSibling : pcLine?.nextElementSibling;
        (nextRow?.querySelector('.gutter') as HTMLElement | null)?.click();
        await sleep(600);
        const instr = d.breakpoints().filter((b) => b.kind === 'instruction');
        checks.push(['disassembly gutter sets an instruction breakpoint', instr.length === 1 && instr[0].verified && '0x' + instr[0].address!.toString(16).padStart(8, '0') === nextRow?.getAttribute('data-address'), `${instr.map((b) => b.address!.toString(16))}`]);
        await d.setInstructionBreakpoints([]);
      } else {
        const text = shadow(dis).querySelector('.unavailable')?.textContent ?? '';
        checks.push(['disassembly panel says it is not available on this connection', text.includes('not available'), text.trim()]);
        // Instruction breakpoints still work without a disassembler.
        const pcNow = d.lastStop!.pc;
        const [ibp] = await d.setInstructionBreakpoints([pcNow + 2n]);
        checks.push(['instruction breakpoint (without disassembly) is verified', ibp.verified, `0x${(pcNow + 2n).toString(16)} ${ibp.message ?? ''}`]);
        await d.setInstructionBreakpoints([]);
      }

      const table = BigInt(qs.get('table') ?? '0');
      if (table) {
        await mem.goTo(table, 16);
        await sleep(300);
        const cells = [...shadow(mem).querySelectorAll('tr[data-offset="0"] td.cell')].map((c) => c.textContent!.trim());
        checks.push(['memory view shows TABLE bytes', cells.slice(0, 8).join(' ') === '11 11 22 22 33 33 44 44', cells.join(' ')]);
        mem.group = 2;
        await sleep(300);
        const words = [...shadow(mem).querySelectorAll('tr[data-offset="0"] td.cell')].map((c) => c.textContent!.trim());
        checks.push(['memory view groups little-endian u16', words.slice(0, 4).join(' ') === '1111 2222 3333 4444', words.join(' ')]);
        checks.push(['memory view exports Intel HEX', mem.exportHex().split('\n')[1]?.startsWith(':10') ?? false, mem.exportHex().split('\n').slice(0, 2).join(' ')]);
      }

      const svdUrl = qs.get('svd');
      if (svdUrl) {
        await periph.loadSvd(new Uint8Array(await (await fetch(svdUrl)).arrayBuffer()), svdUrl);
        await sleep(500);
        (shadow(periph).querySelector('[data-path="/SCB"] .twisty') as HTMLElement | null)?.click();
        await sleep(800);
        const cpuid = shadow(periph).querySelector('[data-path="/SCB/SCB.CPUID"] .value')?.textContent?.trim();
        // `?cpuid=` pins the exact value; otherwise any Arm Cortex-M33 (implementer 0x41, part 0xD21)
        // passes: the MCXA153 reads 0x411FD210, the nRF9160 0x410FD212.
        const value = cpuid ? Number(cpuid) : NaN;
        const cpuidOk = qs.get('cpuid') ? cpuid === qs.get('cpuid') : (value >>> 24) === 0x41 && ((value >>> 4) & 0xfff) === 0xd21;
        checks.push(['peripherals panel reads SCB.CPUID from the SVD', cpuidOk, String(cpuid)]);
      }
      for (const [name, ok, detail] of checks) log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
      await d.clearBreakpoints();
      await d.continue();
      d.dispose();
      log(`DEBUGUI_RESULT=${checks.every((c) => c[1]) ? 'PASS' : 'FAIL'} in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      log(`error: ${(e as Error).stack ?? e}`);
      log('DEBUGUI_RESULT=FAIL');
    }
  })();
}

// Test page for the Phase 3 debugger components.
//   ?fake=1                     scripted FakeDebugger (Playwright)
//   ?auto=1&token=spike&probe=mcu&chip=MCXA153&elf=/firmware/mcxa153-debug.elf&line=40
//                               real target over WebSocket to probe-rs serve: flash, break at src/main.rs:<line>
import '@probe-web/ui';
import { Client, type Debugger } from '@probe-web/client';
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

if (qs.has('webusb-fake')) {
  // The WebUSB worker (fake probe) has no debug endpoints: debugger() must refuse clearly.
  void (async () => {
    const client = await Client.connect({ kind: 'webusb', fake: true });
    const probe = (await client.listProbes()).find((p) => p.serial_number === 'fake')!;
    const session = await client.attach({ probe, chip: 'MCXA153' });
    try {
      session.debugger();
      log('UNSUPPORTED_RESULT=FAIL (debugger() did not throw)');
    } catch (e) {
      const err = e as { kind?: string; message: string };
      log(`debugger(): ${err.kind}: ${err.message}`);
      log(`UNSUPPORTED_RESULT=${err.kind === 'unsupported' ? 'PASS' : 'FAIL'}`);
    }
    client.close();
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
      const client = await Client.connect({ kind: 'websocket', url: qs.get('url') ?? 'ws://127.0.0.1:3000', token: qs.get('token') ?? '' });
      // Close the connection when the page goes away (reloads included), so probe-rs serve
      // releases the probe instead of keeping a session for a dead page.
      addEventListener('pagehide', () => client.close());
      const probes = await client.listProbes();
      const want = (qs.get('probe') ?? '').toLowerCase();
      const probe = probes.find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want));
      if (!probe) throw new Error(`no probe matching ${want}`);
      const session = await client.attach({ probe, chip: qs.get('chip') ?? undefined, protocol: 'Swd' });
      const elfUrl = qs.get('elf')!;
      const elf = new Uint8Array(await (await fetch(elfUrl)).arrayBuffer());
      await session.flash({ image: elf, name: elfUrl, format: 'elf', options: { verify: true } });
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

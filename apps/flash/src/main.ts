import '@probe-web/ui';
import { describe, onDevicesChanged } from '@probe-web/devices';
import { Client, Session, createLocalWorker, type FlashJob, type Wire } from '@probe-web/client';
import type { ProbeDevicePicker, ProbeFlashPanel, ProbeRttTerminal, ProbeSemihostingConsole, ProbeSerialMonitor, ProbeTargetPicker } from '@probe-web/ui';

interface Manifest {
  name: string;
  chip?: string;
  protocol?: 'Swd' | 'Jtag';
  images: { url: string; format?: FlashJob['format']; address?: string; name?: string; defmt?: boolean }[];
  options?: FlashJob['options'];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $('log');
const log = (m: string) => { logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; console.log('[flasher] ' + m); };
const qs = new URLSearchParams(location.search);

/** The fake-probe worker. Dev-only: the `import.meta.env.DEV` guard is what keeps its 12 MB
 * wasm module out of production bundles, since a bundler emits any chunk it can reach. */
async function fakeWorker(): Promise<Worker> {
  if (!import.meta.env.DEV) throw new Error('the fake probe is only available in development');
  const { createFakeLocalWorker } = await import('@probe-web/client/testing/worker');
  return createFakeLocalWorker();
}

let client: Client | null = null;
let session: Session | null = null;
let probe: Wire.DebugProbeEntry | null = null;
let manifest: Manifest | null = null;
let defmtElf: Uint8Array | null = null;
let imageElf: Uint8Array | null = null;

const picker = $<ProbeDevicePicker>('picker');
const flash = $<ProbeFlashPanel>('flash');
const rtt = $<ProbeRttTerminal>('rtt');
const targets = $<ProbeTargetPicker>('targets');
const semi = $<ProbeSemihostingConsole>('semi');
semi.source = rtt;
const serialMonitor = $<ProbeSerialMonitor>('serial');
serialMonitor.addEventListener('serial-state', (e) => {
  const d = (e as CustomEvent<{ connected: boolean; reason?: string }>).detail;
  log(d.connected ? `serial: connected @ ${serialMonitor.baudRate}` : `serial: disconnected (${d.reason})`);
});
serialMonitor.addEventListener('serial-line', (e) => log(`serial: ${(e as CustomEvent<string>).detail}`));
targets.addEventListener('chip-selected', (e) => { $<HTMLInputElement>('chip').value = (e as CustomEvent<string>).detail; log(`chip: ${(e as CustomEvent<string>).detail}`); });

async function loadManifest() {
  try {
    manifest = await (await fetch(qs.get('manifest') ?? '/flash-manifest.json')).json();
    $('manifest-name').textContent = manifest!.name;
    if (manifest!.chip) $<HTMLInputElement>('chip').value = manifest!.chip;
    if (manifest!.protocol) $<HTMLSelectElement>('protocol').value = manifest!.protocol;
    const img = manifest!.images[0];
    if (img) {
      // ?tag= regenerates the test pattern in-page so a run is provably fresh.
      const tag = qs.get('tag');
      flash.job = {
        image: tag ? pattern(tag) : img.url,
        name: img.name ?? img.url,
        format: img.format,
        baseAddress: img.address ? BigInt(img.address) : undefined,
        options: manifest!.options,
      };
      if (img.format === 'elf' && !tag) {
        imageElf = new Uint8Array(await (await fetch(img.url)).arrayBuffer());
        if (img.defmt) defmtElf = imageElf;
      }
    }
  } catch (e) {
    $('manifest-name').textContent = 'no manifest';
  }
}

async function connect(): Promise<Client | null> {
  const kind = (document.querySelector('input[name=transport]:checked') as HTMLInputElement).value as 'webusb' | 'websocket';
  $('conn-status').textContent = 'connecting…';
  try {
    client = kind === 'websocket'
      ? await Client.connect({ kind, url: $<HTMLInputElement>('ws-url').value, token: $<HTMLInputElement>('ws-token').value })
      : await (async () => {
          const worker = qs.has('fake') ? await fakeWorker() : createLocalWorker();
          worker.addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data.startsWith('log:')) log('[worker] ' + e.data.slice(4)); });
          return Client.connect({ kind, worker });
        })();
    picker.client = client;
    targets.client = client;
    $('conn-status').textContent = `connected (${kind})`;
    const caps = client.capabilities();
    log(`connected via ${kind}; ${caps.unsupportedEndpoints.length} unsupported endpoint(s)${caps.unsupportedEndpoints.length ? ': ' + caps.unsupportedEndpoints.join(', ') : ''}`);
    return client;
  } catch (e) {
    $('conn-status').textContent = `failed: ${(e as Error).message}`;
    log(`connect failed: ${(e as Error).message}`);
    return null;
  }
}

async function attach(): Promise<Session | null> {
  if (!client || !probe) return null;
  const chip = $<HTMLInputElement>('chip').value.trim() || undefined;
  const protocol = ($<HTMLSelectElement>('protocol').value || undefined) as 'Swd' | 'Jtag' | undefined;
  $('attach-status').textContent = 'attaching…';
  try {
    const t0 = performance.now();
    session = await client.attach({ probe, chip, protocol });
    const meta = await session.targetMetadata();
    $('attach-status').textContent = `attached to ${meta.target_name} (${meta.cores.length} core${meta.cores.length === 1 ? '' : 's'}) in ${Math.round(performance.now() - t0)} ms`;
    log(`attached: ${meta.target_name}`);
    flash.session = session;
    rtt.session = session;
    return session;
  } catch (e) {
    const err = e as Error & { kind?: string };
    $('attach-status').textContent = `failed (${err.kind ?? 'error'}): ${err.message}`;
    log(`attach failed: ${err.message}`);
    return null;
  }
}

onDevicesChanged((kind, d) => log(`device ${kind}: ${describe(d).label}`));
picker.addEventListener('probe-selected', (e) => {
  probe = (e as CustomEvent<Wire.DebugProbeEntry>).detail;
  log(`probe: ${probe.identifier}`);
});
flash.addEventListener('artifact-changed', (e) => log(`watched file changed: ${(e as CustomEvent).detail.name} (${(e as CustomEvent).detail.size} bytes)`));
flash.addEventListener('flash-done', async (e) => {
  const { bootInfo, ms } = (e as CustomEvent).detail;
  const wasMonitoring = (rtt as unknown as { running: boolean }).running;
  if (wasMonitoring) await rtt.stop();
  rtt.bootInfo = bootInfo;
  if (wasMonitoring) setTimeout(() => void rtt.start(), 200);
  // The flashed ELF is also the defmt table for decoding its RTT output.
  if (imageElf) rtt.elf = imageElf;
  if (defmtElf) rtt.defmtElf = defmtElf;
  log(`flash done in ${ms} ms; boot info ${JSON.stringify(bootInfo, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
  log('FLASH_RESULT=PASS');
});
flash.addEventListener('flash-failed', (e) => log(`flash failed: ${(e as CustomEvent).detail?.message ?? (e as CustomEvent).detail}`));
$('connect').onclick = connect;
$('attach').onclick = attach;

/** 4 KiB position-dependent test pattern with `tag` every 64 bytes. */
function pattern(tag: string): Uint8Array {
  const marker = new TextEncoder().encode(tag.padEnd(21, '-').slice(0, 21));
  const v = new Uint8Array(4096);
  for (let off = 0; off < v.length; ) {
    if (off % 64 === 0) {
      v.set(marker, off);
      v.set(new TextEncoder().encode(off.toString(16).padStart(6, '0')), off + 21);
      off += 27;
    } else {
      v[off] = off % 251;
      off++;
    }
  }
  return v;
}

await loadManifest();

// ?auto=1[&transport=webusb|websocket&token=…&tag=…]: connect, use the first
// probe, attach with the manifest's chip, flash. For automated verification.
// ?crashtest=1: fake worker only. Starts a scan that makes the worker panic and
// checks that the in-flight call and a later call reject as 'worker-crashed'.
if (qs.has('crashtest')) {
  void (async () => {
    const t0 = performance.now();
    const c = await Client.connect({ kind: 'webusb', worker: await fakeWorker() });
    const probeEntry: Wire.DebugProbeEntry = { identifier: 'crash', vendor_id: 0xffff, product_id: 0xfffe, interface: null, serial_number: '', probe_type: 'fake', inaccessible: false };
    const kindOf = (e: unknown) => (e as { kind?: string }).kind ?? 'none';
    let first = 'resolved';
    try {
      await c.info({ probe: probeEntry }, () => {});
    } catch (e) {
      first = `${kindOf(e)}: ${(e as Error).message}`;
    }
    const firstMs = Math.round(performance.now() - t0);
    let second = 'resolved';
    try {
      await c.listProbes();
    } catch (e) {
      second = kindOf(e);
    }
    log(`crashtest: in-flight call -> ${first} (${firstMs} ms); later call -> ${second}; crashReason=${JSON.stringify(c.crashReason)}`);
    log(`CRASH_RESULT=${first.startsWith('worker-crashed') && second === 'worker-crashed' ? 'PASS' : 'FAIL'}`);
  })();
}

// ?serialtest=<text>: connect the granted serial port, send a line, expect the firmware's
// uppercased echo (hardware-tests/firmware/nrf9160-uart-echo), then disconnect.
if (qs.has('serialtest')) {
  const text = qs.get('serialtest') || 'browser check';
  void (async () => {
    for (let i = 0; i < 20 && !serialMonitor.port; i++) await new Promise((r) => setTimeout(r, 100));
    if (!serialMonitor.port) {
      log('serialtest: no granted serial port (click "Choose port…" in section 6 once)');
      log('SERIAL_RESULT=FAIL');
      return;
    }
    const want = `echo: ${text.toUpperCase()}`;
    const lines: string[] = [];
    const got = new Promise<boolean>((resolve) => {
      serialMonitor.addEventListener('serial-line', (e) => {
        lines.push((e as CustomEvent<string>).detail);
        if ((e as CustomEvent<string>).detail === want) resolve(true);
      });
      setTimeout(() => resolve(false), 6000);
    });
    const t0 = performance.now();
    await serialMonitor.connect();
    await new Promise((r) => setTimeout(r, 300));
    await serialMonitor.send(text);
    const ok = await got;
    log(`serialtest: ${lines.length} line(s) in ${Math.round(performance.now() - t0)} ms; ${ok ? 'echo received' : 'echo MISSING'}: ${JSON.stringify(want)}`);
    await serialMonitor.disconnect();
    log(`SERIAL_RESULT=${ok ? 'PASS' : 'FAIL'}`);
  })();
}

if (qs.has('auto')) {
  const transport = qs.get('transport') ?? 'webusb';
  (document.querySelector(`input[name=transport][value=${transport}]`) as HTMLInputElement).checked = true;
  if (qs.get('token')) $<HTMLInputElement>('ws-token').value = qs.get('token')!;
  const c = await connect();
  if (c) {
    const probes = await c.listProbes();
    // ?probe=<substring> picks a probe by identifier/serial when several are attached.
    const want = qs.get('probe')?.toLowerCase();
    const chosen = want ? probes.find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want)) : probes[0];
    if (chosen && qs.get('op') === 'info') {
      // ?op=info: DP/AP/ROM-table scan without attaching to a target (hardware check for the `info` endpoint).
      const events: Wire.InfoEvent[] = [];
      const t0 = performance.now();
      try {
        await c.info({ probe: chosen, protocol: (qs.get('protocol') as 'Swd' | 'Jtag') ?? 'Swd' }, (e) => events.push(e));
        const dps = events.filter((e): e is { ArmDp: Wire.DebugPortInfo } => typeof e === 'object' && 'ArmDp' in e);
        for (const e of events) log(`info: ${JSON.stringify(e, (_, x) => (typeof x === 'bigint' ? Number(x) : x)).slice(0, 300)}`);
        const aps = dps.flatMap((d) => d.ArmDp.aps);
        const names = (n: Wire.ComponentTreeNode): string[] => [n.node, ...n.children.flatMap(names)];
        const nodes = aps.flatMap((a) => ('MemoryAp' in a ? names(a.MemoryAp.component_tree) : []));
        log(`info: ${events.length} event(s), ${dps.length} DP(s), ${aps.length} AP(s), ${nodes.length} component node(s) in ${Math.round(performance.now() - t0)} ms`);
        log(`INFO_RESULT=${dps.length > 0 && aps.length > 0 ? 'PASS' : 'FAIL'}`);
      } catch (e) {
        log(`info failed: ${(e as Error).message}`);
        log('INFO_RESULT=FAIL');
      }
    } else if (chosen) {
      probe = chosen;
      const s = await attach();
      if (s && qs.has('fake')) {
        // The mocked core cannot run flash algorithms; prove the transport with memory ops.
        const core = s.core(0);
        const info = await core.halt();
        const words = await core.readMemory32(0x0, 4);
        log(`fake: halted pc=0x${info.pc.toString(16)}; read32 @0 = [${Array.from(words).map((w) => w.toString(16)).join(', ')}]`);
        await core.run();
        log('FAKE_RESULT=PASS');
      } else if (s) {
        await flash.updateComplete;
        // ?op=: "flash" (default) | "verify" | "erase" | "attach" (no flash) | "cycle" = flash, verify (Ok), erase, verify (Mismatch), flash, verify (Ok)
        const op = qs.get('op') ?? 'flash';
        const verdicts: string[] = [];
        flash.addEventListener('verify-done', (e) => verdicts.push(String((e as CustomEvent).detail)));
        if (op === 'verify') await flash.verifyOnly();
        else if (op === 'erase') await flash.eraseAll();
        else if (op === 'cycle') {
          await flash.flash();
          await flash.verifyOnly();
          await flash.eraseAll();
          await flash.verifyOnly();
          await flash.flash();
          await flash.verifyOnly();
          log(`cycle verdicts: ${verdicts.join(', ')}`);
          log(`CYCLE_RESULT=${verdicts.join(',') === 'Ok,Mismatch,Ok' ? 'PASS' : 'FAIL'}`);
        } else if (op !== 'attach') await flash.flash();
        // ?monitor=<seconds>: run the RTT terminal for a while, then stop; "keep" leaves it running.
        if (qs.get('monitor') === 'keep') {
          void rtt.start();
          log('monitor: running until stopped');
        }
        const secs = Number(qs.get('monitor') ?? 0);
        if (secs > 0 && rtt.bootInfo) {
          const t0 = performance.now();
          let events = 0;
          const seen: string[] = [];
          // ?send=<text>: write it to down channel 0 once RTT is up; expect the firmware's uppercased echo.
          const sendText = qs.get('send');
          const orig = (rtt as unknown as { onEvent: (e: unknown) => void }).onEvent;
          (rtt as unknown as { onEvent: (e: unknown) => void }).onEvent = (ev: unknown) => {
            events++;
            const e = ev as { kind: string; lines?: { message: string }[]; text?: string };
            if (e.kind === 'defmt') for (const l of e.lines ?? []) seen.push(l.message);
            if (e.kind === 'text') seen.push(e.text ?? '');
            if (e.kind === 'semihosting') seen.push((e as { data?: string }).data ?? '');
            if (e.kind === 'rtt-discovered' && sendText && session) {
              setTimeout(() => void session!.rttWrite(0, sendText + '\n').then((n) => log(`sent ${n} bytes to down channel 0`), (err) => log(`rtt write failed: ${err}`)), 300);
            }
            orig.call(rtt, ev);
          };
          const run = rtt.start();
          // Stop after the timeout unless the target already exited (semihosting).
          await Promise.race([run, new Promise((r) => setTimeout(r, secs * 1000))]);
          if ((rtt as unknown as { running: boolean }).running) await rtt.stop();
          await run;
          log(`monitor exit: ${JSON.stringify(await run, (_, x) => typeof x === 'bigint' ? Number(x) : x)}`);
          log(`monitor: ${events} events in ${Math.round(performance.now() - t0)} ms; first: ${JSON.stringify(seen.slice(0, 3))}; last: ${JSON.stringify(seen.slice(-1))}`);
          const all = seen.join('');
          const echoOk = !sendText || all.includes(`echo: ${sendText.toUpperCase()}`);
          if (sendText) log(`echo ${echoOk ? 'received' : 'MISSING'}: ${JSON.stringify(`echo: ${sendText.toUpperCase()}`)}`);
          log(`RTT_RESULT=${seen.length >= 3 && echoOk ? 'PASS' : 'FAIL'}`);
        }
      }
    } else {
      log(want ? `auto: no probe matching ${JSON.stringify(want)} among ${probes.length}` : 'auto: no probes');
    }
  }
  log('AUTORUN_DONE');
}

import '../../shared/shell.ts';
import '@probe-web/ui';
import './layout.ts';
import { describe, onDevicesChanged } from '@probe-web/devices';
import { Client, Session, createLocalWorker, type FlashJob, type Wire } from '@probe-web/client';
import { downloadBytes } from '@probe-web/artifacts';
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

/** The fake-probe worker. Dev-only: the `import.meta.env.DEV` guard is what keeps its 10 MB
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

/**
 * Fill the demo picker from the index shipped with the site, so a visitor can flash something
 * without having a firmware file to hand. Choosing one reloads with `?manifest=`, which is also
 * what a deployment pointing at its own firmware would use.
 */
// The site root, where the manifests and demo firmware live. The flasher itself is served from
// the root in development and from <base>/flash/ when deployed next to the docs.
const siteRoot = new URL(import.meta.env.BASE_URL, location.href);

async function loadDemos() {
  const select = $<HTMLSelectElement>('demo');
  try {
    const url = new URL('demos.json', siteRoot);
    const demos = (await (await fetch(url)).json()) as { manifest: string; label: string }[];
    const current = qs.get('manifest') ?? 'flash-manifest.json';
    select.replaceChildren(
      ...demos.map((d) => {
        const option = document.createElement('option');
        option.value = d.manifest;
        option.textContent = d.label;
        option.selected = d.manifest === current;
        return option;
      }),
    );
    select.onchange = () => {
      const next = new URL(location.href);
      next.searchParams.set('manifest', select.value);
      location.href = next.href;
    };
  } catch {
    select.replaceChildren(new Option('none shipped with this site', ''));
    select.disabled = true;
  }
}

async function loadManifest() {
  try {
    // Relative to the site root, so the app works under any base path (a project GitHub Pages
    // site is served from /<repo>/). Image URLs resolve against the manifest's own URL.
    const manifestUrl = new URL(qs.get('manifest') ?? 'flash-manifest.json', siteRoot);
    manifest = await (await fetch(manifestUrl)).json();
    const imageUrl = (url: string) => new URL(url, manifestUrl).href;
    $('manifest-name').textContent = manifest!.name;
    if (manifest!.chip) $<HTMLInputElement>('chip').value = manifest!.chip;
    if (manifest!.protocol) $<HTMLSelectElement>('protocol').value = manifest!.protocol;
    const img = manifest!.images[0];
    if (img) {
      // ?tag= regenerates the test pattern in-page so a run is provably fresh.
      const tag = qs.get('tag');
      flash.job = {
        image: tag ? pattern(tag) : imageUrl(img.url),
        name: img.name ?? img.url,
        format: img.format,
        baseAddress: img.address ? BigInt(img.address) : undefined,
        options: manifest!.options,
      };
      if (img.format === 'elf' && !tag) {
        imageElf = new Uint8Array(await (await fetch(imageUrl(img.url))).arrayBuffer());
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

await loadDemos();
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
      log('serialtest: no granted serial port (click "Choose port…" in the Serial tab once)');
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

// ?targets=1: expose the pack/FLM importer so a browser test can drive it with bytes
// from disk. The module is loaded the same way the target picker loads it, which is the
// point -- it checks that the separate targets wasm really instantiates in a browser,
// not just that it compiles.
if (qs.has('targets')) {
  const targets = await import('@probe-web/client/targets');
  (window as unknown as { probeWebTargets: typeof targets }).probeWebTargets = targets;
  log('TARGETS_READY');
}

/**
 * ?pack=<url>[&family=<name>]: import a CMSIS pack into the connected registry before
 * attaching, so a chip probe-rs does not ship a target for can still be flashed. This is
 * the whole pack story end to end — vendor archive in, working flash out — and it is the
 * hardware check for it.
 */
async function importPack(c: Client): Promise<boolean> {
  const url = qs.get('pack')!;
  const want = qs.get('family');
  try {
    const t0 = performance.now();
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const { packToYaml } = await import('@probe-web/client/targets');
    const families = await packToYaml(bytes);
    const chosen = want ? families.filter((f) => f.name.toLowerCase() === want.toLowerCase()) : families;
    if (chosen.length === 0) {
      log(`pack: no family named ${want} in ${url} (found ${families.map((f) => f.name).join(', ')})`);
      return false;
    }
    for (const family of chosen) await c.loadChipFamily(family.yaml);
    log(`pack: ${url} (${bytes.length} bytes) -> ${chosen.length}/${families.length} famil${chosen.length === 1 ? 'y' : 'ies'} loaded in ${Math.round(performance.now() - t0)} ms: ${chosen.map((f) => `${f.name} (${f.variants} chips)`).join(', ')}`);
    return true;
  } catch (e) {
    log(`pack: import failed: ${(e as Error).message}`);
    return false;
  }
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
      // A pack has to be in the registry before attach() resolves the chip name.
      const packOk = qs.has('pack') ? await importPack(c) : true;
      if (qs.get('chip')) $<HTMLInputElement>('chip').value = qs.get('chip')!;
      const s = packOk ? await attach() : null;
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
        } else if (op === 'tests') {
          // ?op=tests: flash the embedded-test firmware, then list and run its suite.
          // Each run resets the target, so this is the slow path by design.
          await flash.flash();
          const boot = rtt.bootInfo ?? { FromRam: null };
          const t0 = performance.now();
          const tests = await s.listTests(boot as Wire.BootInfo, (e) => {
            if (e.kind === 'semihosting') log(`test output: ${e.data.trimEnd()}`);
          });
          log(`tests: ${tests.tests.length} found in ${Math.round(performance.now() - t0)} ms: ${tests.tests.map((t) => t.name).join(', ')}`);
          let passed = 0;
          let failed = 0;
          let ignored = 0;
          for (const test of tests.tests) {
            if (test.ignored) { ignored++; log(`test ${test.name}: ignored`); continue; }
            const started = performance.now();
            const result = await s.runTest(test);
            const ms = Math.round(performance.now() - started);
            if (result === 'Success') { passed++; log(`test ${test.name}: PASS (${ms} ms)`); }
            else { failed++; log(`test ${test.name}: FAIL (${ms} ms) ${JSON.stringify(result)}`); }
          }
          log(`tests: ${passed} passed, ${failed} failed, ${ignored} ignored of ${tests.tests.length}`);
          // The suite is written to have one expected-panic and one ignored test, so a
          // correct run is every non-ignored test passing.
          log(`TESTS_RESULT=${failed === 0 && passed === tests.tests.length - ignored && passed > 0 ? 'PASS' : 'FAIL'}`);
        } else if (op === 'dump') {
          // ?op=dump: halt and save a coredump of the target's RAM. The ranges come from
          // `target/metadata` rather than a guess, and the file is the encoding native
          // probe-rs reads -- `cargo run -p probe-web-local --example check-coredump`
          // opens it, which is the check that the format really matches.
          const core = s.core(0);
          await core.halt();
          const metadata = await s.targetMetadata();
          const ranges = metadata.memory_map
            .flatMap((region) => ('Ram' in region ? [region.Ram.range] : []))
            .map(([start, end]) => [start, end] as [bigint, bigint]);
          const t0 = performance.now();
          const bytes = await core.dumpCoreFile(ranges);
          const captured = ranges.reduce((n, [a, b]) => n + Number(b - a), 0);
          log(`dump: ${bytes.length} bytes covering ${captured} bytes of RAM in ${ranges.length} region(s) in ${Math.round(performance.now() - t0)} ms`);
          // Also left on `window` so an automated check can read the bytes out: a browser
          // may decline a repeated automatic download, and the file is the artefact under
          // test.
          (window as unknown as { lastCoredump?: Uint8Array }).lastCoredump = bytes;
          downloadBytes(`${($<HTMLInputElement>('chip').value || 'core')}.coredump`, bytes);
          await core.run();
          log(`DUMP_RESULT=${bytes.length > 64 && ranges.length > 0 ? 'PASS' : 'FAIL'}`);
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

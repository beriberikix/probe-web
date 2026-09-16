import '@probe-web/ui';
import { Client, Session, createLocalWorker, type FlashJob, type Wire } from '@probe-web/client';
import type { ProbeDevicePicker, ProbeFlashPanel, ProbeRttTerminal } from '@probe-web/ui';

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

let client: Client | null = null;
let session: Session | null = null;
let probe: Wire.DebugProbeEntry | null = null;
let manifest: Manifest | null = null;
let defmtElf: Uint8Array | null = null;

const picker = $<ProbeDevicePicker>('picker');
const flash = $<ProbeFlashPanel>('flash');
const rtt = $<ProbeRttTerminal>('rtt');

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
      if (img.defmt && !tag) defmtElf = new Uint8Array(await (await fetch(img.url)).arrayBuffer());
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
          const worker = createLocalWorker({ fake: qs.has('fake') });
          worker.addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data.startsWith('log:')) log('[worker] ' + e.data.slice(4)); });
          return Client.connect({ kind, worker });
        })();
    picker.client = client;
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

picker.addEventListener('probe-selected', (e) => {
  probe = (e as CustomEvent<Wire.DebugProbeEntry>).detail;
  log(`probe: ${probe.identifier}`);
});
flash.addEventListener('flash-done', (e) => {
  const { bootInfo, ms } = (e as CustomEvent).detail;
  rtt.bootInfo = bootInfo;
  // The flashed ELF is also the defmt table for decoding its RTT output.
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
if (qs.has('auto')) {
  const transport = qs.get('transport') ?? 'webusb';
  (document.querySelector(`input[name=transport][value=${transport}]`) as HTMLInputElement).checked = true;
  if (qs.get('token')) $<HTMLInputElement>('ws-token').value = qs.get('token')!;
  const c = await connect();
  if (c) {
    const probes = await c.listProbes();
    if (probes.length) {
      probe = probes[0];
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
        await flash.flash();
        // ?monitor=<seconds>: run the RTT terminal for a while, then stop.
        const secs = Number(qs.get('monitor') ?? 0);
        if (secs > 0 && rtt.bootInfo) {
          const t0 = performance.now();
          let events = 0;
          const seen: string[] = [];
          const orig = (rtt as unknown as { onEvent: (e: unknown) => void }).onEvent;
          (rtt as unknown as { onEvent: (e: unknown) => void }).onEvent = (ev: unknown) => {
            events++;
            const e = ev as { kind: string; lines?: { message: string }[]; text?: string };
            if (e.kind === 'defmt') for (const l of e.lines ?? []) seen.push(l.message);
            if (e.kind === 'text') seen.push(e.text ?? '');
            orig.call(rtt, ev);
          };
          const run = rtt.start();
          await new Promise((r) => setTimeout(r, secs * 1000));
          await rtt.stop();
          await run;
          log(`monitor: ${events} events in ${Math.round(performance.now() - t0)} ms; first: ${JSON.stringify(seen.slice(0, 3))}; last: ${JSON.stringify(seen.slice(-1))}`);
          log(`RTT_RESULT=${seen.length >= 3 ? 'PASS' : 'FAIL'}`);
        }
      }
    } else {
      log('auto: no probes');
    }
  }
  log('AUTORUN_DONE');
}

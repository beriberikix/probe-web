import '../../shared/shell.ts';
import '@probe-web/ui/device-picker';
import './layout.ts';
import { Client, createLocalWorker, type Wire } from '@probe-web/client';
import type { ProbeDevicePicker } from '@probe-web/ui';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $('log');
const log = (m: string) => { logEl.textContent += m + '\n'; console.log('[inspect] ' + m); };
const qs = new URLSearchParams(location.search);
let client: Client | null = null;
let probe: Wire.DebugProbeEntry | null = null;
const picker = $<ProbeDevicePicker>('picker');

/** The fake-probe worker. Dev-only: the `import.meta.env.DEV` guard keeps its 12 MB wasm
 * module out of production bundles. */
async function fakeWorker(): Promise<Worker> {
  if (!import.meta.env.DEV) throw new Error('the fake probe is only available in development');
  const { createFakeLocalWorker } = await import('@probe-web/client/testing/worker');
  return createFakeLocalWorker();
}

async function connect(): Promise<Client | null> {
  const kind = (document.querySelector('input[name=transport]:checked') as HTMLInputElement).value as 'webusb' | 'websocket';
  try {
    client = kind === 'websocket'
      ? await Client.connect({ kind, url: $<HTMLInputElement>('ws-url').value, token: $<HTMLInputElement>('ws-token').value })
      : await Client.connect({ kind, worker: qs.has('fake') ? await fakeWorker() : createLocalWorker() });
    picker.client = client;
    const ok = client.supports('info');
    $('conn-status').textContent = `connected (${kind})${ok ? '' : '; this server has no info endpoint'}`;
    $<HTMLButtonElement>('scan').disabled = !ok;
    log(`connected via ${kind}; info ${ok ? 'supported' : 'unsupported'}`);
    return client;
  } catch (e) {
    $('conn-status').textContent = `failed: ${(e as Error).message}`;
    return null;
  }
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? '0x' + x.toString(16) : x), 1);

/** Render a wire value as nested <details>; objects/arrays fold, scalars print. */
function tree(label: string, v: unknown): HTMLElement {
  if (v === null || typeof v !== 'object') {
    const d = document.createElement('div');
    d.className = 'kv';
    d.textContent = `${label}: ${typeof v === 'bigint' ? '0x' + v.toString(16) : String(v)}`;
    return d;
  }
  const det = document.createElement('details');
  det.open = true;
  const sum = document.createElement('summary');
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
  sum.textContent = `${label}${Array.isArray(v) ? ` [${v.length}]` : ''}`;
  det.appendChild(sum);
  for (const [k, x] of entries) det.appendChild(tree(k, x));
  return det;
}

async function scan() {
  if (!client || !probe) return;
  const results = $('results');
  results.replaceChildren();
  $('scan-status').textContent = 'scanning…';
  let n = 0;
  try {
    await client.info({ probe, protocol: $<HTMLSelectElement>('protocol').value as 'Swd' | 'Jtag', connectUnderReset: $<HTMLInputElement>('cur').checked }, (e) => {
      n++;
      if (typeof e === 'object' && 'Message' in e) {
        const d = document.createElement('div'); d.className = 'muted'; d.textContent = e.Message; results.appendChild(d);
      } else if (typeof e === 'object' && 'ArmDp' in e) {
        results.appendChild(tree('ARM debug port', e.ArmDp));
      } else if (typeof e === 'object' && 'Idcode' in e) {
        results.appendChild(tree(`${e.Idcode.architecture} IDCODE`, e.Idcode.idcode));
      } else {
        results.appendChild(tree('event', e));
      }
      log(json(e).slice(0, 200));
    });
    $('scan-status').textContent = `done, ${n} event(s)`;
    log('SCAN_RESULT=PASS');
  } catch (e) {
    $('scan-status').textContent = `failed: ${(e as Error).message}`;
    log(`scan failed: ${(e as Error).message}`);
  }
}

picker.addEventListener('probe-selected', (e) => { probe = (e as CustomEvent<Wire.DebugProbeEntry>).detail; log(`probe: ${probe.identifier}`); });
$('connect').onclick = connect;
$('scan').onclick = scan;

if (qs.has('auto')) {
  const transport = qs.get('transport') ?? 'webusb';
  (document.querySelector(`input[name=transport][value=${transport}]`) as HTMLInputElement).checked = true;
  if (qs.get('token')) $<HTMLInputElement>('ws-token').value = qs.get('token')!;
  if (qs.get('protocol')) $<HTMLSelectElement>('protocol').value = qs.get('protocol')!;
  const c = await connect();
  if (c) {
    const probes = await c.listProbes();
    const want = qs.get('probe')?.toLowerCase();
    probe = (want ? probes.find((p) => `${p.identifier} ${p.serial_number}`.toLowerCase().includes(want)) : probes[0]) ?? null;
    if (probe && c.supports('info')) await scan(); else log(probe ? 'info unsupported on this transport' : 'auto: no probe');
  }
  log('AUTORUN_DONE');
}

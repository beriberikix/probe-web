import { prefetchWasm } from '@probe-web/client';
import { grantedDevices, hasWebUsb } from '@probe-web/devices';

/**
 * Start the WebUSB worker's download before the click that needs it.
 *
 * Nothing asks for `probe_web_local_bg.wasm` until `Client.connect` runs, so by default the
 * whole 2.8 MB lands inside the wait after the user has clicked connect. These are the two
 * moments where wanting a probe is already evident:
 *
 * - the pointer reaches the connect button, which buys a few hundred milliseconds and costs
 *   nothing to anyone who never reaches for it;
 * - the origin has already been granted a probe, which means this visitor has connected one
 *   here before and will very likely do it again.
 *
 * Deliberately not on page load: most visitors to the deployed site are reading it, and a
 * library that spends a first-time visitor's bandwidth on a 2.8 MB maybe is a bad library.
 */
export function prefetchWhenLikely(opts: { triggers: (HTMLElement | null)[]; webusb: () => boolean }) {
  // `prefetchWasm` is idempotent, so every path below can just call it.
  const hint = () => { if (opts.webusb()) prefetchWasm(); };

  for (const el of opts.triggers) {
    el?.addEventListener('pointerenter', hint);
    el?.addEventListener('focus', hint);
  }

  if (!hasWebUsb()) return;
  // Behind idle, so the permission query never competes with first paint.
  const idle = 'requestIdleCallback' in globalThis ? requestIdleCallback : (fn: () => void) => setTimeout(fn, 1500);
  idle(() => void grantedDevices().then((probes) => { if (probes.length) hint(); }).catch(() => {}));
}

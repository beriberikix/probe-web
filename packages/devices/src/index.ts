/**
 * @probe-web/devices — WebUSB device lifecycle for probes: permission
 * requests, granted-device listing, hotplug events, cross-tab locks.
 * Runs on the main thread (the chooser needs a user gesture); the worker
 * only ever sees devices the page has been granted.
 */

/** Vendor IDs of probes probe-rs has drivers for. CMSIS-DAP probes are
 *  detected by interface, not VID, so `requestProbe({ any: true })` exists. */
export const PROBE_VENDOR_IDS: Record<number, string> = {
  0x0d28: 'Arm / DAPLink',
  0x1366: 'SEGGER J-Link',
  0x0483: 'STMicroelectronics ST-Link',
  0x303a: 'Espressif USB-JTAG',
  0x1fc9: 'NXP MCU-Link',
  0x2e8a: 'Raspberry Pi Debug Probe',
  0x1209: 'pid.codes (Black Magic Probe and others)',
  0x0403: 'FTDI',
  0x1a86: 'WCH-Link',
  0x03eb: 'Microchip',
  0x1915: 'Nordic',
};

export function hasWebUsb(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

export interface ProbeDescription {
  label: string;
  vendorId: number;
  productId: number;
  serial: string | undefined;
  vendorName: string | undefined;
}

export function describe(d: USBDevice): ProbeDescription {
  const vendorName = PROBE_VENDOR_IDS[d.vendorId];
  const label = d.productName || vendorName || `${hex(d.vendorId)}:${hex(d.productId)}`;
  return { label, vendorId: d.vendorId, productId: d.productId, serial: d.serialNumber ?? undefined, vendorName };
}

function hex(n: number): string {
  return n.toString(16).padStart(4, '0');
}

/** Open Chrome's device chooser. Must be called from a user gesture. */
export async function requestProbe(opts: { any?: boolean } = {}): Promise<USBDevice> {
  if (!hasWebUsb()) throw new Error('WebUSB is not available in this browser');
  const filters = opts.any ? [] : Object.keys(PROBE_VENDOR_IDS).map((v) => ({ vendorId: Number(v) }));
  return navigator.usb.requestDevice({ filters });
}

/** Devices this origin has already been granted. */
export async function grantedDevices(): Promise<USBDevice[]> {
  if (!hasWebUsb()) return [];
  return navigator.usb.getDevices();
}

/** Subscribe to plug/unplug of granted devices. Returns an unsubscribe. */
export function onDevicesChanged(cb: (event: 'connect' | 'disconnect', device: USBDevice) => void): () => void {
  if (!hasWebUsb()) return () => {};
  const on = (ev: USBConnectionEvent) => cb('connect', ev.device);
  const off = (ev: USBConnectionEvent) => cb('disconnect', ev.device);
  navigator.usb.addEventListener('connect', on);
  navigator.usb.addEventListener('disconnect', off);
  return () => {
    navigator.usb.removeEventListener('connect', on);
    navigator.usb.removeEventListener('disconnect', off);
  };
}

/**
 * Hold an exclusive cross-tab lock while using a probe. Chrome claims the USB
 * interface per tab, so a second tab would otherwise fail with an opaque error.
 * Resolves `null` immediately if another tab holds the lock.
 */
export async function withProbeLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) return fn();
  return navigator.locks.request(`probe-web:${key}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return null;
    return fn();
  });
}

/** Key for `withProbeLock` from a probe's identity. */
export function probeKey(vendorId: number, productId: number, serial: string | undefined): string {
  return `${hex(vendorId)}:${hex(productId)}:${serial ?? ''}`;
}

# @probe-web/devices

WebUSB device lifecycle for probes: `requestProbe()` opens the browser's device
chooser, `grantedDevices()` lists devices the page was granted on earlier
visits, `onDevicesChanged()` reports hotplug, `withProbeLock()` keeps two tabs
from claiming the same probe, and `describe()` gives a label for a device. The
probe-rs worker in `@probe-web/client` only sees devices granted here.

```ts
import { describe, probeKey, requestProbe, withProbeLock } from '@probe-web/devices';

button.onclick = async () => {
  const device = await requestProbe(); // must run in a user gesture
  const { label, vendorId, productId, serial } = describe(device);
  const done = await withProbeLock(probeKey(vendorId, productId, serial), async () => {
    /* connect with @probe-web/client, flash, … */
    return true;
  });
  if (done === null) console.warn(`${label} is in use in another tab`);
};
```

- WebUSB is Chromium-only; check `hasWebUsb()` first.
- `requestProbe()` needs a user gesture; `grantedDevices()` does not.
- CMSIS-DAP probes are detected by USB interface, not vendor ID, so
  `requestProbe({ any: true })` shows every device for probes the vendor list
  misses.

API reference: https://beriberikix.github.io/probe-web/api/devices/

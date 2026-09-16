# @probe-web/devices

WebUSB device lifecycle for probes: `requestProbe()` (opens the chooser, must
run in a user gesture), `grantedDevices()`, `onDevicesChanged()` for hotplug,
`withProbeLock()` to keep two tabs from claiming the same probe, and
`describe()` for labels. CMSIS-DAP probes are detected by USB interface, not
vendor ID, so `requestProbe({ any: true })` shows every device.

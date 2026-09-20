# Hosted apps

The site hosts four apps and an example, all built from this repository with the SDK and
the components. They share one origin, so a probe granted to one is available to all.

| App | What it does | Source |
|---|---|---|
| [Flasher](/flash/){target="_self"} | Pick a probe and a chip (or a demo), flash, verify, erase; RTT, defmt and semihosting output; a serial monitor; target and pack import | `apps/flash` |
| [Workbench](/workbench/){target="_self"} | Flash and debug in one page: dockable panels, a Monaco source view with gutter breakpoints, a console, test runner and RTT plot | `apps/workbench` |
| [Inspector](/inspect/){target="_self"} | What is behind a probe without a chip description: debug ports, access ports and ROM tables, like `probe-rs info` | `apps/inspect` |
| [Monaco IDE](/monaco-ide/){target="_self"} | A minimal IDE that debugs only through the DAP adapter | `examples/monaco-ide` |
| [Minimal flash](/minimal-flash/){target="_self"} | The shortest complete flashing page | `examples/minimal-flash` |
| [React flash](/react-flash/){target="_self"} | The same flow in React, with the elements wrapped for it (see [Using with React](../guide/react)) | `examples/react-flash` |

The flasher, workbench and inspector each have a transport selector. Choose *WebSocket*
and enter the URL and token of a `probe-rs serve` to use a native server instead of WebUSB.
The Monaco IDE connects to `probe-rs serve` unless opened with `?transport=webusb`.

## Demo firmware

The site ships firmware for the FRDM-MCXA153 and the Thingy:91 (nRF9160). The flasher's
demo menu lists it: a debug target with breakpoints, variables and RTT, an
`embedded-test` suite, RTT and defmt logging, semihosting, a UART echo, and a flash
pattern. The workbench shows the debug target's source without a local checkout, because
the sources ship with the site.

The firmware sources are in `hardware-tests/firmware`, and `scripts/build-firmware.sh`
builds them.

## Offline, and caching

The hosted site installs a service worker at its root. Every asset it serves is
content-hashed and therefore immutable, but GitHub Pages caps `Cache-Control` at ten
minutes and offers no way to configure headers, so past that window each asset costs a
revalidation round trip before anything can start. The worker answers those from the Cache
API instead.

The more useful consequence is that the apps keep working with no network once they are
warm, including the 9.8 MB probe-rs worker — the browser holds it as decompressed bytes, so
expect the site to occupy on the order of tens of megabytes of origin storage after a
session that has connected a probe. Clearing site data removes it.

Nothing is precached: the worker fills as pages ask for things, so the first visit is
exactly as fast as it was before. Documents are fetched network-first, so a new deploy is
always picked up; only the hashed assets are served cache-first. It is registered by the
flasher, the inspector and the workbench, and its scope covers the whole site — the
examples do not register it, but they benefit once one of the apps has.

## URL parameters

| Parameter | Apps | Meaning |
|---|---|---|
| `manifest=<url>` | flasher | Load a flash manifest (chip, protocol, images). See [Flashing](../guide/flashing#manifests). |
| `transport=webusb\|websocket`, `token=` | flasher, inspector, Monaco IDE | Preselect the transport and the `probe-rs serve` token |
| `probe=<substring>` | flasher, inspector | Pick the probe whose identifier or serial number contains this |
| `chip=` | flasher | Preselect the chip |
| `protocol=Swd\|Jtag` | flasher, inspector | Preselect the debug protocol |
| `elf=<url>` | workbench | Load this firmware |
| `workerLog=<level>` | all | probe-rs log level inside the WebUSB worker (`info`, `debug`, `trace`), mirrored to the console |

The apps also have automation parameters (`auto=1`, `fake=1` and others) that the test
suites use. They are documented in `hardware-tests/README.md`.

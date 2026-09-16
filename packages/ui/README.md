# @probe-web/ui

Framework-agnostic web components (Lit) on top of `@probe-web/client`:

| Element | Purpose |
|---|---|
| `<probe-device-picker>` | list/authorize probes; fires `probe-selected` |
| `<probe-flash-panel>` | choose an image, options, live erase/program/verify progress; fires `flash-done` |
| `<probe-rtt-terminal>` | xterm.js terminal running the monitor loop; String, defmt (decoded in-browser) and semihosting output; typed input goes to down channel 0 |

Each element takes a `client` / `session` property and works on its own.
Bundlers must compile the package's TypeScript with `experimentalDecorators`
(a `tsconfig.json` ships in the package for Vite/esbuild).

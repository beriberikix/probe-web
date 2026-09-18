# Monaco IDE example

A minimal browser IDE that debugs firmware using only the Debug Adapter Protocol, through
[`@probe-web/dap`](../../packages/dap). It is the integration an editor such as VS Code for
the Web or Theia would do. Monaco shows the source with gutter breakpoints and the current
line, and an xterm console prints output, the stack and the locals at each stop.

Everything goes through `adapter.handleMessage()` and `adapter.onDidSendMessage()`:
`initialize`, `launch`, `setBreakpoints`, `configurationDone`, and then `stackTrace`,
`scopes` and `variables` on each `stopped` event. See [`src/main.ts`](src/main.ts).

Run it from the repository root, after `./scripts/build-wasm.sh` and
`./scripts/build-firmware.sh`:

```sh
npm run dev -w apps/flash
# open http://127.0.0.1:5173/monaco-ide/ in Chrome or Edge
```

Fill in the chip and the firmware URL (it defaults to `/firmware/mcxa153-debug.elf`) and
click *Launch*. By default it connects to `probe-rs serve` at the URL and token in the
header, so start that first (see
[Transports](https://beriberikix.github.io/probe-web/guide/transports#websocket)). Open the
page with `?transport=webusb` to run probe-rs in the page instead.

In development the source view reads files through Vite's `/@fs/` route. A real IDE would
read its workspace instead.

The deployed copy is at https://beriberikix.github.io/probe-web/monaco-ide/. The guide is
[IDE integration](https://beriberikix.github.io/probe-web/guide/ide-integration).

# @probe-web/serial

A WebSerial console for boards whose output goes to a USB-UART bridge (ESP
devkits, Nucleo VCP, J-Link VCOM) rather than RTT. It is not probe-rs; it sits
next to the probe so a page can show both. `requestPort()` and
`grantedPorts()` find a port, `SerialConnection` opens it and runs the read
loop, and `LineDecoder` turns bytes into lines.

```sh
npm install @probe-web/serial
```

```ts
import { LineDecoder, SerialConnection, requestPort } from '@probe-web/serial';

button.onclick = async () => {
  const port = await requestPort(); // must run in a user gesture
  const lines = new LineDecoder();
  const conn = await SerialConnection.open(port, { baudRate: 115200 }, (bytes) => {
    for (const line of lines.push(bytes)) console.log(line);
  });
  await conn.write('help', 'crlf');
  conn.closed.then((reason) => console.log(`serial closed: ${reason}`));
};
```

- WebSerial is Chromium-only (desktop); check `hasWebSerial()` first.
- `requestPort()` needs a user gesture; ports granted before come back from
  `grantedPorts()` without one. The chooser is filtered to common bridge
  vendors; `requestPort({ any: true })` shows every port.
- `resetViaRts()` resets ESP-style devkits (RTS → EN) through the bridge.

API reference: https://beriberikix.github.io/probe-web/api/serial/

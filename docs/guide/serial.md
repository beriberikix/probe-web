# Serial monitor

Many boards print to a UART that a USB bridge exposes as a serial port: ESP devkits, the
Nucleo and J-Link virtual COM ports, the Thingy:91's board controller. `@probe-web/serial`
reads them with [WebSerial](https://developer.mozilla.org/docs/Web/API/Web_Serial_API), so
a page can show serial output next to RTT. It is independent of probe-rs and of the debug
probe.

```ts
import { LineDecoder, SerialConnection, requestPort, grantedPorts } from '@probe-web/serial';

const [port] = await grantedPorts();                  // remembered from an earlier visit
const chosen = port ?? (await requestPort());         // otherwise ask (needs a user gesture)

const lines = new LineDecoder();
const conn = await SerialConnection.open(chosen, { baudRate: 115200 }, (bytes) => {
  for (const line of lines.push(bytes)) console.log(line);
});

await conn.write('help', 'crlf');
conn.closed.then((reason) => console.log(`closed: ${reason}`));
```

- `requestPort()` filters the chooser to common USB-UART bridges and debug-probe VCOM ports.
  `requestPort({ any: true })` shows every port.
- `LineDecoder` handles UTF-8 split across reads and both LF and CRLF line endings.
- `resetViaRts()` pulses RTS, which resets ESP devkits through their auto-reset circuit.
- `onPortsChanged` reports ports being plugged in and out.

WebSerial, like WebUSB, is available only in Chromium desktop browsers. Check
`hasWebSerial()` before offering it.

## The component

`<probe-serial-monitor>` wraps all of this: port selection, baud rate, connect and
disconnect, reset, an input line and an xterm output. It adopts a previously granted
port on load. It fires `serial-line` for each line received and `serial-state` when it
connects or disconnects.

```html
<probe-serial-monitor baudrate="115200" line-ending="crlf"></probe-serial-monitor>
```

import { expect, test } from '@playwright/test';

// <probe-serial-monitor> in the flasher against a mocked WebSerial: a loopback
// port that prints a banner when opened and echoes writes upper-cased.
test('serial monitor picks a port, receives lines, sends with CRLF, disconnects', async ({ page }) => {
  await page.addInitScript(() => {
    const written: string[] = [];
    (window as unknown as { __serialWritten: string[] }).__serialWritten = written;
    const makePort = () => {
      let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
      const enc = new TextEncoder();
      const port = {
        readable: null as ReadableStream<Uint8Array> | null,
        writable: null as WritableStream<Uint8Array> | null,
        getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }),
        addEventListener: () => {},
        setSignals: async () => {},
        async open(o: { baudRate: number }) {
          port.readable = new ReadableStream({ start: (c) => { ctl = c; } });
          port.writable = new WritableStream({
            write: (chunk) => {
              const text = new TextDecoder().decode(chunk);
              written.push(text);
              ctl?.enqueue(enc.encode(text.toUpperCase()));
            },
          });
          setTimeout(() => ctl?.enqueue(enc.encode(`mock uart @ ${o.baudRate}\r\n`)), 20);
        },
        async close() { ctl?.close(); port.readable = null; port.writable = null; },
      };
      return port;
    };
    const port = makePort();
    Object.defineProperty(navigator, 'serial', {
      value: {
        requestPort: async () => port,
        getPorts: async () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  });
  await page.goto('/?idle=1');
  // The monitor lives in the output panel's Serial tab.
  await page.getByRole('tab', { name: 'Serial' }).click();
  const mon = page.locator('probe-serial-monitor');
  await mon.getByRole('combobox', { name: 'baud rate' }).selectOption('921600');
  await mon.getByRole('button', { name: 'Choose port…' }).click();
  await expect(mon.locator('.status')).toContainText('USB 10c4:ea60');
  await mon.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('#log')).toContainText('serial: connected @ 921600');
  await expect(page.locator('#log')).toContainText('serial: mock uart @ 921600');

  await mon.getByPlaceholder('send a line').fill('ping');
  await mon.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('#log')).toContainText('serial: PING');
  expect(await page.evaluate(() => (window as unknown as { __serialWritten: string[] }).__serialWritten)).toEqual(['ping\r\n']);
  await expect(mon.locator('.xterm-rows')).toContainText('PING');

  await mon.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.locator('#log')).toContainText('serial: disconnected (closed)');
  await expect(mon.getByRole('button', { name: 'Connect' })).toBeEnabled();
});

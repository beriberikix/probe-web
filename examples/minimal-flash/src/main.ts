// The smallest complete flashing page: grant a probe over WebUSB, attach with probe-rs running
// in a Worker in this tab, flash a demo image with progress, and let it run.
import '@probe-web/ui/theme.css'; // the look shared with the docs; not needed to flash
import { Client, progressOperation } from '@probe-web/client';
import { requestProbe } from '@probe-web/devices';

const out = document.getElementById('out')!;
const log = (line: string) => (out.textContent += line + '\n');

/** A flash manifest shipped with the site: the chip and the image to write. */
interface Manifest {
  chip: string;
  protocol: 'Swd' | 'Jtag';
  images: { url: string; format: 'elf' | 'bin' | 'hex'; name: string }[];
}

document.getElementById('go')!.addEventListener('click', async () => {
  out.textContent = '';
  try {
    // The chooser needs a user gesture. The grant is remembered per origin, so later visits
    // can skip it (`grantedDevices()` from @probe-web/devices lists what is already granted).
    await requestProbe();

    // The manifests and demo firmware live at the site root.
    const root = new URL(import.meta.env.BASE_URL, location.href);
    const manifestUrl = new URL((document.getElementById('board') as HTMLSelectElement).value, root);
    const manifest = (await (await fetch(manifestUrl)).json()) as Manifest;
    const image = manifest.images[0];

    const client = await Client.connect({ kind: 'webusb' });
    addEventListener('pagehide', () => client.close()); // release the probe when the page goes
    const [probe] = await client.listProbes();
    if (!probe) throw new Error('no probe found; is it plugged in and granted?');
    log(`probe: ${probe.identifier}`);

    const session = await client.attach({ probe, chip: manifest.chip, protocol: manifest.protocol });
    log(`attached to ${manifest.chip}`);

    let last = '';
    const boot = await session.flash(
      { image: new URL(image.url, manifestUrl).href, format: image.format, name: image.name, options: { verify: true } },
      (event) => {
        const op = progressOperation(event);
        if (op && op !== last) log(`${(last = op)}…`);
      },
    );
    await session.boot(boot); // reset and run the new image
    log('done: the firmware is running');
  } catch (e) {
    log(`failed: ${(e as Error).message ?? e}`);
  }
});

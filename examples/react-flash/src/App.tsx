import { useCallback, useEffect, useRef, useState } from 'react';
import { Client, type Session, type Wire } from '@probe-web/client';
import { requestProbe } from '@probe-web/devices';
import { DevicePicker, FlashPanel, RttTerminal } from './elements.ts';

export function App() {
  const [client, setClient] = useState<Client | null>(null);
  const [probe, setProbe] = useState<Wire.DebugProbeEntry | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [bootInfo, setBootInfo] = useState<Wire.BootInfo | null>(null);
  const [chip, setChip] = useState('MCXA153');
  const [error, setError] = useState<string | null>(null);

  // One connection for the life of the page. probe-rs holds the probe until the client is
  // closed, so a page that navigates away without closing leaves it claimed.
  useEffect(() => () => void client?.close(), [client]);

  const connect = useCallback(async () => {
    setError(null);
    try {
      // The browser's device chooser needs a user gesture, so this has to happen in the
      // handler itself — not in an effect, and not after an await of something slow.
      await requestProbe();
      setClient(await Client.connect({ kind: 'webusb' }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  const attach = useCallback(async () => {
    if (!client || !probe) return;
    setError(null);
    try {
      setSession(await client.attach({ probe, chip, protocol: 'Swd' }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [client, probe, chip]);

  return (
    <main>
      <h1>probe-web in React</h1>

      <section>
        <h2>1. Connect</h2>
        <button onClick={connect} disabled={!!client}>
          {client ? 'Connected' : 'Grant a probe and connect'}
        </button>
      </section>

      <section>
        <h2>2. Pick a probe</h2>
        {/*
          `client` is an object, so it has to be set as a property. The wrapper does that;
          writing <probe-device-picker client={client}> on React 18 would stringify it.
        */}
        <DevicePicker client={client} onProbeSelected={(e) => setProbe(e.detail)} />
        <p>
          <label>
            Chip{' '}
            <input value={chip} onChange={(e) => setChip(e.target.value)} disabled={!!session} />
          </label>{' '}
          <button onClick={attach} disabled={!probe || !!session}>
            {session ? `Attached to ${chip}` : 'Attach'}
          </button>
        </p>
      </section>

      <section>
        <h2>3. Flash</h2>
        <FlashPanel session={session} onFlashDone={(e) => setBootInfo(e.detail.bootInfo)} />
      </section>

      <section>
        <h2>4. Output</h2>
        {/* Passing `bootInfo` is what starts the monitor loop and streams RTT here. */}
        <RttTerminal session={session} bootInfo={bootInfo} />
      </section>

      {error && <p className="error">{error}</p>}
    </main>
  );
}

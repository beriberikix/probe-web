import { describe, expect, it } from 'vitest';
import { fromEmbedToml, fromLaunchJson, importConfig } from '../src/config.ts';

/**
 * These fixtures follow the real schemas: cargo-embed's `default.toml` (profile-prefixed
 * tables, `[default.general]`) and probe-rs's DAP `SessionConfig`, which is camelCase.
 */
describe('Embed.toml', () => {
  const embed = `
# A comment, and a key = value inside it must not be read
[default.general]
chip = "MCXA153"          # trailing comment
chip_descriptions = []
connect_under_reset = true

[default.probe]
protocol = "Swd"
speed = 4000
serial = "ABC123"

[default.flashing]
enabled = true
restore_unwritten_bytes = false
`;

  it('reads the keys this project can act on', () => {
    const c = fromEmbedToml(embed);
    expect(c.chip).toBe('MCXA153');
    expect(c.protocol).toBe('Swd');
    expect(c.speed).toBe(4000);
    expect(c.probe).toBe('ABC123');
    expect(c.connectUnderReset).toBe(true);
    expect(c.applied).toContain('chip');
    expect(c.applied).toContain('speed');
  });

  it('ignores what it cannot use instead of failing', () => {
    // Arrays, floats and unknown tables all appear in real files.
    const c = fromEmbedToml(`
[default.general]
chip = "nRF9160_xxAA"
chip_descriptions = ["a.yaml", "b.yaml"]
log_level = "WARN"

[default.rtt]
enabled = true
timeout = 3000
`);
    expect(c.chip).toBe('nRF9160_xxAA');
    expect(c.applied).toEqual(['chip']);
  });

  it('reads a non-default profile when asked, and bare tables when written that way', () => {
    const c = fromEmbedToml(`[release.general]\nchip = "STM32F407"\n`, 'release');
    expect(c.chip).toBe('STM32F407');
    // A hand-written file often omits the profile entirely.
    expect(fromEmbedToml(`[general]\nchip = "STM32F407"\n`).chip).toBe('STM32F407');
    // …and the default profile must not pick up another profile's chip.
    expect(fromEmbedToml(`[release.general]\nchip = "STM32F407"\n`).chip).toBeUndefined();
  });

  it('maps [remote] onto the WebSocket transport', () => {
    const c = fromEmbedToml(`[default.remote]\nhost = "192.168.1.5:3000"\ntoken = "spike"\n`);
    expect(c.url).toBe('ws://192.168.1.5:3000');
    expect(c.token).toBe('spike');
    // An explicit scheme is left alone.
    expect(fromEmbedToml(`[default.remote]\nhost = "wss://lab:3000"\n`).url).toBe('wss://lab:3000');
  });

  it('does not treat a # inside a quoted value as a comment', () => {
    expect(fromEmbedToml(`[default.probe]\nserial = "AB#12"\n`).probe).toBe('AB#12');
  });
});

describe('launch.json', () => {
  const launch = JSON.stringify({
    version: '0.2.0',
    configurations: [
      { type: 'node', name: 'Not probe-rs' },
      {
        type: 'probe-rs-debug',
        name: 'Debug MCXA153',
        chip: 'MCXA153',
        probe: '1fc9:0143:ABC123',
        wireProtocol: 'Swd',
        speed: 4000,
        connectUnderReset: false,
        coreConfigs: [{ coreIndex: 0, programBinary: 'target/thumbv8m.main-none-eabi/debug/app', svdFile: 'MCXA153.svd' }],
      },
    ],
  });

  it('picks the probe-rs configuration out of a whole launch.json', () => {
    const c = fromLaunchJson(launch);
    expect(c.chip).toBe('MCXA153');
    expect(c.protocol).toBe('Swd');
    expect(c.speed).toBe(4000);
    expect(c.connectUnderReset).toBe(false);
    expect(c.programBinary).toContain('debug/app');
    expect(c.svdFile).toBe('MCXA153.svd');
  });

  it('keeps the serial out of a VID:PID:Serial selector', () => {
    // That is the part which distinguishes one attached board from another.
    expect(fromLaunchJson(launch).probe).toBe('ABC123');
    expect(fromLaunchJson(JSON.stringify({ chip: 'x', probe: 'ABC123' })).probe).toBe('ABC123');
  });

  it('accepts a bare configuration object and selection by name', () => {
    expect(fromLaunchJson(JSON.stringify({ chip: 'nRF9160_xxAA' })).chip).toBe('nRF9160_xxAA');
    expect(fromLaunchJson(launch, 'Not probe-rs').chip).toBeUndefined();
  });
});

describe('importConfig', () => {
  it('chooses the reader from the file name', () => {
    expect(importConfig('Embed.toml', `[default.general]\nchip = "A"\n`).chip).toBe('A');
    expect(importConfig('launch.json', `{"chip":"B"}`).chip).toBe('B');
  });
});

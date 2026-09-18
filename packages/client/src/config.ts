/**
 * Reading the config files a probe-rs user already has.
 *
 * Someone arriving at the workbench has usually been flashing this board from a terminal
 * or VS Code for a while, and the chip name, probe and protocol are already written down
 * — in `Embed.toml` for cargo-embed, or `launch.json` for the probe-rs debugger. Retyping
 * them is the kind of small friction that makes a browser tool feel like a toy.
 *
 * The rule here is to read what we understand and say what we applied. Both formats carry
 * far more than this project can act on (flash layout SVGs, log paths, RTT channel
 * formats), so unknown keys are ignored rather than rejected, and a value that does not
 * make sense is skipped rather than throwing. The worst case is that less gets prefilled,
 * which the caller can see from the returned `applied` list.
 */

/** Settings these files can prefill. Matches the workbench's own stored settings. */
export interface ImportedConfig {
  chip?: string;
  probe?: string;
  protocol?: 'Swd' | 'Jtag';
  speed?: number;
  connectUnderReset?: boolean;
  /** `[remote]` in Embed.toml: a `probe-rs serve` to talk to instead of WebUSB. */
  url?: string;
  token?: string;
  /** Paths named by the file. The browser cannot open them, but it can say what to pick. */
  programBinary?: string;
  svdFile?: string;
  /** Names of the settings that were actually recognised, for reporting back. */
  applied: string[];
}

function protocol(value: unknown): 'Swd' | 'Jtag' | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.toLowerCase();
  return v === 'swd' ? 'Swd' : v === 'jtag' ? 'Jtag' : undefined;
}

/**
 * A deliberately small TOML reader: `[table]` headers and `key = value` for strings,
 * integers and booleans.
 *
 * This is not a TOML implementation and does not try to be — it exists so the SDK can
 * read a handful of scalars out of `Embed.toml` without taking a dependency. Anything it
 * does not understand (arrays, inline tables, multi-line strings) is skipped, which is
 * safe because every caller treats a missing value as "not configured". `fromEmbedToml`
 * reads only scalars, so the subset covers every key it looks at.
 */
function parseTomlScalars(text: string): Map<string, string | number | boolean> {
  const out = new Map<string, string | number | boolean>();
  let table = '';
  for (const raw of text.split(/\r?\n/)) {
    // Strip comments, but not a `#` inside a quoted value.
    let line = raw.trim();
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '#') {
        line = line.slice(0, i);
        break;
      }
    }
    line = line.trim();
    if (!line) continue;

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = header[1].trim();
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const key = table ? `${table}.${pair[1]}` : pair[1];
    const value = pair[2].trim();

    if (/^"(.*)"$/.test(value) || /^'(.*)'$/.test(value)) {
      out.set(key, value.slice(1, -1));
    } else if (value === 'true' || value === 'false') {
      out.set(key, value === 'true');
    } else if (/^[+-]?\d+$/.test(value)) {
      out.set(key, Number(value));
    }
    // Anything else (arrays, inline tables, floats, dates) is not needed here.
  }
  return out;
}

/**
 * Read a cargo-embed `Embed.toml`.
 *
 * Its tables are profile-prefixed — `[default.general]`, `[release.probe]` — so `profile`
 * selects which one to read, defaulting to cargo-embed's own `default`. Keys written
 * without a profile (`[general]`) are accepted too, since hand-written files often omit
 * it.
 */
export function fromEmbedToml(text: string, profile = 'default'): ImportedConfig {
  const values = parseTomlScalars(text);
  const applied: string[] = [];
  const config: ImportedConfig = { applied };

  // Prefer the profile-qualified key, then the bare one.
  const get = (section: string, key: string): string | number | boolean | undefined =>
    values.get(`${profile}.${section}.${key}`) ?? values.get(`${section}.${key}`);

  const chip = get('general', 'chip');
  if (typeof chip === 'string' && chip) {
    config.chip = chip;
    applied.push('chip');
  }

  const serial = get('probe', 'serial');
  if (typeof serial === 'string' && serial) {
    config.probe = serial;
    applied.push('probe');
  }

  const wire = protocol(get('probe', 'protocol'));
  if (wire) {
    config.protocol = wire;
    applied.push('protocol');
  }

  const speed = get('probe', 'speed');
  if (typeof speed === 'number' && speed > 0) {
    config.speed = speed;
    applied.push('speed');
  }

  const underReset = get('general', 'connect_under_reset');
  if (typeof underReset === 'boolean') {
    config.connectUnderReset = underReset;
    applied.push('connectUnderReset');
  }

  // `[remote]` names a `probe-rs serve`, which maps onto the WebSocket transport.
  const host = get('remote', 'host');
  if (typeof host === 'string' && host) {
    config.url = /^wss?:\/\//.test(host) ? host : `ws://${host}`;
    applied.push('url');
  }
  const token = get('remote', 'token');
  if (typeof token === 'string' && token) {
    config.token = token;
    applied.push('token');
  }

  return config;
}

/**
 * Read a probe-rs `launch.json` configuration.
 *
 * Accepts either a single configuration object or a whole VS Code `launch.json` with a
 * `configurations` array, in which case `name` picks one (otherwise the first probe-rs
 * entry wins). Keys are camelCase, as probe-rs's DAP server declares them.
 */
export function fromLaunchJson(text: string, name?: string): ImportedConfig {
  const parsed: unknown = JSON.parse(text);
  const root = parsed as { configurations?: unknown[] };
  const candidates: Record<string, unknown>[] = Array.isArray(root.configurations)
    ? (root.configurations as Record<string, unknown>[])
    : [parsed as Record<string, unknown>];

  const chosen =
    (name ? candidates.find((c) => c.name === name) : undefined) ??
    candidates.find((c) => typeof c.chip === 'string') ??
    candidates[0] ??
    {};

  const applied: string[] = [];
  const config: ImportedConfig = { applied };

  if (typeof chosen.chip === 'string' && chosen.chip) {
    config.chip = chosen.chip;
    applied.push('chip');
  }
  if (typeof chosen.probe === 'string' && chosen.probe) {
    // probe-rs writes a `VID:PID:Serial` selector; the serial is the part that identifies
    // one board among several, and it is what this project matches on.
    const parts = chosen.probe.split(':');
    config.probe = parts.length === 3 ? parts[2] : chosen.probe;
    applied.push('probe');
  }
  const wire = protocol(chosen.wireProtocol);
  if (wire) {
    config.protocol = wire;
    applied.push('protocol');
  }
  if (typeof chosen.speed === 'number' && chosen.speed > 0) {
    config.speed = chosen.speed;
    applied.push('speed');
  }
  if (typeof chosen.connectUnderReset === 'boolean') {
    config.connectUnderReset = chosen.connectUnderReset;
    applied.push('connectUnderReset');
  }

  const cores = chosen.coreConfigs;
  const core = Array.isArray(cores) ? (cores[0] as Record<string, unknown> | undefined) : undefined;
  if (core && typeof core.programBinary === 'string') {
    config.programBinary = core.programBinary;
    applied.push('programBinary');
  }
  if (core && typeof core.svdFile === 'string') {
    config.svdFile = core.svdFile;
    applied.push('svdFile');
  }

  return config;
}

/** Read whichever of the two formats `name` suggests, falling back to the content. */
export function importConfig(name: string, text: string): ImportedConfig {
  const isToml = name.toLowerCase().endsWith('.toml');
  return isToml ? fromEmbedToml(text) : fromLaunchJson(text);
}

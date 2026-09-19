/**
 * Reading CMSIS packs and `.FLM` flash algorithms in the browser.
 *
 * This is a subpath export (`@probe-web/client/targets`) rather than part of the main
 * entry because it pulls in its own ~0.6 MB wasm — a zip reader, an ELF reader and a
 * `.pdsc` parser. The flasher never imports a pack, so nothing here should reach the page
 * most visitors open. Import it dynamically, at the point a user picks a file:
 *
 * ```ts
 * const { packToYaml } = await import('@probe-web/client/targets');
 * for (const family of await packToYaml(bytes)) await client.loadChipFamily(family.yaml);
 * ```
 *
 * Everything returns target YAML, which is exactly what `chips/load` takes, so an
 * imported chip works over either transport with no further plumbing.
 */
import init, {
  initTargets,
  packToYaml as packToYamlWasm,
  packSvds as packSvdsWasm,
  flmToYaml as flmToYamlWasm,
  flmToAlgorithm as flmToAlgorithmWasm,
} from '../targets/probe_web_targets.js';

/** One chip family out of a pack. */
export interface ChipFamilyYaml {
  /** The family name, e.g. `RA6M5`. */
  name: string;
  /** How many chip variants it describes. */
  variants: number;
  /** The family as target YAML, ready for `client.loadChipFamily`. */
  yaml: string;
}

/** An SVD carried inside a pack. */
export interface PackSvd {
  /** The file's name inside the pack, e.g. `R7FA6M5BH.svd`. */
  name: string;
  /** The SVD document. */
  xml: string;
}

/**
 * Errors carry a `kind` so callers can tell "wrong file" from "unsupported pack"
 * without reading the message:
 * `bad-archive`, `no-pdsc`, `bad-pdsc`, `bad-elf`, `no-flash-device`, or `targets`.
 */
export type TargetsErrorKind =
  | 'bad-archive'
  | 'no-pdsc'
  | 'bad-pdsc'
  | 'bad-elf'
  | 'no-flash-device'
  | 'targets';

let ready: Promise<void> | undefined;

/** Instantiate the wasm once, however many times this module is called. */
async function ensureWasm(): Promise<void> {
  ready ??= init().then(() => initTargets());
  await ready;
}

/** Every chip family described by a CMSIS `.pack`. */
export async function packToYaml(bytes: Uint8Array): Promise<ChipFamilyYaml[]> {
  await ensureWasm();
  return packToYamlWasm(bytes).map((f) => ({ name: f.name, variants: f.variants, yaml: f.yaml }));
}

/** Every SVD inside a CMSIS `.pack`, for the Peripherals view. */
export async function packSvds(bytes: Uint8Array): Promise<PackSvd[]> {
  await ensureWasm();
  return packSvdsWasm(bytes).map((s) => ({ name: s.name, xml: s.xml }));
}

/**
 * A CMSIS `.FLM` as a complete, loadable chip family with placeholder names and memory
 * regions — the starting point for a chip probe-rs has never heard of.
 *
 * `fixedLoadAddress` pins the algorithm at the address its linker script chose, for
 * loaders that are not position independent. Algorithms taken from packs are position
 * independent, so this defaults to false.
 */
export async function flmToYaml(
  bytes: Uint8Array,
  name: string,
  fixedLoadAddress = false,
): Promise<string> {
  await ensureWasm();
  return flmToYamlWasm(bytes, name, fixedLoadAddress);
}

/**
 * A CMSIS `.FLM` as just the flash algorithm, to splice into a chip description that
 * already exists — the answer to "probe-rs knows my chip but not my board's external
 * flash".
 */
export async function flmToAlgorithm(
  bytes: Uint8Array,
  name: string,
  fixedLoadAddress = false,
): Promise<string> {
  await ensureWasm();
  return flmToAlgorithmWasm(bytes, name, fixedLoadAddress);
}

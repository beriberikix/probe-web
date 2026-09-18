# Custom targets and packs

probe-rs ships descriptions of hundreds of chip families. For a chip it does not know, or a
board with external flash, probe-web can build the description in the browser from the
files vendors publish anyway: a [CMSIS-Pack](https://open-cmsis-pack.github.io/Open-CMSIS-Pack-Spec/main/html/index.html)
(`.pack`) or a CMSIS flash algorithm (`.FLM`).

All of this lives in `@probe-web/client/targets`, which loads its own wasm module on first
use. Import it dynamically, so pages that never import a pack do not download it:

```ts
const { packToYaml } = await import('@probe-web/client/targets');
```

## From a pack

```ts
const { packToYaml } = await import('@probe-web/client/targets');

const families = await packToYaml(new Uint8Array(await packFile.arrayBuffer()));
for (const family of families) {
  console.log(family.name, family.variants);   // e.g. "MCXA153", 1
  await client.loadChipFamily(family.yaml);    // now attachable by name
}
const session = await client.attach({ probe, chip: 'MCXA153VLH' });
```

`loadChipFamily` takes probe-rs target YAML, so a hand-written or `target-gen`-generated
description works too. A loaded family lasts as long as the client. Load it again after
reconnecting.

### SVDs from a pack

Packs usually carry the chip's SVD, which the debugger's peripherals view needs:

```ts
const { packSvds } = await import('@probe-web/client/targets');
const [svd] = await packSvds(packBytes);           // { name, xml }
await dbg.loadSvd(new TextEncoder().encode(svd.xml), svd.name);
```

## From a flash algorithm

```ts
const { flmToYaml, flmToAlgorithm } = await import('@probe-web/client/targets');

// A whole chip family with placeholder names and memory regions: a starting point for a chip
// probe-rs has never heard of. Edit the YAML, then loadChipFamily it.
const yaml = await flmToYaml(flmBytes, 'MyChip');

// Only the flash algorithm, to add to a description probe-rs already has, such as a board's
// external QSPI flash.
const algorithm = await flmToAlgorithm(flmBytes, 'board-qspi');
```

Algorithms from packs are position independent. Pass `fixedLoadAddress: true` for one that
must run at the address its linker script chose.

## Errors

Failures carry a `kind`, so a UI can tell a wrong file from an unsupported one:
`bad-archive`, `no-pdsc`, `bad-pdsc`, `bad-elf`, `no-flash-device` or `targets`.

## In the UI

`<probe-target-picker>` searches the chips the client knows and imports target YAML,
`.pack` and `.FLM` files, loading the result into the client. It fires `family-imported`
and, for packs, `svds-found`.

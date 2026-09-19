// The wasm modules ship without their `name` section (function names, a quarter to two fifths
// of each file) or any DWARF. scripts/build-wasm.sh keeps a copy with names in
// target/wasm-symbols/; only custom sections are dropped, so both number their functions the
// same way and a `wasm-function[N]` from a deployed stack trace can be looked up in the copy.
//
//   node scripts/wasm-names.mjs strip <module.wasm> <symbols copy.wasm>
//   node scripts/wasm-names.mjs lookup <symbols copy.wasm> <N>...
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

/** The module's sections, in order: `{ id, name, start, body, end }`, `name` for custom ones. */
function sections(b) {
  if (b.readUInt32LE(0) !== 0x6d736100) throw new Error('not a wasm module');
  const out = [];
  let i = 8;
  while (i < b.length) {
    const start = i;
    const id = b[i++];
    const [len, n] = leb(b, i);
    i += n;
    const end = i + len;
    let name;
    if (id === 0) {
      const [nl, m] = leb(b, i);
      name = b.subarray(i + m, i + m + nl).toString();
    }
    out.push({ id, name, start, body: i, end });
    i = end;
  }
  return out;
}

function leb(b, i) {
  let r = 0, s = 0, n = 0, x;
  do { x = b[i + n++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
  return [r, n];
}

const isDebug = (s) => s.id === 0 && (s.name === 'name' || s.name.startsWith('.debug_'));

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'strip') {
  const [module, symbols] = args;
  copyFileSync(module, symbols);
  const b = readFileSync(module);
  const keep = sections(b).filter((s) => !isDebug(s));
  writeFileSync(module, Buffer.concat([b.subarray(0, 8), ...keep.map((s) => b.subarray(s.start, s.end))]));
} else if (cmd === 'lookup') {
  const [symbols, ...indices] = args;
  const b = readFileSync(symbols);
  const sec = sections(b).find((s) => s.id === 0 && s.name === 'name');
  if (!sec) throw new Error(`${symbols} has no name section`);
  // Skip the section's own name, then walk the subsections for function names (id 1).
  let i = sec.body;
  const [nl, m] = leb(b, i);
  i += m + nl;
  const names = new Map();
  while (i < sec.end) {
    const sub = b[i++];
    const [len, n] = leb(b, i);
    i += n;
    const subEnd = i + len;
    if (sub === 1) {
      let [count, c] = leb(b, i);
      i += c;
      while (count--) {
        const [idx, a] = leb(b, i);
        i += a;
        const [sl, d] = leb(b, i);
        i += d;
        names.set(idx, b.subarray(i, i + sl).toString());
        i += sl;
      }
    }
    i = subEnd;
  }
  for (const n of indices) console.log(`${n}\t${names.get(Number(n)) ?? '(no name)'}`);
} else {
  console.error('usage: wasm-names.mjs strip <module.wasm> <symbols.wasm> | lookup <symbols.wasm> <N>...');
  process.exit(2);
}

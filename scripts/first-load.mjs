#!/usr/bin/env node
// What a visitor downloads before an app is interactive, per app, gzipped.
//
//   node scripts/first-load.mjs [site-dir]        table
//   node scripts/first-load.mjs [site-dir] --json machine-readable
//   node scripts/first-load.mjs --detail flash    every chunk of one app, largest first
//
// First load is the entry module plus everything reachable from it by static import, which
// is exactly the set Vite lists as `<link rel=modulepreload>`, plus the stylesheets. We
// still walk the import graph ourselves and take the union, so a chunk Vite did not hint
// cannot hide.
//
// Vite names a shared chunk after one arbitrary member of it, and on this site the names
// actively mislead: the chunk called `xterm-*.js` is Monaco, and the real xterm is in
// `terminal-theme-*.js`. So every chunk is labelled by what is actually inside it, found by
// searching the built bytes for markers no other library emits. Never trust the filename.
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

// Markers chosen to survive minification: class names and internal identifiers that ship as
// string literals. Order matters only for readability of the output.
const LIBRARIES = [
  ['monaco', /monaco-aria-container|\.monaco-editor\b|monaco-editor-background/],
  ['dockview', /dv-tabs-and-actions-container|dv-groupview/],
  ['xterm', /xterm-viewport|xterm-rows/],
  ['react', /__SECRET_INTERNALS|react-stack-bottom-frame|react\.transitional\.element/],
  ['lit', /lit\$\d|lit-html|is not a valid CSS in JS/],
  ['probe-web', /probe_web_core_bg|probe-web:|ProbeWebClient/],
];

const gz = (file) => gzipSync(readFileSync(file), { level: 9 }).length;

const label = (file) => {
  if (!file.endsWith('.js')) return [];
  const text = readFileSync(file, 'utf8');
  return LIBRARIES.filter(([, re]) => re.test(text)).map(([name]) => name);
};

// Hrefs are site-absolute and carry the build's base — `/` locally, `/probe-web/` on a
// project Pages site — so try the path as given and then again with its first segment
// dropped. Chunks also live in subdirectories (VitePress uses assets/chunks/), so the path
// has to be kept, not reduced to a basename.
const resolve = (site, href, from = site) => {
  const path = href.split(/[?#]/)[0];
  const candidates = path.startsWith('.')
    ? [join(from, path)]
    : [join(site, path.replace(/^\//, '')), join(site, path.replace(/^\/[^/]*\//, ''))];
  return candidates.find((f) => existsSync(f) && statSync(f).isFile()) ?? null;
};

const IMPORTS = /(?:^|[;}\s])(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']/g;
const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';

function firstLoad(site, html) {
  const page = readFileSync(html, 'utf8');
  const seen = new Set();
  const css = new Set();
  const queue = [];

  for (const m of page.matchAll(/<script\b[^>]*>/g)) {
    if (attr(m[0], 'type') === 'module' && attr(m[0], 'src')) queue.push(resolve(site, attr(m[0], 'src')));
  }
  // `rel` is a token list: VitePress writes rel="preload stylesheet" for the one stylesheet
  // it wants fetched early, so match tokens rather than the whole attribute.
  for (const m of page.matchAll(/<link\b[^>]*>/g)) {
    const rel = attr(m[0], 'rel').split(/\s+/);
    const file = resolve(site, attr(m[0], 'href'));
    if (!file) continue;
    if (rel.includes('modulepreload')) queue.push(file);
    else if (rel.includes('stylesheet')) css.add(file);
  }

  // Walk static imports as well: the preload hints should already be the whole graph, but
  // this is the check that they are.
  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORTS)) {
      if (m[1].startsWith('.') || m[1].startsWith('/')) queue.push(resolve(site, m[1], dirname(file)));
    }
  }

  const parts = [...seen, ...css]
    .map((file) => ({ file: basename(file), bytes: gz(file), has: label(file) }))
    .sort((a, b) => b.bytes - a.bytes);
  return { total: parts.reduce((n, p) => n + p.bytes, 0), parts };
}

const args = process.argv.slice(2);
const detail = args.includes('--detail') ? args[args.indexOf('--detail') + 1] : null;
const json = args.includes('--json');
const site = args.find((a) => !a.startsWith('--') && a !== detail) ?? 'site';

if (!existsSync(site)) {
  console.error(`no such directory: ${site}\nRun ./scripts/build-site.sh first.`);
  process.exit(1);
}

// Every directory holding an index.html is a page worth measuring, and so is the root (the
// docs). Sorted biggest first, because that is the only ordering anyone reads this for.
const pages = [
  ...readdirSync(site)
    .filter((d) => statSync(join(site, d)).isDirectory() && existsSync(join(site, d, 'index.html')))
    .map((d) => [d, join(site, d, 'index.html')]),
  ...(existsSync(join(site, 'index.html')) ? [['(docs)', join(site, 'index.html')]] : []),
];

const measured = pages
  .map(([name, html]) => ({ name, ...firstLoad(site, html) }))
  .filter((p) => p.total > 0)
  .sort((a, b) => b.total - a.total);

const kB = (n) => `${Math.round(n / 1024)} kB`;

if (json) {
  console.log(JSON.stringify(measured, null, 2));
} else if (detail) {
  const app = measured.find((p) => p.name === detail);
  if (!app) {
    console.error(`no page called ${detail}; have: ${measured.map((p) => p.name).join(', ')}`);
    process.exit(1);
  }
  console.log(`${app.name}: ${kB(app.total)} gzipped, ${app.parts.length} files\n`);
  for (const p of app.parts) {
    console.log(`  ${kB(p.bytes).padStart(8)}  ${p.file}${p.has.length ? `   [${p.has.join(', ')}]` : ''}`);
  }
} else {
  const width = Math.max(...measured.map((p) => p.name.length));
  console.log('first load, gzipped\n');
  for (const p of measured) {
    // Name the libraries that account for the bulk, not every chunk: three is enough to
    // explain any number in this table.
    const top = p.parts.filter((x) => x.has.length).slice(0, 3);
    const why = [...new Set(top.flatMap((x) => x.has))].join(', ');
    console.log(`  ${p.name.padEnd(width)}  ${kB(p.total).padStart(8)}   ${why}`);
  }
  console.log('\n  node scripts/first-load.mjs --detail <page>   for the chunks behind a number');
}

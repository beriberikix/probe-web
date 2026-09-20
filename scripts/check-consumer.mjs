#!/usr/bin/env node
// Install the packed tarballs into a throwaway app, build it, and load the result in a
// browser. This is the check that has caught every packaging bug this project has had: a
// workspace symlink resolves source that a real install never sees, so nothing in this
// repository exercises what npm consumers actually get.
//
//   node scripts/check-consumer.mjs                # against the latest Vite
//   node scripts/check-consumer.mjs --vite 6.4.3   # or a specific one
//
// The consumer's Vite config is deliberately the bare minimum. If @probe-web/ui ever needs
// more than `optimizeDeps.exclude` for the client's worker URL, this fails — which is the
// point: the config a consumer must write is part of the package's contract.
//
// It pins nothing by default because the failure it exists to catch was a *new* Vite
// stripping decorator support: the repository builds on Vite 6, so only a check that
// reaches past it can see that coming.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const PACKAGES = ['devices', 'artifacts', 'serial', 'client', 'ui'];
const ELEMENT = 'probe-serial-monitor';

const args = process.argv.slice(2);
const viteRange = args.includes('--vite') ? args[args.indexOf('--vite') + 1] : 'latest';
const repo = resolve(new URL('..', import.meta.url).pathname);
const run = (cmd, cmdArgs, cwd) => execFileSync(cmd, cmdArgs, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

if (!existsSync(join(repo, 'packages/client/wasm/probe_web_core_bg.wasm'))) {
  console.error('the wasm is not built; run ./scripts/build-wasm.sh first');
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), 'probe-web-consumer-'));
const tarballs = join(dir, 'tarballs');
await mkdir(join(dir, 'src'), { recursive: true });
await mkdir(tarballs, { recursive: true });

try {
  console.log(`packing ${PACKAGES.length} packages…`);
  // `prepack` builds @probe-web/ui's dist and asserts the client's wasm exists.
  for (const name of PACKAGES) run('npm', ['pack', '-w', `@probe-web/${name}`, '--pack-destination', tarballs], repo);
  const files = run('ls', [tarballs]).trim().split('\n').map((f) => join(tarballs, f));

  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2));
  await writeFile(join(dir, 'vite.config.ts'), `import { defineConfig } from 'vite';
export default defineConfig({
  // The client resolves its worker with new URL(..., import.meta.url), which does not
  // survive dependency pre-bundling. Nothing else should be needed.
  optimizeDeps: { exclude: ['@probe-web/client'] },
  build: { target: 'esnext' },
});
`);
  await writeFile(join(dir, 'index.html'), `<!doctype html><html><body><${ELEMENT}></${ELEMENT}><script type="module" src="./src/main.ts"></script></body></html>`);
  await writeFile(join(dir, 'src/main.ts'), `import '@probe-web/ui/serial-monitor';\nimport { Client } from '@probe-web/client';\nconsole.log('ok', typeof Client);\n`);

  console.log(`installing into ${dir} with vite@${viteRange}…`);
  run('npm', ['install', '--silent', '--no-audit', '--no-fund', `vite@${viteRange}`, 'typescript', ...files], dir);
  const vite = JSON.parse(await readFile(join(dir, 'node_modules/vite/package.json'), 'utf8')).version;

  console.log(`building with vite@${vite}…`);
  run('npx', ['vite', 'build'], dir);

  // A build that succeeds proves nothing: Vite 8 emitted untransformed decorators and
  // reported success, and the page only died in the browser. So load it.
  const root = join(dir, 'dist');
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const file = join(root, path === '/' ? '/index.html' : path);
    try {
      const body = await readFile(file);
      // From the resolved file, never the request path: "/" has no extension, and serving
      // the document as application/octet-stream makes the browser download it instead.
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().split('\n')[0]); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });

  const registered = await page.evaluate((tag) => !!customElements.get(tag), ELEMENT);
  const rendered = await page.evaluate((tag) => !!document.querySelector(tag)?.shadowRoot, ELEMENT);
  await browser.close();
  server.close();

  const ok = registered && rendered && errors.length === 0;
  console.log(`\nvite@${vite}: element registered=${registered} rendered=${rendered} errors=${errors.length}`);
  for (const e of errors) console.log(`  ${e}`);
  if (!ok) {
    console.error('\nthe packages do not work in a plain consumer. What a symlinked workspace hides:');
    console.error('untransformed syntax, a missing dependency, or an export that does not resolve.');
    // Not process.exit: that would skip the cleanup below and leave the tree behind.
    process.exitCode = 1;
  } else {
    console.log('the packages work in a plain consumer with no special configuration.');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

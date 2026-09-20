import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

// The service worker only exists in a production build, and the rest of the suite drives the
// dev server, so this spec serves `site/` itself rather than adding a second webServer to
// the config.
const SITE = resolve('site');
const built = existsSync(join(SITE, 'flash', 'index.html'));
if (!built && process.env.CI) {
  throw new Error('tests/service-worker.spec.ts needs ./scripts/build-site.sh to have run before the browser tests');
}

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
};

/** Pages-like: hashed assets are still only cacheable for ten minutes. */
function serve(): Promise<{ origin: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    hits.push(path);
    const file = join(SITE, path.endsWith('/') ? `${path}index.html` : path);
    if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      // The type comes from the file that was resolved, never from the request path: an
      // extensionless URL like /flash/ is an HTML document, not a download.
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'max-age=600',
      }).end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      ok({
        origin: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const controlled = (page: import('@playwright/test').Page) =>
  page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });

const cachedUrls = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const cache = await caches.open('probe-web-assets-v1');
    return (await cache.keys()).map((r) => new URL(r.url).pathname);
  });

test.describe('service worker', () => {
  test.skip(!built, 'run ./scripts/build-site.sh first');

  let site: Awaited<ReturnType<typeof serve>>;
  test.beforeAll(async () => { site = await serve(); });
  test.afterAll(async () => { await site.close(); });

  test('caches the hashed assets it serves, and nothing else', async ({ page }) => {
    await page.goto(`${site.origin}/flash/`);
    await controlled(page);
    await page.reload();

    const urls = await cachedUrls(page);
    expect(urls.length).toBeGreaterThan(0);
    // Everything cached is a content-hashed asset. The manifests and demo firmware beside
    // them are not hashed, so caching them would serve a stale one after a deploy.
    expect(urls.every((u) => u.startsWith('/assets/'))).toBe(true);
    expect(urls.some((u) => u.endsWith('.js'))).toBe(true);
  });

  test('the app still loads with the network gone', async ({ page, context }) => {
    await page.goto(`${site.origin}/flash/`);
    await controlled(page);
    await page.reload();
    await expect(page.locator('#connect')).toBeVisible();

    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#connect')).toBeVisible();
    await context.setOffline(false);
  });

  test('a warm load asks the network for no asset at all', async ({ page }) => {
    await page.goto(`${site.origin}/flash/`);
    await controlled(page);
    await page.reload();
    await expect(page.locator('#connect')).toBeVisible();

    // The page still issues the requests either way -- the worker answers them. The only
    // witness to a round trip having been avoided is the server, so ask it.
    site.hits.length = 0;
    await page.reload();
    await expect(page.locator('#connect')).toBeVisible();

    expect(site.hits.filter((p) => p.startsWith('/assets/'))).toEqual([]);
    // The document itself is network-first, so that one does reach the server -- which is
    // what makes a deploy get picked up.
    expect(site.hits).toContain('/flash/');
  });
});

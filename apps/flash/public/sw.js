// The site's service worker. Served from the site root (this directory is the whole site's
// publicDir), so its scope covers the docs, every app and the shared /assets/ they all pull
// from — an app registering from /probe-web/flash/ could not see /probe-web/assets/.
//
// Why it exists: every asset here is content-hashed and therefore immutable, but GitHub
// Pages caps Cache-Control at ten minutes and offers no way to configure headers. Past that
// window each asset costs a revalidation round trip (an ETag 304, so no re-download, but
// still a blocking trip before compilation can start), and offline does not work at all.
//
// Deliberately no precache manifest: nothing is fetched until a page asks for it, so the
// apps work offline once warm rather than from the first visit. That is the honest trade for
// not shipping a build-time list of a 9.8 MB worker's worth of assets.
const VERSION = 'v1';
const ASSETS = `probe-web-assets-${VERSION}`;
const PAGES = `probe-web-pages-${VERSION}`;

// Hashed URLs accumulate across deploys and are never requested again once a deploy is
// superseded. Cache.keys() is in insertion order, so trimming from the front drops the
// oldest. A count rather than a byte budget: the Cache API stores decompressed bytes while
// Content-Length reports the compressed size, so a byte budget here would be a guess
// wearing a number's clothes.
const MAX_ASSETS = 200;

self.addEventListener('install', () => {
  // Nothing to precache. The next activate is what does any work.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('probe-web-') && name !== ASSETS && name !== PAGES) await caches.delete(name);
    }
    // Only ever takes effect on the first install: on an update this worker has already
    // waited for every tab using the old one to go away.
    await self.clients.claim();
  })());
});

const scope = new URL(self.registration.scope);
const isAsset = (url) => url.origin === scope.origin && url.pathname.startsWith(`${scope.pathname}assets/`);

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (isAsset(new URL(request.url))) event.respondWith(cacheFirst(request, event));
  // Network-first for pages, so a deploy is always picked up: the new HTML names new hashed
  // assets, which miss and fetch normally.
  else if (request.mode === 'navigate') event.respondWith(networkFirst(request));
});

/** Content-hashed, so a hit can never be stale. */
async function cacheFirst(request, event) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone());
    // Housekeeping outside the response: waitUntil keeps the worker alive for it without
    // making the page wait.
    event.waitUntil(trim(cache));
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(PAGES);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
    return response;
  } catch (offline) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw offline;
  }
}

let trimming = false;
async function trim(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (const key of keys.slice(0, keys.length - MAX_ASSETS)) await cache.delete(key);
  } finally {
    trimming = false;
  }
}

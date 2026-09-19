import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// One build for every app and example, so they share chunks: built separately, each carried its own copy of
// the 10 MB probe-rs worker and the client wasm. The apps end up under one origin anyway —
// WebUSB grants are per origin — and `scripts/build-site.sh` moves each app's HTML into place
// afterwards, which is safe because `base` makes every asset URL absolute.
const app = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // The repo root, so one build can reach every app. Their entry scripts are referenced
  // relatively (`./src/main.ts`) for the same reason.
  root: fileURLToPath(new URL('.', import.meta.url)),
  // The flasher's public directory is the site's: manifests, demo firmware, SVDs.
  publicDir: app('apps/flash/public'),
  resolve: {
    // Keep the test-only fake-probe worker (and its 10 MB wasm) out of the deployed site.
    alias: { '@probe-web/client/testing/worker': app('scripts/fake-worker-stub.ts') },
  },
  optimizeDeps: { exclude: ['@probe-web/client', '@probe-web/ui', '@probe-web/devices', '@probe-web/artifacts', '@probe-web/dap'] },
  worker: { format: 'es' },
  build: {
    target: 'esnext',
    outDir: app('site'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        flash: app('apps/flash/index.html'),
        inspect: app('apps/inspect/index.html'),
        workbench: app('apps/workbench/index.html'),
        'monaco-ide': app('examples/monaco-ide/index.html'),
        'minimal-flash': app('examples/minimal-flash/index.html'),
      },
    },
  },
});

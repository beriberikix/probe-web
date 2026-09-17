import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// WebUSB grants are per origin, so apps on their own ports cannot use a probe granted here.
// In development, also serve the other apps from this origin (/inspect/, /workbench/).
// (A deployment hosts the static apps on one site, which has the same effect.)
function siblingApps(): Plugin {
  const apps: Record<string, string> = {
    '/inspect': fileURLToPath(new URL('../inspect/', import.meta.url)),
    '/workbench': fileURLToPath(new URL('../workbench/', import.meta.url)),
    '/monaco-ide': fileURLToPath(new URL('../../examples/monaco-ide/', import.meta.url)),
  };
  return {
    name: 'probe-web-sibling-apps',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0].replace(/\/$/, '');
        const dir = apps[path];
        if (!dir) return next();
        const html = readFileSync(`${dir}index.html`, 'utf8').replace('src="/src/main.ts"', `src="/@fs${dir}src/main.ts"`);
        res.setHeader('Content-Type', 'text/html');
        res.end(await server.transformIndexHtml(req.url ?? path + '/', html));
      });
    },
  };
}

export default defineConfig({
  plugins: [siblingApps()],
  // Vite cannot pre-bundle the wasm-bindgen glue in a linked workspace package.
  optimizeDeps: { exclude: ['@probe-web/client', '@probe-web/ui', '@probe-web/devices', '@probe-web/artifacts', '@probe-web/dap'] },
  server: { fs: { allow: ['../..'] } },
  worker: { format: 'es' },
  build: { target: 'esnext' },
});

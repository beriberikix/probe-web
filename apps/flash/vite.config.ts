import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// WebUSB grants are per origin, so the inspect app on its own port cannot use the
// probe granted here. In development, also serve it from this origin at /inspect/.
// (A deployment hosts both static apps on one site, which has the same effect.)
function inspectApp(): Plugin {
  const inspectDir = fileURLToPath(new URL('../inspect/', import.meta.url));
  return {
    name: 'probe-web-inspect-page',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (path !== '/inspect' && path !== '/inspect/') return next();
        const html = readFileSync(`${inspectDir}index.html`, 'utf8').replace(
          'src="/src/main.ts"',
          `src="/@fs${inspectDir}src/main.ts"`,
        );
        res.setHeader('Content-Type', 'text/html');
        res.end(await server.transformIndexHtml(req.url ?? '/inspect/', html));
      });
    },
  };
}

export default defineConfig({
  plugins: [inspectApp()],
  // Vite cannot pre-bundle the wasm-bindgen glue in a linked workspace package.
  optimizeDeps: { exclude: ['@probe-web/client', '@probe-web/ui', '@probe-web/devices', '@probe-web/artifacts'] },
  server: { fs: { allow: ['../..'] } },
  worker: { format: 'es' },
  build: { target: 'esnext' },
});

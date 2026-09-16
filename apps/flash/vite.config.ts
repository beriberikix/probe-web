import { defineConfig } from 'vite';

export default defineConfig({
  // Vite cannot pre-bundle the wasm-bindgen glue in a linked workspace package.
  optimizeDeps: { exclude: ['@probe-web/client', '@probe-web/ui', '@probe-web/devices'] },
  server: { fs: { allow: ['../..'] } },
  worker: { format: 'es' },
  build: { target: 'esnext' },
});

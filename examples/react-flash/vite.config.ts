import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // probe-rs's Worker and its wasm are addressed with `new URL(..., import.meta.url)`,
    // which does not survive dependency pre-bundling. This is the only @probe-web setting
    // an app needs; @probe-web/ui ships compiled JavaScript and needs nothing.
    exclude: ['@probe-web/client'],
  },
  worker: { format: 'es' },
  build: { target: 'esnext' },
});

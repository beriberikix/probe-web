import { defineConfig } from 'vite';

// Standalone dev server. The flasher's dev server (apps/flash, port 5173) also serves this app
// at /workbench/, which shares that origin's WebUSB grants and its /firmware and /svd files.
export default defineConfig({
  optimizeDeps: { exclude: ['@probe-web/client', '@probe-web/ui', '@probe-web/devices', '@probe-web/artifacts', '@probe-web/dap'] },
  server: { fs: { allow: ['../..'] } },
  worker: { format: 'es' },
  build: { target: 'esnext' },
});

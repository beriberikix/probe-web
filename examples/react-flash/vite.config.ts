import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// @probe-web/ui ships TypeScript source whose components use Lit's decorators, so whatever
// compiles the dependency has to be told about them — the dev-time optimizer and the build
// both. In this repository the package is a workspace link and Vite reads its own
// tsconfig.json, but an app that installs it from npm needs this, so it is written out here
// to keep the example copy-pasteable.
const tsconfigRaw = { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } };

export default defineConfig({
  plugins: [react()],
  esbuild: { tsconfigRaw },
  optimizeDeps: {
    // probe-rs's Worker and its wasm are addressed with `new URL(..., import.meta.url)`,
    // which does not survive dependency pre-bundling.
    exclude: ['@probe-web/client', '@probe-web/ui', '@probe-web/devices', '@probe-web/artifacts'],
    esbuildOptions: { tsconfigRaw },
  },
  worker: { format: 'es' },
  build: { target: 'esnext' },
});

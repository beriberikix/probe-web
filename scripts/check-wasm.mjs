// Refuse to pack @probe-web/client without its wasm. The modules under wasm/, worker/ and
// targets/ are build output and are gitignored, so a clone that has not run build-wasm.sh
// would otherwise publish a package whose src/index.ts imports files that are not there.
// Runs as the package's `prepack`, so its cwd is packages/client.
import { existsSync } from 'node:fs';

const required = [
  'wasm/probe_web_core_bg.wasm',
  'wasm/probe_web_core.js',
  'worker/probe_web_local_bg.wasm',
  'worker/local-worker.js',
  'worker/fake/probe_web_local_bg.wasm',
  'targets/probe_web_targets_bg.wasm',
];

const missing = required.filter((f) => !existsSync(new URL(f, `file://${process.cwd()}/`)));
if (missing.length > 0) {
  console.error(
    `@probe-web/client is missing generated files:\n${missing.map((f) => `  ${f}`).join('\n')}\n` +
      'Run ./scripts/build-wasm.sh from the repository root before packing or publishing.',
  );
  process.exit(1);
}

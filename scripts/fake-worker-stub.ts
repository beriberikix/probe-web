/**
 * Stands in for `@probe-web/client/testing/worker` in the deployed site.
 *
 * That module exists so tests can drive the WebUSB transport without hardware, and referencing
 * it pulls a second 12.6 MB wasm module into the bundle — a bundler emits any chunk it can
 * reach, guard or no guard. The apps only ask for it behind `import.meta.env.DEV`, so in a
 * production build this stub is what they would get if they ever did.
 */
export function createFakeLocalWorker(): Worker {
  throw new Error('the fake probe worker is only built into development bundles');
}

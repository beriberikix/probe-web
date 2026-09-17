import { workerLogLevel } from '../index.js';

/**
 * A worker running probe-rs with a fake probe and a mocked core (`probe_rs::integration`),
 * so the WebUSB transport can be driven without hardware.
 *
 * It lives here, not in the library, because a bundler emits a worker's chunk wherever it sees
 * the URL: importing this module is what pulls the test-only 12 MB wasm module into a bundle.
 */
export function createFakeLocalWorker(opts: { log?: string } = {}): Worker {
  const worker = new Worker(new URL('../../worker/fake/local-worker.js', import.meta.url), {
    type: 'module',
  });
  worker.postMessage(`init:${workerLogLevel(opts.log) ?? ''}`);
  return worker;
}

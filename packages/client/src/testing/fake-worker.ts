/**
 * `@probe-web/client/testing/worker`: the fake-probe worker, for driving the WebUSB transport
 * in tests and demos without hardware. Pass it as the `worker` of a `webusb` transport.
 *
 * @example
 * ```ts
 * const { createFakeLocalWorker } = await import('@probe-web/client/testing/worker');
 * const client = await Client.connect({ kind: 'webusb', worker: createFakeLocalWorker() });
 * ```
 *
 * @module testing/worker
 */
import { workerLogLevel } from '../index.js';

/**
 * A worker running probe-rs with a fake probe and a mocked core (`probe_rs::integration`),
 * so the WebUSB transport can be driven without hardware.
 *
 * It lives here, not in the library, because a bundler emits a worker's chunk wherever it sees
 * the URL: importing this module is what pulls the test-only 10 MB wasm module into a bundle.
 * `log` sets probe-rs's tracing level in the worker, as for `createLocalWorker`.
 */
export function createFakeLocalWorker(opts: { log?: string } = {}): Worker {
  const worker = new Worker(new URL('../../worker/fake/local-worker.js', import.meta.url), {
    type: 'module',
  });
  worker.postMessage(`init:${workerLogLevel(opts.log) ?? ''}`);
  return worker;
}

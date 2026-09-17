// Dedicated worker hosting probe-rs (wasm) over WebUSB. Speaks the probe-rs
// RPC wire format over postMessage; string messages are control traffic:
// "ready" when the server is up, "fatal:<reason>" if this worker dies, and
// "log:<text>" for the host page.
import init, * as local from './probe_web_local.js';
// Mirror the worker's console to the page as "log:" strings so hosts can show
// probe-rs diagnostics without opening the worker's DevTools context.
for (const name of ['log', 'warn', 'error']) {
  const orig = console[name].bind(console);
  console[name] = (...args) => { orig(...args); try { self.postMessage('log:' + args.join(' ')); } catch {} };
}
const fatal = (reason) => { try { self.postMessage('fatal:' + reason); } catch {} };
self.addEventListener('error', (ev) => fatal(ev.message || 'uncaught error'));
self.addEventListener('unhandledrejection', (ev) => fatal(String(ev.reason?.message ?? ev.reason)));
const queue = [];
let recv = null;
// The host sends "init:<log level>" before anything else; probe-rs starts once it arrives,
// because its tracing level is fixed when the subscriber is installed.
let started = null;
const start = (level) => {
  started ??= (async () => {
    try {
      await init();
      recv = local.start(level || undefined);
    } catch (e) {
      fatal(`failed to start: ${e?.message ?? e}`);
      throw e;
    }
    for (const b of queue) recv(b);
    queue.length = 0;
    self.postMessage('ready');
  })();
  return started;
};
self.onmessage = (ev) => {
  if (typeof ev.data === 'string') {
    if (ev.data.startsWith('init:')) { void start(ev.data.slice('init:'.length)); return; }
    if (recv) self.postMessage('ready');
    return;
  }
  const bytes = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data);
  if (recv) recv(bytes); else queue.push(bytes);
};

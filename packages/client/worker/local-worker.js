// Dedicated worker hosting probe-rs (wasm) over WebUSB. Speaks the probe-rs
// RPC wire format over postMessage; a string message means control traffic.
import init, { start } from './probe_web_local.js';
// Mirror the worker's console to the page as "log:" strings so hosts can show
// probe-rs diagnostics without opening the worker's DevTools context.
const origLog = console.log.bind(console);
console.log = (...args) => { origLog(...args); try { self.postMessage('log:' + args.join(' ')); } catch {} };
const queue = [];
let recv = null;
self.onmessage = (ev) => {
  if (typeof ev.data === 'string') {
    if (recv) self.postMessage('ready');
    return;
  }
  const bytes = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data);
  if (recv) recv(bytes); else queue.push(bytes);
};
await init();
recv = start();
for (const b of queue) recv(b);
self.postMessage('ready');

// Dedicated worker: hosts probe-rs (wasm) + nusb over WebUSB and speaks the
// probe-rs RPC wire format over postMessage. Message boundaries are preserved
// by postMessage, so no length-prefix framing is needed here.
import init, { worker_main } from './pkg/spike_webusb_worker.js';
const queue = [];
let push = (b) => queue.push(b);
self.onmessage = (ev) => push(new Uint8Array(ev.data));
await init();
// worker_main returns a function the wasm side uses to receive frames; it
// posts replies with self.postMessage from Rust.
const recv = worker_main();
push = (b) => recv(b);
for (const b of queue) recv(b);
self.postMessage("ready");

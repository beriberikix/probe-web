//! Wires for the postcard-rpc client: a browser `WebSocket` to a native
//! `probe-rs serve`, or a dedicated `Worker` hosting probe-rs itself. Both
//! feed the unmodified `probe-rs-rpc-client` through tokio channels, which
//! satisfy its `Send` bounds while the JS objects stay on this thread.

use std::{cell::RefCell, rc::Rc};

use base64::Engine as _;
use postcard_rpc::server::{WireRxErrorKind, WireTxErrorKind};
use probe_rs_rpc::transport::memory::{PostcardReceiver, PostcardSender};
use probe_rs_rpc::transport::{Deframer, frame};
use probe_rs_rpc_client::{Capabilities, RpcClient};
use sha2::{Digest, Sha512};
use tokio::sync::mpsc;
use wasm_bindgen::prelude::*;
use web_sys::{BinaryType, CloseEvent, Event, MessageEvent, WebSocket, Worker};

use crate::js::{client_err, error, log};

/// Subprotocol that asks `probe-rs serve` for the auth challenge as the first
/// binary frame (browsers cannot read the upgrade response header).
pub const CHALLENGE_FRAME_PROTOCOL: &str = "probe-rs.challenge-frame";

pub struct ChanTx(pub mpsc::UnboundedSender<Vec<u8>>);
impl PostcardSender for ChanTx {
    async fn send(&self, buf: Vec<u8>) -> Result<(), WireTxErrorKind> {
        self.0
            .send(buf)
            .map_err(|_| WireTxErrorKind::ConnectionClosed)
    }
}
pub struct ChanRx(pub mpsc::UnboundedReceiver<Vec<u8>>);
impl PostcardReceiver for ChanRx {
    async fn receive(&mut self) -> Result<Vec<u8>, WireRxErrorKind> {
        self.0.recv().await.ok_or(WireRxErrorKind::ConnectionClosed)
    }
}

/// Connect to `probe-rs serve` at `url` (a `ws://…/worker` URL; the path is
/// added when missing) and authenticate with `token`.
pub async fn connect_web_socket(
    url: &str,
    token: &str,
) -> Result<(RpcClient, Capabilities, WebSocket), JsValue> {
    let url = if url.ends_with("/worker") {
        url.to_string()
    } else {
        format!("{}/worker", url.trim_end_matches('/'))
    };
    let ws = WebSocket::new_with_str(&url, CHALLENGE_FRAME_PROTOCOL)
        .map_err(|e| error("transport", format!("{e:?}")))?;
    ws.set_binary_type(BinaryType::Arraybuffer);

    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let deframer = Rc::new(RefCell::new(Deframer::default()));
    let (open_tx, open_rx) = futures::channel::oneshot::channel::<Result<(), String>>();
    let open_tx = Rc::new(RefCell::new(Some(open_tx)));

    let onmessage = Closure::<dyn FnMut(MessageEvent)>::new({
        let deframer = deframer.clone();
        let in_tx = in_tx.clone();
        move |ev: MessageEvent| {
            if let Ok(buf) = ev.data().dyn_into::<js_sys::ArrayBuffer>() {
                let bytes = js_sys::Uint8Array::new(&buf).to_vec();
                let mut d = deframer.borrow_mut();
                d.push(&bytes);
                while let Some(msg) = d.next_message() {
                    let _ = in_tx.send(msg);
                }
            }
        }
    });
    ws.set_onmessage(Some(onmessage.as_ref().unchecked_ref()));
    onmessage.forget();

    let onopen = Closure::<dyn FnMut(Event)>::new({
        let open_tx = open_tx.clone();
        move |_| {
            if let Some(tx) = open_tx.borrow_mut().take() {
                let _ = tx.send(Ok(()));
            }
        }
    });
    ws.set_onopen(Some(onopen.as_ref().unchecked_ref()));
    onopen.forget();

    let onclose = Closure::<dyn FnMut(CloseEvent)>::new({
        let open_tx = open_tx.clone();
        move |ev: CloseEvent| {
            log(&format!(
                "websocket closed: code={} reason={:?}",
                ev.code(),
                ev.reason()
            ));
            if let Some(tx) = open_tx.borrow_mut().take() {
                let _ = tx.send(Err(format!("connection closed (code {})", ev.code())));
            }
        }
    });
    ws.set_onclose(Some(onclose.as_ref().unchecked_ref()));
    onclose.forget();

    open_rx
        .await
        .map_err(|_| error("transport", "connection dropped"))?
        .map_err(|m| error("transport", m))?;
    if ws.protocol() != CHALLENGE_FRAME_PROTOCOL {
        return Err(error(
            "server-too-old",
            "server did not accept the challenge-frame subprotocol; update probe-rs",
        ));
    }

    let challenge = in_rx
        .recv()
        .await
        .ok_or_else(|| error("transport", "closed before challenge"))?;
    let challenge_str = String::from_utf8_lossy(&challenge).to_string();
    if base64::engine::general_purpose::STANDARD
        .decode(&challenge_str)
        .is_err()
    {
        return Err(error("transport", "malformed challenge frame"));
    }
    let mut hasher = Sha512::new();
    hasher.update(challenge_str.as_bytes());
    hasher.update(token.as_bytes());
    ws.send_with_u8_array(&frame(&hasher.finalize()))
        .map_err(|e| error("transport", format!("{e:?}")))?;

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    wasm_bindgen_futures::spawn_local({
        let ws = ws.clone();
        async move {
            while let Some(msg) = out_rx.recv().await {
                if ws.send_with_u8_array(&frame(&msg)).is_err() {
                    break;
                }
            }
        }
    });

    let client = RpcClient::new_from_wire(ChanTx(out_tx), ChanRx(in_rx));
    let caps = client.negotiate().await.map_err(|e| match e {
        // A wrong token makes the server close the socket during the schema handshake.
        probe_rs_rpc_client::ClientError::Transport(_) => error(
            "auth",
            "server closed the connection: wrong token, or no users configured",
        ),
        e => client_err(e),
    })?;
    Ok((client, caps, ws))
}

/// Resolve after `ms` milliseconds (works on a page and in a worker).
async fn sleep_ms(ms: i32) {
    let promise = js_sys::Promise::new(&mut |resolve, _| {
        let global = js_sys::global();
        if let Ok(set_timeout) = js_sys::Reflect::get(&global, &"setTimeout".into())
            .and_then(|f| f.dyn_into::<js_sys::Function>())
        {
            let _ = set_timeout.call2(&global, &resolve, &JsValue::from(ms));
        }
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

/// How long a worker may take to load its (large) wasm module and start.
const WORKER_READY_TIMEOUT_MS: i32 = 30_000;
/// How long the schema handshake may take once the worker is up.
const NEGOTIATE_TIMEOUT_MS: i32 = 15_000;

/// Attach to a `Worker` that hosts the probe-web local server. The worker
/// posts the string `"ready"` once its server is up and `"fatal:<reason>"` if
/// it dies (a Rust panic, a failed start, an uncaught error); every other
/// non-string message is a frame. When the worker dies the inbound channel is
/// closed, so every pending and later RPC call fails instead of hanging.
pub async fn connect_worker(worker: Worker) -> Result<(RpcClient, Capabilities), JsValue> {
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let in_tx = Rc::new(RefCell::new(Some(in_tx)));
    let (ready_tx, ready_rx) = futures::channel::oneshot::channel::<()>();
    let ready_tx = Rc::new(RefCell::new(Some(ready_tx)));
    let dead: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));

    // Tear down on the first fatal signal: remember why, close the inbound side
    // (pending requests then fail with ConnectionClosed) and fail a pending connect.
    let kill = {
        let in_tx = in_tx.clone();
        let ready_tx = ready_tx.clone();
        let dead = dead.clone();
        move |reason: String| {
            if dead.borrow().is_some() {
                return;
            }
            log(&format!("local worker died: {reason}"));
            *dead.borrow_mut() = Some(reason);
            in_tx.borrow_mut().take();
            ready_tx.borrow_mut().take();
        }
    };

    let onmessage = Closure::<dyn FnMut(MessageEvent)>::new({
        let in_tx = in_tx.clone();
        let ready_tx = ready_tx.clone();
        let kill = kill.clone();
        move |ev: MessageEvent| {
            let data = ev.data();
            if let Some(text) = data.as_string() {
                if text == "ready" {
                    if let Some(tx) = ready_tx.borrow_mut().take() {
                        let _ = tx.send(());
                    }
                } else if let Some(reason) = text.strip_prefix("fatal:") {
                    kill(reason.to_string());
                } else if let Some(line) = text.strip_prefix("log:") {
                    // probe-rs's own tracing from inside the worker (see `?workerLog=`).
                    web_sys::console::log_1(&format!("[worker] {line}").into());
                }
                return;
            }
            let bytes = if let Ok(arr) = data.clone().dyn_into::<js_sys::Uint8Array>() {
                arr.to_vec()
            } else if let Ok(buf) = data.dyn_into::<js_sys::ArrayBuffer>() {
                js_sys::Uint8Array::new(&buf).to_vec()
            } else {
                return;
            };
            if let Some(tx) = in_tx.borrow().as_ref() {
                let _ = tx.send(bytes);
            }
        }
    });
    worker.set_onmessage(Some(onmessage.as_ref().unchecked_ref()));
    onmessage.forget();

    let onerror = Closure::<dyn FnMut(Event)>::new({
        let kill = kill.clone();
        move |ev: Event| {
            let message = js_sys::Reflect::get(&ev, &"message".into())
                .ok()
                .and_then(|m| m.as_string())
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| "uncaught error in the worker".to_string());
            kill(message);
        }
    });
    worker.set_onerror(Some(onerror.as_ref().unchecked_ref()));
    onerror.forget();

    let onmessageerror = Closure::<dyn FnMut(Event)>::new({
        let kill = kill.clone();
        move |_ev: Event| kill("a worker message could not be deserialized".to_string())
    });
    worker.set_onmessageerror(Some(onmessageerror.as_ref().unchecked_ref()));
    onmessageerror.forget();

    // The worker may already have posted "ready" before we attached; it also
    // re-posts on request.
    let _ = worker.post_message(&JsValue::from_str("ping"));
    let ready =
        futures::future::select(ready_rx, Box::pin(sleep_ms(WORKER_READY_TIMEOUT_MS))).await;
    match ready {
        futures::future::Either::Left((Ok(()), _)) => {}
        futures::future::Either::Left((Err(_), _)) => {
            let reason = dead
                .borrow()
                .clone()
                .unwrap_or_else(|| "unknown reason".into());
            return Err(error(
                "worker-crashed",
                format!("the probe-rs worker failed to start: {reason}"),
            ));
        }
        futures::future::Either::Right(_) => {
            return Err(error(
                "transport",
                format!(
                    "the probe-rs worker did not start within {} s",
                    WORKER_READY_TIMEOUT_MS / 1000
                ),
            ));
        }
    }

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    wasm_bindgen_futures::spawn_local({
        let worker = worker.clone();
        let dead = dead.clone();
        async move {
            while let Some(msg) = out_rx.recv().await {
                if dead.borrow().is_some() {
                    break;
                }
                let arr = js_sys::Uint8Array::from(&msg[..]);
                if worker.post_message(&arr).is_err() {
                    break;
                }
            }
        }
    });

    let client = RpcClient::new_local_from_wire(ChanTx(out_tx), ChanRx(in_rx));
    let negotiated = match futures::future::select(
        Box::pin(client.negotiate()),
        Box::pin(sleep_ms(NEGOTIATE_TIMEOUT_MS)),
    )
    .await
    {
        futures::future::Either::Left((result, _)) => Some(result),
        futures::future::Either::Right(_) => None,
    };
    let caps = match negotiated {
        Some(Ok(caps)) => caps,
        Some(Err(e)) => {
            return Err(match dead.borrow().clone() {
                Some(reason) => error(
                    "worker-crashed",
                    format!("the probe-rs worker crashed: {reason}"),
                ),
                None => client_err(e),
            });
        }
        None => {
            return Err(error(
                "transport",
                "the probe-rs worker did not answer the schema handshake",
            ));
        }
    };
    Ok((client, caps))
}

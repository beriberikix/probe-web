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
        self.0.send(buf).map_err(|_| WireTxErrorKind::ConnectionClosed)
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
pub async fn connect_web_socket(url: &str, token: &str) -> Result<(RpcClient, Capabilities), JsValue> {
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
            log(&format!("websocket closed: code={} reason={:?}", ev.code(), ev.reason()));
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
    if base64::engine::general_purpose::STANDARD.decode(&challenge_str).is_err() {
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
        probe_rs_rpc_client::ClientError::Transport(_) => {
            error("auth", "server closed the connection: wrong token, or no users configured")
        }
        e => client_err(e),
    })?;
    Ok((client, caps))
}

/// Attach to a `Worker` that hosts the probe-web local server. The worker
/// posts a string once its server is ready; every other message is a frame.
pub async fn connect_worker(worker: Worker) -> Result<(RpcClient, Capabilities), JsValue> {
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (ready_tx, ready_rx) = futures::channel::oneshot::channel::<()>();
    let ready_tx = Rc::new(RefCell::new(Some(ready_tx)));
    let onmessage = Closure::<dyn FnMut(MessageEvent)>::new(move |ev: MessageEvent| {
        let data = ev.data();
        if data.is_string() {
            if let Some(tx) = ready_tx.borrow_mut().take() {
                let _ = tx.send(());
            }
        } else if let Ok(arr) = data.clone().dyn_into::<js_sys::Uint8Array>() {
            let _ = in_tx.send(arr.to_vec());
        } else if let Ok(buf) = data.dyn_into::<js_sys::ArrayBuffer>() {
            let _ = in_tx.send(js_sys::Uint8Array::new(&buf).to_vec());
        }
    });
    worker.set_onmessage(Some(onmessage.as_ref().unchecked_ref()));
    onmessage.forget();
    // The worker may already have posted "ready" before we attached; it also
    // re-posts on request.
    let _ = worker.post_message(&JsValue::from_str("ping"));
    ready_rx
        .await
        .map_err(|_| error("transport", "worker never became ready"))?;

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    wasm_bindgen_futures::spawn_local({
        let worker = worker.clone();
        async move {
            while let Some(msg) = out_rx.recv().await {
                let arr = js_sys::Uint8Array::from(&msg[..]);
                if worker.post_message(&arr).is_err() {
                    break;
                }
            }
        }
    });

    let client = RpcClient::new_local_from_wire(ChanTx(out_tx), ChanRx(in_rx));
    let caps = client.negotiate().await.map_err(client_err)?;
    Ok((client, caps))
}

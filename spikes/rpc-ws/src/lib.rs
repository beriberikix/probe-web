//! Spike A: probe-rs RPC client compiled to wasm32, talking to a native
//! `probe-rs serve` over the browser WebSocket API.
//!
//! Wire: every message is a `[u32 LE length][payload]` frame
//! (`probe_rs_rpc::transport::frame` / `Deframer`). Auth: the server sends the
//! challenge as the first frame when we offer the `probe-rs.challenge-frame`
//! subprotocol; we answer with `sha512(challenge || token)`.

use std::{cell::RefCell, rc::Rc};

use base64::Engine;
use postcard_rpc::server::{WireRxErrorKind, WireTxErrorKind};
use probe_rs_rpc::transport::memory::{PostcardReceiver, PostcardSender};
use probe_rs_rpc::transport::{Deframer, frame};
use probe_rs_rpc_client::RpcClient;
use sha2::{Digest, Sha512};
use tokio::sync::mpsc;
use wasm_bindgen::prelude::*;
use web_sys::{BinaryType, CloseEvent, Event, MessageEvent, WebSocket};

const CHALLENGE_FRAME_PROTOCOL: &str = "probe-rs.challenge-frame";

/// `Send` half handed to the RPC client; a local task drains it into the socket.
struct ChanTx(mpsc::UnboundedSender<Vec<u8>>);
impl PostcardSender for ChanTx {
    async fn send(&self, buf: Vec<u8>) -> Result<(), WireTxErrorKind> {
        self.0
            .send(buf)
            .map_err(|_| WireTxErrorKind::ConnectionClosed)
    }
}

struct ChanRx(mpsc::UnboundedReceiver<Vec<u8>>);
impl PostcardReceiver for ChanRx {
    async fn receive(&mut self) -> Result<Vec<u8>, WireRxErrorKind> {
        self.0.recv().await.ok_or(WireRxErrorKind::ConnectionClosed)
    }
}

fn log(s: &str) {
    web_sys::console::log_1(&format!("[rpc-ws] {s}").into());
}

/// Open the socket, complete the challenge handshake, and return a connected
/// `RpcClient` whose schema has been verified against the server.
async fn connect(url: &str, token: &str) -> Result<RpcClient, String> {
    let ws =
        WebSocket::new_with_str(url, CHALLENGE_FRAME_PROTOCOL).map_err(|e| format!("{e:?}"))?;
    ws.set_binary_type(BinaryType::Arraybuffer);

    // Incoming: deframe into a channel the RPC client reads from.
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
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
                "closed: code={} reason={:?}",
                ev.code(),
                ev.reason()
            ));
            if let Some(tx) = open_tx.borrow_mut().take() {
                let _ = tx.send(Err(format!("closed before open: code {}", ev.code())));
            }
        }
    });
    ws.set_onclose(Some(onclose.as_ref().unchecked_ref()));
    onclose.forget();

    open_rx.await.map_err(|_| "open dropped".to_string())??;
    log(&format!("open, protocol={:?}", ws.protocol()));
    if ws.protocol() != CHALLENGE_FRAME_PROTOCOL {
        return Err(format!(
            "server did not accept subprotocol {CHALLENGE_FRAME_PROTOCOL:?} (got {:?}); is it built with the challenge-frame patch?",
            ws.protocol()
        ));
    }

    // First frame: the base64 challenge. Answer: sha512(challenge || token).
    let mut in_rx = in_rx;
    let challenge = in_rx.recv().await.ok_or("closed before challenge")?;
    let challenge_str = String::from_utf8_lossy(&challenge).to_string();
    log(&format!(
        "challenge: {} bytes (b64 {} raw)",
        challenge.len(),
        base64::engine::general_purpose::STANDARD
            .decode(&challenge_str)
            .map(|v| v.len())
            .unwrap_or(0)
    ));
    let mut hasher = Sha512::new();
    hasher.update(challenge_str.as_bytes());
    hasher.update(token.as_bytes());
    let response = hasher.finalize().to_vec();
    ws.send_with_u8_array(&frame(&response))
        .map_err(|e| format!("{e:?}"))?;

    // Outgoing: drain the client's channel into the socket, framed.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    wasm_bindgen_futures::spawn_local({
        let ws = ws.clone();
        async move {
            while let Some(msg) = out_rx.recv().await {
                if ws.send_with_u8_array(&frame(&msg)).is_err() {
                    log("send failed; socket closed?");
                    break;
                }
            }
        }
    });

    let client = RpcClient::new_from_wire(ChanTx(out_tx), ChanRx(in_rx));
    let client = client
        .ensure_compatible()
        .await
        .map_err(|e| format!("schema check failed: {e}"))?;
    log("schema compatible");
    Ok(client)
}

/// Entry point used by the page: connect, list probes, list chip families.
#[wasm_bindgen]
pub async fn run(url: String, token: String) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    let mut out = String::new();
    let client = connect(&url, &token)
        .await
        .map_err(|e| JsValue::from_str(&e))?;

    let probes = client
        .list_probes()
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    out.push_str(&format!("probes: {}\n", probes.len()));
    for p in &probes {
        out.push_str(&format!("  {p}\n"));
    }

    let families = client
        .list_chip_families()
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    out.push_str(&format!("chip families: {}\n", families.len()));
    let mcx: Vec<_> = families
        .iter()
        .filter(|f| f.name.contains("MCXA"))
        .map(|f| f.name.clone())
        .collect();
    out.push_str(&format!("  MCXA families: {mcx:?}\n"));

    out.push_str("SPIKE_A_RESULT=PASS\n");
    Ok(out)
}

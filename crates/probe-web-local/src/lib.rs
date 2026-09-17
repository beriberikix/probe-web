//! probe-web local server: probe-rs (async fork) + nusb over WebUSB inside a
//! dedicated Web Worker, speaking `probe-rs-rpc`'s wire format over
//! `postMessage`. The main thread runs the unmodified RPC client
//! (`probe-web-core`), so remote and local transports share one client.
//!
//! Only a subset of `master`'s endpoints is implemented (flash, RTT/monitor,
//! memory, core control, chips); the schema report still lists all of them
//! (see spikes/README.md, "capability negotiation").

mod convert;
mod core_ops;
mod debug_state;
mod info;
mod semihosting;
mod svd;
mod server;

use postcard_rpc::server::{Dispatch, Server, WireRxErrorKind};
use probe_rs_rpc::transport::memory::{WireRx, WireTx};
use tokio::sync::mpsc;
use wasm_bindgen::prelude::*;

fn tracing_subscriber_for_wasm(level: tracing::Level) -> impl tracing::Subscriber + Send + Sync {
    // tracing_wasm exposes only a layer; wrap it in a registry.
    use tracing_subscriber::layer::SubscriberExt;
    tracing_subscriber::Registry::default().with(tracing_wasm::WASMLayer::new(
        tracing_wasm::WASMLayerConfigBuilder::new()
            .set_max_level(level)
            .set_report_logs_in_timings(false)
            .set_console_config(tracing_wasm::ConsoleConfig::ReportWithoutConsoleColor)
            .build(),
    ))
}

/// Tell the page this worker is dead (`"fatal:<reason>"`).
fn post_fatal(reason: &str) {
    if let Ok(scope) = js_sys::global().dyn_into::<web_sys::DedicatedWorkerGlobalScope>() {
        let _ = scope.post_message(&JsValue::from_str(&format!("fatal:{reason}")));
    }
}

pub(crate) fn log(s: &str) {
    web_sys::console::log_1(&format!("[probe-web-local] {s}").into());
}

/// Start the server. Returns a JS function that feeds one client frame (a
/// `Uint8Array`); replies and topic messages go out via `postMessage`.
#[wasm_bindgen]
pub fn start(log_level: Option<String>) -> js_sys::Function {
    // Log the panic as before, and tell the page: a wasm panic leaves this instance
    // unusable, so the client must fail pending calls instead of waiting forever.
    std::panic::set_hook(Box::new(|info| {
        console_error_panic_hook::hook(info);
        post_fatal(&info.to_string());
    }));
    // probe-rs's own tracing goes to the worker console (and from there to the
    // page via local-worker.js). WARN by default; raise to INFO to see the vendor sequences' steps.
    let level = match log_level.as_deref().unwrap_or("warn").to_ascii_lowercase().as_str() {
        "trace" => tracing::Level::TRACE,
        "debug" => tracing::Level::DEBUG,
        "info" => tracing::Level::INFO,
        "error" => tracing::Level::ERROR,
        _ => tracing::Level::WARN,
    };
    let _ = tracing::subscriber::set_global_default(tracing_subscriber_for_wasm(level));

    let (c2s_tx, c2s_rx) = mpsc::channel::<Result<Vec<u8>, WireRxErrorKind>>(256);
    let (s2c_tx, mut s2c_rx) = mpsc::channel::<Vec<u8>>(256);

    let mut dispatcher = server::App::new(server::Ctx::new(), probe_rs_rpc::TokioSpawner::default());
    let vkk = dispatcher.min_key_len();
    let tx = WireTx::new(s2c_tx);
    dispatcher
        .context
        .set_sender(postcard_rpc::server::Sender::new(tx.clone(), vkk));
    let mut rpc_server = Server::new(
        tx,
        WireRx::new(c2s_rx),
        vec![0u8; 1024 * 1024].into_boxed_slice(),
        dispatcher,
        vkk,
    );
    wasm_bindgen_futures::spawn_local(async move {
        let _ = rpc_server.run().await;
        log("server stopped");
        post_fatal("the RPC server stopped");
    });

    let scope: web_sys::DedicatedWorkerGlobalScope = js_sys::global().unchecked_into();
    wasm_bindgen_futures::spawn_local(async move {
        while let Some(msg) = s2c_rx.recv().await {
            let arr = js_sys::Uint8Array::from(&msg[..]);
            if scope.post_message(&arr).is_err() {
                log("post_message failed");
            }
        }
    });

    let recv = Closure::<dyn FnMut(js_sys::Uint8Array)>::new(move |b: js_sys::Uint8Array| {
        if c2s_tx.try_send(Ok(b.to_vec())).is_err() {
            log("dropped client frame: channel full");
        }
    });
    let f: js_sys::Function = recv.as_ref().clone().unchecked_into();
    recv.forget();
    f
}

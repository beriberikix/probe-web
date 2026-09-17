//! Spike B: probe-rs (async fork) + nusb WebUSB hosted in a Web Worker,
//! speaking probe-rs's RPC wire format over `postMessage`.
//!
//! The worker runs a postcard-rpc `Server` whose dispatch table implements a
//! subset of `master`'s schema (probe list, chip families, attach, core halt /
//! run, read32). The main thread runs the unmodified `probe-rs-rpc-client`
//! over a `postMessage` wire. Both halves live in this one wasm module.

use std::{cell::RefCell, rc::Rc};

use postcard_rpc::server::{WireRxErrorKind, WireTxErrorKind};
use probe_rs_rpc::transport::memory::{PostcardReceiver, PostcardSender};
use tokio::sync::mpsc;
use wasm_bindgen::prelude::*;

fn log(s: &str) {
    web_sys::console::log_1(&format!("[webusb-worker] {s}").into());
}

// ---------------------------------------------------------------------------
// Worker side: the RPC server on top of the fork's async probe-rs.
// ---------------------------------------------------------------------------
mod server {
    use std::{collections::HashMap, convert::Infallible, future::Future};

    use postcard_rpc::{
        header::VarHeader,
        server::{Sender as PostcardSender, WireRxErrorKind},
    };
    use probe_rs::{
        MemoryInterface, Permissions,
        config::{Registry, TargetSelector},
        probe::list::Lister,
    };
    use probe_rs_rpc::{
        AttachEndpoint, CancelTopic, CoreHaltEndpoint, CoreRunEndpoint, ENDPOINT_LIST,
        ListChipFamiliesEndpoint, ListProbesEndpoint, NoResponse, ReadMemory32Endpoint, RpcError,
        RpcResult, Session, TOPICS_IN_LIST, TOPICS_OUT_LIST, TokioSpawner,
        chip::{Chip, ChipFamily, JEP106Code, ListFamiliesResponse},
        core_ops::{CoreAccessRequest, CoreHaltRequest, WireCoreInformation},
        memory::ReadMemoryRequest,
        probe::{
            AttachRequest, AttachResponse, AttachResult, DebugProbeEntry, ListProbesResponse,
            WireProtocol,
        },
        transport::memory::{WireRx, WireTx},
    };
    use tokio::sync::mpsc::{Receiver, Sender};

    pub type WireTxImpl = WireTx<Sender<Vec<u8>>>;
    pub type WireRxImpl = WireRx<Receiver<Result<Vec<u8>, WireRxErrorKind>>>;

    pub struct Ctx {
        registry: Registry,
        sessions: HashMap<u64, probe_rs::Session>,
    }

    impl Ctx {
        pub fn new() -> Self {
            Self {
                registry: Registry::from_builtin_families(),
                sessions: HashMap::new(),
            }
        }
        fn session(
            &mut self,
            key: probe_rs_rpc::Key<Session>,
        ) -> RpcResult<&mut probe_rs::Session> {
            self.sessions
                .get_mut(&key.id())
                .ok_or_else(|| RpcError::from("unknown session"))
        }
    }

    fn err<E: std::fmt::Display>(e: E) -> RpcError {
        RpcError::from(e.to_string())
    }

    pub fn spawn_fn(
        _sp: &TokioSpawner,
        fut: impl Future<Output = ()> + 'static,
    ) -> Result<(), Infallible> {
        wasm_bindgen_futures::spawn_local(fut);
        Ok(())
    }

    async fn cancel_handler(
        _ctx: &mut Ctx,
        _header: VarHeader,
        _msg: (),
        _sender: &PostcardSender<WireTxImpl>,
    ) {
    }

    async fn list_probes(_ctx: &mut Ctx, _h: VarHeader, _r: ()) -> ListProbesResponse {
        let probes = Lister::new().list_all().await;
        Ok(probes
            .iter()
            .map(|p| DebugProbeEntry {
                identifier: p.identifier.clone(),
                vendor_id: p.vendor_id,
                product_id: p.product_id,
                interface: p.hid_interface,
                serial_number: p.serial_number.clone().unwrap_or_default(),
                probe_type: p.identifier.clone(),
                inaccessible: false,
            })
            .collect())
    }

    async fn list_families(ctx: &mut Ctx, _h: VarHeader, _r: ()) -> ListFamiliesResponse {
        Ok(ctx
            .registry
            .families()
            .iter()
            .map(|f| ChipFamily {
                name: f.name.clone(),
                manufacturer: f.manufacturer.map(|m| JEP106Code { id: m.id, cc: m.cc }),
                variants: f
                    .variants
                    .iter()
                    .map(|v| Chip {
                        name: v.name.clone(),
                    })
                    .collect(),
            })
            .collect())
    }

    async fn attach(ctx: &mut Ctx, _h: VarHeader, req: AttachRequest) -> AttachResponse {
        let probes = Lister::new().list_all().await;
        let Some(info) = probes.iter().find(|p| {
            p.vendor_id == req.probe.vendor_id
                && p.product_id == req.probe.product_id
                && (req.probe.serial_number.is_empty()
                    || p.serial_number.as_deref() == Some(req.probe.serial_number.as_str()))
        }) else {
            return Ok(AttachResult::ProbeNotFound);
        };
        let mut probe = match info.open().await {
            Ok(p) => p,
            Err(e) => return Ok(AttachResult::FailedToOpenProbe(e.to_string())),
        };
        if let Some(proto) = req.protocol {
            let wp = match proto {
                WireProtocol::Swd => probe_rs::probe::WireProtocol::Swd,
                WireProtocol::Jtag => probe_rs::probe::WireProtocol::Jtag,
            };
            probe.select_protocol(wp).await.map_err(err)?;
        }
        let selector = match req.chip {
            Some(c) => TargetSelector::Unspecified(c),
            None => TargetSelector::Auto,
        };
        let session = match probe.attach(selector, Permissions::default()).await {
            Ok(s) => s,
            Err(e) => {
                return Ok(AttachResult::TargetAttachFailed {
                    message: e.to_string(),
                    connect_under_reset: req.connect_under_reset,
                });
            }
        };
        let key = probe_rs_rpc::Key::<Session>::new();
        ctx.sessions.insert(key.id(), session);
        Ok(AttachResult::Success(key))
    }

    async fn core_halt(
        ctx: &mut Ctx,
        _h: VarHeader,
        req: CoreHaltRequest,
    ) -> RpcResult<WireCoreInformation> {
        let session = ctx.session(req.sessid)?;
        let mut core = session.core(req.core as usize).await.map_err(err)?;
        let info = core.halt(req.timeout).await.map_err(err)?;
        Ok(WireCoreInformation { pc: info.pc })
    }

    async fn core_run(ctx: &mut Ctx, _h: VarHeader, req: CoreAccessRequest) -> NoResponse {
        let session = ctx.session(req.sessid)?;
        let mut core = session.core(req.core as usize).await.map_err(err)?;
        core.run().await.map_err(err)?;
        Ok(())
    }

    async fn read_memory32(
        ctx: &mut Ctx,
        _h: VarHeader,
        req: ReadMemoryRequest,
    ) -> RpcResult<Vec<u32>> {
        let session = ctx.session(req.sessid)?;
        let mut core = session.core(req.core as usize).await.map_err(err)?;
        let mut words = vec![0u32; req.count as usize];
        core.read_32(req.address, &mut words).await.map_err(err)?;
        Ok(words)
    }

    postcard_rpc::define_dispatch! {
        app: App;
        spawn_fn: spawn_fn;
        tx_impl: WireTxImpl;
        spawn_impl: TokioSpawner;
        context: Ctx;

        endpoints: {
            list: ENDPOINT_LIST;

            | EndpointTy                | kind      | handler           |
            | ----------                | ----      | -------           |
            | ListProbesEndpoint        | async     | list_probes       |
            | ListChipFamiliesEndpoint  | async     | list_families     |
            | AttachEndpoint            | async     | attach            |
            | CoreHaltEndpoint          | async     | core_halt         |
            | CoreRunEndpoint           | async     | core_run          |
            | ReadMemory32Endpoint      | async     | read_memory32     |
        };
        topics_in: {
            list: TOPICS_IN_LIST;

            | TopicTy                   | kind      | handler           |
            | ----------                | ----      | -------           |
            | CancelTopic               | async     | cancel_handler    |
        };
        topics_out: {
            list: TOPICS_OUT_LIST;
        };
    }
}

/// Worker entry: start the RPC server and return a JS function that feeds it
/// one client frame (a `Uint8Array`). Replies go out via `postMessage`.
#[wasm_bindgen]
pub fn worker_main() -> js_sys::Function {
    use postcard_rpc::server::{Dispatch, Server};
    use probe_rs_rpc::transport::memory::{WireRx, WireTx};
    console_error_panic_hook::set_once();

    let (c2s_tx, c2s_rx) = mpsc::channel::<Result<Vec<u8>, WireRxErrorKind>>(256);
    let (s2c_tx, mut s2c_rx) = mpsc::channel::<Vec<u8>>(256);

    let dispatcher = server::App::new(server::Ctx::new(), probe_rs_rpc::TokioSpawner::default());
    let vkk = dispatcher.min_key_len();
    let mut rpc_server = Server::new(
        WireTx::new(s2c_tx),
        WireRx::new(c2s_rx),
        vec![0u8; 1024 * 1024].into_boxed_slice(),
        dispatcher,
        vkk,
    );
    wasm_bindgen_futures::spawn_local(async move {
        let _ = rpc_server.run().await;
        log("server stopped");
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
    log("server ready");
    f
}

// ---------------------------------------------------------------------------
// Main-thread side: the unmodified RPC client over a postMessage wire.
// ---------------------------------------------------------------------------
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

fn js_err<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen]
pub async fn main_run(chip: String, protocol: String, addr_hex: String) -> Result<String, JsValue> {
    use probe_rs_rpc::probe::{AttachRequest, AttachResult, WireProtocol};
    use probe_rs_rpc_client::SessionInterface;
    use web_sys::{MessageEvent, Worker, WorkerOptions, WorkerType};
    console_error_panic_hook::set_once();
    let mut out = String::new();

    let opts = WorkerOptions::new();
    opts.set_type(WorkerType::Module);
    let worker = Worker::new_with_options("./worker.js", &opts)?;

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

    let t0 = web_time::Instant::now();
    ready_rx
        .await
        .map_err(|_| js_err("worker never became ready"))?;
    out.push_str(&format!("worker ready in {:?}\n", t0.elapsed()));

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    wasm_bindgen_futures::spawn_local({
        let worker = worker.clone();
        async move {
            while let Some(msg) = out_rx.recv().await {
                let arr = js_sys::Uint8Array::from(&msg[..]);
                if worker.post_message(&arr).is_err() {
                    log("post_message to worker failed");
                    break;
                }
            }
        }
    });

    let client = probe_rs_rpc_client::RpcClient::new_local_from_wire(ChanTx(out_tx), ChanRx(in_rx))
        .ensure_compatible()
        .await
        .map_err(js_err)?;
    out.push_str("schema compatible\n");

    let families = client.list_chip_families().await.map_err(js_err)?;
    out.push_str(&format!("chip families: {}\n", families.len()));

    let probes = client.list_probes().await.map_err(js_err)?;
    out.push_str(&format!("probes: {}\n", probes.len()));
    for p in &probes {
        out.push_str(&format!("  {p}\n"));
    }
    let Some(probe) = probes.first() else {
        out.push_str("SPIKE_B_RESULT=PARTIAL (no authorised probe; worker + wire + schema OK)\n");
        return Ok(out);
    };

    let protocol = match protocol.to_ascii_lowercase().as_str() {
        "swd" => Some(WireProtocol::Swd),
        "jtag" => Some(WireProtocol::Jtag),
        _ => None,
    };
    let req = AttachRequest {
        chip: if chip.eq_ignore_ascii_case("auto") || chip.is_empty() {
            None
        } else {
            Some(chip)
        },
        protocol,
        probe: probe.clone(),
        speed: None,
        connect_under_reset: false,
        dry_run: false,
        allow_erase_all: false,
        resume_target: false,
        wait_for_probe: None,
    };
    let t1 = web_time::Instant::now();
    let sessid = match client.attach_probe(req).await.map_err(js_err)? {
        AttachResult::Success(k) => k,
        AttachResult::ProbeNotFound => return Err(js_err("attach failed: probe not found")),
        AttachResult::ProbeInUse => return Err(js_err("attach failed: probe in use")),
        AttachResult::FailedToOpenProbe(m) => {
            return Err(js_err(format!("attach failed: open: {m}")));
        }
        AttachResult::TargetAttachFailed { message, .. } => {
            return Err(js_err(format!("attach failed: {message}")));
        }
    };
    out.push_str(&format!("attached in {:?}\n", t1.elapsed()));

    let session = SessionInterface::new(client.clone(), sessid);
    let core = session.core(0);
    let info = core
        .halt(std::time::Duration::from_millis(500))
        .await
        .map_err(js_err)?;
    out.push_str(&format!("halted, pc={:#010x}\n", info.pc));

    let addr = u64::from_str_radix(addr_hex.trim().trim_start_matches("0x"), 16).unwrap_or(0);
    let words = core.read_memory_32(addr, 4).await.map_err(js_err)?;
    out.push_str(&format!("read32 @{addr:#010x}: {words:08x?}\n"));

    core.run().await.map_err(js_err)?;
    out.push_str("resumed\nSPIKE_B_RESULT=PASS\n");
    Ok(out)
}

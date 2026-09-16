//! probe-web core: the probe-rs RPC client for browsers.
//!
//! One JS API, two transports: `ProbeWebClient.connectWebSocket(url, token)`
//! talks to a native `probe-rs serve`; `ProbeWebClient.connectWorker(worker)`
//! talks to probe-rs itself compiled to wasm inside a Web Worker
//! (`probe-web-local`). Values cross the boundary under the contract in
//! `js.rs`; the TypeScript types are generated from the RPC schema.

mod js;
mod rtt;
mod transport;

use std::{cell::RefCell, path::Path, rc::Rc, time::Duration};

use probe_rs_rpc::{
    flash::{BootInfo, DownloadOptions},
    format::FormatOptions,
    monitor::{MonitorMode, MonitorOptions, RttEvent, SemihostingEvent},
    probe::{AttachRequest, AttachResult},
    rtt_client::ScanRegion,
    rtt_config::RttChannelConfig,
    semihosting_options::SemihostingOptions,
};
use probe_rs_rpc_client::{MonitorEvent, RpcClient, SessionInterface};
use wasm_bindgen::prelude::*;

use js::{client_err, error, from_js, to_js};

/// Address of the RTT control block (`_SEGGER_RTT`) in an ELF, if present.
/// Lets `createRttClient` use an exact scan region instead of scanning all of
/// RAM (which costs ~0.5 s per attempt over WebUSB).
#[wasm_bindgen(js_name = rttSymbolAddress)]
pub fn rtt_symbol_address(elf: &[u8]) -> Option<u64> {
    use object::{Object, ObjectSymbol};
    let file = object::File::parse(elf).ok()?;
    file.symbols()
        .find(|s| s.name() == Ok("_SEGGER_RTT"))
        .map(|s| s.address())
}

#[wasm_bindgen]
pub struct ProbeWebClient {
    client: RpcClient,
    local: bool,
    caps: probe_rs_rpc_client::Capabilities,
}

#[wasm_bindgen]
impl ProbeWebClient {
    /// Connect to a native `probe-rs serve` over WebSocket.
    #[wasm_bindgen(js_name = connectWebSocket)]
    pub async fn connect_web_socket(url: String, token: String) -> Result<ProbeWebClient, JsValue> {
        console_error_panic_hook::set_once();
        let (client, caps) = transport::connect_web_socket(&url, &token).await?;
        Ok(Self { client, local: false, caps })
    }

    /// Connect to a Worker running the probe-web local server (probe-rs in wasm over WebUSB).
    #[wasm_bindgen(js_name = connectWorker)]
    pub async fn connect_worker(worker: web_sys::Worker) -> Result<ProbeWebClient, JsValue> {
        console_error_panic_hook::set_once();
        let (client, caps) = transport::connect_worker(worker).await?;
        Ok(Self { client, local: true, caps })
    }

    /// Endpoint/topic paths this client knows but the server does not
    /// implement: `{ unsupportedEndpoints: string[], unsupportedTopics: string[] }`.
    pub fn capabilities(&self) -> Result<JsValue, JsValue> {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Caps<'a> {
            unsupported_endpoints: &'a [String],
            unsupported_topics: &'a [String],
        }
        to_js(&Caps {
            unsupported_endpoints: &self.caps.unsupported_endpoints,
            unsupported_topics: &self.caps.unsupported_topics,
        })
    }

    /// True for the in-browser (WebUSB) transport.
    #[wasm_bindgen(js_name = isLocal)]
    pub fn is_local(&self) -> bool {
        self.local
    }

    #[wasm_bindgen(js_name = listProbes)]
    pub async fn list_probes(&self) -> Result<JsValue, JsValue> {
        to_js(&self.client.list_probes().await.map_err(client_err)?)
    }

    #[wasm_bindgen(js_name = listChipFamilies)]
    pub async fn list_chip_families(&self) -> Result<JsValue, JsValue> {
        to_js(&self.client.list_chip_families().await.map_err(client_err)?)
    }

    #[wasm_bindgen(js_name = chipInfo)]
    pub async fn chip_info(&self, name: String) -> Result<JsValue, JsValue> {
        to_js(&self.client.chip_info(&name).await.map_err(client_err)?)
    }

    /// Register a chip family described in probe-rs target YAML for this connection.
    #[wasm_bindgen(js_name = loadChipFamily)]
    pub async fn load_chip_family(&self, yaml: String) -> Result<(), JsValue> {
        self.client.load_chip_family(yaml).await.map_err(client_err)
    }

    /// Open a probe and attach to a target. `request` is an `AttachRequest`.
    /// Rejects with `kind` = `probe-not-found` | `probe-in-use` | `open-failed` | `attach-failed`.
    pub async fn attach(&self, request: JsValue) -> Result<ProbeWebSession, JsValue> {
        let request: AttachRequest = from_js(request)?;
        match self.client.attach_probe(request).await.map_err(client_err)? {
            AttachResult::Success(key) => Ok(ProbeWebSession {
                session: SessionInterface::new(self.client.clone(), key),
                rtt: Rc::new(RefCell::new(None)),
            }),
            AttachResult::ProbeNotFound => Err(error("probe-not-found", "probe not found")),
            AttachResult::ProbeInUse => Err(error("probe-in-use", "probe is in use")),
            AttachResult::FailedToOpenProbe(m) => Err(error("open-failed", m)),
            AttachResult::TargetAttachFailed { message, connect_under_reset } => {
                let e = error("attach-failed", message);
                let _ = js_sys::Reflect::set(&e, &"connectUnderReset".into(), &connect_under_reset.into());
                Err(e)
            }
        }
    }
}

struct RttState {
    key: probe_rs_rpc::Key<probe_rs_rpc::RttClient>,
    decoders: rtt::RttDecoders,
}

#[wasm_bindgen]
pub struct ProbeWebSession {
    session: SessionInterface,
    rtt: Rc<RefCell<Option<RttState>>>,
}

fn call(cb: &Option<js_sys::Function>, v: Result<JsValue, JsValue>) {
    if let (Some(cb), Ok(v)) = (cb, v) {
        let _ = cb.call1(&JsValue::NULL, &v);
    }
}

#[wasm_bindgen]
impl ProbeWebSession {
    #[wasm_bindgen(js_name = targetMetadata)]
    pub async fn target_metadata(&self) -> Result<JsValue, JsValue> {
        to_js(&self.session.target_metadata().await.map_err(client_err)?)
    }

    /// Upload `image` (named `name` for caching/logging), build a flash loader
    /// for it and program it. `format` is a `FormatOptions`, `options` a
    /// `DownloadOptions`; `on_progress` receives every `ProgressEvent`.
    /// Resolves with the image's `BootInfo`.
    pub async fn flash(
        &self,
        image: Vec<u8>,
        name: String,
        format: JsValue,
        options: JsValue,
        on_progress: Option<js_sys::Function>,
    ) -> Result<JsValue, JsValue> {
        let format: FormatOptions = from_js(format)?;
        let mut options: DownloadOptions = from_js(options)?;
        options.sanitize();
        let rtt_key = self.rtt.borrow().as_ref().map(|r| r.key);

        let upload = self
            .session
            .resolve_upload_bytes(Path::new(&name), &image)
            .await
            .map_err(client_err)?;
        let loader = self
            .session
            .build_flash_loader_resolved(&upload, format, None, false, rtt_key)
            .await
            .map_err(client_err)?;
        self.session
            .flash(options, loader.loader, async |event| call(&on_progress, to_js(&event)))
            .await
            .map_err(client_err)?;
        to_js(&loader.boot_info)
    }

    /// Compare `image` against flash without writing. Resolves with a `VerifyResult`.
    pub async fn verify(
        &self,
        image: Vec<u8>,
        name: String,
        format: JsValue,
        on_progress: Option<js_sys::Function>,
    ) -> Result<JsValue, JsValue> {
        let format: FormatOptions = from_js(format)?;
        let upload = self
            .session
            .resolve_upload_bytes(Path::new(&name), &image)
            .await
            .map_err(client_err)?;
        let loader = self
            .session
            .build_flash_loader_resolved(&upload, format, None, false, None)
            .await
            .map_err(client_err)?;
        let result = self
            .session
            .verify(loader.loader, async |event| call(&on_progress, to_js(&event)))
            .await
            .map_err(client_err)?;
        to_js(&result)
    }

    #[wasm_bindgen(js_name = eraseAll)]
    pub async fn erase_all(&self, on_progress: Option<js_sys::Function>) -> Result<(), JsValue> {
        self.session
            .erase_all(false, async |event| call(&on_progress, to_js(&event)))
            .await
            .map_err(client_err)
    }

    /// Reset/boot the target according to `boot_info` (from `flash()`) on `core`.
    pub async fn boot(&self, boot_info: JsValue, core: u32) -> Result<(), JsValue> {
        let boot_info: BootInfo = from_js(boot_info)?;
        self.session.boot(boot_info, core as usize).await.map_err(client_err)
    }

    /// Create the server-side RTT client. `scan_region` is a `ScanRegion`,
    /// `configs` an array of `RttChannelConfig`, `default_config` one
    /// `RttChannelConfig`. Must precede `flash()` when the image contains an
    /// RTT control block, and `monitor()`.
    #[wasm_bindgen(js_name = createRttClient)]
    pub async fn create_rtt_client(
        &self,
        scan_region: JsValue,
        configs: JsValue,
        default_config: JsValue,
    ) -> Result<JsValue, JsValue> {
        let scan_region: ScanRegion = from_js(scan_region)?;
        let configs: Vec<RttChannelConfig> = from_js(configs)?;
        let default_config: RttChannelConfig = from_js(default_config)?;
        let data = self
            .session
            .create_rtt_client(scan_region, configs.clone(), default_config.clone())
            .await
            .map_err(client_err)?;
        *self.rtt.borrow_mut() = Some(RttState {
            key: data.handle,
            decoders: rtt::RttDecoders::new(configs, default_config),
        });
        to_js(&data)
    }

    /// Provide the ELF whose defmt table decodes `Defmt` channels. Resolves
    /// with whether the ELF contains a defmt table.
    #[wasm_bindgen(js_name = setDefmtElf)]
    pub fn set_defmt_elf(&self, elf: Vec<u8>) -> Result<bool, JsValue> {
        let mut rtt = self.rtt.borrow_mut();
        let state = rtt
            .as_mut()
            .ok_or_else(|| error("state", "call createRttClient first"))?;
        state.decoders.set_elf(&elf).map_err(|e| error("defmt", e))
    }

    /// Run the monitor loop: boot (or attach to a running target), stream RTT
    /// and semihosting output to `on_event`, resolve with the exit reason.
    /// `mode` is a `MonitorMode`; `options` carries the vector-catch flags.
    /// Events: `{kind:"rtt-discovered", up, down}`, `{kind:"text"|"defmt"|"bytes", channel, …}`,
    /// `{kind:"semihosting", stream, data}`.
    pub async fn monitor(
        &self,
        mode: JsValue,
        options: JsValue,
        on_event: js_sys::Function,
    ) -> Result<JsValue, JsValue> {
        #[derive(serde::Deserialize, Default)]
        #[serde(default, rename_all = "camelCase")]
        struct Opts {
            catch_reset: bool,
            catch_hardfault: bool,
            catch_svc: bool,
            catch_hlt: bool,
        }
        let mode: MonitorMode = from_js(mode)?;
        let opts: Opts = from_js(options)?;
        let rtt_client = self.rtt.borrow().as_ref().map(|r| r.key);
        let options = MonitorOptions {
            catch_reset: opts.catch_reset,
            catch_hardfault: opts.catch_hardfault,
            catch_svc: opts.catch_svc,
            catch_hlt: opts.catch_hlt,
            rtt_client,
            semihosting_options: SemihostingOptions::default(),
        };
        let rtt = self.rtt.clone();
        let exit = self
            .session
            .monitor(mode, options, async |msg| {
                let v = match msg {
                    MonitorEvent::Rtt(RttEvent::Discovered { up_channels, down_channels }) => {
                        #[derive(serde::Serialize)]
                        struct Discovered<'a> {
                            kind: &'static str,
                            up: &'a [probe_rs_rpc::monitor::ChannelInfo],
                            down: &'a [probe_rs_rpc::monitor::ChannelInfo],
                        }
                        to_js(&Discovered { kind: "rtt-discovered", up: &up_channels, down: &down_channels })
                    }
                    MonitorEvent::Rtt(RttEvent::Output { channel, bytes }) => {
                        let mut rtt = rtt.borrow_mut();
                        match rtt.as_mut() {
                            Some(state) => to_js(&state.decoders.decode(channel, &bytes)),
                            None => to_js(&rtt::RttOutput::Bytes { channel, bytes }),
                        }
                    }
                    MonitorEvent::Semihosting(SemihostingEvent::Output { stream, data }) => {
                        #[derive(serde::Serialize)]
                        struct Semi {
                            kind: &'static str,
                            stream: String,
                            data: String,
                        }
                        to_js(&Semi { kind: "semihosting", stream, data })
                    }
                };
                if let Ok(v) = v {
                    let _ = on_event.call1(&JsValue::NULL, &v);
                }
            })
            .await
            .map_err(client_err)?;
        to_js(&exit)
    }

    /// Write to an RTT down channel; resolves with the number of bytes accepted.
    #[wasm_bindgen(js_name = rttWrite)]
    pub async fn rtt_write(&self, channel: u32, data: Vec<u8>, timeout_ms: u32) -> Result<u32, JsValue> {
        let key = self
            .rtt
            .borrow()
            .as_ref()
            .map(|r| r.key)
            .ok_or_else(|| error("state", "call createRttClient first"))?;
        self.session
            .send_to_rtt(key, channel, data, timeout_ms)
            .await
            .map_err(client_err)
    }

    /// Ask the server to stop the running `monitor()`.
    pub async fn cancel(&self) -> Result<(), JsValue> {
        self.session
            .client()
            .publish::<probe_rs_rpc::CancelTopic>(&())
            .await
            .map_err(client_err)
    }

    pub fn core(&self, index: u32) -> ProbeWebCore {
        ProbeWebCore { core: self.session.core(index as usize) }
    }
}

#[wasm_bindgen]
pub struct ProbeWebCore {
    core: probe_rs_rpc_client::CoreInterface,
}

#[wasm_bindgen]
impl ProbeWebCore {
    pub async fn halt(&self, timeout_ms: u32) -> Result<JsValue, JsValue> {
        to_js(&self.core.halt(Duration::from_millis(timeout_ms as u64)).await.map_err(client_err)?)
    }
    pub async fn run(&self) -> Result<(), JsValue> {
        self.core.run().await.map_err(client_err)
    }
    pub async fn status(&self) -> Result<JsValue, JsValue> {
        to_js(&self.core.status().await.map_err(client_err)?)
    }
    pub async fn reset(&self) -> Result<(), JsValue> {
        self.core.reset().await.map_err(client_err)
    }
    #[wasm_bindgen(js_name = resetAndHalt)]
    pub async fn reset_and_halt(&self, timeout_ms: u32) -> Result<JsValue, JsValue> {
        to_js(&self.core.reset_and_halt(Duration::from_millis(timeout_ms as u64)).await.map_err(client_err)?)
    }
    #[wasm_bindgen(js_name = readMemory8)]
    pub async fn read_memory_8(&self, address: u64, count: u32) -> Result<Vec<u8>, JsValue> {
        self.core.read_memory_8(address, count as usize).await.map_err(client_err)
    }
    #[wasm_bindgen(js_name = readMemory32)]
    pub async fn read_memory_32(&self, address: u64, count: u32) -> Result<Vec<u32>, JsValue> {
        self.core.read_memory_32(address, count as usize).await.map_err(client_err)
    }
    #[wasm_bindgen(js_name = writeMemory8)]
    pub async fn write_memory_8(&self, address: u64, data: Vec<u8>) -> Result<(), JsValue> {
        self.core.write_memory_8(address, data).await.map_err(client_err)
    }
    #[wasm_bindgen(js_name = writeMemory32)]
    pub async fn write_memory_32(&self, address: u64, data: Vec<u32>) -> Result<(), JsValue> {
        self.core.write_memory_32(address, data).await.map_err(client_err)
    }
}

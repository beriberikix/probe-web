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
    breakpoints::SourceBreakpointLocation,
    core_ops::{WireRegisterId, WireRegisterValue, WireSteppingMode, WireVectorCatchCondition},
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

/// Address of a symbol in an ELF (exact name match), if present.
#[wasm_bindgen(js_name = elfSymbolAddress)]
pub fn elf_symbol_address(elf: &[u8], name: &str) -> Option<u64> {
    use object::{Object, ObjectSymbol};
    let file = object::File::parse(elf).ok()?;
    file.symbols().find(|s| s.name() == Ok(name)).map(|s| s.address())
}

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
    /// The WebSocket (remote transport). It must be closed explicitly: dropping the Rust
    /// handle leaves the JS socket, and with it the server session and probe, open.
    socket: Option<web_sys::WebSocket>,
}

impl Drop for ProbeWebClient {
    fn drop(&mut self) {
        if let Some(ws) = self.socket.take() {
            let _ = ws.close_with_code(1000);
        }
    }
}

#[wasm_bindgen]
impl ProbeWebClient {
    /// Connect to a native `probe-rs serve` over WebSocket.
    #[wasm_bindgen(js_name = connectWebSocket)]
    pub async fn connect_web_socket(url: String, token: String) -> Result<ProbeWebClient, JsValue> {
        console_error_panic_hook::set_once();
        let (client, caps, ws) = transport::connect_web_socket(&url, &token).await?;
        Ok(Self { client, local: false, caps, socket: Some(ws) })
    }

    /// Connect to a Worker running the probe-web local server (probe-rs in wasm over WebUSB).
    #[wasm_bindgen(js_name = connectWorker)]
    pub async fn connect_worker(worker: web_sys::Worker) -> Result<ProbeWebClient, JsValue> {
        console_error_panic_hook::set_once();
        let (client, caps) = transport::connect_worker(worker).await?;
        Ok(Self { client, local: true, caps, socket: None })
    }

    /// Close the connection now (WebSocket: the server ends the session and releases the probe).
    pub fn close(&mut self) {
        if let Some(ws) = self.socket.take() {
            let _ = ws.close_with_code(1000);
        }
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

    /// Scan the debug port(s) behind a probe without a chip definition: DP/AP
    /// enumeration, ROM tables, JTAG IDCODEs. `request` is a `TargetInfoRequest`;
    /// every `InfoEvent` goes to `on_event`.
    pub async fn info(&self, request: JsValue, on_event: js_sys::Function) -> Result<(), JsValue> {
        let request: probe_rs_rpc::info::TargetInfoRequest = from_js(request)?;
        self.client
            .info(request, async |event| {
                if let Ok(v) = to_js(&event) {
                    let _ = on_event.call1(&JsValue::NULL, &v);
                }
            })
            .await
            .map_err(client_err)
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

    /// Forget the RTT client so the next `monitor` runs without RTT polling
    /// (e.g. firmware that only uses semihosting).
    #[wasm_bindgen(js_name = clearRttClient)]
    pub fn clear_rtt_client(&self) {
        *self.rtt.borrow_mut() = None;
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

    // ------------------------------------------------------------ debugging
    // Thin wrappers over probe-rs-rpc-client; the TypeScript `Debugger` owns
    // the state (live frame/variable ids, breakpoint addresses) and ordering.

    /// Upload an ELF (content-hash cached) and load its DWARF for this session.
    #[wasm_bindgen(js_name = loadDebugInfo)]
    pub async fn load_debug_info(&self, elf: Vec<u8>, name: String) -> Result<(), JsValue> {
        let upload = self.session.resolve_upload_bytes(Path::new(&name), &elf).await.map_err(client_err)?;
        self.session.load_debug_info_resolved(&upload).await.map_err(client_err)
    }

    /// Replace the SVD for `core` (upload, then load; a failed parse clears it).
    #[wasm_bindgen(js_name = loadSvd)]
    pub async fn load_svd(&self, core: u32, svd: Vec<u8>, name: String) -> Result<(), JsValue> {
        self.session.clear_svd(core).await.map_err(client_err)?;
        let upload = self.session.resolve_upload_bytes(Path::new(&name), &svd).await.map_err(client_err)?;
        self.session.load_svd_at(core, upload.server_path()).await.map_err(client_err)
    }

    #[wasm_bindgen(js_name = clearSvd)]
    pub async fn clear_svd(&self, core: u32) -> Result<(), JsValue> {
        self.session.clear_svd(core).await.map_err(client_err)
    }

    /// `stack_trace/rich` for one core (replaces the server's frame/variable caches).
    #[wasm_bindgen(js_name = richStackTrace)]
    pub async fn rich_stack_trace(&self, core: u32, limit: u32) -> Result<JsValue, JsValue> {
        to_js(&self.session.take_rich_stack_trace(Some(core), limit).await.map_err(client_err)?)
    }

    pub async fn scopes(&self, core: u32, frame_id: u32) -> Result<JsValue, JsValue> {
        to_js(&self.session.scopes(core, frame_id).await.map_err(client_err)?)
    }

    pub async fn variables(&self, core: u32, reference: u32, filter: Option<String>) -> Result<JsValue, JsValue> {
        to_js(&self.session.variables(core, reference, filter).await.map_err(client_err)?)
    }

    pub async fn evaluate(&self, core: u32, frame_id: Option<u32>, expression: String) -> Result<JsValue, JsValue> {
        to_js(&self.session.evaluate(core, frame_id, expression).await.map_err(client_err)?)
    }

    #[wasm_bindgen(js_name = setVariable)]
    pub async fn set_variable(&self, core: u32, parent_key: i64, name: String, value: String) -> Result<JsValue, JsValue> {
        to_js(&self.session.set_variable(core, parent_key, name, value).await.map_err(client_err)?)
    }

    #[wasm_bindgen(js_name = clearCoreDebugState)]
    pub async fn clear_core_debug_state(&self, core: u32) -> Result<(), JsValue> {
        self.session.clear_core_debug_state(core).await.map_err(client_err)
    }

    /// `mode`: "StepInstruction" | "OverStatement" | "IntoStatement" | "OutOfStatement".
    pub async fn step(&self, core: u32, mode: JsValue) -> Result<JsValue, JsValue> {
        let mode: WireSteppingMode = from_js(mode)?;
        to_js(&self.session.debug_step(core, mode).await.map_err(client_err)?)
    }

    #[wasm_bindgen(js_name = resolveSourceBreakpoints)]
    pub async fn resolve_source_breakpoints(&self, locations: JsValue) -> Result<JsValue, JsValue> {
        let locations: Vec<SourceBreakpointLocation> = from_js(locations)?;
        to_js(&self.session.resolve_source_breakpoints(locations).await.map_err(client_err)?)
    }

    #[wasm_bindgen(js_name = resolveSourceLocations)]
    pub async fn resolve_source_locations(&self, addresses: Vec<u64>) -> Result<JsValue, JsValue> {
        to_js(&self.session.resolve_source_locations(addresses).await.map_err(client_err)?)
    }

    pub async fn disassemble(
        &self,
        core: u32,
        memory_reference: u64,
        byte_offset: i64,
        instruction_offset: i64,
        instruction_count: i64,
    ) -> Result<JsValue, JsValue> {
        to_js(
            &self
                .session
                .disassemble(core, memory_reference, byte_offset, instruction_offset, instruction_count)
                .await
                .map_err(client_err)?,
        )
    }

    /// RTT channels of the client from `createRttClient` (attaches if needed; errors until the
    /// firmware has set up its control block).
    #[wasm_bindgen(js_name = rttChannels)]
    pub async fn rtt_channels(&self) -> Result<JsValue, JsValue> {
        let key = self.rtt.borrow().as_ref().map(|r| r.key).ok_or_else(|| error("state", "call createRttClient first"))?;
        to_js(&self.session.get_rtt_channels(key).await.map_err(client_err)?)
    }

    /// Read the given up channels once (without the monitor loop, e.g. while debugging) and
    /// decode what arrived. Returns the decoded outputs (`{kind: text|defmt|bytes, channel, …}`);
    /// channels with nothing new are omitted, failed reads are returned as `{kind: "error", channel, message}`.
    #[wasm_bindgen(js_name = pollRtt)]
    pub async fn poll_rtt(&self, channels: Vec<u32>) -> Result<js_sys::Array, JsValue> {
        let key = self.rtt.borrow().as_ref().map(|r| r.key).ok_or_else(|| error("state", "call createRttClient first"))?;
        let results = self.session.poll_rtt_up(key, channels).await.map_err(client_err)?;
        let out = js_sys::Array::new();
        let mut rtt = self.rtt.borrow_mut();
        let state = rtt.as_mut().ok_or_else(|| error("state", "RTT client was cleared"))?;
        for r in results {
            match r.result {
                Ok(bytes) if bytes.is_empty() => {}
                Ok(bytes) => {
                    out.push(&to_js(&state.decoders.decode(r.channel, &bytes))?);
                }
                Err(e) => {
                    #[derive(serde::Serialize)]
                    struct PollError {
                        kind: &'static str,
                        channel: u32,
                        message: String,
                    }
                    out.push(&to_js(&PollError { kind: "error", channel: r.channel, message: e.to_string() })?);
                }
            }
        }
        Ok(out)
    }

    /// `cores`: `null` for all cores.
    #[wasm_bindgen(js_name = haltCores)]
    pub async fn halt_cores(&self, cores: Option<Vec<u32>>, timeout_ms: u32) -> Result<JsValue, JsValue> {
        to_js(&self.session.halt_cores(cores, Duration::from_millis(timeout_ms as u64)).await.map_err(client_err)?)
    }

    #[wasm_bindgen(js_name = resumeCores)]
    pub async fn resume_cores(&self, cores: Option<Vec<u32>>) -> Result<JsValue, JsValue> {
        to_js(&self.session.resume_cores(cores).await.map_err(client_err)?)
    }

    #[wasm_bindgen(js_name = coresStatus)]
    pub async fn cores_status(&self, cores: Option<Vec<u32>>) -> Result<JsValue, JsValue> {
        to_js(&self.session.cores_status(cores).await.map_err(client_err)?)
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
    #[wasm_bindgen(js_name = readMemory16)]
    pub async fn read_memory_16(&self, address: u64, count: u32) -> Result<Vec<u16>, JsValue> {
        self.core.read_memory_16(address, count as usize).await.map_err(client_err)
    }
    #[wasm_bindgen(js_name = readMemory64)]
    pub async fn read_memory_64(&self, address: u64, count: u32) -> Result<Vec<u64>, JsValue> {
        self.core.read_memory_64(address, count as usize).await.map_err(client_err)
    }
    #[wasm_bindgen(js_name = writeMemory16)]
    pub async fn write_memory_16(&self, address: u64, data: Vec<u16>) -> Result<(), JsValue> {
        self.core.write_memory_16(address, data).await.map_err(client_err)
    }
    #[wasm_bindgen(js_name = writeMemory64)]
    pub async fn write_memory_64(&self, address: u64, data: Vec<u64>) -> Result<(), JsValue> {
        self.core.write_memory_64(address, data).await.map_err(client_err)
    }
    /// Reads up to `count` bytes; stops early (shorter result) at unreadable memory.
    #[wasm_bindgen(js_name = readBytes)]
    pub async fn read_bytes(&self, address: u64, count: u32) -> Result<Vec<u8>, JsValue> {
        self.core.read_bytes(address, count as usize).await.map_err(client_err)
    }

    /// `ids`: register ids (probe-rs `RegisterId`). Each result carries `Ok` or `Err`.
    #[wasm_bindgen(js_name = readRegisters)]
    pub async fn read_registers(&self, ids: Vec<u16>) -> Result<JsValue, JsValue> {
        let ids = ids.into_iter().map(WireRegisterId).collect();
        to_js(&self.core.read_registers(ids).await.map_err(client_err)?)
    }
    /// `value`: `{ U32: number } | { U64: bigint } | { U128: bigint }`.
    #[wasm_bindgen(js_name = writeRegister)]
    pub async fn write_register(&self, id: u16, value: JsValue) -> Result<(), JsValue> {
        let value: WireRegisterValue = from_js(value)?;
        self.core.write_core_reg(WireRegisterId(id), value).await.map_err(client_err)
    }
    /// One result per address (`Ok` or `Err(message)`, e.g. no free comparator).
    #[wasm_bindgen(js_name = setHwBreakpoints)]
    pub async fn set_hw_breakpoints(&self, addresses: Vec<u64>) -> Result<JsValue, JsValue> {
        to_js(&self.core.set_hw_breakpoints(addresses).await.map_err(client_err)?)
    }
    #[wasm_bindgen(js_name = clearHwBreakpoints)]
    pub async fn clear_hw_breakpoints(&self, addresses: Vec<u64>) -> Result<(), JsValue> {
        self.core.clear_hw_breakpoints(addresses).await.map_err(client_err)
    }
    /// `condition`: "HardFault" | "CoreReset" | "SecureFault" | "All" | "Svc" | "Hlt".
    #[wasm_bindgen(js_name = enableVectorCatch)]
    pub async fn enable_vector_catch(&self, condition: JsValue) -> Result<(), JsValue> {
        let condition: WireVectorCatchCondition = from_js(condition)?;
        self.core.enable_vector_catch(condition).await.map_err(client_err)
    }
    pub async fn metadata(&self) -> Result<JsValue, JsValue> {
        to_js(&self.core.metadata().await.map_err(client_err)?)
    }
    /// Service a semihosting request the core is halted on (console/file writes); the server
    /// resumes the core when it handled the call. Returns `{status, events}`.
    #[wasm_bindgen(js_name = handleSemihosting)]
    pub async fn handle_semihosting(&self) -> Result<JsValue, JsValue> {
        to_js(&self.core.handle_semihosting().await.map_err(client_err)?)
    }
}

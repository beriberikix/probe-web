//! The dispatch table and handlers.

use std::{
    collections::HashMap, convert::Infallible, future::Future, io::Cursor, rc::Rc, sync::Arc,
    time::Duration,
};

use postcard_rpc::{
    header::{VarHeader, VarSeq},
    server::{Sender as PostcardSender, SpawnContext},
};
use probe_rs::{
    MemoryInterface, Permissions,
    config::{Registry, TargetSelector},
    flashing::{
        self, BinOptions, DownloadOptions as PrDownloadOptions, ElfOptions, FlashLoader,
        FlashProgress, Format,
    },
    probe::list::Lister,
    rtt::Rtt,
};
use probe_rs_rpc::{
    AttachEndpoint, BootEndpoint, BuildEndpoint, CancelTopic, ChipInfoEndpoint, CleanUpRttEndpoint,
    ClearCoreDebugStateEndpoint, CoreClearHwBpsEndpoint, CoreDumpEndpoint, CoreEnableVcEndpoint,
    CoreHaltEndpoint, CoreMetadataEndpoint, CoreReadRegistersEndpoint, CoreRunEndpoint,
    CoreSetHwBpsEndpoint, CoreStatusEndpoint, CoreStepEndpoint, CoreWriteRegEndpoint,
    CoresStatusEndpoint, CreateRttClientEndpoint, CreateTempFileEndpoint, ENDPOINT_LIST,
    EraseAllEndpoint, EvaluateEndpoint, FlashEndpoint, GetRttChannelsEndpoint, HaltCoresEndpoint,
    HandleSemihostingEndpoint, ListChipFamiliesEndpoint, ListProbesEndpoint,
    LoadChipFamilyEndpoint, LoadDebugInfoEndpoint, LoadRegionEndpoint, LoadSvdEndpoint,
    MonitorEndpoint, NewFlashLoaderEndpoint, NoResponse, PollRttUpEndpoint, ProgressEventTopic,
    ReadBytesEndpoint, ReadMemory8Endpoint, ReadMemory16Endpoint, ReadMemory32Endpoint,
    ReadMemory64Endpoint, ResetCoreAndHaltEndpoint, ResetCoreEndpoint,
    ResolveSourceBreakpointsEndpoint, ResolveSourceLocationsEndpoint, ResumeCoresEndpoint,
    RpcError, RpcResult, RttDownEndpoint, RttTopic, ScopesEndpoint, SemihostingTopic, Session,
    SetVariableEndpoint, TOPICS_IN_LIST, TOPICS_OUT_LIST, TakeRichStackTraceEndpoint,
    TargetInfoEndpoint, TargetMetadataEndpoint, TempFileDataEndpoint, TokioSpawner,
    VariablesEndpoint, VerifyEndpoint, WriteMemory8Endpoint, WriteMemory16Endpoint,
    WriteMemory32Endpoint, WriteMemory64Endpoint,
    chip::{
        Chip, ChipData, ChipFamily, ChipInfoRequest, ChipInfoResponse, JEP106Code,
        ListFamiliesResponse, LoadChipFamilyRequest,
    },
    core_ops::{CoreAccessRequest, CoreHaltRequest, WireCoreInformation, WireCoreStatus},
    file::{AppendFileRequest, CreateFileResponse, TempFile},
    flash::{
        BootInfo, BootRequest, BuildRequest, BuildResponse, BuildResult, EraseAllRequest,
        FlashRequest, LoadRegionRequest, NewFlashLoaderRequest, NewFlashLoaderResponse,
        ProgressEvent, VerifyRequest, VerifyResponse, VerifyResult,
    },
    format::FormatKind,
    info::{
        TargetMetadataRequest, TargetMetadataResponse, WireSessionCore, WireSessionTargetMetadata,
    },
    memory::{ReadBytesRequest, ReadMemoryRequest, WriteMemoryRequest},
    monitor::{
        ChannelInfo, MonitorExitReason, MonitorMode, MonitorRequest, MonitorResponse, RttEvent,
    },
    probe::{
        AttachRequest, AttachResponse, AttachResult, DebugProbeEntry, ListProbesResponse,
        WireProtocol,
    },
    reset::{ResetCoreAndHaltRequest, ResetCoreRequest},
    rtt_client::{
        CreateRttClientRequest, CreateRttClientResponse, PollRttUpRequest, PollRttUpResponse,
        RttChannelMeta, RttChannelRequest, RttChannels, RttChannelsResponse, RttClientData,
        RttDownRequest, RttDownResponse, RttPollResult,
    },
    rtt_config::{ChannelMode, RttChannelConfig},
    transport::memory::WireTx,
};
use tokio::sync::{Mutex, mpsc::Sender};
use tokio_util::sync::CancellationToken;

use crate::{
    convert,
    core_ops::{
        core_clear_hw_bps, core_dump, core_enable_vc, core_metadata, core_read_registers,
        core_set_hw_bps, core_step, core_write_reg, cores_status, halt_cores, handle_semihosting,
        resume_cores,
    },
    debug_state::{
        clear_core, evaluate, load_debug_info, load_svd, resolve_source_breakpoints,
        resolve_source_locations, scopes, set_variable, take_rich_stack_trace, variables,
    },
    log,
};

pub type WireTxImpl = WireTx<Sender<Vec<u8>>>;

pub(crate) fn err<E: std::fmt::Display>(e: E) -> RpcError {
    RpcError::from(e.to_string())
}

/// The error's message, plus its `Debug` form when that says more.
pub(crate) fn detail<E: std::fmt::Display + std::fmt::Debug>(e: E) -> String {
    let (display, debug) = (e.to_string(), format!("{e:?}"));
    if debug.contains(&display) || debug == display {
        display
    } else {
        format!("{display} ({debug})")
    }
}

struct RttCfg {
    scan_region: probe_rs::rtt::ScanRegion,
    configs: Vec<RttChannelConfig>,
    default: RttChannelConfig,
    /// The image being flashed writes the control block itself; do not clear it.
    keep_control_block: bool,
    /// Where the control block was last found; later attaches go straight there
    /// instead of rescanning the whole region (a RAM scan takes ~0.5 s over WebUSB).
    found_at: Option<u64>,
    /// RTT attached for `rtt/poll_up` (polling while debugging), kept between polls.
    live: Option<Rtt>,
}

pub struct Inner {
    /// Shared with attach, because `Probe::attach` resolves a chip name against the
    /// registry it is handed -- and its no-registry form builds a fresh one from the
    /// built-in families, so anything `chips/load` added would be invisible. `Registry`
    /// is not `Clone`, so adding a family rebuilds from the built-ins plus `family_yamls`.
    registry: Arc<Registry>,
    /// Every chip-family document loaded at runtime, in order, so the registry can be
    /// rebuilt when another arrives.
    family_yamls: Vec<String>,
    pub(crate) sessions: HashMap<u64, probe_rs::Session>,
    loaders: HashMap<u64, FlashLoader>,
    pub(crate) files: HashMap<String, Vec<u8>>,
    /// Per-session debug state (DWARF, stack frames, variable caches).
    pub(crate) debug: HashMap<u64, crate::debug_state::DebugState>,
    rtt: HashMap<u64, RttCfg>,
    next_file: u64,
}

/// Handler context. `inner` is shared with spawned (long-running) handlers
/// such as `monitor`, which lock it per iteration so other requests can
/// interleave on the single-threaded executor.
#[derive(Clone)]
pub struct Ctx {
    pub(crate) inner: Rc<Mutex<Inner>>,
    cancel: Rc<std::cell::RefCell<CancellationToken>>,
    sender: Option<PostcardSender<WireTxImpl>>,
}

impl Ctx {
    pub fn new() -> Self {
        Self {
            inner: Rc::new(Mutex::new(Inner {
                registry: Arc::new(Registry::from_builtin_families()),
                family_yamls: Vec::new(),
                sessions: HashMap::new(),
                loaders: HashMap::new(),
                files: HashMap::new(),
                debug: HashMap::new(),
                rtt: HashMap::new(),
                next_file: 0,
            })),
            cancel: Rc::new(std::cell::RefCell::new(CancellationToken::new())),
            sender: None,
        }
    }
    pub fn set_sender(&mut self, sender: PostcardSender<WireTxImpl>) {
        self.sender = Some(sender);
    }
    fn sender(&self) -> PostcardSender<WireTxImpl> {
        self.sender.clone().expect("sender set at startup")
    }
}

impl SpawnContext for Ctx {
    type SpawnCtxt = Ctx;
    fn spawn_ctxt(&mut self) -> Self::SpawnCtxt {
        self.clone()
    }
}

impl Inner {
    pub(crate) fn session(
        &mut self,
        key: probe_rs_rpc::Key<Session>,
    ) -> RpcResult<&mut probe_rs::Session> {
        self.sessions
            .get_mut(&key.id())
            .ok_or_else(|| err("unknown session"))
    }
}

pub fn spawn_fn(
    _sp: &TokioSpawner,
    fut: impl Future<Output = ()> + 'static,
) -> Result<(), Infallible> {
    wasm_bindgen_futures::spawn_local(fut);
    Ok(())
}

async fn cancel_handler(ctx: &mut Ctx, _h: VarHeader, _msg: (), _s: &PostcardSender<WireTxImpl>) {
    ctx.cancel.borrow().cancel();
}

/// Publish flash progress events produced by a sync callback during `commit`.
fn progress_pump(ctx: &Ctx) -> (FlashProgress<'static>, impl Future<Output = ()> + 'static) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ProgressEvent>();
    let progress = FlashProgress::new(move |e| {
        let _ = tx.send(convert::progress(e));
    });
    let sender = ctx.sender();
    let pump = async move {
        while let Some(e) = rx.recv().await {
            let _ = sender
                .publish::<ProgressEventTopic>(VarSeq::Seq2(0), &e)
                .await;
        }
    };
    (progress, pump)
}

// ---------------------------------------------------------------- probes

#[cfg(feature = "fake")]
const FAKE_VID_PID: (u16, u16) = (0xFFFF, 0xFFFF);

async fn list_probes(_ctx: &mut Ctx, _h: VarHeader, _r: ()) -> ListProbesResponse {
    #[cfg(feature = "fake")]
    let fake = std::iter::once(DebugProbeEntry {
        identifier: "Fake probe (mocked core, no hardware)".into(),
        vendor_id: FAKE_VID_PID.0,
        product_id: FAKE_VID_PID.1,
        interface: None,
        serial_number: "fake".into(),
        probe_type: "fake".into(),
        inaccessible: false,
    });
    #[cfg(not(feature = "fake"))]
    let fake = std::iter::empty();
    Ok(fake
        .chain(
            Lister::new()
                .list_all()
                .await
                .iter()
                .map(|p| DebugProbeEntry {
                    identifier: p.identifier.clone(),
                    vendor_id: p.vendor_id,
                    product_id: p.product_id,
                    interface: p.hid_interface,
                    serial_number: p.serial_number.clone().unwrap_or_default(),
                    probe_type: p.identifier.clone(),
                    inaccessible: false,
                }),
        )
        .collect())
}

async fn attach(ctx: &mut Ctx, _h: VarHeader, req: AttachRequest) -> AttachResponse {
    #[cfg(feature = "fake")]
    if (req.probe.vendor_id, req.probe.product_id) == FAKE_VID_PID {
        let probe = probe_rs::probe::Probe::from_specific_probe(Box::new(
            probe_rs::integration::FakeProbe::with_mocked_core(),
        ));
        let selector = match req.chip {
            Some(c) => TargetSelector::Unspecified(c),
            None => {
                return Ok(AttachResult::TargetAttachFailed {
                    message: "the fake probe needs an explicit chip".into(),
                    connect_under_reset: false,
                });
            }
        };
        // Same registry as the real path, so a chip imported with `chips/load` can be
        // attached to on the fake probe too -- which is what lets CI cover pack import.
        let registry = ctx.inner.lock().await.registry.clone();
        return match probe
            .attach_with_registry(selector, Permissions::default(), registry)
            .await
        {
            Ok(session) => {
                let key = probe_rs_rpc::Key::<Session>::new();
                ctx.inner.lock().await.sessions.insert(key.id(), session);
                Ok(AttachResult::Success(key))
            }
            Err(e) => Ok(AttachResult::TargetAttachFailed {
                message: detail(e),
                connect_under_reset: false,
            }),
        };
    }
    // Taken before the attach loop: `Probe::attach` would otherwise build its own
    // registry from the built-in families and never see anything `chips/load` added.
    let registry = ctx.inner.lock().await.registry.clone();
    let probes = Lister::new().list_all().await;
    let Some(info) = probes.iter().find(|p| {
        p.vendor_id == req.probe.vendor_id
            && p.product_id == req.probe.product_id
            && (req.probe.serial_number.is_empty()
                || p.serial_number.as_deref() == Some(req.probe.serial_number.as_str()))
    }) else {
        return Ok(AttachResult::ProbeNotFound);
    };
    let selector = match req.chip.clone() {
        Some(c) => TargetSelector::Unspecified(c),
        None => TargetSelector::Auto,
    };

    // A page that went away mid-command leaves its USB transfers queued - WebUSB cannot cancel one
    // (https://github.com/WICG/webusb/issues/25) - and they swallow the replies meant for this
    // session, so the first attach fails (the ESP-USB-JTAG reports `JtagScanChain(InvalidIdCode)`,
    // a CMSIS-DAP probe a read timeout). Closing the probe is what cancels them, so a second
    // attempt with a freshly opened probe succeeds; without this the probe stays unusable in the
    // browser until something opens it natively.
    let mut attempt = 0;
    let mut session = loop {
        attempt += 1;
        let mut probe = match info.open().await {
            Ok(p) => p,
            Err(e) => return Ok(AttachResult::FailedToOpenProbe(detail(e))),
        };
        if let Some(proto) = req.protocol {
            let wp = match proto {
                WireProtocol::Swd => probe_rs::probe::WireProtocol::Swd,
                WireProtocol::Jtag => probe_rs::probe::WireProtocol::Jtag,
            };
            probe.select_protocol(wp).await.map_err(err)?;
        }
        if let Some(speed) = req.speed {
            let _ = probe.set_speed(speed).await;
        }
        let mut permissions = Permissions::default();
        if req.allow_erase_all {
            permissions = permissions.allow_erase_all();
        }
        let attach = if req.connect_under_reset {
            probe
                .attach_under_reset_with_registry(selector.clone(), permissions, registry.clone())
                .await
        } else {
            probe
                .attach_with_registry(selector.clone(), permissions, registry.clone())
                .await
        };
        match attach {
            Ok(s) => break s,
            Err(e) if attempt < 2 => {
                tracing::warn!(
                    "Attach failed ({e}); closing the probe to cancel transfers left over from an \
                     earlier session and trying once more"
                );
                drop(e);
                // `probe` is dropped here, which closes the device and cancels its transfers.
                probe_rs::probe::usb_util::wait(std::time::Duration::from_millis(100)).await;
            }
            Err(e) => {
                return Ok(AttachResult::TargetAttachFailed {
                    message: detail(e),
                    connect_under_reset: req.connect_under_reset,
                });
            }
        }
    };
    // A previous page that went away while debugging leaves its hardware breakpoints armed: native
    // probe-rs clears them when a session is dropped, but dropping cannot await in the worker. An
    // armed breakpoint makes the next flash fail (the flash algorithm runs on the core), so start
    // every session without any.
    for (index, _) in session.list_cores() {
        if let Ok(mut core) = session.core(index).await
            && let Err(e) = core.clear_all_hw_breakpoints().await
        {
            tracing::debug!("could not clear hardware breakpoints on core {index}: {e}");
        }
    }
    let key = probe_rs_rpc::Key::<Session>::new();
    ctx.inner.lock().await.sessions.insert(key.id(), session);
    Ok(AttachResult::Success(key))
}

// ---------------------------------------------------------------- chips

async fn list_families(ctx: &mut Ctx, _h: VarHeader, _r: ()) -> ListFamiliesResponse {
    Ok(ctx
        .inner
        .lock()
        .await
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

async fn chip_info(ctx: &mut Ctx, _h: VarHeader, req: ChipInfoRequest) -> ChipInfoResponse {
    let inner = ctx.inner.lock().await;
    let target = inner.registry.get_target_by_name(&req.name).map_err(err)?;
    Ok(ChipData {
        cores: target
            .cores
            .iter()
            .map(|c| probe_rs_rpc::chip::Core {
                name: c.name.clone(),
                core_type: convert::chip_core_type(c.core_type),
            })
            .collect(),
        memory_map: target
            .memory_map
            .iter()
            .cloned()
            .map(convert::memory_region)
            .collect(),
    })
}

async fn load_chip_family(ctx: &mut Ctx, _h: VarHeader, req: LoadChipFamilyRequest) -> NoResponse {
    let mut inner = ctx.inner.lock().await;
    // Build the replacement first, so a document that does not validate leaves the
    // registry exactly as it was rather than half-updated.
    let mut next = Registry::from_builtin_families();
    for yaml in inner.family_yamls.iter().chain([&req.families_yaml]) {
        next.add_target_family_from_yaml(yaml).map_err(err)?;
    }
    inner.family_yamls.push(req.families_yaml);
    inner.registry = Arc::new(next);
    Ok(())
}

// ---------------------------------------------------------------- files (virtual)

async fn create_temp_file(ctx: &mut Ctx, _h: VarHeader, _r: ()) -> CreateFileResponse {
    let mut inner = ctx.inner.lock().await;
    inner.next_file += 1;
    let path = format!("/virtual/{}", inner.next_file);
    inner.files.insert(path.clone(), Vec::new());
    let key = probe_rs_rpc::Key::<probe_rs_rpc::TempFileHandle>::new();
    // Map the handle to the path so appends can find the buffer.
    inner
        .files
        .insert(format!("/key/{}", key.id()), path.clone().into_bytes());
    Ok(TempFile { key, path })
}

async fn append_temp_file(ctx: &mut Ctx, _h: VarHeader, req: AppendFileRequest) -> NoResponse {
    let mut inner = ctx.inner.lock().await;
    let path = inner
        .files
        .get(&format!("/key/{}", req.key.id()))
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .ok_or_else(|| err("unknown temp file"))?;
    inner
        .files
        .get_mut(&path)
        .ok_or_else(|| err("unknown temp file"))?
        .extend_from_slice(&req.data);
    Ok(())
}

// ---------------------------------------------------------------- flash

async fn new_flash_loader(
    ctx: &mut Ctx,
    _h: VarHeader,
    req: NewFlashLoaderRequest,
) -> NewFlashLoaderResponse {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let loader = session.target().flash_loader();
    let key = probe_rs_rpc::Key::<probe_rs_rpc::FlashLoader>::new();
    inner.loaders.insert(key.id(), loader);
    Ok(key)
}

async fn load_region(ctx: &mut Ctx, _h: VarHeader, req: LoadRegionRequest) -> NoResponse {
    let mut inner = ctx.inner.lock().await;
    let loader = inner
        .loaders
        .get_mut(&req.loader.id())
        .ok_or_else(|| err("unknown loader"))?;
    loader.add_data(req.address, &req.data).map_err(err)?;
    Ok(())
}

fn format_for(kind: FormatKind, default: Option<&str>, req: &BuildRequest) -> RpcResult<Format> {
    Ok(match kind.resolve_default_format(default) {
        FormatKind::Bin => Format::Bin(BinOptions {
            base_address: req.format.bin_options.base_address,
            skip: req.format.bin_options.skip,
        }),
        FormatKind::Hex => Format::Hex,
        FormatKind::Elf => Format::Elf(ElfOptions {
            skip_sections: req.format.elf_options.skip_section.clone(),
        }),
        FormatKind::Uf2 => Format::Uf2,
        FormatKind::Idf => Format::Idf(Default::default()),
        FormatKind::Target => unreachable!(),
    })
}

async fn build(ctx: &mut Ctx, _h: VarHeader, req: BuildRequest) -> BuildResponse {
    let mut inner = ctx.inner.lock().await;
    let bytes = inner
        .files
        .get(&req.path)
        .cloned()
        .ok_or_else(|| err(format!("no uploaded file {}", req.path)))?;
    let keep_cb;
    let (loader, boot) = {
        let session = inner.session(req.sessid)?;
        let default = session.target().default_format.clone();
        let format = format_for(req.format.binary_format, default.as_deref(), &req)?;
        let mut loader = session.target().flash_loader();
        loader
            .load_image(session, &mut Cursor::new(bytes), format, None)
            .await
            .map_err(err)?;
        let boot = loader.boot_info();
        // The image writes the RTT control block itself when it lives in flash data.
        keep_cb = loader.has_data_for_address(0);
        (loader, boot)
    };
    if let Some(rtt) = req.rtt_client
        && let Some(cfg) = inner.rtt.get_mut(&rtt.id())
    {
        cfg.keep_control_block = keep_cb;
        // A new image can move the control block.
        cfg.found_at = None;
    }
    let key = probe_rs_rpc::Key::<probe_rs_rpc::FlashLoader>::new();
    inner.loaders.insert(key.id(), loader);
    Ok(BuildResult {
        loader: key,
        boot_info: convert::boot_info(boot),
    })
}

async fn flash(ctx: &mut Ctx, _h: VarHeader, req: FlashRequest) -> NoResponse {
    let (progress, pump) = progress_pump(ctx);
    wasm_bindgen_futures::spawn_local(pump);
    let mut inner = ctx.inner.lock().await;
    let loader = inner
        .loaders
        .remove(&req.loader.id())
        .ok_or_else(|| err("unknown loader"))?;
    let session = inner.session(req.sessid)?;
    let mut options = PrDownloadOptions::new();
    options.progress = Some(progress);
    options.keep_unwritten_bytes = req.options.keep_unwritten_bytes;
    options.do_chip_erase = req.options.do_chip_erase;
    options.skip_erase = req.options.skip_erase;
    options.verify = req.options.verify;
    options.disable_double_buffering = req.options.disable_double_buffering;
    loader.commit(session, options).await.map_err(err)?;
    Ok(())
}

async fn verify(ctx: &mut Ctx, _h: VarHeader, req: VerifyRequest) -> VerifyResponse {
    let (progress, pump) = progress_pump(ctx);
    wasm_bindgen_futures::spawn_local(pump);
    let mut inner = ctx.inner.lock().await;
    // The loader is kept for a subsequent `flash` of the same image.
    let loader = inner
        .loaders
        .remove(&req.loader.id())
        .ok_or_else(|| err("unknown loader"))?;
    let result = {
        let session = inner.session(req.sessid)?;
        loader.verify(session, progress).await
    };
    inner.loaders.insert(req.loader.id(), loader);
    match result {
        Ok(()) => Ok(VerifyResult::Ok),
        Err(flashing::FlashError::Verify) => Ok(VerifyResult::Mismatch),
        Err(e) => Err(err(e)),
    }
}

async fn erase_all(ctx: &mut Ctx, _h: VarHeader, req: EraseAllRequest) -> NoResponse {
    let (progress, pump) = progress_pump(ctx);
    wasm_bindgen_futures::spawn_local(pump);
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    flashing::erase_all(session, progress).await.map_err(err)?;
    Ok(())
}

/// Mirror `probe-rs serve`: leave the core halted at the reset vector so RTT
/// can attach deterministically; the caller resumes it.
async fn prepare_boot(
    session: &mut probe_rs::Session,
    boot: &BootInfo,
    core_id: usize,
) -> RpcResult<()> {
    match boot {
        BootInfo::Other => {
            let mut core = session.core(core_id).await.map_err(err)?;
            core.reset_and_halt(Duration::from_millis(500))
                .await
                .map_err(err)?;
        }
        BootInfo::FromRam {
            vector_table_addr, ..
        } => {
            session
                .prepare_running_on_ram(*vector_table_addr)
                .await
                .map_err(err)?;
        }
    }
    Ok(())
}

async fn boot(ctx: &mut Ctx, _h: VarHeader, req: BootRequest) -> NoResponse {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    prepare_boot(session, &req.boot_info, req.core_id as usize).await?;
    if req.resume {
        session.resume_all_cores().await.map_err(err)?;
    }
    Ok(())
}

// ---------------------------------------------------------------- RTT + monitor

async fn create_rtt_client(
    ctx: &mut Ctx,
    _h: VarHeader,
    req: CreateRttClientRequest,
) -> CreateRttClientResponse {
    let mut inner = ctx.inner.lock().await;
    let key = probe_rs_rpc::Key::<probe_rs_rpc::RttClient>::new();
    inner.rtt.insert(
        key.id(),
        RttCfg {
            scan_region: convert::scan_region(req.scan_regions),
            configs: req.config,
            default: req.default_config,
            keep_control_block: false,
            found_at: None,
            live: None,
        },
    );
    Ok(RttClientData {
        handle: key,
        core_id: 0,
    })
}

fn channel_mode(m: ChannelMode) -> probe_rs::rtt::ChannelMode {
    match m {
        ChannelMode::NoBlockSkip => probe_rs::rtt::ChannelMode::NoBlockSkip,
        ChannelMode::NoBlockTrim => probe_rs::rtt::ChannelMode::NoBlockTrim,
        ChannelMode::BlockIfFull => probe_rs::rtt::ChannelMode::BlockIfFull,
    }
}

/// Attached RTT state for the running monitor.
struct LiveRtt {
    rtt: Rtt,
}

impl LiveRtt {
    fn info(&mut self) -> (Vec<ChannelInfo>, Vec<ChannelInfo>) {
        let up = self
            .rtt
            .up_channels()
            .iter()
            .map(|c| ChannelInfo {
                name: c.name().unwrap_or("").to_string(),
                buffer_size: c.buffer_size() as u64,
            })
            .collect();
        let down = self
            .rtt
            .down_channels()
            .iter()
            .map(|c| ChannelInfo {
                name: c.name().unwrap_or("").to_string(),
                buffer_size: c.buffer_size() as u64,
            })
            .collect();
        (up, down)
    }
}

/// Attach RTT for `rtt_client`: at the cached control-block address when known
/// (falling back to a scan if the block moved), else by scanning the region.
async fn attach_rtt(
    core: &mut probe_rs::Core<'_>,
    region: &probe_rs::rtt::ScanRegion,
    found_at: Option<u64>,
) -> Result<Rtt, RpcError> {
    if let Some(ptr) = found_at
        && let Ok(rtt) = Rtt::attach_at(core, ptr).await
    {
        return Ok(rtt);
    }
    Rtt::attach_region(core, region).await.map_err(err)
}

async fn get_rtt_channels(
    ctx: &mut Ctx,
    _h: VarHeader,
    req: RttChannelRequest,
) -> RttChannelsResponse {
    let mut inner = ctx.inner.lock().await;
    let (cfg_region, found_at) = inner
        .rtt
        .get(&req.rtt_client.id())
        .map(|c| (c.scan_region.clone(), c.found_at))
        .ok_or_else(|| err("unknown rtt client"))?;
    let (channels, ptr) = {
        let session = inner.session(req.sessid)?;
        let mut core = session.core(0).await.map_err(err)?;
        let mut rtt = attach_rtt(&mut core, &cfg_region, found_at).await?;
        let channels = RttChannels {
            up: rtt
                .up_channels()
                .iter()
                .map(|c| RttChannelMeta {
                    number: c.number() as u32,
                    name: c.name().unwrap_or("").into(),
                })
                .collect(),
            down: rtt
                .down_channels()
                .iter()
                .map(|c| RttChannelMeta {
                    number: c.number() as u32,
                    name: c.name().unwrap_or("").into(),
                })
                .collect(),
        };
        (channels, rtt.ptr())
    };
    if let Some(cfg) = inner.rtt.get_mut(&req.rtt_client.id()) {
        cfg.found_at = Some(ptr);
    }
    Ok(channels)
}

async fn write_rtt_down(ctx: &mut Ctx, _h: VarHeader, req: RttDownRequest) -> RttDownResponse {
    let mut inner = ctx.inner.lock().await;
    let (region, found_at) = inner
        .rtt
        .get(&req.rtt_client.id())
        .map(|c| (c.scan_region.clone(), c.found_at))
        .ok_or_else(|| err("unknown rtt client"))?;
    let (n, ptr) = {
        let session = inner.session(req.sessid)?;
        let mut core = session.core(0).await.map_err(err)?;
        let mut rtt = attach_rtt(&mut core, &region, found_at).await?;
        let ptr = rtt.ptr();
        let ch = rtt
            .down_channel(req.channel as usize)
            .ok_or_else(|| err("no such down channel"))?;
        (ch.write(&mut core, &req.data).await.map_err(err)?, ptr)
    };
    if let Some(cfg) = inner.rtt.get_mut(&req.rtt_client.id()) {
        cfg.found_at = Some(ptr);
    }
    Ok(n as u32)
}

/// `rtt/poll_up`: read the given up channels once (for polling while debugging). Until the
/// firmware has set up its control block every channel reads empty, as on probe-rs serve.
async fn poll_rtt_up(ctx: &mut Ctx, _h: VarHeader, req: PollRttUpRequest) -> PollRttUpResponse {
    let mut guard = ctx.inner.lock().await;
    let inner = &mut *guard;
    let cfg = inner
        .rtt
        .get_mut(&req.rtt_client.id())
        .ok_or_else(|| err("unknown rtt client"))?;
    let session = inner
        .sessions
        .get_mut(&req.sessid.id())
        .ok_or_else(|| err("unknown session"))?;
    let mut core = session.core(0).await.map_err(err)?;
    if cfg.live.is_none() {
        match attach_rtt(&mut core, &cfg.scan_region, cfg.found_at).await {
            Ok(rtt) => {
                cfg.found_at = Some(rtt.ptr());
                cfg.live = Some(rtt);
            }
            Err(_) => {
                return Ok(req
                    .channels
                    .into_iter()
                    .map(|channel| RttPollResult {
                        channel,
                        result: Ok(Vec::new()),
                    })
                    .collect());
            }
        }
    }
    let rtt = cfg.live.as_mut().expect("attached above");
    let mut results = Vec::with_capacity(req.channels.len());
    let mut failed = false;
    for channel in req.channels {
        let result = match rtt.up_channel(channel as usize) {
            None => Err(err(format!("no up channel {channel}"))),
            Some(up) => {
                let mut data = Vec::new();
                let mut buf = [0u8; 1024];
                loop {
                    match up.read(&mut core, &mut buf).await {
                        Ok(0) => break Ok(data),
                        Ok(n) => {
                            data.extend_from_slice(&buf[..n]);
                            if data.len() >= 64 * 1024 {
                                break Ok(data);
                            }
                        }
                        Err(e) => {
                            failed = true;
                            break Err(err(e));
                        }
                    }
                }
            }
        };
        results.push(RttPollResult { channel, result });
    }
    if failed {
        // The control block may have moved (the firmware restarted): attach again next time.
        cfg.live = None;
    }
    Ok(results)
}

/// `rtt/clean_up`: forget the attached RTT state of the client.
async fn clean_up_rtt(ctx: &mut Ctx, _h: VarHeader, req: RttChannelRequest) -> NoResponse {
    let mut inner = ctx.inner.lock().await;
    if let Some(cfg) = inner.rtt.get_mut(&req.rtt_client.id()) {
        cfg.live = None;
    }
    Ok(())
}

/// The run loop: boot (or attach), then poll the core status and RTT until
/// cancelled, the core halts, or the connection drops.
/// `info`: open the probe (no target attach) and stream DP/AP/ROM-table findings.
async fn target_info(
    _ctx: Ctx,
    header: VarHeader,
    req: probe_rs_rpc::info::TargetInfoRequest,
    sender: PostcardSender<WireTxImpl>,
) {
    let result = target_info_impl(&req, &sender).await;
    let _ = sender
        .reply::<TargetInfoEndpoint>(header.seq_no, &result)
        .await;
}

async fn target_info_impl(
    req: &probe_rs_rpc::info::TargetInfoRequest,
    sender: &PostcardSender<WireTxImpl>,
) -> NoResponse {
    // Test hook (fake build only): a scan of probe ffff:fffe panics, so browser tests
    // can check that a crashed worker fails in-flight calls instead of hanging them.
    #[cfg(feature = "fake")]
    if (req.probe.vendor_id, req.probe.product_id) == (0xFFFF, 0xFFFE) {
        panic!("test panic requested through the fake probe");
    }
    #[cfg(feature = "fake")]
    let fake = (req.probe.vendor_id, req.probe.product_id) == FAKE_VID_PID;
    #[cfg(not(feature = "fake"))]
    let fake = false;
    let mut probe = if fake {
        // The fake probe has no debug port; its DP access returns NotImplemented, so the
        // scan reports that as an event instead of panicking the worker.
        #[cfg(feature = "fake")]
        {
            probe_rs::probe::Probe::from_specific_probe(Box::new(
                probe_rs::integration::FakeProbe::with_mocked_core(),
            ))
        }
        #[cfg(not(feature = "fake"))]
        unreachable!("fake is false without the feature")
    } else {
        let probes = Lister::new().list_all().await;
        let info = probes
            .iter()
            .find(|p| {
                p.vendor_id == req.probe.vendor_id
                    && p.product_id == req.probe.product_id
                    && (req.probe.serial_number.is_empty()
                        || p.serial_number.as_deref() == Some(req.probe.serial_number.as_str()))
            })
            .ok_or_else(|| err("probe not found"))?;
        info.open().await.map_err(err)?
    };
    if let Some(speed) = req.speed {
        let _ = probe.set_speed(speed).await;
    }
    let mut ictx = crate::info::InfoCtx { sender };
    crate::info::show_info(
        &mut ictx,
        probe,
        &req.scan_chain,
        req.protocol,
        req.connect_under_reset,
        req.target_sel,
    )
    .await
    .map_err(err)?;
    Ok(())
}

async fn monitor(
    ctx: Ctx,
    header: VarHeader,
    req: MonitorRequest,
    sender: PostcardSender<WireTxImpl>,
) {
    let result = monitor_impl(&ctx, &req, &sender).await;
    let _ = sender
        .reply::<MonitorEndpoint>(header.seq_no, &result)
        .await;
}

/// The page stopped listening (tab closed, client dropped): end the monitor.
fn client_gone() -> MonitorExitReason {
    log("monitor: client disconnected; stopping");
    MonitorExitReason::UserExit
}

async fn monitor_impl(
    ctx: &Ctx,
    req: &MonitorRequest,
    sender: &PostcardSender<WireTxImpl>,
) -> MonitorResponse {
    // Fresh token per monitor run; `cancel` cancels the current one.
    *ctx.cancel.borrow_mut() = CancellationToken::new();
    let token = ctx.cancel.borrow().clone();

    /// The parts of an RTT client's configuration this poll needs, copied out so the lock on
    /// `Inner` can be released before talking to the target.
    type RttPollConfig = (
        Option<probe_rs::rtt::ScanRegion>,
        bool,
        Option<u64>,
        Vec<(u32, Option<ChannelMode>)>,
    );
    let (scan_region, keep_cb, found_at, modes): RttPollConfig = {
        let inner = ctx.inner.lock().await;
        match req.options.rtt_client.and_then(|k| inner.rtt.get(&k.id())) {
            Some(cfg) => {
                let mut modes: Vec<(u32, Option<ChannelMode>)> = cfg
                    .configs
                    .iter()
                    .filter_map(|c| c.channel_number.map(|n| (n, c.mode)))
                    .collect();
                modes.push((u32::MAX, cfg.default.mode));
                (
                    Some(cfg.scan_region.clone()),
                    cfg.keep_control_block,
                    cfg.found_at,
                    modes,
                )
            }
            None => (None, false, None, vec![]),
        }
    };

    // Boot / attach, clearing a stale control block first unless the image writes its own.
    {
        let mut inner = ctx.inner.lock().await;
        let session = inner.session(req.sessid)?;
        // The fork has no `Rtt::clear_control_block`; a stale block from a
        // previous run is tolerated because we re-attach after reset.
        let _ = (&scan_region, keep_cb);
        if let MonitorMode::Run(boot) = &req.mode {
            prepare_boot(session, boot, 0).await?;
        }
    }
    let mut needs_resume = matches!(req.mode, MonitorMode::Run(_));

    let mut live: Option<LiveRtt> = None;
    let mut learned_ptr: Option<u64> = None;
    let mut semihosting = crate::semihosting::ConsoleSemihosting::default();
    let mut buf = vec![0u8; 4096];
    let mut polls: u64 = 0;
    let started = web_time::Instant::now();
    let mut last_rtt_attempt = None::<web_time::Instant>;

    loop {
        if token.is_cancelled() {
            return Ok(MonitorExitReason::UserExit);
        }
        let mut next_poll = Duration::from_millis(50);
        {
            let mut inner = ctx.inner.lock().await;
            let session = inner.session(req.sessid)?;
            let mut core = session.core(0).await.map_err(err)?;

            // Try to attach RTT (retry for a few seconds after boot).
            if live.is_none()
                && let Some(region) = &scan_region
            {
                let due = last_rtt_attempt
                    .map(|t| t.elapsed() >= Duration::from_millis(200))
                    .unwrap_or(true);
                if due && started.elapsed() < Duration::from_secs(10) {
                    last_rtt_attempt = Some(web_time::Instant::now());
                    let attempt = attach_rtt(&mut core, region, found_at).await;
                    if let Ok(mut rtt) = attempt {
                        log(&format!("RTT attached after {:?}", started.elapsed()));
                        learned_ptr = Some(rtt.ptr());
                        for (n, mode) in &modes {
                            if let Some(mode) = mode {
                                let targets: Vec<usize> = if *n == u32::MAX {
                                    (0..rtt.up_channels().len()).collect()
                                } else {
                                    vec![*n as usize]
                                };
                                for i in targets {
                                    if let Some(ch) = rtt.up_channel(i)
                                        && let Err(e) =
                                            ch.set_mode(&mut core, channel_mode(*mode)).await
                                    {
                                        log(&format!(
                                            "RTT: could not set the mode of up channel {i}: {e}"
                                        ));
                                    }
                                }
                            }
                        }
                        let mut l = LiveRtt { rtt };
                        let (up, down) = l.info();
                        if sender
                            .publish::<RttTopic>(
                                VarSeq::Seq2(0),
                                &RttEvent::Discovered {
                                    up_channels: up,
                                    down_channels: down,
                                },
                            )
                            .await
                            .is_err()
                        {
                            return Ok(client_gone());
                        }
                        live = Some(l);
                    }
                }
            }

            polls += 1;
            if let Some(l) = live.as_mut() {
                let mut any = false;
                for i in 0..l.rtt.up_channels().len() {
                    let ch = &mut l.rtt.up_channels()[i];
                    match ch.read(&mut core, &mut buf).await {
                        Ok(n) if n > 0 => {
                            any = true;
                            if sender
                                .publish::<RttTopic>(
                                    VarSeq::Seq2(0),
                                    &RttEvent::Output {
                                        channel: i as u32,
                                        bytes: buf[..n].to_vec(),
                                    },
                                )
                                .await
                                .is_err()
                            {
                                return Ok(client_gone());
                            }
                        }
                        Ok(_) => {}
                        Err(e) => log(&format!("rtt read error on channel {i}: {e}")),
                    }
                }
                if any {
                    next_poll = Duration::from_millis(1);
                }
            }

            if needs_resume {
                // RTT attaches before the first instruction runs (as the server
                // does), or after a bounded number of attempts on a halted core.
                if live.is_some() || polls >= 5 {
                    core.run().await.map_err(err)?;
                    needs_resume = false;
                }
            }
            let status = core.status().await.map_err(err)?;
            if let probe_rs::CoreStatus::Halted(reason) = status
                && !needs_resume
            {
                let probe_rs::HaltReason::Breakpoint(probe_rs::BreakpointCause::Semihosting(cmd)) =
                    reason
                else {
                    return Ok(MonitorExitReason::Halted(convert::halt_reason(reason)));
                };
                match semihosting.handle(cmd, &mut core).await.map_err(err)? {
                    crate::semihosting::Outcome::Exit(exit) => return Ok(exit),
                    crate::semihosting::Outcome::Continue(events) => {
                        for ev in &events {
                            if sender
                                .publish::<SemihostingTopic>(VarSeq::Seq2(0), ev)
                                .await
                                .is_err()
                            {
                                return Ok(client_gone());
                            }
                        }
                        core.run().await.map_err(err)?;
                        // Output often comes in bursts of semihosting calls.
                        next_poll = Duration::ZERO;
                    }
                }
            }
        }
        if let (Some(ptr), Some(key)) = (learned_ptr.take(), req.options.rtt_client)
            && let Some(cfg) = ctx.inner.lock().await.rtt.get_mut(&key.id())
        {
            cfg.found_at = Some(ptr);
        }
        probe_rs::probe::usb_util::wait(next_poll).await;
    }
}

// ---------------------------------------------------------------- target / cores / memory

async fn target_metadata(
    ctx: &mut Ctx,
    _h: VarHeader,
    req: TargetMetadataRequest,
) -> TargetMetadataResponse {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let target = session.target();
    Ok(WireSessionTargetMetadata {
        target_name: target.name.clone(),
        default_format: target.default_format.clone(),
        cores: session
            .list_cores()
            .into_iter()
            .map(|(index, t)| WireSessionCore {
                index: index as u32,
                core_type: convert::core_type(t),
            })
            .collect(),
        memory_map: target
            .memory_map
            .iter()
            .cloned()
            .map(convert::memory_region)
            .collect(),
        flash_sectors: convert::flash_sectors(target),
    })
}

async fn reset(ctx: &mut Ctx, _h: VarHeader, req: ResetCoreRequest) -> NoResponse {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    core.reset().await.map_err(err)?;
    Ok(())
}

async fn reset_and_halt(
    ctx: &mut Ctx,
    _h: VarHeader,
    req: ResetCoreAndHaltRequest,
) -> RpcResult<WireCoreInformation> {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    let info = core.reset_and_halt(req.timeout).await.map_err(err)?;
    Ok(WireCoreInformation { pc: info.pc })
}

async fn core_status(
    ctx: &mut Ctx,
    _h: VarHeader,
    req: CoreAccessRequest,
) -> RpcResult<WireCoreStatus> {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    Ok(convert::core_status(core.status().await.map_err(err)?))
}

async fn core_halt(
    ctx: &mut Ctx,
    _h: VarHeader,
    req: CoreHaltRequest,
) -> RpcResult<WireCoreInformation> {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    let info = core.halt(req.timeout).await.map_err(err)?;
    Ok(WireCoreInformation { pc: info.pc })
}

async fn core_run(ctx: &mut Ctx, _h: VarHeader, req: CoreAccessRequest) -> NoResponse {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    core.run().await.map_err(err)?;
    Ok(())
}

macro_rules! read_mem {
    ($name:ident, $ty:ty, $read:ident) => {
        async fn $name(
            ctx: &mut Ctx,
            _h: VarHeader,
            req: ReadMemoryRequest,
        ) -> RpcResult<Vec<$ty>> {
            let mut inner = ctx.inner.lock().await;
            let session = inner.session(req.sessid)?;
            let mut core = session.core(req.core as usize).await.map_err(err)?;
            let mut words = vec![0 as $ty; req.count as usize];
            core.$read(req.address, &mut words).await.map_err(err)?;
            Ok(words)
        }
    };
}
read_mem!(read_memory8, u8, read_8);
read_mem!(read_memory16, u16, read_16);
read_mem!(read_memory32, u32, read_32);
read_mem!(read_memory64, u64, read_64);

async fn read_bytes(ctx: &mut Ctx, _h: VarHeader, req: ReadBytesRequest) -> RpcResult<Vec<u8>> {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    let mut bytes = vec![0u8; req.count as usize];
    core.read(req.address, &mut bytes).await.map_err(err)?;
    Ok(bytes)
}

macro_rules! write_mem {
    ($name:ident, $ty:ty, $write:ident) => {
        async fn $name(ctx: &mut Ctx, _h: VarHeader, req: WriteMemoryRequest<$ty>) -> NoResponse {
            let mut inner = ctx.inner.lock().await;
            let session = inner.session(req.sessid)?;
            let mut core = session.core(req.core as usize).await.map_err(err)?;
            core.$write(req.address, &req.data).await.map_err(err)?;
            Ok(())
        }
    };
}
write_mem!(write_memory8, u8, write_8);
write_mem!(write_memory16, u16, write_16);
write_mem!(write_memory32, u32, write_32);
write_mem!(write_memory64, u64, write_64);

/// The endpoints this server actually implements. Advertised to clients so
/// `RpcClient::negotiate` reports the rest as unsupported instead of the
/// schema check passing vacuously against `master`'s full list.
pub const LOCAL_ENDPOINT_LIST: postcard_rpc::EndpointMap = postcard_rpc::EndpointMap {
    types: ENDPOINT_LIST.types,
    endpoints: &[
        // postcard-rpc's standard endpoints, served by the dispatcher itself.
        (
            <postcard_rpc::standard_icd::PingEndpoint as postcard_rpc::Endpoint>::PATH,
            <postcard_rpc::standard_icd::PingEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <postcard_rpc::standard_icd::PingEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <postcard_rpc::standard_icd::GetAllSchemasEndpoint as postcard_rpc::Endpoint>::PATH,
            <postcard_rpc::standard_icd::GetAllSchemasEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <postcard_rpc::standard_icd::GetAllSchemasEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ListProbesEndpoint as postcard_rpc::Endpoint>::PATH,
            <ListProbesEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ListProbesEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <AttachEndpoint as postcard_rpc::Endpoint>::PATH,
            <AttachEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <AttachEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ListChipFamiliesEndpoint as postcard_rpc::Endpoint>::PATH,
            <ListChipFamiliesEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ListChipFamiliesEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ChipInfoEndpoint as postcard_rpc::Endpoint>::PATH,
            <ChipInfoEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ChipInfoEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <LoadChipFamilyEndpoint as postcard_rpc::Endpoint>::PATH,
            <LoadChipFamilyEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <LoadChipFamilyEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CreateTempFileEndpoint as postcard_rpc::Endpoint>::PATH,
            <CreateTempFileEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CreateTempFileEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <TempFileDataEndpoint as postcard_rpc::Endpoint>::PATH,
            <TempFileDataEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <TempFileDataEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <NewFlashLoaderEndpoint as postcard_rpc::Endpoint>::PATH,
            <NewFlashLoaderEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <NewFlashLoaderEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <LoadRegionEndpoint as postcard_rpc::Endpoint>::PATH,
            <LoadRegionEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <LoadRegionEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <BuildEndpoint as postcard_rpc::Endpoint>::PATH,
            <BuildEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <BuildEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <FlashEndpoint as postcard_rpc::Endpoint>::PATH,
            <FlashEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <FlashEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <VerifyEndpoint as postcard_rpc::Endpoint>::PATH,
            <VerifyEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <VerifyEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <EraseAllEndpoint as postcard_rpc::Endpoint>::PATH,
            <EraseAllEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <EraseAllEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <BootEndpoint as postcard_rpc::Endpoint>::PATH,
            <BootEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <BootEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CreateRttClientEndpoint as postcard_rpc::Endpoint>::PATH,
            <CreateRttClientEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CreateRttClientEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <GetRttChannelsEndpoint as postcard_rpc::Endpoint>::PATH,
            <GetRttChannelsEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <GetRttChannelsEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <RttDownEndpoint as postcard_rpc::Endpoint>::PATH,
            <RttDownEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <RttDownEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <TargetInfoEndpoint as postcard_rpc::Endpoint>::PATH,
            <TargetInfoEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <TargetInfoEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <MonitorEndpoint as postcard_rpc::Endpoint>::PATH,
            <MonitorEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <MonitorEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <TargetMetadataEndpoint as postcard_rpc::Endpoint>::PATH,
            <TargetMetadataEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <TargetMetadataEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ResetCoreEndpoint as postcard_rpc::Endpoint>::PATH,
            <ResetCoreEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ResetCoreEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ResetCoreAndHaltEndpoint as postcard_rpc::Endpoint>::PATH,
            <ResetCoreAndHaltEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ResetCoreAndHaltEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CoreStatusEndpoint as postcard_rpc::Endpoint>::PATH,
            <CoreStatusEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CoreStatusEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CoreHaltEndpoint as postcard_rpc::Endpoint>::PATH,
            <CoreHaltEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CoreHaltEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CoreRunEndpoint as postcard_rpc::Endpoint>::PATH,
            <CoreRunEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CoreRunEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ReadMemory8Endpoint as postcard_rpc::Endpoint>::PATH,
            <ReadMemory8Endpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ReadMemory8Endpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ReadMemory16Endpoint as postcard_rpc::Endpoint>::PATH,
            <ReadMemory16Endpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ReadMemory16Endpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ReadMemory32Endpoint as postcard_rpc::Endpoint>::PATH,
            <ReadMemory32Endpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ReadMemory32Endpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ReadMemory64Endpoint as postcard_rpc::Endpoint>::PATH,
            <ReadMemory64Endpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ReadMemory64Endpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ReadBytesEndpoint as postcard_rpc::Endpoint>::PATH,
            <ReadBytesEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ReadBytesEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <WriteMemory8Endpoint as postcard_rpc::Endpoint>::PATH,
            <WriteMemory8Endpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <WriteMemory8Endpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <WriteMemory16Endpoint as postcard_rpc::Endpoint>::PATH,
            <WriteMemory16Endpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <WriteMemory16Endpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <WriteMemory32Endpoint as postcard_rpc::Endpoint>::PATH,
            <WriteMemory32Endpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <WriteMemory32Endpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <WriteMemory64Endpoint as postcard_rpc::Endpoint>::PATH,
            <WriteMemory64Endpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <WriteMemory64Endpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <LoadDebugInfoEndpoint as postcard_rpc::Endpoint>::PATH,
            <LoadDebugInfoEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <LoadDebugInfoEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <TakeRichStackTraceEndpoint as postcard_rpc::Endpoint>::PATH,
            <TakeRichStackTraceEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <TakeRichStackTraceEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <HaltCoresEndpoint as postcard_rpc::Endpoint>::PATH,
            <HaltCoresEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <HaltCoresEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ResumeCoresEndpoint as postcard_rpc::Endpoint>::PATH,
            <ResumeCoresEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ResumeCoresEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CoresStatusEndpoint as postcard_rpc::Endpoint>::PATH,
            <CoresStatusEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CoresStatusEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CoreStepEndpoint as postcard_rpc::Endpoint>::PATH,
            <CoreStepEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CoreStepEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CoreWriteRegEndpoint as postcard_rpc::Endpoint>::PATH,
            <CoreWriteRegEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CoreWriteRegEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CoreSetHwBpsEndpoint as postcard_rpc::Endpoint>::PATH,
            <CoreSetHwBpsEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CoreSetHwBpsEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CoreClearHwBpsEndpoint as postcard_rpc::Endpoint>::PATH,
            <CoreClearHwBpsEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CoreClearHwBpsEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CoreEnableVcEndpoint as postcard_rpc::Endpoint>::PATH,
            <CoreEnableVcEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CoreEnableVcEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CoreMetadataEndpoint as postcard_rpc::Endpoint>::PATH,
            <CoreMetadataEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CoreMetadataEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CoreReadRegistersEndpoint as postcard_rpc::Endpoint>::PATH,
            <CoreReadRegistersEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CoreReadRegistersEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ScopesEndpoint as postcard_rpc::Endpoint>::PATH,
            <ScopesEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ScopesEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <VariablesEndpoint as postcard_rpc::Endpoint>::PATH,
            <VariablesEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <VariablesEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ClearCoreDebugStateEndpoint as postcard_rpc::Endpoint>::PATH,
            <ClearCoreDebugStateEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ClearCoreDebugStateEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ResolveSourceBreakpointsEndpoint as postcard_rpc::Endpoint>::PATH,
            <ResolveSourceBreakpointsEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ResolveSourceBreakpointsEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <ResolveSourceLocationsEndpoint as postcard_rpc::Endpoint>::PATH,
            <ResolveSourceLocationsEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <ResolveSourceLocationsEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <EvaluateEndpoint as postcard_rpc::Endpoint>::PATH,
            <EvaluateEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <EvaluateEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <SetVariableEndpoint as postcard_rpc::Endpoint>::PATH,
            <SetVariableEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <SetVariableEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <LoadSvdEndpoint as postcard_rpc::Endpoint>::PATH,
            <LoadSvdEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <LoadSvdEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CoreDumpEndpoint as postcard_rpc::Endpoint>::PATH,
            <CoreDumpEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CoreDumpEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <PollRttUpEndpoint as postcard_rpc::Endpoint>::PATH,
            <PollRttUpEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <PollRttUpEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <CleanUpRttEndpoint as postcard_rpc::Endpoint>::PATH,
            <CleanUpRttEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <CleanUpRttEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
        (
            <HandleSemihostingEndpoint as postcard_rpc::Endpoint>::PATH,
            <HandleSemihostingEndpoint as postcard_rpc::Endpoint>::REQ_KEY,
            <HandleSemihostingEndpoint as postcard_rpc::Endpoint>::RESP_KEY,
        ),
    ],
};

postcard_rpc::define_dispatch! {
    app: App;
    spawn_fn: spawn_fn;
    tx_impl: WireTxImpl;
    spawn_impl: TokioSpawner;
    context: Ctx;

    endpoints: {
        list: LOCAL_ENDPOINT_LIST;

        | EndpointTy                | kind      | handler            |
        | ----------                | ----      | -------            |
        | ListProbesEndpoint        | async     | list_probes        |
        | AttachEndpoint            | async     | attach             |
        | ListChipFamiliesEndpoint  | async     | list_families      |
        | ChipInfoEndpoint          | async     | chip_info          |
        | LoadChipFamilyEndpoint    | async     | load_chip_family   |
        | CreateTempFileEndpoint    | async     | create_temp_file   |
        | TempFileDataEndpoint      | async     | append_temp_file   |
        | NewFlashLoaderEndpoint    | async     | new_flash_loader   |
        | LoadRegionEndpoint        | async     | load_region        |
        | BuildEndpoint             | async     | build              |
        | FlashEndpoint             | async     | flash              |
        | VerifyEndpoint            | async     | verify             |
        | EraseAllEndpoint          | async     | erase_all          |
        | BootEndpoint              | async     | boot               |
        | CreateRttClientEndpoint   | async     | create_rtt_client  |
        | GetRttChannelsEndpoint    | async     | get_rtt_channels   |
        | RttDownEndpoint           | async     | write_rtt_down     |
        | MonitorEndpoint           | spawn     | monitor            |
        | TargetInfoEndpoint        | spawn     | target_info        |
        | TargetMetadataEndpoint    | async     | target_metadata    |
        | ResetCoreEndpoint         | async     | reset              |
        | ResetCoreAndHaltEndpoint  | async     | reset_and_halt     |
        | CoreStatusEndpoint        | async     | core_status        |
        | CoreHaltEndpoint          | async     | core_halt          |
        | CoreRunEndpoint           | async     | core_run           |
        | ReadMemory8Endpoint       | async     | read_memory8       |
        | ReadMemory16Endpoint      | async     | read_memory16      |
        | ReadMemory32Endpoint      | async     | read_memory32      |
        | ReadMemory64Endpoint      | async     | read_memory64      |
        | ReadBytesEndpoint         | async     | read_bytes         |
        | WriteMemory8Endpoint      | async     | write_memory8      |
        | WriteMemory16Endpoint     | async     | write_memory16     |
        | WriteMemory32Endpoint     | async     | write_memory32     |
        | WriteMemory64Endpoint     | async     | write_memory64     |
        | LoadDebugInfoEndpoint     | async     | load_debug_info    |
        | TakeRichStackTraceEndpoint | async    | take_rich_stack_trace |
        | HaltCoresEndpoint | async | halt_cores |
        | ResumeCoresEndpoint | async | resume_cores |
        | CoresStatusEndpoint | async | cores_status |
        | CoreStepEndpoint | async | core_step |
        | CoreWriteRegEndpoint | async | core_write_reg |
        | CoreSetHwBpsEndpoint | async | core_set_hw_bps |
        | CoreClearHwBpsEndpoint | async | core_clear_hw_bps |
        | CoreEnableVcEndpoint | async | core_enable_vc |
        | CoreMetadataEndpoint | async | core_metadata |
        | CoreReadRegistersEndpoint | async | core_read_registers |
        | ScopesEndpoint | async | scopes |
        | VariablesEndpoint | async | variables |
        | ClearCoreDebugStateEndpoint | async | clear_core |
        | ResolveSourceBreakpointsEndpoint | async | resolve_source_breakpoints |
        | ResolveSourceLocationsEndpoint | async | resolve_source_locations |
        | EvaluateEndpoint | async | evaluate |
        | SetVariableEndpoint | async | set_variable |
        | LoadSvdEndpoint | async | load_svd |
        | CoreDumpEndpoint | async | core_dump |
        | PollRttUpEndpoint | async | poll_rtt_up |
        | CleanUpRttEndpoint | async | clean_up_rtt |
        | HandleSemihostingEndpoint | async | handle_semihosting |
    };
    topics_in: {
        list: TOPICS_IN_LIST;

        | TopicTy                   | kind      | handler            |
        | ----------                | ----      | -------            |
        | CancelTopic               | async     | cancel_handler     |
    };
    topics_out: {
        list: TOPICS_OUT_LIST;
    };
}

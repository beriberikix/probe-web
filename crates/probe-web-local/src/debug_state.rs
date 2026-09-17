//! Debugging in the worker: per-session DWARF and the stack/variable caches derived from it,
//! mirroring `probe-rs serve`'s `ServerDebugState` so the TypeScript `Debugger` sees the same
//! handle semantics on both transports (frame ids from probe-rs-debug; the Registers scope's
//! `variablesReference` is the frame id; `scopes`/`variables` need the last rich stack trace;
//! `debug_state/clear_core` drops it).

use std::{collections::HashMap, rc::Rc};

use postcard_rpc::header::VarHeader;
use probe_rs::{Error, RegisterValue};
use probe_rs_debug::{
    DebugInfo, DebugRegister, DebugRegisters, ObjectRef, StackFrame, Variable, VariableCache,
    VariableLocation, VariableName, exception_handler_for_core, stack_frame::StackFrameInfo,
};
use probe_rs_rpc::{
    RpcResult,
    core_ops::{WireRegisterId, WireRegisterValue},
    breakpoints::{
        BreakpointResolution, ResolveSourceBreakpointsRequest, ResolveSourceBreakpointsResponse,
        ResolveSourceLocationsRequest, ResolveSourceLocationsResponse, WireColumn, WireSourceLocation,
        WireVerifiedBreakpoint,
    },
    debug_vars::{
        ClearCoreDebugStateRequest, EvaluateRequest, EvaluateResponse, LoadSvdRequest, LoadSvdResponse, ScopesRequest,
        ScopesResponse, SetVariableRequest, SetVariableResult, VariablesRequest, VariablesResponse, WireEvaluateResponse,
        WireScope, WireSetVariableResponse, WireVariable,
    },
    stack_trace::{
        LoadDebugInfoRequest, LoadDebugInfoResponse, RichStackTrace, RichStackTraceFrame, RichStackTraces,
        SourceLocation, TakeRichStackTraceRequest, TakeRichStackTraceResponse, WireDebugRegister,
    },
};

use crate::server::{Ctx, err};

/// Debug state of one session.
#[derive(Default)]
pub struct DebugState {
    /// DWARF of the running program; `None` until `debug_state/load_debug_info`.
    pub debug_info: Option<Rc<DebugInfo>>,
    pub per_core: HashMap<usize, CoreDebugState>,
    /// Console semihosting per core (open `:tt` handles), for `core/handle_semihosting`.
    pub semihosting: HashMap<usize, crate::semihosting::ConsoleSemihosting>,
}

#[derive(Default)]
pub struct CoreDebugState {
    /// Frames of the last `stack_trace/rich`, innermost first.
    pub stack_frames: Vec<StackFrame>,
    pub static_variables: Option<VariableCache>,
    /// CMSIS-SVD peripherals for the Peripherals scope; survives stack refreshes and `clear_core`.
    pub svd_variables: Option<crate::svd::SvdVariableCache>,
}

impl DebugState {
    /// Replace the DWARF and drop everything derived from the previous binary.
    fn replace_debug_info(&mut self, debug_info: DebugInfo) {
        self.debug_info = Some(Rc::new(debug_info));
        for core in self.per_core.values_mut() {
            core.stack_frames.clear();
            core.static_variables = None;
        }
    }
}

pub fn wire_register_value(value: RegisterValue) -> WireRegisterValue {
    match value {
        RegisterValue::U32(v) => WireRegisterValue::U32(v),
        RegisterValue::U64(v) => WireRegisterValue::U64(v),
        RegisterValue::U128(v) => WireRegisterValue::U128(v),
    }
}

fn wire_source_location(location: &probe_rs_debug::SourceLocation) -> SourceLocation {
    SourceLocation {
        file: location.path.to_path().to_string_lossy().into_owned(),
        line: location.line,
        column: location.column.map(|col| match col {
            probe_rs_debug::ColumnType::LeftEdge => 1,
            probe_rs_debug::ColumnType::Column(c) => c,
        }),
    }
}

fn wire_debug_register(r: &DebugRegister) -> WireDebugRegister {
    WireDebugRegister {
        id: WireRegisterId(r.core_register.id.0),
        dwarf_id: r.dwarf_id,
        value: r.value.map(wire_register_value),
    }
}

/// `debug_state/load_debug_info`: parse the ELF uploaded as a temp file (the worker has no file
/// system). Parsing finishes before the old state is replaced, so a bad file leaves it intact.
pub async fn load_debug_info(ctx: &mut Ctx, _h: VarHeader, req: LoadDebugInfoRequest) -> LoadDebugInfoResponse {
    let mut inner = ctx.inner.lock().await;
    inner.session(req.sessid)?;
    let bytes = inner.files.get(&req.path).ok_or_else(|| err(format!("unknown file {}", req.path)))?;
    let started = web_time::Instant::now();
    let debug_info = DebugInfo::from_raw(bytes).map_err(err)?;
    tracing::info!("parsed debug info ({} bytes) in {:?}", bytes.len(), started.elapsed());
    inner.debug.entry(req.sessid.id()).or_default().replace_debug_info(debug_info);
    Ok(())
}

/// `stack_trace/rich`: unwind each (or the requested) core with the session's DWARF and keep the
/// frames and static scope for `scopes`/`variables`.
pub async fn take_rich_stack_trace(ctx: &mut Ctx, _h: VarHeader, req: TakeRichStackTraceRequest) -> TakeRichStackTraceResponse {
    let mut guard = ctx.inner.lock().await;
    let inner = &mut *guard;
    let debug_info = inner
        .debug
        .get(&req.sessid.id())
        .and_then(|state| state.debug_info.clone())
        .ok_or_else(|| err("no debug info loaded for this session (debug_state/load_debug_info)"))?;
    let session = inner.session(req.sessid)?;
    let limit = req.stack_frame_limit as usize;

    let cores: Vec<(u32, Vec<StackFrame>, VariableCache)> = session
        .halted_access(async |session| {
            let mut cores = Vec::new();
            for (idx, core_type) in session.list_cores() {
                if req.core.is_some_and(|c| c as usize != idx) {
                    continue;
                }
                let mut core = match session.core(idx).await {
                    Ok(core) => core,
                    Err(Error::CoreDisabled(_)) => continue,
                    Err(e) => return Err(e),
                };
                let registers = DebugRegisters::from_core(&mut core).await;
                let exception_handler = exception_handler_for_core(core_type);
                let instruction_set = core.instruction_set().await.ok();
                // Always bounded: the fork's unwinder can loop on some stacks (seen on the ESP32-S3).
                let limit = if limit == 0 { 100 } else { limit };
                let frames = debug_info
                    .unwind_with_limit(&mut core, registers, exception_handler.as_ref(), instruction_set, limit)
                    .await?;
                cores.push((idx as u32, frames, debug_info.create_static_scope_cache()));
            }
            Ok(cores)
        })
        .await
        .map_err(err)?;

    let state = inner.debug.entry(req.sessid.id()).or_default();
    let mut wire = Vec::new();
    for (core, frames, statics) in cores {
        let rich = frames
            .iter()
            .map(|f| RichStackTraceFrame {
                function_name: f.function_name.clone(),
                program_counter: wire_register_value(f.pc),
                is_inlined: f.is_inlined,
                location: f.source_location.as_ref().map(wire_source_location),
                frame_base: f.frame_base,
                canonical_frame_address: f.canonical_frame_address,
                registers: f.registers.0.iter().map(wire_debug_register).collect(),
                id: i64::from(f.id) as u32,
            })
            .collect();
        let core_state = state.per_core.entry(core as usize).or_default();
        core_state.stack_frames = frames;
        core_state.static_variables = Some(statics);
        wire.push(RichStackTrace { core, frames: rich });
    }
    Ok(RichStackTraces { cores: wire })
}

// ---------------------------------------------------------------- scopes and variables

/// The memory reference of a variable, only when it lives at an address.
fn memory_reference(location: &VariableLocation) -> Option<String> {
    match location {
        VariableLocation::Address(address) => Some(format!("{address:#010x}")),
        _ => None,
    }
}

/// `(variables_reference, named children, indexed children)` of a variable, as serve reports them.
fn variable_reference(parent: &Variable, cache: &VariableCache) -> (ObjectRef, i64, i64) {
    if !parent.is_valid() {
        return (ObjectRef::Invalid, 0, 0);
    }
    let (mut named, mut indexed) = (0, 0);
    for child in cache.get_children(parent.variable_key()) {
        if child.is_indexed() {
            indexed += 1;
        } else {
            named += 1;
        }
    }
    if named > 0 || indexed > 0 {
        (parent.variable_key(), named, indexed)
    } else if parent.variable_node_type.is_deferred() && parent.to_string(cache) != "()" {
        (parent.variable_key(), 0, 0)
    } else {
        (ObjectRef::Invalid, 0, 0)
    }
}

/// `stack_trace/scopes`: Static, Registers (reference = frame id) and Variables of a frame from
/// the last rich stack trace.
pub async fn scopes(ctx: &mut Ctx, _h: VarHeader, req: ScopesRequest) -> ScopesResponse {
    let inner = ctx.inner.lock().await;
    let core_state = inner
        .debug
        .get(&req.sessid.id())
        .and_then(|s| s.per_core.get(&(req.core as usize)))
        .ok_or_else(|| err("no stack trace for this core (stack_trace/rich)"))?;
    let frame_ref = ObjectRef::from(req.frame_id as i64);
    let mut scopes = Vec::new();
    if let Some(statics) = &core_state.static_variables {
        scopes.push(WireScope {
            name: "Static".into(),
            presentation_hint: Some("statics".into()),
            variables_reference: i64::from(statics.root_variable().variable_key()),
            expensive: true,
            line: None,
            column: None,
        });
    }
    if let Some(svd) = &core_state.svd_variables {
        scopes.push(WireScope {
            name: "Peripherals".into(),
            presentation_hint: None,
            variables_reference: i64::from(svd.root_variable_key()),
            expensive: true,
            line: None,
            column: None,
        });
    }
    if let Some(frame) = core_state.stack_frames.iter().find(|f| f.id == frame_ref) {
        scopes.push(WireScope {
            name: "Registers".into(),
            presentation_hint: Some("registers".into()),
            variables_reference: i64::from(frame.id),
            expensive: true,
            line: None,
            column: None,
        });
        if let Some(locals) = &frame.local_variables {
            let location = frame.source_location.as_ref();
            scopes.push(WireScope {
                name: "Variables".into(),
                presentation_hint: Some("locals".into()),
                variables_reference: i64::from(locals.root_variable().variable_key()),
                expensive: false,
                line: location.and_then(|l| l.line.map(|l| l as i64)),
                column: location.and_then(|l| {
                    l.column.map(|c| match c {
                        probe_rs_debug::ColumnType::LeftEdge => 0,
                        probe_rs_debug::ColumnType::Column(c) => c as i64,
                    })
                }),
            });
        }
    }
    Ok(scopes)
}

/// `stack_trace/variables`: a frame's registers, or the children of a static or local variable,
/// resolving deferred children from target memory on first use.
pub async fn variables(ctx: &mut Ctx, _h: VarHeader, req: VariablesRequest) -> VariablesResponse {
    let mut guard = ctx.inner.lock().await;
    let inner = &mut *guard;
    let state = inner.debug.get_mut(&req.sessid.id()).ok_or_else(|| err("no debug state for this session"))?;
    let debug_info = state.debug_info.clone().ok_or_else(|| err("no debug info loaded for this session"))?;
    let core_state = state
        .per_core
        .get_mut(&(req.core as usize))
        .ok_or_else(|| err("no stack trace for this core (stack_trace/rich)"))?;
    let session = inner.sessions.get_mut(&req.sessid.id()).ok_or_else(|| err("unknown session"))?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    let variable_ref = ObjectRef::from(req.variables_reference as i64);

    // A frame id: its registers.
    if let Some(frame) = core_state.stack_frames.iter().find(|f| f.id == variable_ref) {
        return Ok(frame
            .registers
            .0
            .iter()
            .map(|register| WireVariable {
                name: register.get_register_name(),
                evaluate_name: Some(register.get_register_name()),
                memory_reference: None,
                indexed_variables: None,
                named_variables: None,
                type_: Some(format!("{}", VariableName::RegistersRoot)),
                value: register.value.unwrap_or_default().to_string(),
                variables_reference: 0,
            })
            .collect());
    }

    // Peripherals: values are read from the target on every request.
    if let Some(svd) = core_state.svd_variables.as_ref()
        && svd.get_variable_by_key(variable_ref).is_some()
    {
        let mut out = Vec::new();
        for variable in svd.get_children(variable_ref) {
            let child_count = svd.get_children(variable.variable_key()).len() as i64;
            out.push(WireVariable {
                name: variable.name().to_string(),
                evaluate_name: None,
                memory_reference: variable.memory_reference(),
                indexed_variables: Some(0),
                named_variables: Some(child_count),
                type_: variable.type_name(),
                value: variable.get_value(&mut core).await,
                variables_reference: i64::from(variable.variable_key()),
            });
        }
        return Ok(out);
    }

    // Statics resolve against the innermost frame's registers; locals against their own frame's.
    let top_registers = core_state.stack_frames.first().map(|f| (f.registers.clone(), f.frame_base, f.canonical_frame_address));
    let mut parent: Option<Variable> = None;
    let mut cache: Option<&mut VariableCache> = None;
    let mut frame_info: Option<(DebugRegisters, Option<u64>, Option<u64>)> = None;
    if let Some(statics) = core_state.static_variables.as_mut()
        && let Some(variable) = statics.get_variable_by_key(variable_ref)
    {
        parent = Some(variable);
        cache = Some(statics);
        frame_info = top_registers;
    }
    if parent.is_none() {
        for frame in core_state.stack_frames.iter_mut() {
            let registers = (frame.registers.clone(), frame.frame_base, frame.canonical_frame_address);
            if let Some(locals) = frame.local_variables.as_mut()
                && let Some(variable) = locals.get_variable_by_key(variable_ref)
            {
                parent = Some(variable);
                cache = Some(locals);
                frame_info = Some(registers);
                break;
            }
        }
    }
    let cache = cache.ok_or_else(|| err(format!("No variable information found for {}!", req.variables_reference)))?;

    if let Some(parent) = parent.as_mut()
        && parent.variable_node_type.is_deferred()
        && !cache.has_children(parent)
        && let Some((registers, frame_base, canonical_frame_address)) = &frame_info
    {
        let info = StackFrameInfo { registers, frame_base: *frame_base, canonical_frame_address: *canonical_frame_address };
        debug_info.cache_deferred_variables(cache, &mut core, parent, info).await.map_err(err)?;
    }

    let filter = req.filter.as_deref();
    Ok(cache
        .get_children(variable_ref)
        .filter(|v| match filter {
            Some("indexed") => v.is_indexed(),
            Some("named") => !v.is_indexed(),
            Some(_) => false,
            None => true,
        })
        .map(|v| {
            let (reference, named, indexed) = variable_reference(v, cache);
            WireVariable {
                name: v.name.to_string(),
                evaluate_name: None,
                memory_reference: memory_reference(&v.memory_location),
                indexed_variables: Some(indexed),
                named_variables: Some(named),
                type_: Some(v.type_name()),
                value: v.to_string(cache),
                variables_reference: i64::from(reference),
            }
        })
        .collect())
}

/// `debug_state/clear_core`: forget a core's frames and variable caches (called before resuming).
pub async fn clear_core(ctx: &mut Ctx, _h: VarHeader, req: ClearCoreDebugStateRequest) -> RpcResult<()> {
    let mut inner = ctx.inner.lock().await;
    if let Some(core) = inner.debug.get_mut(&req.sessid.id()).and_then(|s| s.per_core.get_mut(&(req.core as usize))) {
        core.stack_frames.clear();
        core.static_variables = None;
    }
    Ok(())
}

// ---------------------------------------------------------------- source breakpoints

fn wire_breakpoint_location(location: &probe_rs_debug::SourceLocation) -> WireSourceLocation {
    WireSourceLocation {
        path: location.path.to_path().to_string_lossy().into_owned(),
        line: location.line,
        column: location.column.map(|column| match column {
            probe_rs_debug::ColumnType::LeftEdge => WireColumn::LeftEdge,
            probe_rs_debug::ColumnType::Column(column) => WireColumn::Column(column),
        }),
        address: location.address,
    }
}

/// `debug_state/resolve_source_breakpoints`: the address probe-rs would halt at for each
/// `path:line[:column]` (paths may be a suffix of the DWARF path), or why there is none.
pub async fn resolve_source_breakpoints(ctx: &mut Ctx, _h: VarHeader, req: ResolveSourceBreakpointsRequest) -> ResolveSourceBreakpointsResponse {
    let inner = ctx.inner.lock().await;
    let Some(debug_info) = inner.debug.get(&req.sessid.id()).and_then(|s| s.debug_info.clone()) else {
        return Ok(req
            .locations
            .into_iter()
            .map(|_| BreakpointResolution { breakpoint: None, error: Some("No debug information is loaded for this session.".into()) })
            .collect());
    };
    Ok(req
        .locations
        .into_iter()
        .map(|location| match debug_info.get_breakpoint_location(typed_path::TypedPath::derive(location.path.as_bytes()), location.line, location.column) {
            Ok(breakpoint) => BreakpointResolution {
                breakpoint: Some(WireVerifiedBreakpoint {
                    address: breakpoint.address,
                    source_location: wire_breakpoint_location(&breakpoint.source_location),
                }),
                error: None,
            },
            Err(error) => BreakpointResolution { breakpoint: None, error: Some(error.to_string()) },
        })
        .collect())
}

/// `debug_state/resolve_source_locations`: the source line of each address, when DWARF has one.
pub async fn resolve_source_locations(ctx: &mut Ctx, _h: VarHeader, req: ResolveSourceLocationsRequest) -> ResolveSourceLocationsResponse {
    let inner = ctx.inner.lock().await;
    let Some(debug_info) = inner.debug.get(&req.sessid.id()).and_then(|s| s.debug_info.clone()) else {
        return Ok(req.addresses.iter().map(|_| None).collect());
    };
    Ok(req.addresses.into_iter().map(|address| debug_info.get_source_location(address).as_ref().map(wire_breakpoint_location)).collect())
}

// ---------------------------------------------------------------- evaluate, set_variable, SVD

/// `debug_state/load_svd`: parse an uploaded CMSIS-SVD file into the core's Peripherals scope, or
/// drop it when no path is given. A file that does not parse also drops the previous one.
pub async fn load_svd(ctx: &mut Ctx, _h: VarHeader, req: LoadSvdRequest) -> LoadSvdResponse {
    let mut inner = ctx.inner.lock().await;
    inner.session(req.sessid)?;
    let parsed = match &req.path {
        Some(path) => {
            let bytes = inner.files.get(path).ok_or_else(|| err(format!("unknown file {path}")))?;
            Some(crate::svd::parse_svd_bytes(bytes, path))
        }
        None => None,
    };
    let core_state = inner.debug.entry(req.sessid.id()).or_default().per_core.entry(req.core as usize).or_default();
    match parsed {
        None => {
            core_state.svd_variables = None;
            Ok(())
        }
        Some(Ok(cache)) => {
            core_state.svd_variables = Some(cache);
            Ok(())
        }
        Some(Err(error)) => {
            core_state.svd_variables = None;
            Err(err(error))
        }
    }
}

/// `stack_trace/evaluate`: a register of the frame, or a local or static variable by name (or by
/// variable reference), as serve evaluates it (there is no expression parser).
pub async fn evaluate(ctx: &mut Ctx, _h: VarHeader, req: EvaluateRequest) -> EvaluateResponse {
    let mut guard = ctx.inner.lock().await;
    let inner = &mut *guard;
    let state = inner.debug.get_mut(&req.sessid.id()).ok_or_else(|| err("no debug state for this session"))?;
    let debug_info = state.debug_info.clone().ok_or_else(|| err("no debug info loaded for this session"))?;
    let core_state = state
        .per_core
        .get_mut(&(req.core as usize))
        .ok_or_else(|| err("no stack trace for this core (stack_trace/rich)"))?;
    let session = inner.sessions.get_mut(&req.sessid.id()).ok_or_else(|| err("unknown session"))?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;

    let invalid = || WireEvaluateResponse {
        result: format!("<invalid expression {:?}>", req.expression),
        type_: None,
        variables_reference: 0,
        named_variables: None,
        indexed_variables: None,
        memory_reference: None,
    };
    let frame_ref = match req.frame_id {
        Some(id) => ObjectRef::from(id as i64),
        None => core_state.stack_frames.first().map(|f| f.id).unwrap_or(ObjectRef::Invalid),
    };
    let Some(frame_index) = core_state.stack_frames.iter().position(|f| f.id == frame_ref) else {
        return Ok(invalid());
    };

    if let Some(value) = core_state.stack_frames[frame_index]
        .registers
        .get_register_by_name(&req.expression)
        .and_then(|r| r.value)
    {
        return Ok(WireEvaluateResponse {
            result: format!("{value}"),
            type_: Some(format!("{}", VariableName::RegistersRoot)),
            variables_reference: 0,
            named_variables: None,
            indexed_variables: None,
            memory_reference: None,
        });
    }

    let frame = &core_state.stack_frames[frame_index];
    let frame_registers = (frame.registers.clone(), frame.frame_base, frame.canonical_frame_address);
    if let Some(cache) = core_state.stack_frames[frame_index].local_variables.as_mut()
        && let Some(response) = resolve_expression(&debug_info, &mut core, cache, &req.expression, &frame_registers).await
    {
        return Ok(response);
    }
    let top = core_state
        .stack_frames
        .first()
        .map(|f| (f.registers.clone(), f.frame_base, f.canonical_frame_address))
        .unwrap_or((DebugRegisters::default(), None, None));
    if let Some(cache) = core_state.static_variables.as_mut()
        && let Some(response) = resolve_expression(&debug_info, &mut core, cache, &req.expression, &top).await
    {
        return Ok(response);
    }
    Ok(invalid())
}

/// A variable of `cache` named by `expression` (or given as a variable reference), with its value
/// read now; `None` when the cache has no such variable.
async fn resolve_expression(
    debug_info: &DebugInfo,
    core: &mut probe_rs::Core<'_>,
    cache: &mut VariableCache,
    expression: &str,
    (registers, frame_base, canonical_frame_address): &(DebugRegisters, Option<u64>, Option<u64>),
) -> Option<WireEvaluateResponse> {
    if cache.len() == 1 {
        let mut root = cache.root_variable().clone();
        if root.variable_node_type.is_deferred() && !cache.has_children(&root) {
            let info = StackFrameInfo { registers, frame_base: *frame_base, canonical_frame_address: *canonical_frame_address };
            debug_info.cache_deferred_variables(cache, core, &mut root, info).await.ok()?;
        }
    }
    let mut variable = match expression.parse::<i64>() {
        Ok(key) => cache.get_variable_by_key(ObjectRef::from(key)),
        Err(_) => cache.get_variable_by_name(&VariableName::Named(expression.to_string())),
    }?;
    let (reference, named, indexed) = variable_reference(&variable, cache);
    variable.extract_value(core, cache).await;
    cache.update_variable(&variable).ok()?;
    Some(WireEvaluateResponse {
        result: variable.to_string(cache),
        type_: Some(variable.type_name()),
        variables_reference: i64::from(reference),
        named_variables: Some(named),
        indexed_variables: Some(indexed),
        memory_reference: memory_reference(&variable.memory_location),
    })
}

/// `stack_trace/set_variable`: write a local or static variable (found by parent key and name).
pub async fn set_variable(ctx: &mut Ctx, _h: VarHeader, req: SetVariableRequest) -> SetVariableResult {
    let mut guard = ctx.inner.lock().await;
    let inner = &mut *guard;
    let core_state = inner
        .debug
        .get_mut(&req.sessid.id())
        .and_then(|s| s.per_core.get_mut(&(req.core as usize)))
        .ok_or_else(|| err("no stack trace for this core (stack_trace/rich)"))?;
    let session = inner.sessions.get_mut(&req.sessid.id()).ok_or_else(|| err("unknown session"))?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;

    let parent_key = ObjectRef::from(req.parent_key);
    let name = VariableName::Named(req.name.clone());
    let mut found: Option<(Variable, &mut VariableCache)> = None;
    for frame in core_state.stack_frames.iter_mut() {
        if let Some(cache) = frame.local_variables.as_mut()
            && let Some(variable) = cache.get_variable_by_name_and_parent(&name, parent_key)
        {
            found = Some((variable, cache));
            break;
        }
    }
    if found.is_none()
        && let Some(cache) = core_state.static_variables.as_mut()
        && let Some(variable) = cache.get_variable_by_name_and_parent(&name, parent_key)
    {
        found = Some((variable, cache));
    }
    let Some((variable, cache)) = found else {
        return Err(err(format!("No variable information found for {name}!")));
    };
    variable.update_value(&mut core, cache, req.value.clone()).await.map_err(err)?;
    let (reference, named, indexed) = variable_reference(&variable, cache);
    Ok(WireSetVariableResponse {
        value: req.value,
        type_: Some(format!("{:?}", variable.type_name())),
        variables_reference: i64::from(reference),
        named_variables: Some(named),
        indexed_variables: Some(indexed),
        memory_reference: memory_reference(&variable.memory_location),
    })
}


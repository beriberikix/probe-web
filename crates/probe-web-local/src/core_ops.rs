//! Core run control, registers and breakpoints for debugging in the worker: ports of
//! `probe-rs serve`'s `core_ops.rs` / `cores.rs` handlers onto the fork's async `Core`.

use postcard_rpc::header::VarHeader;
use probe_rs::{CoreDump, CoreStatus, Error, InstructionSet, RegisterId, RegisterValue, Session as PrSession, VectorCatchCondition};
use probe_rs_debug::{DebugError, SteppingMode};
use probe_rs_rpc::{
    NoResponse, RpcError, RpcResult,
    core_ops::{
        CoreAccessRequest, CoreBreakpointsRequest, CoreDumpRequest, HandleSemihostingRequest, HandleSemihostingResponse,
        HandleSemihostingResult, WireCoreDump, WireRegisterId, WireSemihostingUiEvent, CoreReadRegistersRequest, CoreVectorCatchRequest,
        CoreWriteRegRequest, StepRequest, StepResponse, StepResult, WireCoreMetadata, WireInstructionSet,
        WireRegisterReadResult, WireRegisterValue, WireSteppingMode, WireVectorCatchCondition,
    },
    cores::{CoresRequest, CoresStatusMap, CoresStatusResponse, HaltCoresRequest},
};

use crate::{
    convert,
    debug_state::wire_register_value,
    server::{Ctx, err},
};

fn register_value(value: WireRegisterValue) -> RegisterValue {
    match value {
        WireRegisterValue::U32(v) => RegisterValue::U32(v),
        WireRegisterValue::U64(v) => RegisterValue::U64(v),
        WireRegisterValue::U128(v) => RegisterValue::U128(v),
    }
}

fn instruction_set(set: InstructionSet) -> WireInstructionSet {
    match set {
        InstructionSet::Thumb2 => WireInstructionSet::Thumb2,
        InstructionSet::A32 => WireInstructionSet::A32,
        InstructionSet::A64 => WireInstructionSet::A64,
        InstructionSet::RV32 => WireInstructionSet::RV32,
        InstructionSet::RV32C => WireInstructionSet::RV32C,
        InstructionSet::Xtensa => WireInstructionSet::Xtensa,
    }
}

/// `CoreStatus` is not `Copy` in every probe-rs version; convert through a reference-free copy.
fn status(s: CoreStatus) -> probe_rs_rpc::core_ops::WireCoreStatus {
    convert::core_status(s)
}

// ---------------------------------------------------------------- one core

pub async fn core_step(ctx: &mut Ctx, _h: VarHeader, req: StepRequest) -> StepResult {
    let mut guard = ctx.inner.lock().await;
    let inner = &mut *guard;
    let debug_info = inner.debug.get(&req.sessid.id()).and_then(|s| s.debug_info.clone());
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;

    if matches!(req.mode, WireSteppingMode::StepInstruction) {
        let info = core.step().await.map_err(err)?;
        let st = core.status().await.map_err(err)?;
        return Ok(StepResponse { status: status(st), program_counter: info.pc, warning: None });
    }
    let debug_info = debug_info.ok_or_else(|| err("statement stepping needs debug info (debug_state/load_debug_info)"))?;
    let mode = match req.mode {
        WireSteppingMode::OverStatement => SteppingMode::OverStatement,
        WireSteppingMode::IntoStatement => SteppingMode::IntoStatement,
        WireSteppingMode::OutOfStatement => SteppingMode::OutOfStatement,
        WireSteppingMode::StepInstruction => SteppingMode::StepInstruction,
    };
    match mode.step(&mut core, &debug_info).await {
        Ok((st, pc)) => Ok(StepResponse { status: status(st), program_counter: pc, warning: None }),
        Err(DebugError::WarnAndContinue { message }) => {
            let st = core.status().await.map_err(err)?;
            let pc_id = core.program_counter().id();
            let pc: u64 = core.read_core_reg::<u64>(pc_id).await.map_err(err)?;
            Ok(StepResponse { status: status(st), program_counter: pc, warning: Some(message) })
        }
        Err(other) => {
            core.halt(std::time::Duration::from_millis(100)).await.ok();
            Err(err(other))
        }
    }
}

pub async fn core_write_reg(ctx: &mut Ctx, _h: VarHeader, req: CoreWriteRegRequest) -> NoResponse {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    core.write_core_reg(RegisterId(req.id.0), register_value(req.value)).await.map_err(err)?;
    Ok(())
}

/// Per-address results, so one address that finds no free comparator does not fail the batch.
pub async fn core_set_hw_bps(ctx: &mut Ctx, _h: VarHeader, req: CoreBreakpointsRequest) -> RpcResult<Vec<Result<(), RpcError>>> {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(req.addresses.len());
    for address in req.addresses {
        if seen.contains(&address) {
            out.push(Ok(()));
            continue;
        }
        match core.set_hw_breakpoint(address).await {
            Ok(()) => {
                seen.insert(address);
                out.push(Ok(()));
            }
            Err(e) => out.push(Err(err(e))),
        }
    }
    Ok(out)
}

/// Clearing an address with no breakpoint is not an error (as on serve).
pub async fn core_clear_hw_bps(ctx: &mut Ctx, _h: VarHeader, req: CoreBreakpointsRequest) -> NoResponse {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    for address in req.addresses {
        match core.clear_hw_breakpoint(address).await {
            Ok(()) => {}
            // The fork reports a missing breakpoint as `Error::Other("No breakpoint found …")`.
            Err(Error::Other(message)) if message.starts_with("No breakpoint found") => {}
            Err(e) => return Err(err(e)),
        }
    }
    Ok(())
}

pub async fn core_enable_vc(ctx: &mut Ctx, _h: VarHeader, req: CoreVectorCatchRequest) -> NoResponse {
    let condition = match req.condition {
        WireVectorCatchCondition::HardFault => VectorCatchCondition::HardFault,
        WireVectorCatchCondition::CoreReset => VectorCatchCondition::CoreReset,
        WireVectorCatchCondition::SecureFault => VectorCatchCondition::SecureFault,
        WireVectorCatchCondition::All => VectorCatchCondition::All,
        WireVectorCatchCondition::Svc | WireVectorCatchCondition::Hlt => {
            return Err(err("this vector catch condition is not supported by the WebUSB transport"));
        }
    };
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    core.enable_vector_catch(condition).await.map_err(err)?;
    Ok(())
}

pub async fn core_metadata(ctx: &mut Ctx, _h: VarHeader, req: CoreAccessRequest) -> RpcResult<WireCoreMetadata> {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    let fpu_support = core.fpu_support().await.map_err(err)?;
    let floating_point_register_count = if fpu_support {
        Some(core.floating_point_register_count().map_err(err)? as u64)
    } else {
        None
    };
    let set = core.instruction_set().await.map_err(err)?;
    Ok(WireCoreMetadata { fpu_support, floating_point_register_count, instruction_set: instruction_set(set) })
}

/// Per-register results, so an unreadable register does not fail the batch.
pub async fn core_read_registers(ctx: &mut Ctx, _h: VarHeader, req: CoreReadRegistersRequest) -> RpcResult<Vec<WireRegisterReadResult>> {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    let mut out = Vec::with_capacity(req.ids.len());
    for id in req.ids {
        let result = core.read_core_reg::<RegisterValue>(RegisterId(id.0)).await.map(wire_register_value).map_err(err);
        out.push(WireRegisterReadResult { id, result });
    }
    Ok(out)
}

// ---------------------------------------------------------------- all cores

fn core_indices(session: &PrSession, cores: Option<&[u32]>) -> Vec<usize> {
    match cores {
        Some(cores) => cores.iter().map(|c| *c as usize).collect(),
        None => (0..session.list_cores().len()).collect(),
    }
}

pub async fn halt_cores(ctx: &mut Ctx, _h: VarHeader, req: HaltCoresRequest) -> CoresStatusResponse {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut statuses = Vec::new();
    for idx in core_indices(session, req.cores.as_deref()) {
        let result: Result<CoreStatus, Error> = async {
            let mut core = session.core(idx).await?;
            if !core.core_halted().await? {
                core.halt(req.timeout).await?;
            }
            core.status().await
        }
        .await;
        match result {
            Ok(st) => statuses.push((idx as u32, status(st))),
            Err(Error::CoreDisabled(_)) => {}
            Err(e) => return Err(err(e)),
        }
    }
    Ok(CoresStatusMap { statuses })
}

pub async fn resume_cores(ctx: &mut Ctx, _h: VarHeader, req: CoresRequest) -> CoresStatusResponse {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut statuses = Vec::new();
    for idx in core_indices(session, req.cores.as_deref()) {
        let result: Result<CoreStatus, Error> = async {
            let mut core = session.core(idx).await?;
            if core.core_halted().await? {
                core.run().await?;
            }
            core.status().await
        }
        .await;
        match result {
            Ok(st) => statuses.push((idx as u32, status(st))),
            Err(Error::CoreDisabled(_)) => {}
            Err(e) => return Err(err(e)),
        }
    }
    Ok(CoresStatusMap { statuses })
}

pub async fn cores_status(ctx: &mut Ctx, _h: VarHeader, req: CoresRequest) -> CoresStatusResponse {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut statuses = Vec::new();
    for idx in core_indices(session, req.cores.as_deref()) {
        let result: Result<CoreStatus, Error> = async { session.core(idx).await?.status().await }.await;
        match result {
            Ok(st) => statuses.push((idx as u32, status(st))),
            Err(Error::CoreDisabled(_)) => {}
            Err(e) => return Err(err(e)),
        }
    }
    Ok(CoresStatusMap { statuses })
}

/// `core/dump`: registers and the requested memory ranges (for a coredump file).
pub async fn core_dump(ctx: &mut Ctx, _h: VarHeader, req: CoreDumpRequest) -> RpcResult<WireCoreDump> {
    let mut inner = ctx.inner.lock().await;
    let session = inner.session(req.sessid)?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    let dump = CoreDump::dump_core(&mut core, req.ranges).await.map_err(err)?;
    Ok(WireCoreDump {
        registers: dump.registers.into_iter().map(|(id, v)| (WireRegisterId(id.0), wire_register_value(v))).collect(),
        data: dump.data,
        instruction_set: instruction_set(dump.instruction_set),
        supports_native_64bit_access: dump.supports_native_64bit_access,
        core_type: convert::core_type(dump.core_type),
        fpu_support: dump.fpu_support,
        floating_point_register_count: dump.floating_point_register_count.map(|c| c as u64),
    })
}

/// `core/handle_semihosting`: service the semihosting call the core is halted on (console output
/// only in the browser) and resume it; an exit call stays halted and is reported as the status.
pub async fn handle_semihosting(ctx: &mut Ctx, _h: VarHeader, req: HandleSemihostingRequest) -> HandleSemihostingResponse {
    let mut guard = ctx.inner.lock().await;
    let inner = &mut *guard;
    let session = inner.sessions.get_mut(&req.sessid.id()).ok_or_else(|| err("unknown session"))?;
    let mut core = session.core(req.core as usize).await.map_err(err)?;
    let st = core.status().await.map_err(err)?;
    let CoreStatus::Halted(probe_rs::HaltReason::Breakpoint(probe_rs::BreakpointCause::Semihosting(command))) = st else {
        return Ok(HandleSemihostingResult { status: status(st), events: vec![] });
    };
    let handler = inner.debug.entry(req.sessid.id()).or_default().semihosting.entry(req.core as usize).or_default();
    match handler.handle(command, &mut core).await.map_err(err)? {
        crate::semihosting::Outcome::Continue(events) => {
            let events = events
                .into_iter()
                .filter_map(|event| match event {
                    probe_rs_rpc::monitor::SemihostingEvent::Output { data, .. } => Some(WireSemihostingUiEvent::RttOutput { handle: 0, data }),
                    _ => None,
                })
                .collect();
            core.run().await.map_err(err)?;
            Ok(HandleSemihostingResult { status: status(CoreStatus::Running), events })
        }
        crate::semihosting::Outcome::Exit(reason) => {
            let message = match reason {
                probe_rs_rpc::monitor::MonitorExitReason::SemihostingExit(Ok(())) => "Application has exited with success.".to_string(),
                probe_rs_rpc::monitor::MonitorExitReason::SemihostingExit(Err(e)) => {
                    format!("Application has exited with reason {:#x}, subcode {:?}.", e.reason, e.subcode)
                }
                _ => "Application has exited.".to_string(),
            };
            let st = core.status().await.map_err(err)?;
            Ok(HandleSemihostingResult { status: status(st), events: vec![WireSemihostingUiEvent::LogToConsole(message)] })
        }
    }
}


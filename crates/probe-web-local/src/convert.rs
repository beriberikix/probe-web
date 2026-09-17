//! probe-rs (fork) ↔ probe-rs-rpc wire type conversions.

use probe_rs::{CoreStatus, CoreType, HaltReason, BreakpointCause, flashing};
use probe_rs_rpc::{
    chip::{GenericRegion, MemoryAccess, MemoryRegion, NvmRegion, RamRegion},
    core_ops::{
        WireBreakpointCause, WireCoreType, WireCoreStatus, WireExitErrorDetails, WireHaltReason,
        WireSemihostingCommand,
    },
    flash::{BootInfo, FlashDataBlockSpan, FlashFill, FlashLayout, FlashPage, FlashSector, Operation, ProgressEvent},
    info::WireFlashSector,
    rtt_client::ScanRegion,
};

pub fn core_type(t: CoreType) -> WireCoreType {
    match t {
        CoreType::Armv6m => WireCoreType::Armv6m,
        CoreType::Armv7a => WireCoreType::Armv7a,
        CoreType::Armv7m => WireCoreType::Armv7m,
        CoreType::Armv7em => WireCoreType::Armv7em,
        CoreType::Armv8a => WireCoreType::Armv8a,
        CoreType::Armv8m => WireCoreType::Armv8m,
        CoreType::Riscv => WireCoreType::Riscv,
        CoreType::Xtensa => WireCoreType::Xtensa,
    }
}

/// The chip-registry flavour of the core type enum (same variants, different wire type).
pub fn chip_core_type(t: CoreType) -> probe_rs_rpc::chip::CoreType {
    use probe_rs_rpc::chip::CoreType as W;
    match t {
        CoreType::Armv6m => W::Armv6m,
        CoreType::Armv7a => W::Armv7a,
        CoreType::Armv7m => W::Armv7m,
        CoreType::Armv7em => W::Armv7em,
        CoreType::Armv8a => W::Armv8a,
        CoreType::Armv8m => W::Armv8m,
        CoreType::Riscv => W::Riscv,
        CoreType::Xtensa => W::Xtensa,
    }
}

fn access(a: probe_rs::config::MemoryAccess) -> MemoryAccess {
    MemoryAccess { read: a.read, write: a.write, execute: a.execute, boot: a.boot }
}

pub fn memory_region(r: probe_rs::config::MemoryRegion) -> MemoryRegion {
    use probe_rs::config::MemoryRegion as M;
    match r {
        M::Ram(x) => MemoryRegion::Ram(RamRegion {
            name: x.name,
            range: (x.range.start, x.range.end),
            cores: x.cores,
            access: x.access.map(access),
        }),
        M::Generic(x) => MemoryRegion::Generic(GenericRegion {
            name: x.name,
            range: (x.range.start, x.range.end),
            cores: x.cores,
            access: x.access.map(access),
        }),
        M::Nvm(x) => MemoryRegion::Nvm(NvmRegion {
            name: x.name,
            range: (x.range.start, x.range.end),
            cores: x.cores,
            is_alias: x.is_alias,
            access: x.access.map(access),
        }),
    }
}

/// Absolute flash sector ranges, as `probe-rs serve` reports them.
pub fn flash_sectors(target: &probe_rs::Target) -> Vec<WireFlashSector> {
    let mut out = vec![];
    for algo in target.flash_algorithms.iter() {
        let start = algo.flash_properties.address_range.start;
        let end = target
            .memory_region_by_address(start)
            .map(|r| r.address_range().end)
            .unwrap_or(algo.flash_properties.address_range.end);
        let mut sectors = algo.flash_properties.sectors.clone();
        sectors.sort_by_key(|s| s.address);
        sectors.push(probe_rs::config::SectorDescription { size: 0, address: end - start });
        for (cur, next) in sectors.iter().zip(sectors.iter().skip(1)) {
            out.push(WireFlashSector {
                start: start + cur.address,
                length: next.address - cur.address,
                blocksize: cur.size,
            });
        }
    }
    out
}

/// The kind of a semihosting command, without its target-memory payload.
fn semihosting_command(cmd: &probe_rs::semihosting::SemihostingCommand) -> WireSemihostingCommand {
    use probe_rs::semihosting::SemihostingCommand;
    match cmd {
        SemihostingCommand::ExitSuccess => WireSemihostingCommand::ExitSuccess,
        SemihostingCommand::ExitError(details) => {
            WireSemihostingCommand::ExitError(WireExitErrorDetails {
                reason: details.reason,
                exit_status: details.exit_status,
                subcode: details.subcode,
            })
        }
        // `GetCommandLine` would carry the target block address so a client could write the
        // command line itself; the fork's request does not expose it, and the worker services the
        // command locally anyway, so it is reported like any other kind.
        _ => WireSemihostingCommand::Other,
    }
}

pub fn halt_reason(r: HaltReason) -> WireHaltReason {
    match r {
        HaltReason::Multiple => WireHaltReason::Multiple,
        HaltReason::Breakpoint(c) => WireHaltReason::Breakpoint(match c {
            BreakpointCause::Hardware => WireBreakpointCause::Hardware,
            BreakpointCause::Software => WireBreakpointCause::Software,
            // The command's pointers into target memory do not travel over the wire, but the kind
            // does: a client that sees a semihosting halt services it through
            // `core/handle_semihosting` instead of reporting a stop, which is how the SDK
            // `Debugger` turns semihosting into output events.
            BreakpointCause::Semihosting(ref cmd) => {
                WireBreakpointCause::Semihosting(semihosting_command(cmd))
            }
            _ => WireBreakpointCause::Unknown,
        }),
        HaltReason::Exception => WireHaltReason::Exception,
        HaltReason::Watchpoint => WireHaltReason::Watchpoint,
        HaltReason::Step => WireHaltReason::Step,
        HaltReason::Request => WireHaltReason::Request,
        HaltReason::External => WireHaltReason::External,
        _ => WireHaltReason::Unknown,
    }
}

pub fn core_status(s: CoreStatus) -> WireCoreStatus {
    match s {
        CoreStatus::Running => WireCoreStatus::Running,
        CoreStatus::Halted(r) => WireCoreStatus::Halted(halt_reason(r)),
        CoreStatus::LockedUp => WireCoreStatus::LockedUp,
        CoreStatus::Sleeping => WireCoreStatus::Sleeping,
        CoreStatus::Unknown => WireCoreStatus::Unknown,
    }
}

pub fn boot_info(b: flashing::BootInfo) -> BootInfo {
    match b {
        flashing::BootInfo::FromRam { vector_table_addr, cores_to_reset } => {
            BootInfo::FromRam { vector_table_addr, cores_to_reset }
        }
        flashing::BootInfo::Other => BootInfo::Other,
    }
}

fn operation(o: flashing::ProgressOperation) -> Operation {
    use flashing::ProgressOperation as P;
    match o {
        P::Fill => Operation::Fill,
        P::Erase => Operation::Erase,
        P::Program => Operation::Program,
        P::Verify => Operation::Verify,
    }
}

fn layout(l: &flashing::FlashLayout) -> FlashLayout {
    FlashLayout {
        sectors: l.sectors().iter().map(|s| FlashSector { address: s.address(), size: s.size() }).collect(),
        pages: l.pages().iter().map(|p| FlashPage { address: p.address(), data_len: p.size() as u64 }).collect(),
        fills: l
            .fills()
            .iter()
            .map(|f| FlashFill { address: f.address(), size: f.size(), page_index: f.page_index() as u64 })
            .collect(),
        data_blocks: l
            .data_blocks()
            .iter()
            .map(|d| FlashDataBlockSpan { address: d.address(), size: d.size() })
            .collect(),
    }
}

pub fn progress(e: flashing::ProgressEvent) -> ProgressEvent {
    use flashing::ProgressEvent as E;
    match e {
        E::FlashLayoutReady { flash_layout } => ProgressEvent::FlashLayoutReady {
            flash_layout: flash_layout.iter().map(layout).collect(),
        },
        E::AddProgressBar { operation: op, total } => ProgressEvent::AddProgressBar { operation: operation(op), total },
        E::Started(op) => ProgressEvent::Started(operation(op)),
        E::Progress { operation: op, size, .. } => ProgressEvent::Progress { operation: operation(op), size },
        E::Failed(op) => ProgressEvent::Failed(operation(op)),
        E::Finished(op) => ProgressEvent::Finished(operation(op)),
        E::DiagnosticMessage { message } => ProgressEvent::DiagnosticMessage { message },
    }
}

pub fn scan_region(s: ScanRegion) -> probe_rs::rtt::ScanRegion {
    match s {
        ScanRegion::Ram => probe_rs::rtt::ScanRegion::Ram,
        ScanRegion::Ranges(v) => probe_rs::rtt::ScanRegion::Ranges(v.into_iter().map(|(a, b)| a..b).collect()),
        ScanRegion::Exact(a) => probe_rs::rtt::ScanRegion::Exact(a),
    }
}

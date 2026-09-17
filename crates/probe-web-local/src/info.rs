//! `info` (DP/AP/ROM-table scan, target identification) for the worker.
//!
//! Ported from the fork's bin-internal RPC (`probe-rs-tools/src/bin/probe-rs/rpc/functions/info.rs`,
//! already async) onto master's wire types (`probe_rs_rpc::info`). The scan logic is unchanged; the
//! server context is replaced by a publisher on `TargetInfoDataTopic`, and the `From` impls
//! become functions because both sides of each conversion are foreign to this crate.

use anyhow::anyhow;
use postcard_rpc::header::VarSeq;
use postcard_rpc::server::Sender as PostcardSender;
use probe_rs::{
    architecture::{
        arm::{
            self, ApAddress, ApV2Address, ArmProbeInterface,
            ap::{ApClass, ApRegister, IDR},
            component::Scs,
            dp::{self, Ctrl, DLPIDR, DPIDR, DpRegister, TARGETID},
            memory::{
                ArmMemoryInterface, Component, ComponentId, CoresightComponent, PeripheralType,
                romtable::{PeripheralID, RomTable},
            },
            sequences::DefaultArmSequence,
        },
        riscv::communication_interface::RiscvCommunicationInterface,
        xtensa::communication_interface::{
            XtensaCommunicationInterface, XtensaDebugInterfaceState,
        },
    },
    probe::{Probe, WireProtocol as ProbeRsWireProtocol},
};
use probe_rs_rpc::{
    TargetInfoDataTopic,
    chip::JEP106Code,
    info::{
        ApInfo, ComponentTreeNode, DebugPortId, DebugPortInfo, DebugPortInfoNode, DebugPortVersion,
        DpAddress, FullyQualifiedApAddress, InfoEvent, MinDpSupport,
    },
    probe::WireProtocol,
};

use crate::server::WireTxImpl;

pub struct InfoCtx<'a> {
    pub sender: &'a PostcardSender<WireTxImpl>,
}

impl InfoCtx<'_> {
    async fn publish<T: postcard_rpc::Topic<Message = InfoEvent>>(
        &mut self,
        seq: VarSeq,
        msg: &InfoEvent,
    ) -> anyhow::Result<()> {
        self.sender
            .publish::<T>(seq, msg)
            .await
            .map_err(|_| anyhow!("client disconnected"))
    }
}

fn wire_protocol(p: WireProtocol) -> ProbeRsWireProtocol {
    match p {
        WireProtocol::Swd => ProbeRsWireProtocol::Swd,
        WireProtocol::Jtag => ProbeRsWireProtocol::Jtag,
    }
}

fn wire_dp_addr(a: dp::DpAddress) -> DpAddress {
    match a {
        dp::DpAddress::Default => DpAddress::Default,
        dp::DpAddress::Multidrop(sel) => DpAddress::Multidrop(sel),
    }
}

fn dp_id(id: &dp::DebugPortId) -> DebugPortId {
    DebugPortId {
        revision: id.revision,
        part_no: id.part_no,
        version: match id.version {
            dp::DebugPortVersion::DPv0 => DebugPortVersion::DPv0,
            dp::DebugPortVersion::DPv1 => DebugPortVersion::DPv1,
            dp::DebugPortVersion::DPv2 => DebugPortVersion::DPv2,
            dp::DebugPortVersion::DPv3 => DebugPortVersion::DPv3,
            dp::DebugPortVersion::Unsupported(v) => DebugPortVersion::Unsupported(v),
        },
        min_dp_support: match id.min_dp_support {
            dp::MinDpSupport::NotImplemented => MinDpSupport::NotImplemented,
            dp::MinDpSupport::Implemented => MinDpSupport::Implemented,
        },
        designer: JEP106Code {
            id: id.designer.id,
            cc: id.designer.cc,
        },
    }
}

/// Scan what is behind an opened probe; failures are reported as a message event.
pub async fn show_info(
    ctx: &mut InfoCtx<'_>,
    mut probe: Probe,
    scan_chain: &[u8],
    protocol: WireProtocol,
    connect_under_reset: bool,
    target_sel: Option<u32>,
) -> anyhow::Result<()> {
    // An explicit scan chain (IR lengths in chain order) replaces JTAG auto-detection,
    // as in probe-rs master. It only applies to probes with JTAG access.
    if !scan_chain.is_empty() {
        match probe.try_as_jtag_probe() {
            Some(jtag) => {
                let elements: Vec<probe_rs::config::ScanChainElement> = scan_chain
                    .iter()
                    .map(|&ir_len| probe_rs::config::ScanChainElement {
                        name: None,
                        ir_len: Some(ir_len),
                    })
                    .collect();
                jtag.set_scan_chain(&elements)?;
            }
            None => {
                ctx.publish::<TargetInfoDataTopic>(
                    VarSeq::Seq2(0),
                    &InfoEvent::Message("scan_chain ignored: this probe has no JTAG access".into()),
                )
                .await?;
            }
        }
    }
    if let Err(e) = try_show_info(ctx, probe, protocol, connect_under_reset, target_sel).await {
        ctx.publish::<TargetInfoDataTopic>(
            VarSeq::Seq2(0),
            &InfoEvent::Message(format!(
                "Failed to identify target using protocol {protocol}: {e:?}"
            )),
        )
        .await?;
    }
    Ok(())
}

async fn try_show_info(
    ctx: &mut InfoCtx<'_>,
    mut probe: Probe,
    protocol: WireProtocol,
    connect_under_reset: bool,
    target_sel: Option<u32>,
) -> anyhow::Result<()> {
    probe.select_protocol(wire_protocol(protocol)).await?;

    if connect_under_reset {
        probe.attach_to_unspecified_under_reset().await?;
    } else {
        probe.attach_to_unspecified().await?;
    }

    if probe.has_arm_interface() {
        let dp_addr = if let Some(target_sel) = target_sel {
            vec![dp::DpAddress::Multidrop(target_sel)]
        } else {
            vec![
                dp::DpAddress::Default,
                // RP2040
                dp::DpAddress::Multidrop(0x01002927),
                dp::DpAddress::Multidrop(0x11002927),
            ]
        };

        for address in dp_addr {
            match try_show_arm_dp_info(ctx, probe, address).await {
                (probe_moved, Ok(dp_version)) => {
                    probe = probe_moved;
                    if dp_version < dp::DebugPortVersion::DPv2 && target_sel.is_none() {
                        let message = format!(
                            "Debug port version {dp_version} does not support SWD multidrop. Stopping here."
                        );

                        ctx.publish::<TargetInfoDataTopic>(
                            VarSeq::Seq2(0),
                            &InfoEvent::Message(message),
                        )
                        .await?;
                        break;
                    }
                }
                (probe_moved, Err(e)) => {
                    probe = probe_moved;

                    ctx.publish::<TargetInfoDataTopic>(
                        VarSeq::Seq2(0),
                        &InfoEvent::ArmError {
                            dp_addr: wire_dp_addr(address),
                            error: format!("{e:?}"),
                        },
                    )
                    .await?;
                }
            }
        }
    } else {
        ctx.publish::<TargetInfoDataTopic>(
            VarSeq::Seq2(0),
            &InfoEvent::ProbeInterfaceMissing {
                interface: "DAP".to_string(),
                architecture: "ARM".to_string(),
            },
        )
        .await?;
    }

    if let Err(error) = try_read_riscv_info(ctx, &mut probe, protocol).await {
        ctx.publish::<TargetInfoDataTopic>(
            VarSeq::Seq2(0),
            &InfoEvent::Error {
                architecture: "RISC-V".to_string(),
                error: format!("{error:?}"),
            },
        )
        .await?;
    }

    if let Err(error) = try_read_xtensa_info(ctx, &mut probe, protocol).await {
        ctx.publish::<TargetInfoDataTopic>(
            VarSeq::Seq2(0),
            &InfoEvent::Error {
                architecture: "Xtensa".to_string(),
                error: format!("{error:?}"),
            },
        )
        .await?;
    }

    Ok(())
}

async fn try_read_riscv_info(
    ctx: &mut InfoCtx<'_>,
    probe: &mut Probe,
    protocol: WireProtocol,
) -> Result<(), anyhow::Error> {
    if probe.has_riscv_interface() && protocol == WireProtocol::Jtag {
        tracing::debug!("Trying to show RISC-V chip information");
        let factory = probe.try_get_riscv_interface_builder().await?;

        let mut state = factory.create_state();
        let mut interface = factory.attach(&mut state).await?;
        show_riscv_info(ctx, &mut interface).await?;
    } else if protocol == WireProtocol::Swd {
        ctx.publish::<TargetInfoDataTopic>(
            VarSeq::Seq2(0),
            &InfoEvent::ProtocolNotSupportedByArch {
                architecture: "RISC-V".to_string(),
                protocol,
            },
        )
        .await?;
    } else {
        ctx.publish::<TargetInfoDataTopic>(
            VarSeq::Seq2(0),
            &InfoEvent::ProbeInterfaceMissing {
                interface: "RISC-V".to_string(),
                architecture: "RISC-V".to_string(),
            },
        )
        .await?;
    }

    Ok(())
}

async fn try_read_xtensa_info(
    ctx: &mut InfoCtx<'_>,
    probe: &mut Probe,
    protocol: WireProtocol,
) -> Result<(), anyhow::Error> {
    if probe.has_xtensa_interface() && protocol == WireProtocol::Jtag {
        tracing::debug!("Trying to show Xtensa chip information");
        let mut state = XtensaDebugInterfaceState::default();
        let mut interface = probe.try_get_xtensa_interface(&mut state).await?;

        show_xtensa_info(ctx, &mut interface).await?;
    } else if protocol == WireProtocol::Swd {
        ctx.publish::<TargetInfoDataTopic>(
            VarSeq::Seq2(0),
            &InfoEvent::ProtocolNotSupportedByArch {
                architecture: "Xtensa".to_string(),
                protocol,
            },
        )
        .await?;
    } else {
        ctx.publish::<TargetInfoDataTopic>(
            VarSeq::Seq2(0),
            &InfoEvent::ProbeInterfaceMissing {
                interface: "Xtensa".to_string(),
                architecture: "Xtensa".to_string(),
            },
        )
        .await?;
    }

    Ok(())
}

async fn try_show_arm_dp_info(
    ctx: &mut InfoCtx<'_>,
    probe: Probe,
    dp_address: dp::DpAddress,
) -> (Probe, anyhow::Result<dp::DebugPortVersion>) {
    tracing::debug!("Trying to show ARM chip information");
    let uninitialized_interface = probe
        .try_into_arm_interface()
        .map_err(|(iface, e)| (iface, anyhow!(e)));

    let uninitialized_interface = match uninitialized_interface {
        Ok(interface) => interface,
        Err((probe, e)) => return (probe, Err(e)),
    };

    let interface = uninitialized_interface
        .initialize(DefaultArmSequence::create(), dp_address)
        .await;

    match interface {
        Ok(mut interface) => {
            let res = show_arm_info(ctx, &mut *interface, dp_address).await;
            (interface.close().await, res)
        }
        Err((probe, e)) => (probe.close().await, Err(anyhow!(e))),
    }
}

/// Try to show information about the ARM chip, connected to a DP at the given address.
///
/// Returns the version of the DP.
async fn show_arm_info(
    ctx: &mut InfoCtx<'_>,
    interface: &mut dyn ArmProbeInterface,
    dp: dp::DpAddress,
) -> anyhow::Result<dp::DebugPortVersion> {
    let dp_info = interface.read_raw_dp_register(dp, DPIDR::ADDRESS).await?;
    let dp_info = dp::DebugPortId::from(DPIDR(dp_info));

    let dpinfo = if dp_info.version == dp::DebugPortVersion::DPv2 {
        let targetid = interface
            .read_raw_dp_register(dp, TARGETID::ADDRESS)
            .await?;

        // Read Instance ID
        let dlpidr = interface.read_raw_dp_register(dp, DLPIDR::ADDRESS).await?;

        // Read from the CTRL/STAT register, to ensure that the dpbanksel field is set to zero.
        // This helps with error handling later, because it means the CTRL/AP register can be
        // read in case of an error.
        let _ = interface.read_raw_dp_register(dp, Ctrl::ADDRESS).await?;

        DebugPortInfoNode {
            dp_info: dp_id(&dp_info),
            targetid,
            dlpidr,
        }
    } else {
        DebugPortInfoNode {
            dp_info: dp_id(&dp_info),
            targetid: 0,
            dlpidr: 0,
        }
    };

    let mut info = DebugPortInfo {
        dp_info: dpinfo.clone(),
        aps: vec![],
    };

    ctx.publish::<TargetInfoDataTopic>(
        VarSeq::Seq2(0),
        &InfoEvent::Message(format!("ARM Chip with debug port {:x?}:", dp)),
    )
    .await?;

    if dp_info.version != dp::DebugPortVersion::DPv3 {
        let access_ports = interface.access_ports(dp).await?;
        for ap_address in access_ports {
            match ap_address.ap() {
                ApAddress::V1(_) => {
                    let raw_idr = interface
                        .read_raw_ap_register(&ap_address, IDR::ADDRESS)
                        .await?;
                    let idr: IDR = raw_idr.try_into()?;

                    let ap_info = if idr.CLASS == ApClass::MemAp {
                        let mut ap_nodes = ComponentTreeNode::new(format!(
                            "{} MemoryAP ({:?})",
                            ap_address.ap_v1()?,
                            idr.TYPE
                        ));
                        if let Err(e) =
                            handle_memory_ap(interface, &ap_address, &mut ap_nodes).await
                        {
                            ap_nodes.push(format!("Error during access: {e}"));
                        };
                        ApInfo::MemoryAp {
                            ap_addr: FullyQualifiedApAddress {
                                dp: wire_dp_addr(ap_address.dp()),
                                ap: ap_address.ap().to_string(),
                            },
                            component_tree: ap_nodes,
                        }
                    } else {
                        ApInfo::Unknown {
                            ap_addr: FullyQualifiedApAddress {
                                dp: wire_dp_addr(ap_address.dp()),
                                ap: ap_address.ap().to_string(),
                            },
                            idr: raw_idr,
                        }
                    };

                    info.aps.push(ap_info);
                }

                ApAddress::V2(_) => {
                    unreachable!("Ap V1 and V2 cannot be mixed.")
                }
            }
        }
    } else {
        let fqa = arm::FullyQualifiedApAddress::v2_with_dp(dp, ApV2Address::root());
        let root_rom_table = {
            let mut root_memory = interface.memory_interface(&fqa).await?;
            let base_address = root_memory.base_address().await?;
            Component::try_parse(&mut *root_memory, base_address).await?
        };
        let mut component_tree = ComponentTreeNode::new(String::new());
        coresight_component_tree(interface, root_rom_table, &fqa, &mut component_tree).await?;
        info.aps.push(ApInfo::ApV2Root { component_tree });
    }

    ctx.publish::<TargetInfoDataTopic>(VarSeq::Seq2(0), &InfoEvent::ArmDp(info))
        .await?;

    Ok(dp_info.version)
}

async fn handle_memory_ap(
    interface: &mut dyn ArmProbeInterface,
    access_port: &arm::FullyQualifiedApAddress,
    parent: &mut ComponentTreeNode,
) -> anyhow::Result<()> {
    let component = {
        let mut memory = interface.memory_interface(access_port).await?;

        // Check if the AP is accessible
        let csw = memory.generic_status().await?;
        if !csw.DeviceEn {
            *parent = ComponentTreeNode::new(
                "Memory AP is not accessible, DeviceEn bit not set".to_string(),
            );
            return Ok(());
        }

        let base_address = memory.base_address().await?;
        Component::try_parse(&mut *memory, base_address).await?
    };
    Box::pin(coresight_component_tree(
        interface,
        component,
        access_port,
        parent,
    ))
    .await
}

async fn coresight_component_tree(
    interface: &mut dyn ArmProbeInterface,
    component: Component,
    access_port: &arm::FullyQualifiedApAddress,
    parent: &mut ComponentTreeNode,
) -> anyhow::Result<()> {
    match &component {
        Component::GenericVerificationComponent(id) => {
            parent.push(ComponentTreeNode::new(format!(
                "{:#06x} Generic",
                id.component_address()
            )));
        }
        Component::Class1RomTable(id, table) => {
            let peripheral_id = id.peripheral_id();

            let root = if let Some(part) = peripheral_id.determine_part() {
                format!("{} (ROM Table, Class 1)", part.name())
            } else {
                match peripheral_id.designer() {
                    Some(designer) => format!("ROM Table (Class 1), Designer: {designer}"),
                    None => "ROM Table (Class 1)".to_string(),
                }
            };

            let mut tree =
                ComponentTreeNode::new(format!("{:#06x} {}", id.component_address(), root));
            process_vendor_rom_tables(interface, id, table, access_port, &mut tree).await?;
            parent.push(tree);

            for entry in table.entries() {
                let component = entry.component().clone();

                Box::pin(coresight_component_tree(
                    interface,
                    component,
                    access_port,
                    parent,
                ))
                .await?;
            }
        }
        Component::CoresightComponent(id) => {
            let peripheral_id = id.peripheral_id();
            let part_info = peripheral_id.determine_part();

            let component_description = if let Some(part_info) = part_info {
                format!("{: <15} (Coresight Component)", part_info.name())
            } else {
                format!(
                    "Coresight Component, Part: {:#06x}, Devtype: {:#04x}, Archid: {:#06x}, Designer: {}",
                    peripheral_id.part(),
                    peripheral_id.dev_type(),
                    peripheral_id.arch_id(),
                    peripheral_id.designer().unwrap_or("<unknown>"),
                )
            };

            let mut tree = ComponentTreeNode::new(format!(
                "{:#06x} {}",
                id.component_address(),
                component_description
            ));
            let is_rom = part_info
                .map(|p| p.peripheral_type() == PeripheralType::Rom)
                .unwrap_or(false);
            process_component_entry(
                if is_rom { &mut *parent } else { &mut tree },
                interface,
                peripheral_id,
                &component,
                access_port,
            )
            .await?;
            parent.push(tree);
        }

        Component::PeripheralTestBlock(id) => {
            parent.push(ComponentTreeNode::new(format!(
                "{:#06x} Peripheral test block",
                id.component_address()
            )));
        }
        Component::GenericIPComponent(id) => {
            let peripheral_id = id.peripheral_id();

            let desc = if let Some(part_desc) = peripheral_id.determine_part() {
                format!("{: <15} (Generic IP component)", part_desc.name())
            } else {
                "Generic IP component".to_string()
            };

            let mut tree = ComponentTreeNode::new(desc);
            process_component_entry(&mut tree, interface, peripheral_id, &component, access_port)
                .await?;
        }

        Component::CoreLinkOrPrimeCellOrSystemComponent(id) => {
            let desc = "Core Link / Prime Cell / System component";
            let desc = if let Some(part_desc) = id.peripheral_id().determine_part() {
                format!("{: <15} ({})", part_desc.name(), desc)
            } else {
                desc.to_string()
            };

            parent.push(ComponentTreeNode::new(format!(
                "{:#06x} {}",
                id.component_address(),
                desc
            )));
        }
    };

    Ok(())
}

/// Processes information from/around manufacturer-specific ROM tables and adds them to the tree.
///
/// Some manufacturer-specific ROM tables contain more than just entries. This function tries
/// to make sense of these tables.
async fn process_vendor_rom_tables(
    interface: &mut dyn ArmProbeInterface,
    id: &ComponentId,
    _table: &RomTable,
    access_port: &arm::FullyQualifiedApAddress,
    tree: &mut ComponentTreeNode,
) -> anyhow::Result<()> {
    let peripheral_id = id.peripheral_id();
    let Some(part_info) = peripheral_id.determine_part() else {
        return Ok(());
    };

    if part_info.peripheral_type() == PeripheralType::Custom && part_info.name() == "Atmel DSU" {
        use probe_rs::vendor::microchip::sequences::atsam::DsuDid;

        // Read and parse the DID register
        let did = DsuDid(
            interface
                .memory_interface(access_port)
                .await?
                .read_word_32(DsuDid::ADDRESS)
                .await?,
        );

        tree.push(format!("Atmel device (DID = {:#010x})", did.0));
    }

    Ok(())
}

/// Processes ROM table entries and adds them to the tree.
async fn process_component_entry(
    tree: &mut ComponentTreeNode,
    interface: &mut dyn ArmProbeInterface,
    peripheral_id: &PeripheralID,
    component: &Component,
    access_port: &arm::FullyQualifiedApAddress,
) -> anyhow::Result<()> {
    let Some(part) = peripheral_id.determine_part() else {
        return Ok(());
    };

    match part.peripheral_type() {
        PeripheralType::Scs => {
            let cc = &CoresightComponent::new(component.clone(), access_port.clone());
            let scs = &mut Scs::new(interface, cc);
            let cpu_tree = cpu_info_tree(scs).await?;

            tree.push(cpu_tree);
        }
        PeripheralType::MemAp => {
            let dp = access_port.dp();
            let ApAddress::V2(addr) = access_port.ap() else {
                unreachable!("This should only happen on ap v2 addresses.");
            };
            if addr.0.is_some() {
                return Err(anyhow::anyhow!("Nested memory APs are not yet supported."));
            }
            let addr = arm::FullyQualifiedApAddress::v2_with_dp(
                dp,
                arm::ApV2Address::new(component.id().component_address()),
            );
            handle_memory_ap(interface, &addr, tree).await?;
        }
        PeripheralType::Rom => {
            let id = component.id();
            let mut memory = interface.memory_interface(access_port).await?;
            let rom_table = RomTable::try_parse(
                memory.as_mut() as &mut dyn ArmMemoryInterface,
                id.component_address(),
            )
            .await?;
            drop(memory);

            process_vendor_rom_tables(interface, id, &rom_table, access_port, tree).await?;
            for entry in rom_table.entries() {
                let component = entry.component().clone();

                Box::pin(coresight_component_tree(
                    interface,
                    component,
                    access_port,
                    tree,
                ))
                .await?;
            }
        }
        _ => {}
    }

    Ok(())
}

async fn cpu_info_tree(scs: &mut Scs<'_>) -> anyhow::Result<ComponentTreeNode> {
    let mut tree = ComponentTreeNode::new("CPUID".into());

    let cpuid = scs.cpuid().await?;

    tree.push(format!("IMPLEMENTER: {}", cpuid.implementer_name()));
    tree.push(format!("VARIANT: {}", cpuid.variant()));
    tree.push(format!("PARTNO: {}", cpuid.part_name()));
    tree.push(format!("REVISION: {}", cpuid.revision()));

    Ok(tree)
}

async fn show_riscv_info(
    ctx: &mut InfoCtx<'_>,
    interface: &mut RiscvCommunicationInterface<'_>,
) -> anyhow::Result<()> {
    let idcode = interface.read_idcode().await?;

    ctx.publish::<TargetInfoDataTopic>(
        VarSeq::Seq2(0),
        &InfoEvent::Idcode {
            architecture: "RISC-V".to_string(),
            idcode,
        },
    )
    .await
}

async fn show_xtensa_info(
    ctx: &mut InfoCtx<'_>,
    interface: &mut XtensaCommunicationInterface<'_>,
) -> anyhow::Result<()> {
    let idcode = interface.read_idcode().await?;

    ctx.publish::<TargetInfoDataTopic>(
        VarSeq::Seq2(0),
        &InfoEvent::Idcode {
            architecture: "Xtensa".to_string(),
            idcode: Some(idcode),
        },
    )
    .await
}

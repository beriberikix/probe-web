//! CMSIS flash-algorithm and chip-description ingestion, for the browser.
//!
//! This is `probe-rs`'s `target-gen` with the filesystem and the network taken out, so
//! a user can drop a vendor `.pack` or `.FLM` into a page and get
//! target YAML that `chips/load` accepts — no probe-rs release, no server, no network.
//!
//! Ported from the fork (`beriberikix/probe-rs@webusb/nusb-0.2.7`), *not* from probe-rs
//! master: the worker parses the YAML we emit with `probe-rs-target` 0.28, and master's
//! 0.32 changed several field types (`pc_program_page` and `pc_erase_sector` became
//! `Option<u64>`, `data_section_offset` likewise, and `big_endian` / `vendor_functions`
//! were added). Matching the consumer is what keeps `chips/load` working.
//!
//! The crate is pure — bytes in, `String` out — so it tests natively and runs in wasm
//! unchanged.

mod algorithm_binary;
mod fault;
mod flash_device;
mod flm;
mod pack;
mod wasm;
mod yaml;

use anyhow::Result;
use probe_rs_target::{
    ApAddress, ArmCoreAccessOptions, Chip, ChipFamily, Core, CoreAccessOptions, CoreType,
    MemoryAccess, MemoryRegion, NvmRegion, RamRegion, RawFlashAlgorithm, TargetDescriptionSource,
};
use std::collections::HashMap;

pub use fault::Fault;
pub use flm::extract_flash_algo;
pub use pack::{families_from_pack, svds_from_pack};
pub use yaml::serialize_to_yaml_string;

/// Space probe-rs reserves in front of a flash algorithm when it does not yet know the
/// target's architecture.
///
/// Inlined from `probe_rs::flashing::FlashAlgorithm::get_max_algorithm_header_size()`,
/// which is a `max` over three `const` headers: Arm `[u32; 1]`, RISC-V `[u32; 2]`,
/// Xtensa `[u32; 0]` — so 8 bytes. Inlining it is what lets this crate depend on
/// `probe-rs-target` alone instead of dragging all of `probe-rs` into a second wasm
/// binary. It is load-bearing for pack import: a pack's `RAMstart` is offset by it when
/// the `<algorithm>` element pins where the loader is placed.
pub const MAX_ALGORITHM_HEADER_SIZE: u64 = 8;

/// Read a CMSIS `.FLM` and return the flash algorithm it describes.
///
/// `name` is only used for the algorithm's name (its stem, lowercased, as `target-gen`
/// does) and for error messages; pass the file name the user picked.
pub fn flm_to_algorithm(
    bytes: &[u8],
    name: &str,
    fixed_load_address: bool,
) -> Result<RawFlashAlgorithm> {
    extract_flash_algo(None, bytes, name, true, fixed_load_address)
}

/// Read a CMSIS `.FLM` and return just that algorithm as YAML, for splicing into a chip
/// description the user already has.
///
/// This is the answer to "probe-rs supports my chip but not the external flash on my
/// board": lift the vendor's loader and add it to the family under `flash_algorithms`.
pub fn flm_to_algorithm_yaml(bytes: &[u8], name: &str, fixed_load_address: bool) -> Result<String> {
    let mut algorithm = flm_to_algorithm(bytes, name, fixed_load_address)?;
    algorithm.cores = vec!["main".to_owned()];
    yaml::serialize_with_cleanup(&vec![algorithm])
}

/// Read a CMSIS `.FLM` and wrap it in a complete, loadable chip family with placeholder
/// names and memory regions, ready for the user to edit.
///
/// Mirrors `target-gen elf`'s non-`--update` path: the same `<family name>` /
/// `<chip name>` placeholders and the same 0..0x2000 NVM, 0x10000..0x20000 RAM skeleton.
pub fn flm_to_family_yaml(bytes: &[u8], name: &str, fixed_load_address: bool) -> Result<String> {
    let family = flm_to_family(bytes, name, fixed_load_address)?;
    serialize_to_yaml_string(&family)
}

fn flm_to_family(bytes: &[u8], name: &str, fixed_load_address: bool) -> Result<ChipFamily> {
    let mut algorithm = flm_to_algorithm(bytes, name, fixed_load_address)?;
    let algorithm_name = algorithm.name.clone();
    algorithm.cores = vec!["main".to_owned()];

    Ok(ChipFamily {
        name: "<family name>".to_owned(),
        manufacturer: None,
        generated_from_pack: false,
        chip_detection: vec![],
        pack_file_release: None,
        variants: vec![Chip {
            cores: vec![Core {
                name: "main".to_owned(),
                core_type: CoreType::Armv6m,
                core_access_options: CoreAccessOptions::Arm(ArmCoreAccessOptions {
                    ap: ApAddress::V1(0),
                    targetsel: None,
                    debug_base: None,
                    cti_base: None,
                    jtag_tap: None,
                }),
                // `svd` sits on the core in this schema version, not on the chip — the
                // fork's own target-gen still puts it on `Chip` and no longer compiles
                // against its own `probe-rs-target`, which is why this is a port rather
                // than a copy.
                svd: None,
            }],
            part: None,
            documentation: HashMap::new(),
            package_variants: vec![],
            name: "<chip name>".to_owned(),
            memory_map: vec![
                MemoryRegion::Nvm(NvmRegion {
                    access: None,
                    range: 0..0x2000,
                    cores: vec!["main".to_owned()],
                    name: None,
                    is_alias: false,
                }),
                MemoryRegion::Ram(RamRegion {
                    range: 0x1_0000..0x2_0000,
                    cores: vec!["main".to_owned()],
                    name: None,
                    access: Some(MemoryAccess {
                        boot: true,
                        ..Default::default()
                    }),
                }),
            ],
            flash_algorithms: vec![algorithm_name],
            rtt_scan_ranges: None,
            jtag: None,
            default_binary_format: None,
        }],
        flash_algorithms: vec![algorithm],
        source: TargetDescriptionSource::BuiltIn,
    })
}

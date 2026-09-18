//! Turning a CMSIS `.pack` into `ChipFamily` descriptions.
//!
//! Ported from `target-gen/src/generate.rs` on the fork
//! (`beriberikix/probe-rs@webusb/nusb-0.2.7`), with everything that touched a disk or a
//! network removed: `Kind::Directory`, `visit_dirs`/`walk_files`, and the `visit_arm_*`
//! functions that downloaded packs from Keil. What is left reads out of a zip archive,
//! and `zip::ZipArchive` is generic over `Read + Seek`, so a `Cursor<Vec<u8>>` over the
//! bytes a file input handed us is a drop-in for the file handle the CLI used.
//!
//! Two couplings to `probe-rs` proper were also removed, which is what keeps this crate
//! off a second copy of probe-rs in wasm: the `Registry::from_builtin_families()` filter
//! (we never want to skip families the browser's registry has not heard of — importing
//! an unsupported chip is the entire point) and `get_max_algorithm_header_size()`, which
//! is inlined in `lib.rs`.

use anyhow::{Context, Error, Result, anyhow, bail};
use cmsis_pack::pdsc::{AccessPort, Algorithm, Core, Device, Package, Processor};
use cmsis_pack::utils::FromElem;
use jep106::JEP106Code;
use probe_rs_target::{
    Architecture, ArmCoreAccessOptions, Chip, ChipFamily, Core as ProbeCore, CoreAccessOptions,
    CoreType, GenericRegion, MemoryAccess, MemoryRegion, NvmRegion, RamRegion, RawFlashAlgorithm,
    RiscvCoreAccessOptions, TargetDescriptionSource, XtensaCoreAccessOptions,
};
use std::collections::HashMap;
use std::io::{Cursor, Read, Seek};

use crate::MAX_ALGORITHM_HEADER_SIZE;
use crate::fault::Fault;

/// The archive a pack's files are read out of.
///
/// `target-gen` had a `Kind` enum here to abstract over a directory and a zip; in the
/// browser only the archive exists.
struct Pack<T: Read + Seek> {
    archive: zip::ZipArchive<T>,
}

impl<T: Read + Seek> Pack<T> {
    /// Read one file out of the pack by its path inside the archive.
    fn read_bytes(&mut self, path: &str) -> Result<Vec<u8>> {
        // Pack manifests use Windows separators; zip entries use forward slashes.
        let normalized = path.replace('\\', "/");
        let mut file = self
            .archive
            .by_name(&normalized)
            .with_context(|| format!("'{normalized}' is not in the pack"))?;
        let mut buffer = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut buffer)?;
        Ok(buffer)
    }
}

/// Every chip family described by a CMSIS pack.
///
/// `bytes` is the whole `.pack` file, which is an ordinary zip archive.
pub fn families_from_pack(bytes: Vec<u8>) -> Result<Vec<ChipFamily>> {
    let mut pack = Pack {
        archive: zip::ZipArchive::new(Cursor::new(bytes)).context(Fault::BadArchive)?,
    };

    let pdsc = read_pdsc(&mut pack)?;
    let package = Package::from_string(&pdsc)
        .map_err(|e| anyhow!("{e}"))
        .context(Fault::BadPdsc)?;

    let mut families = Vec::new();
    extract_families(package, &mut pack, &mut families)?;
    Ok(families)
}

/// Every SVD in a pack, as `(name, xml)`.
///
/// `target-gen` never looks at these — it always writes `svd: None` — but they are the
/// natural companion to the chip description, and the Peripherals view already takes SVD
/// text, so a pack import can fill it in without a second download.
pub fn svds_from_pack(bytes: Vec<u8>) -> Result<Vec<(String, String)>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).context(Fault::BadArchive)?;

    let mut names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let file = archive.by_index(i)?;
        let name = file.name();
        if file.is_file()
            && name
                .rsplit('.')
                .next()
                .is_some_and(|e| e.eq_ignore_ascii_case("svd"))
        {
            names.push(name.to_string());
        }
    }

    let mut svds = Vec::with_capacity(names.len());
    for name in names {
        let mut file = archive.by_name(&name)?;
        let mut xml = String::new();
        file.read_to_string(&mut xml)?;
        let short = name.rsplit('/').next().unwrap_or(&name).to_string();
        svds.push((short, xml));
    }
    svds.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(svds)
}

/// Find and read the `.pdsc` manifest inside the archive.
fn read_pdsc<T: Read + Seek>(pack: &mut Pack<T>) -> Result<String> {
    let index = (0..pack.archive.len())
        .find(|&i| {
            pack.archive.by_index(i).is_ok_and(|file| {
                file.enclosed_name().is_some_and(|path| {
                    path.extension()
                        .is_some_and(|e| e.eq_ignore_ascii_case("pdsc"))
                })
            })
        })
        .ok_or(Fault::NoPdsc)?;

    let mut file = pack.archive.by_index(index)?;
    let mut pdsc = String::new();
    file.read_to_string(&mut pdsc)?;
    Ok(pdsc)
}

fn process_flash_algo<T: Read + Seek>(
    flash_algorithm: &Algorithm,
    pack: &mut Pack<T>,
) -> Result<RawFlashAlgorithm> {
    let file_name = flash_algorithm.file_name.to_string_lossy().to_string();
    let algo_bytes = pack.read_bytes(&file_name)?;
    let mut algo = crate::flm::extract_flash_algo(
        None,
        &algo_bytes,
        &file_name,
        flash_algorithm.default,
        // Algorithms from CMSIS-Pack files are position independent.
        false,
    )?;

    // If the algo specifies `RAMstart` and/or `RAMsize` fields, then use them.
    // - See https://open-cmsis-pack.github.io/Open-CMSIS-Pack-Spec/main/html/pdsc_family_pg.html#element_algorithm
    algo.load_address = flash_algorithm
        .ram_start
        .map(|ram_start| ram_start + MAX_ALGORITHM_HEADER_SIZE);

    Ok(algo)
}

fn extract_families<T: Read + Seek>(
    pdsc: Package,
    pack: &mut Pack<T>,
    families: &mut Vec<ChipFamily>,
) -> Result<()> {
    // Forge a definition file for each device in the .pdsc file.
    let mut devices = pdsc.devices.0.into_iter().collect::<Vec<_>>();
    devices.sort_by(|a, b| a.0.cmp(&b.0));

    for (device_name, device) in devices {
        // Check if this device family is already known.
        let family = if let Some(index) = families
            .iter()
            .position(|family| family.name == device.family)
        {
            &mut families[index]
        } else {
            families.push(ChipFamily {
                name: device.family.clone(),
                manufacturer: try_parse_vendor(device.vendor.as_deref()),
                generated_from_pack: true,
                chip_detection: vec![],
                pack_file_release: Some(pdsc.releases.latest_release().version.clone()),
                variants: Vec::new(),
                flash_algorithms: Vec::new(),
                source: TargetDescriptionSource::BuiltIn,
            });
            // This unwrap is always safe as we insert at least one item previously.
            families.last_mut().unwrap()
        };

        // Extract the flash algorithm, block & sector size and the erased byte value
        // from the ELF binary.
        let flash_algorithm_names = device
            .algorithms
            .iter()
            .filter_map(
                |flash_algorithm| match process_flash_algo(flash_algorithm, pack) {
                    Ok(algo) => {
                        // Add the algo to the family's algos if it is not already there, so
                        // the same blob is not stored twice.
                        let algo_name = algo.name.clone();
                        if !family.flash_algorithms.contains(&algo) {
                            family.flash_algorithms.push(algo);
                        }
                        Some(algo_name)
                    }
                    Err(e) => {
                        log::warn!(
                            "Failed to process flash algorithm {}: {e:?}",
                            flash_algorithm.file_name.display()
                        );
                        None
                    }
                },
            )
            .collect::<Vec<_>>();

        // Sometimes the algos are referenced twice, for example in the multicore H7s.
        // Deduplicate while keeping order.
        let flash_algorithm_names = flash_algorithm_names
            .iter()
            .enumerate()
            .filter(|(i, s)| !flash_algorithm_names[..*i].contains(s))
            .map(|(_, s)| s.clone())
            .collect::<Vec<_>>();

        let cores = device
            .processors
            .iter()
            .map(create_core)
            .collect::<Result<Vec<_>>>()?;

        let mut memory_map = get_mem_map(&device, &cores);
        patch_memmap(&mut memory_map);
        // Where the vendor says each of this chip's algorithms runs.
        let load_addresses: Vec<u64> = family
            .flash_algorithms
            .iter()
            .filter(|a| flash_algorithm_names.contains(&a.name))
            .filter_map(|a| a.load_address)
            .collect();
        mark_algorithm_ram_executable(&mut memory_map, &load_addresses);

        family.variants.push(Chip {
            name: device_name,
            part: None,
            documentation: HashMap::new(),
            package_variants: vec![],
            cores,
            memory_map,
            flash_algorithms: flash_algorithm_names,
            rtt_scan_ranges: None,
            jtag: None,
            default_binary_format: None,
        });
    }

    Ok(())
}

fn try_parse_vendor(vendor: Option<&str>) -> Option<JEP106Code> {
    let jep = match vendor? {
        "Atmel:3" => JEP106Code::new(0, 0x1f),
        "NXP:11" => JEP106Code::new(0, 0x15),
        "STMicroelectronics:13" => JEP106Code::new(0, 0x20),
        _ => return None,
    };

    Some(jep)
}

fn create_core(processor: &Processor) -> Result<ProbeCore> {
    let core_type = core_to_probe_core(&processor.core)?;
    Ok(ProbeCore {
        name: processor
            .name
            .as_ref()
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_else(|| "main".to_string()),
        core_type,
        core_access_options: match core_type.architecture() {
            Architecture::Arm => CoreAccessOptions::Arm(ArmCoreAccessOptions {
                ap: match processor.ap {
                    AccessPort::Index(id) => probe_rs_target::ApAddress::V1(id),
                    AccessPort::Address(addr) => probe_rs_target::ApAddress::V2(addr),
                },
                targetsel: None,
                debug_base: None,
                cti_base: None,
                jtag_tap: None,
            }),
            Architecture::Riscv => CoreAccessOptions::Riscv(RiscvCoreAccessOptions {
                hart_id: None,
                jtag_tap: None,
            }),
            Architecture::Xtensa => {
                CoreAccessOptions::Xtensa(XtensaCoreAccessOptions { jtag_tap: None })
            }
        },
        // The pack's SVDs are offered separately; see `svds_from_pack`.
        svd: None,
    })
}

fn core_to_probe_core(value: &Core) -> Result<CoreType, Error> {
    Ok(match value {
        Core::CortexM0 => CoreType::Armv6m,
        Core::CortexM0Plus => CoreType::Armv6m,
        Core::CortexM4 => CoreType::Armv7em,
        Core::CortexM3 => CoreType::Armv7m,
        Core::CortexM23 => CoreType::Armv8m,
        Core::CortexM33 => CoreType::Armv8m,
        Core::CortexM55 => CoreType::Armv8m,
        Core::CortexM85 => CoreType::Armv8m,
        Core::CortexM7 => CoreType::Armv7em,
        Core::StarMC1 => CoreType::Armv8m,
        c => bail!("Core '{c:?}' is not yet supported for target generation."),
    })
}

/// A flag to indicate what type of memory this is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MemoryType {
    /// A RAM memory.
    Ram,
    /// A Non Volatile memory.
    Nvm,
    /// Generic
    Generic,
}

/// A struct to combine essential information from [`cmsis_pack::pdsc::Device::memories`].
/// This is used to apply the necessary sorting and filtering in creating [`MemoryRegion`]s.
// The sequence of the fields is important for the sorting by derived natural order.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DeviceMemory {
    memory_type: MemoryType,
    p_name: Option<String>,
    memory_start: u64,
    memory_end: u64,
    name: String,
    access: MemoryAccess,
}

impl DeviceMemory {
    fn access(&self) -> Option<MemoryAccess> {
        if self.access == MemoryAccess::default() {
            None
        } else {
            Some(self.access)
        }
    }
}

/// Extracts the memory regions in the package.
/// The new memory regions are sorted by memory type, then by boot memory, then by start
/// address, with correctly assigned cores/processor names.
fn get_mem_map(device: &Device, cores: &[ProbeCore]) -> Vec<MemoryRegion> {
    let mut device_memories: Vec<DeviceMemory> = device
        .memories
        .0
        .iter()
        .map(|(name, memory)| DeviceMemory {
            name: name.clone(),
            p_name: memory.p_name.clone(),
            memory_type: if memory.default && memory.access.read && memory.access.write {
                MemoryType::Ram
            } else if memory.default
                && memory.access.read
                && memory.access.execute
                && !memory.access.write
            {
                MemoryType::Nvm
            } else {
                MemoryType::Generic
            },
            memory_start: memory.start,
            memory_end: memory.start + memory.size,
            access: MemoryAccess {
                read: memory.access.read,
                write: memory.access.write,
                execute: memory.access.execute,
                boot: memory.startup,
            },
        })
        .collect();

    // Sort by memory type, then by processor name, then by boot memory, then by start address.
    device_memories.sort_by_key(|memory| {
        (
            memory.memory_type,
            memory.p_name.clone(),
            memory.access.boot,
            memory.memory_start,
        )
    });

    let all_cores: Vec<_> = cores.iter().map(|core| core.name.clone()).collect();
    let is_multi_core = cores.len() > 1;

    // Convert DeviceMemory's to MemoryRegion's, and assign cores to shared regions.
    let mut mem_map: Vec<MemoryRegion> = vec![];
    for region in device_memories {
        if is_multi_core && region.p_name.is_none() {
            log::warn!(
                "Device {}, memory region {} has no processor name, but this is required for a multicore device. Assigning memory to all cores!",
                device.name,
                region.name
            );
        }

        let cores = region
            .p_name
            .as_ref()
            .map(|s| vec![s.to_ascii_lowercase()])
            .unwrap_or_else(|| all_cores.clone());

        let access = region.access();
        let existing = mem_map.iter_mut().find(|existing| match existing {
            MemoryRegion::Ram(r) => {
                region.memory_type == MemoryType::Ram
                    && r.name.as_deref() == Some(&region.name)
                    && r.access == access
            }
            MemoryRegion::Nvm(r) => {
                region.memory_type == MemoryType::Nvm
                    && r.name.as_deref() == Some(&region.name)
                    && r.access == access
            }
            MemoryRegion::Generic(r) => {
                region.memory_type == MemoryType::Generic
                    && r.name.as_deref() == Some(&region.name)
                    && r.access == access
            }
        });

        if let Some(existing) = existing {
            match existing {
                MemoryRegion::Ram(r) => r.cores.extend_from_slice(&cores),
                MemoryRegion::Nvm(r) => r.cores.extend_from_slice(&cores),
                MemoryRegion::Generic(r) => r.cores.extend_from_slice(&cores),
            }
            continue;
        }

        let range = region.memory_start..region.memory_end;
        let name = Some(region.name);
        mem_map.push(match region.memory_type {
            MemoryType::Ram => MemoryRegion::Ram(RamRegion {
                access,
                name,
                range,
                cores,
            }),
            MemoryType::Nvm => MemoryRegion::Nvm(NvmRegion {
                access,
                name,
                range,
                cores,
                is_alias: false,
            }),
            MemoryType::Generic => MemoryRegion::Generic(GenericRegion {
                access,
                name,
                range,
                cores,
            }),
        });
    }

    mem_map
}

/// Mark the RAM a vendor flash algorithm loads into as executable.
///
/// probe-rs runs a flash algorithm out of RAM, so a chip needs at least one RAM region
/// flagged executable or flashing fails with "No suitable RAM region is defined". A CMSIS
/// pack never says which region that is: its `<memory>` `access` describes the CPU's view
/// of the memory, and vendors routinely mark all RAM non-executable there.
///
/// `target-gen` only covers the case where a chip has exactly one RAM region (see
/// `ensure_single_ram_region_is_executable`), which leaves every multi-RAM chip
/// unflashable straight out of a pack -- the MCXA153 has three and failed exactly that
/// way on hardware. But when the pack's `<algorithm>` element pins a `RAMstart`, it has
/// told us precisely where the loader is meant to run, so that region can be marked with
/// confidence rather than guessed at.
fn mark_algorithm_ram_executable(memory_map: &mut [MemoryRegion], load_addresses: &[u64]) {
    for address in load_addresses {
        for region in memory_map.iter_mut() {
            let MemoryRegion::Ram(ram) = region else {
                continue;
            };
            if ram.range.contains(address) {
                ram.access.get_or_insert_default().execute = true;
            }
        }
    }
}

fn patch_memmap(mem_map: &mut [MemoryRegion]) {
    ensure_single_ram_region_is_executable(mem_map);
}

/// Ensure that at least one RAM region is executable.
fn ensure_single_ram_region_is_executable(mem_map: &mut [MemoryRegion]) {
    // If the device only has one Ram region, mark that region as executable. This is
    // necessary as we rely on RAM-loaded flashing algorithms and so at least some of the
    // RAM must be executable.
    let ram_regions = mem_map
        .iter()
        .filter_map(MemoryRegion::as_ram_region)
        .count();

    if ram_regions == 1
        && let Some(MemoryRegion::Ram(ram_region)) = mem_map
            .iter_mut()
            .find(|region| matches!(region, MemoryRegion::Ram(_)))
        && let Some(ref mut access) = ram_region.access
    {
        access.execute = true;
    }
}

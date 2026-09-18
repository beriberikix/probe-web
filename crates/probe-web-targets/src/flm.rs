//! Reading a CMSIS `.FLM` flash algorithm out of its ELF container.
//!
//! Ported from `target-gen/src/parser.rs` on the fork
//! (`beriberikix/probe-rs@webusb/nusb-0.2.7`). The only change for the browser: the
//! algorithm's file name arrives as a `&str` rather than a `&Path`, since there is no
//! filesystem here — it is used for the algorithm name and for error messages.

use anyhow::{Context, Result};
use probe_rs_target::{FlashProperties, MemoryRange, RawFlashAlgorithm, SectorDescription};

use crate::fault::Fault;
use crate::flash_device::FlashDevice;

/// Extract a chunk of data from an ELF binary.
///
/// This does only return the data chunk if it is fully contained in one section.
/// If it is across two sections, no chunk will be returned.
pub(crate) fn read_elf_bin_data<'a>(
    elf: &'a goblin::elf::Elf<'_>,
    buffer: &'a [u8],
    address: u32,
    size: u32,
) -> Option<&'a [u8]> {
    log::debug!("Trying to read {} bytes from {:#010x}.", size, address);

    let start = address as u64;
    let end = (address + size) as u64;
    let range_to_read = start..end;

    // Iterate all segments.
    for ph in &elf.program_headers {
        let segment_address = ph.p_paddr;
        let segment_size = ph.p_memsz.min(ph.p_filesz);

        log::debug!("Segment address: {:#010x}", segment_address);
        log::debug!("Segment size:    {} bytes", segment_size);

        let segment = segment_address..segment_address + segment_size;
        // If the requested data is not fully inside of the current segment, skip the segment.
        if !segment.contains_range(&range_to_read) {
            log::debug!("Skipping segment.");
            continue;
        }

        let start = ph.p_offset as u32 + address - segment_address as u32;
        return Some(&buffer[start as usize..][..size as usize]);
    }

    None
}

fn extract_flash_device(elf: &goblin::elf::Elf, buffer: &[u8]) -> Result<FlashDevice> {
    // Extract the flash device info.
    for sym in elf.syms.iter() {
        let name = &elf.strtab[sym.st_name];

        if name == "FlashDevice" {
            // This struct contains information about the FLM file structure.
            let address = sym.st_value as u32;
            return FlashDevice::new(elf, buffer, address);
        }
    }

    // Failed to find flash device
    Err(Fault::NoFlashDevice.into())
}

/// The algorithm name probe-rs uses, derived the way `target-gen` derives it from a
/// path: the file stem, lowercased.
fn algorithm_name(file_name: &str) -> String {
    let stem = file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(file_name)
        .rsplit_once('.')
        .map(|(stem, _extension)| stem)
        .unwrap_or(file_name);
    stem.to_lowercase()
}

/// Extracts a position & memory independent flash algorithm blob from the provided ELF file.
pub fn extract_flash_algo(
    existing_algo: Option<RawFlashAlgorithm>,
    buffer: &[u8],
    file_name: &str,
    default: bool,
    fixed_load_address: bool,
) -> Result<RawFlashAlgorithm> {
    let mut algo = existing_algo.unwrap_or_default();

    let elf = goblin::elf::Elf::parse(buffer).context(Fault::BadElf)?;

    let flash_device = extract_flash_device(&elf, buffer).context(format!(
        "Failed to extract flash information from ELF file '{file_name}'."
    ))?;

    // Extract binary blob.
    let algorithm_binary = crate::algorithm_binary::AlgorithmBinary::new(&elf, buffer)?;
    algo.instructions = algorithm_binary.blob();

    let code_section_offset = algorithm_binary.code_section.start;

    // Extract the function pointers,
    // and check if a RTT symbol is present.
    for sym in elf.syms.iter() {
        let name = &elf.strtab[sym.st_name];

        match name {
            "Init" => algo.pc_init = Some(sym.st_value - code_section_offset as u64),
            "UnInit" => algo.pc_uninit = Some(sym.st_value - code_section_offset as u64),
            "EraseChip" => algo.pc_erase_all = Some(sym.st_value - code_section_offset as u64),
            "EraseSector" => algo.pc_erase_sector = sym.st_value - code_section_offset as u64,
            "ProgramPage" => algo.pc_program_page = sym.st_value - code_section_offset as u64,
            "Verify" => algo.pc_verify = Some(sym.st_value - code_section_offset as u64),
            "ReadFlash" => algo.pc_read = Some(sym.st_value - code_section_offset as u64),
            "BlankCheck" => algo.pc_blank_check = Some(sym.st_value - code_section_offset as u64),
            "_SEGGER_RTT" => {
                algo.rtt_location = Some(sym.st_value);
                log::debug!("Found RTT control block at address {:#010x}", sym.st_value);
            }

            _ => {}
        }
    }

    if fixed_load_address {
        log::debug!(
            "Flash algorithm will be loaded at fixed address {:#010x}",
            algorithm_binary.code_section.load_address
        );

        anyhow::ensure!(
            algorithm_binary.is_continuous_in_ram(),
            "If the flash algorithm is not position independent, all sections have to follow each other in RAM. \
            Please check your linkerscript."
        );

        algo.load_address = Some(algorithm_binary.code_section.load_address as u64);
    }

    algo.description.clone_from(&flash_device.name);
    algo.name = algorithm_name(file_name);
    algo.default = default;
    algo.data_section_offset = algorithm_binary.data_section.start as u64;
    algo.flash_properties = FlashProperties::from(flash_device);

    Ok(algo)
}

impl From<FlashDevice> for FlashProperties {
    fn from(device: FlashDevice) -> Self {
        let sectors = device
            .sectors
            .iter()
            .map(|si| SectorDescription {
                address: si.address.into(),
                size: si.size.into(),
            })
            .collect();

        FlashProperties {
            address_range: device.start_address as u64
                ..(device.start_address as u64 + device.device_size as u64),

            page_size: device.page_size,
            erased_byte_value: device.erased_default_value,

            program_page_timeout: device.program_page_timeout,
            erase_sector_timeout: device.erase_sector_timeout,

            sectors,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::algorithm_name;

    #[test]
    fn algorithm_name_matches_target_gens_file_stem() {
        // target-gen uses `Path::file_stem().to_lowercase()`; these are the shapes a
        // browser file picker or a pack's `<algorithm>` element can hand us.
        assert_eq!(algorithm_name("MIMXRT5xx_FLEXSPI.FLM"), "mimxrt5xx_flexspi");
        assert_eq!(algorithm_name("CMSIS/Flash/LPC5460x.flm"), "lpc5460x");
        assert_eq!(algorithm_name("Flash\\W25Q64JV.FLM"), "w25q64jv");
        assert_eq!(algorithm_name("no_extension"), "no_extension");
        assert_eq!(algorithm_name("dots.in.name.FLM"), "dots.in.name");
    }
}

//! Turning a `ChipFamily` into the YAML dialect `chips/load` accepts.
//!
//! Ported from `target-gen/src/commands/elf.rs` on the fork
//! (`beriberikix/probe-rs@webusb/nusb-0.2.7`): `compact` and friends plus
//! `serialize_to_yaml_string`, with the surrounding `std::fs` CLI plumbing dropped.
//!
//! The cleanup below looks cosmetic and is not. `serde_yaml` writes the schema's
//! hex-formatted integers as quoted strings, and a quoted `'0x1'` does not deserialize
//! back into a `u64` — so the output would not survive the round trip through the
//! worker's registry. The tests assert re-loadability, not appearance.

use anyhow::Result;
use probe_rs_target::{ChipFamily, MemoryRange as _, RawFlashAlgorithm};
use std::{borrow::Cow, fmt::Write, ops::Range};

fn compact(family: &ChipFamily) -> ChipFamily {
    let mut out = family.clone();

    sort_memory_regions(&mut out);
    compact_flash_algos(&mut out);

    out
}

fn sort_memory_regions(out: &mut ChipFamily) {
    for variant in &mut out.variants {
        variant
            .memory_map
            .sort_by_key(|region| region.address_range().start);
    }
}

fn compact_flash_algos(out: &mut ChipFamily) {
    fn comparable_algo(algo: &RawFlashAlgorithm) -> RawFlashAlgorithm {
        let mut algo = algo.clone();
        algo.flash_properties.address_range.end = 0;
        algo.description = String::new();
        algo.name = String::new();
        algo
    }

    let mut renames = std::collections::HashMap::<String, String>::new();

    let algos = std::mem::take(&mut out.flash_algorithms);
    let mut algos_iter = algos.iter();
    while let Some(algo) = algos_iter.next() {
        if renames.contains_key(&algo.name) {
            continue;
        }

        // Collect renames because the new name may change during looping
        let mut renamed = vec![algo.name.clone()];

        // Find the algo with the widest address range and replace all others with it.
        let algo_template = comparable_algo(algo);
        let mut widest_algo = algo.clone();
        for algo_b in algos_iter.clone() {
            if renames.contains_key(&algo_b.name) {
                continue;
            }

            if algo_template == comparable_algo(algo_b) {
                renamed.push(algo_b.name.clone());

                if algo_b.flash_properties.address_range.end
                    > widest_algo.flash_properties.address_range.end
                {
                    widest_algo = algo_b.clone();
                }
            }
        }

        for renamed in renamed {
            renames.insert(renamed, widest_algo.name.clone());
        }
        if widest_algo.name != algo.name {
            // Keep the original algo, too. We will remove these if no uses remain.
            out.flash_algorithms.push(algo.clone());
        }
        out.flash_algorithms.push(widest_algo);
    }

    fn memory_range_of_algo(algo_name: &str, algos: &[RawFlashAlgorithm]) -> Option<Range<u64>> {
        algos
            .iter()
            .find(|a| a.name == algo_name)
            .map(|a| &a.flash_properties.address_range)
            .cloned()
    }

    // Now walk through the target variants' flash algo map and apply the renames
    for variant in &mut out.variants {
        for algo_name in &mut variant.flash_algorithms {
            let Some(replacement_name) = renames.get(algo_name) else {
                continue;
            };

            // Only algos that have memory regions in the memory map are subject to renaming.
            let memory_range = memory_range_of_algo(algo_name, &algos)
                .unwrap_or_else(|| panic!("Flash algorithm {algo_name} not found."));

            if !variant
                .memory_map
                .iter()
                .any(|region| region.address_range().intersects_range(&memory_range))
            {
                // This flash algo has no memory region, so we conjure up one ourselves. We can
                // only deduplicate these algos if the replacement has the same size.
                let replacement_memory_range = memory_range_of_algo(replacement_name, &algos)
                    .unwrap_or_else(|| panic!("Flash algorithm {replacement_name} not found."));

                if replacement_memory_range != memory_range {
                    continue;
                }
            }

            // Apply rename.
            algo_name.clone_from(replacement_name);
        }
    }

    // Remove flash algos with no uses
    out.flash_algorithms.retain(|algo| {
        out.variants
            .iter()
            .any(|variant| variant.flash_algorithms.contains(&algo.name))
    });
}

/// Some optimizations to improve the readability of the `serde_yaml` output:
/// - If `Option<T>` is `None`, it is serialized as `null` ... we want to omit it.
/// - If `Vec<T>` is empty, it is serialized as `[]` ... we want to omit it.
/// - `serde_yaml` serializes hex formatted integers as single quoted strings, e.g. '0x1234' ... we need to remove the single quotes so that it round-trips properly.
pub fn serialize_to_yaml_string(family: &ChipFamily) -> Result<String> {
    let family = compact(family);
    let raw_yaml_string = serde_yaml::to_string(&family)?;
    tidy(&raw_yaml_string)
}

/// Serialize anything in the target schema with the same cleanup.
///
/// The quote stripping is not cosmetic: `serde_yaml` writes the schema's hex-formatted
/// integers as quoted strings (`pc_init: '0x1'`), which do not deserialize back into
/// `u64`. Anything we emit for a user to load or paste has to go through here, not just
/// whole families — a lesson from the algorithm fragment, which skipped it and produced
/// YAML that would not round-trip.
pub(crate) fn serialize_with_cleanup<T: serde::Serialize>(value: &T) -> Result<String> {
    tidy(&serde_yaml::to_string(value)?)
}

fn tidy(raw_yaml_string: &str) -> Result<String> {
    let mut yaml_string = String::with_capacity(raw_yaml_string.len());
    for reader_line in raw_yaml_string.lines() {
        let trimmed_line = reader_line.trim();
        if reader_line.ends_with(": null")
            || reader_line.ends_with(": []")
            || reader_line.ends_with(": {}")
            || reader_line.ends_with(": false")
        {
            // Some fields have default-looking, but significant values that we want to keep.
            let keep_default = [
                "rtt_scan_ranges: []",
                "read: false",
                "write: false",
                "execute: false",
                "stack_overflow_check: false",
            ];
            if !keep_default.contains(&trimmed_line) {
                // Skip the line
                continue;
            }
        } else {
            // Some fields have different default values than the type may indicate.
            let trim_nondefault = [
                "read: true",
                "write: true",
                "execute: true",
                "stack_overflow_check: true",
            ];
            if trim_nondefault.contains(&trimmed_line) {
                // Skip the line
                continue;
            }
        }

        let mut reader_line = Cow::Borrowed(reader_line);
        if (reader_line.contains("'0x") || reader_line.contains("'0X"))
            && (reader_line.ends_with('\'') || reader_line.contains("':"))
        {
            // Remove the single quotes
            reader_line = reader_line.replace('\'', "").into();
        }

        yaml_string.write_str(&reader_line)?;
        yaml_string.push('\n');
    }

    // Second pass: remove empty `access:` objects
    let mut output = String::with_capacity(yaml_string.len());
    let mut lines = yaml_string.lines().peekable();
    while let Some(line) = lines.next() {
        if line.trim() == "access:" {
            let Some(next) = lines.peek() else {
                // No other lines, access is empty, skip it
                continue;
            };

            let indent_level = line.find(|c: char| c != ' ').unwrap_or(0);
            let next_indent_level = next.find(|c: char| c != ' ').unwrap_or(0);
            if next_indent_level <= indent_level {
                // Access is empty, skip it
                continue;
            }
        }

        output.push_str(line);
        output.push('\n');
    }

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use probe_rs_target::{
        Chip, CoreType, MemoryAccess, NvmRegion, RamRegion, TargetDescriptionSource,
    };

    fn family_with(memory_map: Vec<probe_rs_target::MemoryRegion>) -> ChipFamily {
        let mut chip = Chip::generic_arm("Test Chip", CoreType::Armv8m);
        chip.memory_map = memory_map;
        ChipFamily {
            name: "Test Family".to_owned(),
            manufacturer: None,
            generated_from_pack: false,
            chip_detection: vec![],
            pack_file_release: None,
            variants: vec![chip],
            flash_algorithms: vec![],
            source: TargetDescriptionSource::BuiltIn,
        }
    }

    /// The cleanup pass exists so the output stays readable *and* re-loadable. Both
    /// halves are asserted here because only the second one can actually break a user:
    /// a dropped line is cosmetic, a quoted hex number fails to deserialize.
    #[test]
    fn defaults_are_trimmed_but_significant_ones_are_kept() {
        let family = family_with(vec![
            probe_rs_target::MemoryRegion::Ram(RamRegion {
                range: 0x2000_0000..0x2000_4000,
                cores: vec!["main".to_owned()],
                name: Some("SRAM".to_owned()),
                access: Some(MemoryAccess::default()),
            }),
            // `execute: false` on RAM is a real statement, not a default to drop.
            probe_rs_target::MemoryRegion::Ram(RamRegion {
                range: 0x2000_4000..0x2000_8000,
                cores: vec!["main".to_owned()],
                name: Some("CCMRAM".to_owned()),
                access: Some(MemoryAccess {
                    boot: false,
                    read: true,
                    write: true,
                    execute: false,
                }),
            }),
            probe_rs_target::MemoryRegion::Nvm(NvmRegion {
                range: 0x0800_0000..0x0801_0000,
                cores: vec!["main".to_owned()],
                name: Some("Flash".to_owned()),
                access: None,
                is_alias: false,
            }),
        ]);

        let yaml = serialize_to_yaml_string(&family).unwrap();

        assert!(yaml.contains("execute: false"), "{yaml}");
        // Defaults that carry no information are dropped.
        assert!(!yaml.contains("read: true"), "{yaml}");
        assert!(!yaml.contains(": null"), "{yaml}");
        assert!(!yaml.contains(": []"), "{yaml}");
        // An `access:` key whose body was entirely trimmed must go too, or the YAML
        // reads as `access: null` and the region loses its defaults.
        assert!(!yaml.contains("access:\n      range"), "{yaml}");

        // The whole point: it comes back.
        let parsed: ChipFamily = serde_yaml::from_str(&yaml).unwrap();
        parsed.validate().unwrap();
        assert_eq!(parsed.variants[0].memory_map.len(), 3);
    }

    /// `serde_yaml` quotes the schema's hex integers; quoted, they do not parse as u64.
    #[test]
    fn hex_integers_are_not_left_quoted() {
        let family = family_with(vec![probe_rs_target::MemoryRegion::Nvm(NvmRegion {
            range: 0x0800_0000..0x0801_0000,
            cores: vec!["main".to_owned()],
            name: Some("Flash".to_owned()),
            access: None,
            is_alias: false,
        })]);

        let yaml = serialize_to_yaml_string(&family).unwrap();
        assert!(!yaml.contains("'0x"), "{yaml}");
        serde_yaml::from_str::<ChipFamily>(&yaml).unwrap();
    }
}

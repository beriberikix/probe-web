//! What a `.FLM` has to survive before the browser hands it to `chips/load`.
//!
//! The load-bearing assertion is the round trip: whatever we emit has to come back as a
//! `ChipFamily` through the same `serde_yaml` path the worker's registry uses
//! (`probe-rs/src/config/registry.rs` -> `add_target_family_from_yaml`) and then pass
//! `validate()`, which is the gate `add_target_family` applies. A YAML that fails either
//! is a YAML the user cannot load, whatever it looks like.
//!
//! The corpus test wants real vendor algorithms. Point `PROBE_WEB_FLM_DIR` at a
//! directory of `.FLM` files to run it — e.g. anything unzipped out of a CMSIS DFP:
//!
//! ```sh
//! unzip -j -o path/to/Vendor.DFP.pack '*.FLM' -d /tmp/flm
//! PROBE_WEB_FLM_DIR=/tmp/flm cargo test -p probe-web-targets
//! ```
//!
//! Vendor packs are large and not ours to redistribute, so nothing is committed and the
//! test reports itself skipped when the variable is unset.

use probe_rs_target::ChipFamily;

/// Parse YAML the way the worker's registry does, then apply the same validation.
fn load_like_the_worker(yaml: &str) -> ChipFamily {
    let family: ChipFamily =
        serde_yaml::from_str(yaml).unwrap_or_else(|e| panic!("YAML did not deserialize: {e}\n"));
    family
        .validate()
        .unwrap_or_else(|e| panic!("ChipFamily::validate rejected our output: {e}"));
    family
}

fn flm_dir() -> Option<std::path::PathBuf> {
    let dir = std::env::var_os("PROBE_WEB_FLM_DIR")?;
    let dir = std::path::PathBuf::from(dir);
    assert!(
        dir.is_dir(),
        "PROBE_WEB_FLM_DIR is not a directory: {dir:?}"
    );
    Some(dir)
}

fn flm_files() -> Vec<std::path::PathBuf> {
    let Some(dir) = flm_dir() else {
        return Vec::new();
    };
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("flm")))
        .collect();
    files.sort();
    files
}

#[test]
fn every_vendor_flm_becomes_a_loadable_family() {
    let files = flm_files();
    if files.is_empty() {
        eprintln!("skipped: set PROBE_WEB_FLM_DIR to a directory of .FLM files");
        return;
    }

    let mut failures = Vec::new();
    for path in &files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let bytes = std::fs::read(path).unwrap();

        // Pack algorithms are position independent, so no fixed load address.
        match probe_web_targets::flm_to_family_yaml(&bytes, &name, false) {
            Ok(yaml) => {
                let family = load_like_the_worker(&yaml);
                let algo = &family.flash_algorithms[0];
                if algo.instructions.is_empty() {
                    failures.push(format!("{name}: no instructions extracted"));
                }
                if algo.flash_properties.sectors.is_empty() {
                    failures.push(format!("{name}: no sectors"));
                }
            }
            Err(e) => failures.push(format!("{name}: {e:#}")),
        }
    }

    eprintln!("converted {} vendor .FLM files", files.len());
    assert!(
        failures.is_empty(),
        "{} of {} .FLM files failed:\n{}",
        failures.len(),
        files.len(),
        failures.join("\n")
    );
}

#[test]
fn algorithm_fragment_splices_into_an_existing_family() {
    let files = flm_files();
    let Some(path) = files.first() else {
        eprintln!("skipped: set PROBE_WEB_FLM_DIR to a directory of .FLM files");
        return;
    };
    let name = path.file_name().unwrap().to_string_lossy().to_string();
    let bytes = std::fs::read(path).unwrap();

    // The "probe-rs knows my chip but not my external flash" path: the fragment is a
    // `flash_algorithms` list, so it can be pasted straight into a family document.
    let fragment = probe_web_targets::flm_to_algorithm_yaml(&bytes, &name, false).unwrap();
    let algorithms: Vec<probe_rs_target::RawFlashAlgorithm> =
        serde_yaml::from_str(&fragment).expect("fragment is a flash_algorithms list");
    assert_eq!(algorithms.len(), 1);
    assert!(!algorithms[0].instructions.is_empty());
    assert_eq!(algorithms[0].cores, ["main"]);
}

// --- pack import -----------------------------------------------------------------
//
// Same contract as the .FLM tests: whatever comes out has to load. Point
// PROBE_WEB_PACK at a vendor .pack to run these.

fn pack_bytes() -> Option<(String, Vec<u8>)> {
    let path = std::env::var_os("PROBE_WEB_PACK")?;
    let path = std::path::PathBuf::from(path);
    let name = path.file_name().unwrap().to_string_lossy().to_string();
    Some((name, std::fs::read(&path).unwrap()))
}

#[test]
fn a_vendor_pack_becomes_loadable_families() {
    let Some((name, bytes)) = pack_bytes() else {
        eprintln!("skipped: set PROBE_WEB_PACK to a vendor .pack file");
        return;
    };
    let size = bytes.len();

    let families = probe_web_targets::families_from_pack(bytes).unwrap();
    assert!(!families.is_empty(), "{name} produced no families");

    let mut chips = 0;
    let mut algorithms = 0;
    for family in &families {
        // Every family has to survive the same round trip a user's import would do.
        let yaml = probe_web_targets::serialize_to_yaml_string(family).unwrap();
        let reloaded = load_like_the_worker(&yaml);
        assert_eq!(reloaded.name, family.name);
        chips += family.variants.len();
        algorithms += family.flash_algorithms.len();

        // `generated_from_pack` is what tells probe-rs the description came from a
        // vendor pack rather than its own registry.
        assert!(family.generated_from_pack, "{}", family.name);
    }

    eprintln!(
        "{name} ({size} bytes): {} families, {chips} chips, {algorithms} flash algorithms",
        families.len()
    );
    assert!(chips > 0 && algorithms > 0);
}

#[test]
fn svds_come_out_of_the_pack() {
    let Some((name, bytes)) = pack_bytes() else {
        eprintln!("skipped: set PROBE_WEB_PACK to a vendor .pack file");
        return;
    };

    let svds = probe_web_targets::svds_from_pack(bytes).unwrap();
    eprintln!("{name}: {} SVDs", svds.len());
    for (svd_name, xml) in svds.iter().take(3) {
        assert!(svd_name.to_lowercase().ends_with(".svd"), "{svd_name}");
        assert!(xml.contains("<device"), "{svd_name} is not an SVD document");
    }
}

/// A pack we wrote ourselves, so CI exercises the whole pdsc path with no vendor bytes
/// and nothing to redistribute. It has no flash algorithms, which is the point: the chip
/// description still has to come out loadable.
#[test]
fn the_committed_fixture_pack_imports() {
    // Lives under the flasher's public directory because the browser tests need it
    // served over HTTP as well; one copy, used from both sides.
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/flash/public/targets/minimal.pack"
    ))
    .unwrap();

    let families = probe_web_targets::families_from_pack(bytes).unwrap();
    assert_eq!(families.len(), 1);
    let family = &families[0];
    assert_eq!(family.name, "ProbeWebTest");
    assert_eq!(family.variants.len(), 1);
    assert_eq!(family.variants[0].name, "ProbeWebTestChip");
    assert!(family.generated_from_pack);

    let yaml = probe_web_targets::serialize_to_yaml_string(family).unwrap();
    let reloaded = load_like_the_worker(&yaml);
    assert_eq!(
        reloaded.variants[0].cores[0].core_type,
        probe_rs_target::CoreType::Armv8m
    );
}

/// The failure a user is most likely to hit: picking the wrong file. It has to come back
/// as a typed fault, since that is what the picker shows.
#[test]
fn picking_a_non_pack_reports_a_typed_fault() {
    let err = probe_web_targets::families_from_pack(b"this is not a zip".to_vec()).unwrap_err();
    assert_eq!(
        probe_web_targets::Fault::of(&err),
        Some(probe_web_targets::Fault::BadArchive)
    );

    // A zip, but not a pack.
    let mut zip = std::io::Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut zip);
        w.start_file::<_, ()>("readme.txt", Default::default())
            .unwrap();
        std::io::Write::write_all(&mut w, b"no pdsc here").unwrap();
        w.finish().unwrap();
    }
    let err = probe_web_targets::families_from_pack(zip.into_inner()).unwrap_err();
    assert_eq!(
        probe_web_targets::Fault::of(&err),
        Some(probe_web_targets::Fault::NoPdsc)
    );

    // Not an ELF, so not a .FLM.
    let err = probe_web_targets::flm_to_family_yaml(b"nope", "x.FLM", false).unwrap_err();
    assert_eq!(
        probe_web_targets::Fault::of(&err),
        Some(probe_web_targets::Fault::BadElf)
    );
}

//! Convert a CMSIS `.pack` or `.FLM` to probe-rs target YAML, on the command line.
//!
//! The browser is the point of this crate, but the same conversion is useful from a
//! shell — to inspect what a pack contains before importing it, or to produce a YAML for
//! a hardware check without clicking through a page.
//!
//! ```sh
//! cargo run -p probe-web-targets --example pack-to-yaml -- vendor.pack            # list
//! cargo run -p probe-web-targets --example pack-to-yaml -- vendor.pack MCXA153    # emit
//! cargo run -p probe-web-targets --example pack-to-yaml -- algorithm.FLM
//! ```

use anyhow::{Result, bail};

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        bail!("usage: pack-to-yaml <file.pack|file.FLM> [family name]");
    };
    let wanted = args.next();
    let bytes = std::fs::read(&path)?;

    if path.to_lowercase().ends_with(".flm") {
        let name = path.rsplit(['/', '\\']).next().unwrap_or(&path);
        print!(
            "{}",
            probe_web_targets::flm_to_family_yaml(&bytes, name, false)?
        );
        return Ok(());
    }

    let families = probe_web_targets::families_from_pack(bytes)?;
    match wanted {
        // No family named: list what is in the pack, on stderr so stdout stays pipeable.
        None => {
            for family in &families {
                eprintln!(
                    "{} — {} chip(s), {} algorithm(s): {}",
                    family.name,
                    family.variants.len(),
                    family.flash_algorithms.len(),
                    family
                        .variants
                        .iter()
                        .map(|v| v.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                );
            }
        }
        Some(wanted) => {
            let family = families
                .iter()
                .find(|f| f.name.eq_ignore_ascii_case(&wanted))
                .ok_or_else(|| anyhow::anyhow!("no family named '{wanted}' in {path}"))?;
            print!("{}", probe_web_targets::serialize_to_yaml_string(family)?);
        }
    }
    Ok(())
}

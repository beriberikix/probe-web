//! Open a coredump written by the browser, using probe-rs's own reader.
//!
//! `crates/probe-web-core/src/coredump.rs` writes the MessagePack encoding that
//! `probe_rs::CoreDump::store` produces. That is a coupling to probe-rs's field names and
//! nested types, so it is checked rather than assumed: this loads a file through
//! `CoreDump::load_raw` — the same call `probe-rs` makes — and prints what came back.
//!
//! ```sh
//! cargo run -p probe-web-local --example check-coredump -- dump.coredump
//! ```
//!
//! It lives here because this is the crate that already depends on `probe-rs`; the client
//! deliberately does not.

use anyhow::{Result, bail};

fn main() -> Result<()> {
    let Some(path) = std::env::args().nth(1) else {
        bail!("usage: check-coredump <file>");
    };
    let bytes = std::fs::read(&path)?;
    let dump = match probe_rs::CoreDump::load_raw(&bytes) {
        Ok(dump) => dump,
        Err(e) => {
            // Say *what* the file looks like, not just that it failed: the whole point of
            // this example is diagnosing a field that drifted.
            eprintln!("probe-rs could not read {path}: {e}");
            // The wrapper's message says only that decoding failed; the inner serde error
            // names the field.
            match rmp_serde::from_slice::<probe_rs::CoreDump>(&bytes) {
                Ok(_) => eprintln!(
                    "  (but rmp_serde read it directly -- so the ELF probe path is what objected)"
                ),
                Err(e) => eprintln!("  serde says: {e}"),
            }
            if let Ok(value) = rmpv::decode::read_value(&mut &bytes[..]) {
                if let rmpv::Value::Map(fields) = &value {
                    eprintln!("the file is a {}-entry map:", fields.len());
                    for (k, v) in fields {
                        let shape = match v {
                            rmpv::Value::Map(m) => format!("map({} entries)", m.len()),
                            rmpv::Value::Array(a) => format!("array({} items)", a.len()),
                            other => format!("{other}"),
                        };
                        eprintln!("  {k} = {shape}");
                    }
                } else {
                    eprintln!("the file is not a map: {value}");
                }
            }
            bail!("coredump did not load");
        }
    };

    let bytes_captured: usize = dump.data.iter().map(|(_, d)| d.len()).sum();
    println!(
        "{path}: {} bytes, {} registers, {} memory range(s) totalling {bytes_captured} bytes",
        bytes.len(),
        dump.registers.len(),
        dump.data.len(),
    );
    println!(
        "core_type={:?} instruction_set={:?} fpu={} fp_registers={:?} native_64bit={}",
        dump.core_type,
        dump.instruction_set,
        dump.fpu_support,
        dump.floating_point_register_count,
        dump.supports_native_64bit_access,
    );
    for (range, data) in dump.data.iter().take(4) {
        let head: Vec<String> = data.iter().take(8).map(|b| format!("{b:02x}")).collect();
        println!(
            "  {:#010x}..{:#010x}  {}",
            range.start,
            range.end,
            head.join(" ")
        );
    }
    Ok(())
}

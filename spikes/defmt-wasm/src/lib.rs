//! Spike E: defmt decoding from ELF bytes, identical code on native and wasm.

use defmt_decoder::{DecodeError, Table};
use wasm_bindgen::prelude::*;

/// Decode `stream` using the defmt table in `elf`; one line per frame.
pub fn decode_all(elf: &[u8], stream: &[u8]) -> Result<String, String> {
    let table = Table::parse(elf)
        .map_err(|e| format!("{e:?}"))?
        .ok_or("ELF has no .defmt section")?;
    let mut decoder = table.new_stream_decoder();
    decoder.received(stream);
    let mut out = String::new();
    loop {
        match decoder.decode() {
            Ok(frame) => {
                let level = frame.level().map(|l| l.as_str()).unwrap_or("println");
                out.push_str(&format!("{level}: {}\n", frame.display_message()));
            }
            Err(DecodeError::UnexpectedEof) => break,
            Err(DecodeError::Malformed) => return Err(format!("malformed frame after:\n{out}")),
        }
    }
    Ok(out)
}

#[wasm_bindgen]
pub fn decode(elf: &[u8], stream: &[u8]) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    decode_all(elf, stream).map_err(|e| JsValue::from_str(&e))
}

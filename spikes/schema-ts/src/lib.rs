//! Round-trip check for the generated `.d.ts`: JS objects shaped like the
//! generated types must deserialize into the real `probe-rs-rpc` structs and
//! serialize back to the same shape, through `serde-wasm-bindgen`.
use probe_rs_rpc::probe::{AttachRequest, AttachResult};
use probe_rs_rpc::{Key, Session};
use serde_wasm_bindgen::Serializer;
use wasm_bindgen::prelude::*;

fn ser() -> Serializer {
    // u64 must not be truncated to f64; keep enums externally tagged.
    Serializer::new()
        .serialize_large_number_types_as_bigints(true)
        .serialize_missing_as_null(true)
}

#[wasm_bindgen]
pub fn roundtrip_attach(v: JsValue) -> Result<JsValue, JsValue> {
    let req: AttachRequest = serde_wasm_bindgen::from_value(v)?;
    Ok(req.serialize(&ser())?)
}

#[wasm_bindgen]
pub fn sample_results() -> Result<JsValue, JsValue> {
    let samples = vec![
        AttachResult::Success(Key::<Session>::new()),
        AttachResult::ProbeNotFound,
        AttachResult::FailedToOpenProbe("nope".into()),
        AttachResult::TargetAttachFailed {
            message: "m".into(),
            connect_under_reset: true,
        },
    ];
    Ok(samples.serialize(&ser())?)
}

/// Round-trip the `rename_all` cases the generator special-cases.
#[wasm_bindgen]
pub fn roundtrip_rtt_config(v: JsValue) -> Result<JsValue, JsValue> {
    let c: probe_rs_rpc::rtt_config::RttChannelConfig = serde_wasm_bindgen::from_value(v)?;
    Ok(c.serialize(&ser())?)
}

#[wasm_bindgen]
pub fn sample_esp_mode() -> Result<JsValue, JsValue> {
    Ok(probe_rs_rpc::format::EspFlashMode::Qio.serialize(&ser())?)
}

#[wasm_bindgen]
pub fn sample_u64() -> Result<JsValue, JsValue> {
    Ok((0xDEAD_BEEF_CAFE_u64, vec![1u8, 2, 3]).serialize(&ser())?)
}

use serde::Serialize;

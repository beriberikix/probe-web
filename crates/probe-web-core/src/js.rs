//! The JS boundary contract. Every value crossing into JS is serialized with
//! these settings, which `spikes/schema-ts` documents in the generated
//! `probe-rs-rpc.d.ts`: externally tagged enums, u64/i64 as `bigint`,
//! `None`/unit as `null`, `Vec<u8>` as `Array<number>`.

use serde::{Serialize, de::DeserializeOwned};
use serde_wasm_bindgen::Serializer;
use wasm_bindgen::JsValue;

pub fn serializer() -> Serializer {
    Serializer::new()
        .serialize_large_number_types_as_bigints(true)
        .serialize_missing_as_null(true)
}

pub fn to_js<T: Serialize + ?Sized>(v: &T) -> Result<JsValue, JsValue> {
    v.serialize(&serializer()).map_err(JsValue::from)
}

pub fn from_js<T: DeserializeOwned>(v: JsValue) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(v).map_err(JsValue::from)
}

/// Errors reach JS as `Error` objects with a `kind` property so callers can
/// switch on them without parsing messages.
pub fn error(kind: &str, message: impl std::fmt::Display) -> JsValue {
    let e = js_sys::Error::new(&message.to_string());
    let _ = js_sys::Reflect::set(&e, &"kind".into(), &kind.into());
    e.into()
}

pub fn client_err(e: probe_rs_rpc_client::ClientError) -> JsValue {
    use probe_rs_rpc_client::ClientError::*;
    let kind = match &e {
        Transport(_) => "transport",
        UnknownEndpoint => "unknown-endpoint",
        IncompatibleServer => "incompatible-server",
        Remote(_) => "remote",
        InvalidRemoteHost => "invalid-host",
        _ => "client",
    };
    error(kind, e)
}

pub fn log(s: &str) {
    web_sys::console::log_1(&format!("[probe-web] {s}").into());
}

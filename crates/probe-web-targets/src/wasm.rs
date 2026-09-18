//! The JS surface, loaded only when someone actually imports a pack.
//!
//! This is a separate cdylib from `probe-web-core` on purpose. The flasher is the page
//! most people open and it never needs any of this, so keeping the zip reader, the ELF
//! reader and the `.pdsc` parser out of the client's own wasm is what stops every visitor
//! paying for a feature a few will use. `@probe-web/client/targets` dynamically imports
//! it, so the cost lands on the first `.pack` or `.FLM` a user picks and never before.
//!
//! Error convention is `probe-web-core`'s: JS gets an `Error` with a `kind` property so
//! callers switch on the cause rather than parsing the message. See `fault.rs`.

use wasm_bindgen::prelude::*;

use crate::fault::Fault;

/// Turn an internal error into the `Error` JS sees, tagged with the fault if one was
/// attached and `targets` otherwise.
fn js_error(error: anyhow::Error) -> JsValue {
    let kind = Fault::of(&error).map_or("targets", Fault::kind);
    // `{:#}` prints the context chain on one line, which is what a UI wants to show.
    let e = js_sys::Error::new(&format!("{error:#}"));
    let _ = js_sys::Reflect::set(&e, &"kind".into(), &kind.into());
    e.into()
}

/// One chip family read out of a pack, with its YAML ready for `chips/load`.
#[wasm_bindgen(getter_with_clone)]
pub struct ChipFamilyYaml {
    /// The family name, for showing the user what a pack contains.
    pub name: String,
    /// How many chip variants the family describes.
    pub variants: usize,
    /// The family as target YAML.
    pub yaml: String,
}

/// An SVD found inside a pack.
#[wasm_bindgen(getter_with_clone)]
pub struct PackSvd {
    /// The file's name inside the pack, e.g. `R7FA6M5BH.svd`.
    pub name: String,
    /// The SVD document itself.
    pub xml: String,
}

#[wasm_bindgen(js_name = initTargets)]
pub fn init_targets() {
    console_error_panic_hook::set_once();
}

/// Read a CMSIS `.pack` and return one entry per chip family it describes.
///
/// A pack routinely holds dozens of families, so the caller chooses which to load rather
/// than having them all forced into the registry.
#[wasm_bindgen(js_name = packToYaml)]
pub fn pack_to_yaml(bytes: Vec<u8>) -> Result<Vec<ChipFamilyYaml>, JsValue> {
    let families = crate::families_from_pack(bytes).map_err(js_error)?;
    families
        .iter()
        .map(|family| {
            Ok(ChipFamilyYaml {
                name: family.name.clone(),
                variants: family.variants.len(),
                yaml: crate::serialize_to_yaml_string(family).map_err(js_error)?,
            })
        })
        .collect()
}

/// Every SVD inside a CMSIS `.pack`.
#[wasm_bindgen(js_name = packSvds)]
pub fn pack_svds(bytes: Vec<u8>) -> Result<Vec<PackSvd>, JsValue> {
    Ok(crate::svds_from_pack(bytes)
        .map_err(js_error)?
        .into_iter()
        .map(|(name, xml)| PackSvd { name, xml })
        .collect())
}

/// Read a CMSIS `.FLM` and return a complete placeholder chip family, ready to load and
/// then edit.
#[wasm_bindgen(js_name = flmToYaml)]
pub fn flm_to_yaml(bytes: &[u8], name: &str, fixed_load_address: bool) -> Result<String, JsValue> {
    crate::flm_to_family_yaml(bytes, name, fixed_load_address).map_err(js_error)
}

/// Read a CMSIS `.FLM` and return just the flash algorithm, as a YAML fragment to splice
/// into a chip description that already exists.
#[wasm_bindgen(js_name = flmToAlgorithm)]
pub fn flm_to_algorithm(
    bytes: &[u8],
    name: &str,
    fixed_load_address: bool,
) -> Result<String, JsValue> {
    crate::flm_to_algorithm_yaml(bytes, name, fixed_load_address).map_err(js_error)
}

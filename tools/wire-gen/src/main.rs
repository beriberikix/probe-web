//! Generates `packages/client/src/wire.ts`: TypeScript types for every probe-rs RPC
//! endpoint and topic, emitted from the postcard-schema type model that the wire
//! itself uses, so the SDK's types cannot drift from probe-rs-rpc (no `tsify` on
//! upstream types, no hand-written mirrors).
//!
//! Output goes to stdout: one `type`/`interface` per named type, plus an `Endpoints`
//! map of path → { request, response } and a `Topics` map. `scripts/build-wasm.sh`
//! runs it, and CI fails when the committed `wire.ts` differs from the output.
//!
//! The types describe values as they cross the wasm boundary through
//! serde-wasm-bindgen: externally tagged enums, 64-bit integers as `bigint`,
//! `None`/unit as `null`, `Vec<u8>` as `Array<number>`.

use std::collections::{BTreeMap, BTreeSet};

use postcard_schema::schema::{DataModelType, DataModelVariant, NamedType};

/// Rust type names that postcard-schema reports (`Vec<u8>`, `Option<Key<T>>`)
/// mapped to TS-friendly identifiers; generics collapse structurally.
fn ident(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        match c {
            '<' | '>' | ',' | ' ' | '(' | ')' | '[' | ']' | ';' | '&' | '\'' => s.push('_'),
            c => s.push(c),
        }
    }
    s.trim_matches('_').to_string()
}

/// Inline TS for a type reference; named structs/enums are emitted once and
/// referenced by name.
fn ts_ref(
    t: &NamedType,
    named: &mut BTreeMap<String, String>,
    seen: &mut BTreeSet<String>,
) -> String {
    use DataModelType::*;
    match t.ty {
        Bool => "boolean".into(),
        I8 | U8 | I16 | U16 | I32 | U32 | F32 | F64 | Usize | Isize => "number".into(),
        // 64/128-bit integers exceed Number.MAX_SAFE_INTEGER; serde-wasm-bindgen
        // maps u64 to bigint, so keep the wire honest.
        I64 | U64 | I128 | U128 => "bigint".into(),
        Char | String => "string".into(),
        ByteArray => "Uint8Array".into(),
        Unit | UnitStruct => "null".into(),
        Option(inner) => format!("({} | null)", ts_ref(inner, named, seen)),
        NewtypeStruct(_) => {
            // e.g. Key<Session> is a struct with key: u64; RpcError(String) newtype.
            define(t, named, seen);
            ident(t.name)
        }
        // serde-wasm-bindgen serializes `Vec<u8>` as a plain JS Array (only
        // serde_bytes-wrapped fields become Uint8Array), so mirror that.
        Seq(inner) => format!("Array<{}>", ts_ref(inner, named, seen)),
        Tuple(items) | TupleStruct(items) => {
            let parts: Vec<_> = items.iter().map(|i| ts_ref(i, named, seen)).collect();
            format!("[{}]", parts.join(", "))
        }
        Map { key, val } => format!(
            "Map<{}, {}>",
            ts_ref(key, named, seen),
            ts_ref(val, named, seen)
        ),
        Struct(fields) if t.name.contains('<') => {
            // Generic struct (e.g. `Key<T>`): inline, since every instantiation
            // shares the same reported name.
            let parts: Vec<_> = fields
                .iter()
                .map(|f| format!("{}: {}", f.name, ts_ref(f.ty, named, seen)))
                .collect();
            format!("{{ {} }}", parts.join("; "))
        }
        Enum(variants) if t.name.contains('<') => {
            // Generic enum (e.g. `Result<T, E>`): inline union.
            let alts: Vec<_> = variants
                .iter()
                .map(|v| variant_ts(v.name, v.ty, named, seen))
                .collect();
            format!("({})", alts.join(" | "))
        }
        Struct(_) | Enum(_) => {
            define(t, named, seen);
            ident(t.name)
        }
        Schema => "unknown".into(),
    }
}

fn variant_ts(
    name: &str,
    v: &DataModelVariant,
    named: &mut BTreeMap<String, String>,
    seen: &mut BTreeSet<String>,
) -> String {
    match v {
        DataModelVariant::UnitVariant => format!("\"{name}\""),
        DataModelVariant::NewtypeVariant(inner) => {
            format!("{{ {name}: {} }}", ts_ref(inner, named, seen))
        }
        // A one-element tuple variant serializes like a newtype variant.
        DataModelVariant::TupleVariant([single]) => {
            format!("{{ {name}: {} }}", ts_ref(single, named, seen))
        }
        DataModelVariant::TupleVariant(items) => {
            let parts: Vec<_> = items.iter().map(|i| ts_ref(i, named, seen)).collect();
            format!("{{ {name}: [{}] }}", parts.join(", "))
        }
        DataModelVariant::StructVariant(fields) => {
            let parts: Vec<_> = fields
                .iter()
                .map(|f| format!("{}: {}", f.name, ts_ref(f.ty, named, seen)))
                .collect();
            format!("{{ {name}: {{ {} }} }}", parts.join("; "))
        }
    }
}

/// `#[serde(rename_all = …)]` is not carried by postcard-schema (only per-item
/// `rename` is), so the few upstream uses are listed here. The tests below check
/// the list against serde's actual output.
const RENAME_ALL: &[(&str, &str)] = &[
    ("EspFlashMode", "lowercase"),
    ("EspFlashFrequency", "lowercase"),
    ("RttChannelConfig", "camelCase"),
];

/// Recursive fields. postcard-schema cannot express recursion, so probe-rs-rpc's
/// hand-written `Schema` impls stand in a placeholder (`Vec<()>` for
/// `ComponentTreeNode::children`); emit the real self-reference instead.
const RECURSIVE: &[(&str, &str, &str)] =
    &[("ComponentTreeNode", "children", "Array<ComponentTreeNode>")];

fn recursive_field(ty: &str, field: &str) -> Option<&'static str> {
    RECURSIVE
        .iter()
        .find(|(t, f, _)| *t == ty && *f == field)
        .map(|(_, _, ts)| *ts)
}

fn rename(ty: &str, name: &str) -> String {
    // A per-item `#[serde(rename = "12MHz")]` takes precedence over `rename_all`, and
    // postcard-schema reports the renamed name. Such names are usually not Rust
    // identifiers, which is how they are told apart here.
    let is_ident = name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !is_ident {
        return name.to_string();
    }
    match RENAME_ALL.iter().find(|(t, _)| *t == ty).map(|(_, c)| *c) {
        Some("lowercase") => name.to_ascii_lowercase(),
        Some("camelCase") => {
            let mut out = String::new();
            let mut upper = false;
            for c in name.chars() {
                if c == '_' {
                    upper = true;
                } else if upper {
                    out.extend(c.to_uppercase());
                    upper = false;
                } else {
                    out.push(c);
                }
            }
            out
        }
        _ => name.to_string(),
    }
}

fn define(t: &NamedType, named: &mut BTreeMap<String, String>, seen: &mut BTreeSet<String>) {
    let id = ident(t.name);
    if !seen.insert(id.clone()) {
        return;
    }
    use DataModelType::*;
    let body = match t.ty {
        Struct(fields) => {
            let mut s = format!("export interface {id} {{\n");
            for f in fields.iter() {
                let ts = match recursive_field(t.name, f.name) {
                    Some(ts) => ts.to_string(),
                    None => ts_ref(f.ty, named, seen),
                };
                s.push_str(&format!("  {}: {};\n", rename(t.name, f.name), ts));
            }
            s.push('}');
            s
        }
        // serde's externally tagged enum representation (what serde-wasm-bindgen
        // and serde_json produce): unit → "Name", others → { Name: payload }.
        Enum(variants) => {
            let alts: Vec<_> = variants
                .iter()
                .map(|v| variant_ts(&rename(t.name, v.name), v.ty, named, seen))
                .collect();
            format!("export type {id} =\n  | {};", alts.join("\n  | "))
        }
        NewtypeStruct(inner) => format!("export type {id} = {};", ts_ref(inner, named, seen)),
        _ => format!("export type {id} = {};", ts_ref(t, named, seen)),
    };
    named.insert(id, body);
}

fn main() {
    let mut named = BTreeMap::new();
    let mut seen = BTreeSet::new();
    let mut endpoints = vec![];
    let mut topics = vec![];

    // Emit every named type reachable from an endpoint or topic, then the endpoint
    // and topic maps. The client dispatches by key; the SDK needs the type names,
    // which come from the per-endpoint `Endpoint` impls below.
    macro_rules! ep {
        ($($e:ident),* $(,)?) => {$(
            {
                let req = ts_ref(<probe_rs_rpc::$e as postcard_rpc::Endpoint>::Request::SCHEMA, &mut named, &mut seen);
                let resp = ts_ref(<probe_rs_rpc::$e as postcard_rpc::Endpoint>::Response::SCHEMA, &mut named, &mut seen);
                endpoints.push((<probe_rs_rpc::$e as postcard_rpc::Endpoint>::PATH, req, resp));
            }
        )*};
    }
    macro_rules! tp {
        ($($t:ident),* $(,)?) => {$(
            {
                let msg = ts_ref(<probe_rs_rpc::$t as postcard_rpc::Topic>::Message::SCHEMA, &mut named, &mut seen);
                topics.push((<probe_rs_rpc::$t as postcard_rpc::Topic>::PATH, msg));
            }
        )*};
    }
    use postcard_schema::Schema;
    ep!(
        ListProbesEndpoint,
        SelectProbeEndpoint,
        AttachEndpoint,
        HaltCoresEndpoint,
        ResumeCoresEndpoint,
        CoresStatusEndpoint,
        NewFlashLoaderEndpoint,
        BuildEndpoint,
        LoadRegionEndpoint,
        FlashEndpoint,
        EraseAllEndpoint,
        EraseRangeEndpoint,
        VerifyEndpoint,
        BootEndpoint,
        MonitorEndpoint,
        TakeStackTraceEndpoint,
        TakeRichStackTraceEndpoint,
        ScopesEndpoint,
        VariablesEndpoint,
        EvaluateEndpoint,
        SetVariableEndpoint,
        LoadDebugInfoEndpoint,
        ResolveSourceBreakpointsEndpoint,
        ResolveSourceLocationsEndpoint,
        ClearCoreDebugStateEndpoint,
        LoadSvdEndpoint,
        CreateRttClientEndpoint,
        RttDownEndpoint,
        GetRttChannelsEndpoint,
        PollRttUpEndpoint,
        CleanUpRttEndpoint,
        ClearRttControlBlockEndpoint,
        ListTestsEndpoint,
        RunTestEndpoint,
        TestKickoffEndpoint,
        CreateTempFileEndpoint,
        TempFileDataEndpoint,
        ListChipFamiliesEndpoint,
        ChipInfoEndpoint,
        LoadChipFamilyEndpoint,
        TargetMetadataEndpoint,
        TargetInfoEndpoint,
        ResetCoreEndpoint,
        ResetCoreAndHaltEndpoint,
        CoreStatusEndpoint,
        CoreHaltEndpoint,
        CoreRunEndpoint,
        CoreStepEndpoint,
        CoreWriteRegEndpoint,
        CoreSetHwBpsEndpoint,
        CoreClearHwBpsEndpoint,
        CoreEnableVcEndpoint,
        CoreMetadataEndpoint,
        CoreReadRegistersEndpoint,
        CoreDumpEndpoint,
        HandleSemihostingEndpoint,
        DisassembleEndpoint,
        ReadMemory8Endpoint,
        ReadMemory16Endpoint,
        ReadMemory32Endpoint,
        ReadMemory64Endpoint,
        ReadBytesEndpoint,
        WriteMemory8Endpoint,
        WriteMemory16Endpoint,
        WriteMemory32Endpoint,
        WriteMemory64Endpoint,
    );
    tp!(
        CancelTopic,
        TargetInfoDataTopic,
        ProgressEventTopic,
        RttTopic,
        SemihostingTopic
    );

    // Where each named type appears at the top level of an endpoint or topic, for its
    // doc comment.
    let mut used_by: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for (path, req, resp) in &endpoints {
        used_by
            .entry(req.as_str())
            .or_default()
            .push(format!("`{path}` request"));
        used_by
            .entry(resp.as_str())
            .or_default()
            .push(format!("`{path}` response"));
    }
    for (path, msg) in &topics {
        used_by
            .entry(msg.as_str())
            .or_default()
            .push(format!("`{path}` topic"));
    }

    println!("// Generated from probe-rs-rpc's postcard-schema by tools/wire-gen. Do not edit.");
    println!(
        "// Boundary contract (serde-wasm-bindgen): externally tagged enums; u64/i64 as bigint\n// (serialize_large_number_types_as_bigints); None/unit as null (serialize_missing_as_null);\n// Vec<u8> as Array<number>.\n"
    );
    println!(
        "/**\n * Wire types of the probe-rs RPC protocol, generated from probe-rs-rpc. Most code uses\n * the SDK's own types; these appear where the SDK passes wire values through.\n *\n * @packageDocumentation\n */\n"
    );
    for (id, body) in &named {
        match used_by.get(id.as_str()) {
            Some(uses) => println!("/** probe-rs-rpc `{id}`: {}. */", uses.join(", ")),
            None => println!("/** probe-rs-rpc `{id}`. */"),
        }
        println!("{body}\n");
    }
    println!("/** Every RPC endpoint by path, with its request and response types. */");
    println!("export interface Endpoints {{");
    for (path, req, resp) in &endpoints {
        println!("  \"{path}\": {{ request: {req}; response: {resp} }};");
    }
    println!(
        "}}\n\n/** Every RPC topic by path, with its message type. */\nexport interface Topics {{"
    );
    for (path, msg) in &topics {
        println!("  \"{path}\": {msg};");
    }
    println!("}}");
    eprintln!(
        "types: {}, endpoints: {}, topics: {}",
        named.len(),
        endpoints.len(),
        topics.len()
    );
}

#[cfg(test)]
mod tests {
    use super::rename;
    use probe_rs_rpc::format::{EspFlashFrequency, EspFlashMode};
    use probe_rs_rpc::rtt_config::RttChannelConfig;

    /// `RENAME_ALL` must agree with serde: the same variant or field name, renamed by the
    /// generator and serialized by serde, has to come out identical.
    #[test]
    fn rename_all_matches_serde() {
        let mode = serde_json::to_value(EspFlashMode::Qio).unwrap();
        assert_eq!(mode, rename("EspFlashMode", "Qio"));

        // Per-item renames win over `rename_all`; postcard-schema reports "40MHz".
        let freq = serde_json::to_value(EspFlashFrequency::_40Mhz).unwrap();
        assert_eq!(freq, rename("EspFlashFrequency", "40MHz"));

        let config = serde_json::to_value(RttChannelConfig::default()).unwrap();
        let keys: Vec<_> = config.as_object().unwrap().keys().cloned().collect();
        assert!(keys.contains(&rename("RttChannelConfig", "channel_number")));
        assert!(keys.contains(&rename("RttChannelConfig", "data_format")));
    }
}

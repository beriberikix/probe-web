//! Writing a coredump file that native `probe-rs` can open.
//!
//! `core/dump` gives us registers and memory over the wire; turning that into a *file*
//! means matching the encoding `probe_rs::CoreDump::store` produces, which is
//! `rmp_serde::encode::write_named` over a plain `derive(Serialize)` struct
//! (`probe-rs/src/core/dump.rs`). Encoding it here rather than in TypeScript avoids
//! adding a MessagePack library to the client and hand-writing the same field names in a
//! second language.
//!
//! Most field *types* are the wire types unchanged, because the RPC schema's mirrors
//! serialize identically to probe-rs's own: `WireRegisterId` is a newtype over `u16` like
//! `RegisterId` (which is `#[serde(transparent)]`, same encoding); `WireRegisterValue`
//! has the same three variants as `RegisterValue`, so both encode as `{"U32": …}`; and
//! `InstructionSet` carries no rename, so `Thumb2` is written as-is. Reusing them keeps
//! this file from becoming a second, drifting copy of probe-rs's types.
//!
//! `CoreType` is the exception: probe-rs declares it `#[serde(rename_all = "snake_case")]`,
//! so it reads `"armv8m"`, while the wire enum has no rename and would write `"Armv8m"`,
//! which probe-rs rejects (`unknown variant Armv8m`). The names below are therefore spelled
//! out.
//!
//! Using the wire types also avoids a version skew: the RPC schema follows probe-rs master,
//! while the fork this project builds against is `probe-rs-target` 0.28, whose `CoreType`
//! and `InstructionSet` lack variants the wire can carry (`Armv7r`, `Riscv64`, `RV64`,
//! `RV64C`). Encoding through the older enums would make those dumps unrepresentable.
//!
//! The coupling to probe-rs's field names is real, so it is checked rather than assumed:
//! `cargo run -p probe-web-local --example check-coredump -- <file>` opens a file we wrote
//! using probe-rs's own `CoreDump::load_raw`.

use probe_rs_rpc::core_ops::{
    WireCoreDump, WireCoreType, WireInstructionSet, WireRegisterId, WireRegisterValue,
};
use serde::Serialize;
use serde::ser::SerializeMap;
use std::ops::Range;

/// probe-rs holds the registers in a `HashMap`, which MessagePack writes as a map. The
/// wire carries them as pairs and `WireRegisterId` implements neither `Hash` nor `Ord`,
/// so the map is written straight from the pairs rather than built into a collection
/// first.
struct Registers(Vec<(WireRegisterId, WireRegisterValue)>);

impl Serialize for Registers {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (id, value) in &self.0 {
            map.serialize_entry(id, value)?;
        }
        map.end()
    }
}

/// The name `probe-rs` reads for a core type, which is its variant in `snake_case`.
fn core_type_name(core_type: WireCoreType) -> &'static str {
    match core_type {
        WireCoreType::Armv6m => "armv6m",
        WireCoreType::Armv7a => "armv7a",
        WireCoreType::Armv7r => "armv7r",
        WireCoreType::Armv7m => "armv7m",
        WireCoreType::Armv7em => "armv7em",
        WireCoreType::Armv8a => "armv8a",
        WireCoreType::Armv8m => "armv8m",
        WireCoreType::Riscv => "riscv",
        WireCoreType::Riscv64 => "riscv64",
        WireCoreType::Xtensa => "xtensa",
    }
}

/// The shape of `probe_rs::CoreDump`. Field names and order are what `write_named`
/// writes, so they follow `probe-rs/src/core/dump.rs`.
#[derive(Serialize)]
struct CoreDump {
    registers: Registers,
    data: Vec<(Range<u64>, Vec<u8>)>,
    instruction_set: WireInstructionSet,
    supports_native_64bit_access: bool,
    core_type: &'static str,
    fpu_support: bool,
    /// probe-rs declares this `Option<usize>`; MessagePack writes either as an integer.
    floating_point_register_count: Option<u64>,
}

/// Encode a dump as the MessagePack file `probe-rs` reads.
pub fn encode(dump: WireCoreDump) -> Result<Vec<u8>, rmp_serde::encode::Error> {
    let dump = CoreDump {
        registers: Registers(dump.registers),
        data: dump.data,
        instruction_set: dump.instruction_set,
        supports_native_64bit_access: dump.supports_native_64bit_access,
        core_type: core_type_name(dump.core_type),
        fpu_support: dump.fpu_support,
        floating_point_register_count: dump.floating_point_register_count,
    };
    let mut bytes = Vec::new();
    rmp_serde::encode::write_named(&mut bytes, &dump)?;
    Ok(bytes)
}

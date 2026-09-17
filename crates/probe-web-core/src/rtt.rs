//! Per-channel RTT decoding, mirroring `probe-rs run`: `String` channels
//! are UTF-8 text, `Defmt` channels are decoded with the ELF's defmt table,
//! `BinaryLE` channels pass raw bytes through.

use std::collections::HashMap;

use defmt_decoder::{DecodeError, StreamDecoder, Table};
use probe_rs_rpc::rtt_config::{DataFormat, RttChannelConfig};
use serde::Serialize;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RttOutput {
    Text {
        channel: u32,
        text: String,
    },
    Defmt {
        channel: u32,
        lines: Vec<DefmtLine>,
        malformed: bool,
    },
    Bytes {
        channel: u32,
        bytes: Vec<u8>,
    },
}

#[derive(Serialize)]
pub struct DefmtLine {
    pub level: Option<String>,
    pub message: String,
    pub location: Option<String>,
}

enum Decoder {
    Text,
    Bytes,
    Defmt(Box<dyn StreamDecoder>),
    /// Configured as defmt but no ELF table has been provided yet.
    DefmtMissingTable,
}

pub struct RttDecoders {
    configs: Vec<RttChannelConfig>,
    default: RttChannelConfig,
    table: Option<Box<Table>>,
    per_channel: HashMap<u32, Decoder>,
}

impl RttDecoders {
    pub fn new(configs: Vec<RttChannelConfig>, default: RttChannelConfig) -> Self {
        Self {
            configs,
            default,
            table: None,
            per_channel: HashMap::new(),
        }
    }

    pub fn set_elf(&mut self, elf: &[u8]) -> Result<bool, String> {
        let table = Table::parse(elf).map_err(|e| e.to_string())?;
        let has = table.is_some();
        self.table = table.map(Box::new);
        self.per_channel.clear();
        Ok(has)
    }

    fn format_for(&self, channel: u32) -> DataFormat {
        self.configs
            .iter()
            .find(|c| c.channel_number == Some(channel))
            .map(|c| c.data_format)
            .unwrap_or(self.default.data_format)
    }

    pub fn decode(&mut self, channel: u32, bytes: &[u8]) -> RttOutput {
        if !self.per_channel.contains_key(&channel) {
            let d = match self.format_for(channel) {
                DataFormat::String => Decoder::Text,
                DataFormat::BinaryLE => Decoder::Bytes,
                DataFormat::Defmt => match &self.table {
                    // The decoder borrows the table; leak a copy so it can
                    // live in the map without a self-referential struct.
                    Some(t) => {
                        let table: &'static Table = Box::leak(t.clone());
                        Decoder::Defmt(table.new_stream_decoder())
                    }
                    None => Decoder::DefmtMissingTable,
                },
            };
            self.per_channel.insert(channel, d);
        }
        match self.per_channel.get_mut(&channel).unwrap() {
            Decoder::Text => RttOutput::Text {
                channel,
                text: String::from_utf8_lossy(bytes).into_owned(),
            },
            Decoder::Bytes | Decoder::DefmtMissingTable => RttOutput::Bytes {
                channel,
                bytes: bytes.to_vec(),
            },
            Decoder::Defmt(dec) => {
                dec.received(bytes);
                let mut lines = vec![];
                let mut malformed = false;
                loop {
                    match dec.decode() {
                        Ok(frame) => lines.push(DefmtLine {
                            level: frame.level().map(|l| l.as_str().to_string()),
                            message: frame.display_message().to_string(),
                            location: None,
                        }),
                        Err(DecodeError::UnexpectedEof) => break,
                        Err(DecodeError::Malformed) => {
                            malformed = true;
                            break;
                        }
                    }
                }
                RttOutput::Defmt {
                    channel,
                    lines,
                    malformed,
                }
            }
        }
    }
}

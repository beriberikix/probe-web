//! The failures a user can actually do something about.
//!
//! Importing a pack fails for mundane reasons — the wrong file was picked, the pack is
//! compressed with something we left out, the `.FLM` is not a flash algorithm — and the
//! UI should say which. Carrying that as a typed value rather than a message means the
//! page can switch on it; `probe-web-core` has the same rule, where every error reaching
//! JS gets a `kind` property so callers never parse strings.
//!
//! These attach as `anyhow` context, so each one is both the machine-readable kind and
//! the sentence the user reads.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    /// The bytes are not a zip archive, or use a compression method we do not carry.
    BadArchive,
    /// A zip, but with no `.pdsc` description in it — so probably not a CMSIS pack.
    NoPdsc,
    /// The `.pdsc` is there but did not parse.
    BadPdsc,
    /// The `.FLM` is not a readable ELF.
    BadElf,
    /// A readable ELF with no `FlashDevice` symbol, so not a CMSIS flash algorithm.
    NoFlashDevice,
}

impl Fault {
    /// The `kind` property the error carries into JS.
    pub fn kind(self) -> &'static str {
        match self {
            Fault::BadArchive => "bad-archive",
            Fault::NoPdsc => "no-pdsc",
            Fault::BadPdsc => "bad-pdsc",
            Fault::BadElf => "bad-elf",
            Fault::NoFlashDevice => "no-flash-device",
        }
    }

    /// Pick the fault out of an error, if one was attached.
    ///
    /// `anyhow::Error::downcast_ref` is what searches here, not `chain()`: a fault added
    /// with `.context(..)` is held inside anyhow's own context wrapper, so it is never a
    /// chain item and iterating the chain finds nothing.
    pub fn of(error: &anyhow::Error) -> Option<Fault> {
        error.downcast_ref::<Fault>().copied()
    }
}

impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Fault::BadArchive => {
                "this file is not a readable .pack archive (a pack is a zip; zstd- and \
                 bzip2-compressed entries are not supported)"
            }
            Fault::NoPdsc => "this archive has no .pdsc description, so it is not a CMSIS pack",
            Fault::BadPdsc => "the pack's .pdsc description did not parse",
            Fault::BadElf => "this file is not a readable ELF, so it is not a .FLM flash algorithm",
            Fault::NoFlashDevice => {
                "this ELF has no 'FlashDevice' symbol, so it is not a CMSIS flash algorithm"
            }
        };
        f.write_str(message)
    }
}

impl std::error::Error for Fault {}

#[cfg(test)]
mod tests {
    use super::Fault;
    use anyhow::Context as _;

    /// `flm.rs` adds a plain string context *after* the fault, so the fault is buried.
    /// It still has to be findable — this is the composition that made an earlier
    /// `chain()`-based lookup silently return nothing.
    #[test]
    fn a_fault_survives_later_context() {
        let error = anyhow::Error::from(Fault::NoFlashDevice)
            .context("Failed to extract flash information from ELF file 'x.FLM'.");
        assert_eq!(Fault::of(&error), Some(Fault::NoFlashDevice));

        // And the one-line rendering a UI shows keeps both halves.
        let rendered = format!("{error:#}");
        assert!(rendered.contains("x.FLM"), "{rendered}");
        assert!(rendered.contains("FlashDevice"), "{rendered}");
    }

    #[test]
    fn an_untagged_error_has_no_fault() {
        let error = anyhow::anyhow!("something else went wrong");
        assert_eq!(Fault::of(&error), None);
    }
}

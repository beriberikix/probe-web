//! A small `embedded-test` suite, so the browser test runner has something real to drive.
//!
//! The outcomes are deliberately mixed. A runner that only ever sees passing tests proves
//! very little: this suite contains tests that pass, one that is *expected* to panic, and
//! one marked `#[ignore]`, because reporting all three correctly is the actual
//! requirement. `adds_up_slowly` exists to take visibly longer than the others, so a
//! per-test duration that is obviously wrong shows up.

#![no_std]
#![no_main]

// embedded-test supplies `main`, so nothing here references cortex-m-rt by name — but its
// reset handler and vector table are still what boots the chip, and an rlib whose symbols
// are never mentioned is not linked at all (the tell is `symbol not found:
// DefaultHandler_` from cortex-m-rt's own linker script).
use cortex_m_rt as _;

#[cfg(test)]
#[embedded_test::tests]
mod tests {
    /// Runs before each test; its return value is passed to any test that takes an argument.
    #[init]
    fn init() -> u32 {
        // A value the tests can check, proving the fixture reached them.
        0xC0FFEE
    }

    #[test]
    fn arithmetic_works() {
        assert_eq!(2 + 2, 4);
    }

    #[test]
    fn the_fixture_is_passed_in(value: u32) {
        assert_eq!(value, 0xC0FFEE);
    }

    #[test]
    fn adds_up_slowly() {
        // Enough work to be measurable without being slow; `black_box` stops the
        // optimiser folding the whole thing away at opt-level 1.
        let mut total: u32 = 0;
        for i in 0..200_000u32 {
            total = total.wrapping_add(core::hint::black_box(i));
        }
        assert_ne!(total, 0);
    }

    /// The runner must report a panicking test that is *expected* to panic as a pass.
    #[test]
    #[should_panic]
    fn panics_as_expected() {
        panic!("this panic is the point");
    }

    /// And it must report an ignored test as ignored, without running it.
    #[test]
    #[ignore]
    fn skipped_entirely() {
        panic!("an ignored test must never run");
    }
}

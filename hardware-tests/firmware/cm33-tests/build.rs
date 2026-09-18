use std::{env, fs, path::PathBuf};
fn main() {
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let memory = if env::var_os("CARGO_FEATURE_NRF9160").is_some() {
        // nRF9160: 1 MiB flash, 256 KiB RAM; runs as the secure image after a full erase.
        "MEMORY { FLASH : ORIGIN = 0x00000000, LENGTH = 1M\n RAM : ORIGIN = 0x20000000, LENGTH = 256K }\n"
    } else if env::var_os("CARGO_FEATURE_MCXA153").is_some() {
        // FRDM-MCXA153: 128 KiB flash, 24 KiB SRAM.
        "MEMORY { FLASH : ORIGIN = 0x00000000, LENGTH = 128K\n RAM : ORIGIN = 0x20000000, LENGTH = 24K }\n"
    } else {
        panic!("enable feature `mcxa153` or `nrf9160`");
    };
    fs::write(out.join("memory.x"), memory).unwrap();
    // embedded-test ships its own linker script, which redirects the harness entry point;
    // without it the build fails with a deliberate "linker file was not added" error.
    println!("cargo::rustc-link-arg-tests=-Tembedded-test.x");
    println!("cargo:rustc-link-search={}", out.display());
    println!("cargo:rerun-if-changed=build.rs");
}

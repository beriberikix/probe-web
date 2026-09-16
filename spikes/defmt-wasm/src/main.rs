fn main() {
    let args: Vec<String> = std::env::args().collect();
    let elf = std::fs::read(&args[1]).expect("elf");
    let stream = std::fs::read(&args[2]).expect("stream");
    match spike_defmt_wasm::decode_all(&elf, &stream) {
        Ok(s) => print!("{s}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1)
        }
    }
}

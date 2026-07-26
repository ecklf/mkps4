fn main() {
    if let Err(error) = mkps4::run() {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

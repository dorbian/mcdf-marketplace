fn main() {
    if let Err(error) = mcdf_marketplace_lib::registry_server::run_from_cli() {
        eprintln!("mcdf-registry-server failed: {error}");
        std::process::exit(1);
    }
}

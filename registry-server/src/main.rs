mod mcdf;
mod registry_server;

fn main() {
    if let Err(error) = registry_server::run_from_cli() {
        eprintln!("mcdf-registry-server failed: {error}");
        std::process::exit(1);
    }
}

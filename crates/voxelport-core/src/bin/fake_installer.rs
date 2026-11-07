//! A stand-in for an app installer, used only by the tests: it records that it ran, and with what arguments, in the file named by the
//! `VP_FAKE_INSTALL_MARK` environment variable, then exits like a quiet installer would.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Ok(mark) = std::env::var("VP_FAKE_INSTALL_MARK") {
        let _ = std::fs::write(mark, format!("ran with: {}\n", args.join(" ")));
    }
}

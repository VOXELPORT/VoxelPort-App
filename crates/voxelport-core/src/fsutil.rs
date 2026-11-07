//! Small file helpers shared by the stores.

use std::fs;
use std::io::Write;
use std::path::Path;

/// Writes the whole file or leaves the old one alone: a temp file beside it, flushed to disk, then renamed over.
/// (On Windows `rename` replaces an existing file.) Same idea as `atomicWriteFileSync` in the Electron app.
pub fn atomic_write(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut nonce = [0u8; 4];
    let _ = getrandom::getrandom(&mut nonce);
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = file.with_file_name(format!("{name}.tmp-{}", nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

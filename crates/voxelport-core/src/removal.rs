//! When a server's whole folder may be moved to the Recycle Bin. Ported from `serverRemoval.js`.
//!
//! A server can be imported from anywhere, so before any folder is touched it has to be clearly a server folder and
//! clearly not somewhere the person keeps other things. Anything doubtful means "only take it off the list".

use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// A drive root or a top-level folder.
    TooBroad,
    /// It is, or holds, a folder that must never go (home, Desktop, the app's own data...).
    Protected,
    /// Another saved server uses this folder, or one inside it, or sits around it.
    Shared,
    NotAServer,
    Missing,
    NotAFolder,
}

impl Refusal {
    /// The words the screens and the dialog key on (same as Electron's).
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::TooBroad => "too-broad",
            Refusal::Protected => "protected",
            Refusal::Shared => "shared",
            Refusal::NotAServer => "not-a-server",
            Refusal::Missing => "missing",
            Refusal::NotAFolder => "not-a-folder",
        }
    }
}

/// The path with `.` and `..` resolved by reading it, not by asking the disk (like `path.resolve` for an absolute path).
fn normalize(p: &Path) -> Vec<Component<'_>> {
    let mut out: Vec<Component> = Vec::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.last(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other),
        }
    }
    out
}

fn key(c: &Component) -> String {
    let s = c.as_os_str().to_string_lossy().into_owned();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

fn keys(p: &Path) -> Vec<String> {
    normalize(p).iter().map(key).collect()
}

fn same_path(a: &Path, b: &Path) -> bool {
    keys(a) == keys(b)
}

/// `child` is strictly inside `parent`.
fn is_inside(child: &Path, parent: &Path) -> bool {
    let (c, p) = (keys(child), keys(parent));
    c.len() > p.len() && c[..p.len()] == p[..]
}

/// Whether `dir` may be moved to the Recycle Bin. `keep` lists folders that must never be deleted, nor any folder that
/// holds one of them. `other_server_dirs` are the folders of the other saved servers.
pub fn check_deletable(dir: &Path, keep: &[PathBuf], other_server_dirs: &[PathBuf]) -> Result<(), Refusal> {
    if !dir.is_absolute() {
        return Err(Refusal::NotAFolder);
    }
    let parts = normalize(dir);
    let depth = parts.iter().filter(|c| matches!(c, Component::Prefix(_) | Component::Normal(_))).count();
    let only_normal = parts.iter().filter(|c| matches!(c, Component::Normal(_))).count();
    if depth < 2 || only_normal == 0 {
        return Err(Refusal::TooBroad);
    }
    for k in keep {
        if same_path(dir, k) || is_inside(k, dir) {
            return Err(Refusal::Protected);
        }
    }
    for other in other_server_dirs {
        if same_path(dir, other) || is_inside(other, dir) || is_inside(dir, other) {
            return Err(Refusal::Shared);
        }
    }
    let meta = fs::metadata(dir).map_err(|_| Refusal::Missing)?;
    if !meta.is_dir() {
        return Err(Refusal::NotAFolder);
    }
    let names: Vec<String> = fs::read_dir(dir).map_err(|_| Refusal::NotAFolder)?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    // It must look like a Minecraft server: a server.properties, or a jar next to a world or logs.
    let looks_like_server = names.iter().any(|n| n == "server.properties") || (names.iter().any(|n| n.to_lowercase().ends_with(".jar")) && names.iter().any(|n| matches!(n.as_str(), "world" | "logs" | "eula.txt")));
    if looks_like_server { Ok(()) } else { Err(Refusal::NotAServer) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server_dir(parent: &Path, name: &str) -> PathBuf {
        let d = parent.join(name);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("server.properties"), "x").unwrap();
        d
    }

    #[test]
    fn a_normal_server_folder_may_go() {
        let root = tempfile::tempdir().unwrap();
        let d = server_dir(root.path(), "srv");
        assert_eq!(check_deletable(&d, &[], &[]), Ok(()));
    }

    #[test]
    fn relative_roots_and_top_level_folders_are_too_broad() {
        assert_eq!(check_deletable(Path::new("srv"), &[], &[]), Err(Refusal::NotAFolder));
        let root = if cfg!(windows) { PathBuf::from("C:\\") } else { PathBuf::from("/") };
        assert_eq!(check_deletable(&root, &[], &[]), Err(Refusal::TooBroad));
        if !cfg!(windows) {
            assert_eq!(check_deletable(Path::new("/home"), &[], &[]), Err(Refusal::TooBroad));
        }
    }

    #[test]
    fn protected_folders_and_anything_that_holds_one_are_kept() {
        let root = tempfile::tempdir().unwrap();
        let d = server_dir(root.path(), "srv");
        let home = d.join("nested-home");
        fs::create_dir_all(&home).unwrap();
        assert_eq!(check_deletable(&d, &[d.clone()], &[]), Err(Refusal::Protected));
        assert_eq!(check_deletable(&d, &[home], &[]), Err(Refusal::Protected), "it holds a protected folder");
        assert_eq!(check_deletable(&d, &[PathBuf::from(root.path()).join("elsewhere")], &[]), Ok(()));
    }

    #[test]
    fn a_folder_another_saved_server_uses_or_holds_is_shared() {
        let root = tempfile::tempdir().unwrap();
        let outer = server_dir(root.path(), "outer");
        let inner = server_dir(&outer, "inner");
        assert_eq!(check_deletable(&outer, &[], &[outer.clone()]), Err(Refusal::Shared));
        assert_eq!(check_deletable(&outer, &[], &[inner.clone()]), Err(Refusal::Shared), "another server lives inside");
        assert_eq!(check_deletable(&inner, &[], &[outer]), Err(Refusal::Shared), "this one lives inside another");
    }

    #[test]
    fn dotdot_cannot_dodge_the_checks() {
        let root = tempfile::tempdir().unwrap();
        let d = server_dir(root.path(), "srv");
        let sneaky = d.join("sub").join("..");
        fs::create_dir_all(d.join("sub")).unwrap();
        assert_eq!(check_deletable(&sneaky, &[d.clone()], &[]), Err(Refusal::Protected));
    }

    #[test]
    fn missing_files_and_non_server_folders_are_refused() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(check_deletable(&root.path().join("gone"), &[], &[]), Err(Refusal::Missing));
        let file = root.path().join("a-file");
        fs::write(&file, "x").unwrap();
        assert_eq!(check_deletable(&file, &[], &[]), Err(Refusal::NotAFolder));
        let docs = root.path().join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("notes.txt"), "x").unwrap();
        assert_eq!(check_deletable(&docs, &[], &[]), Err(Refusal::NotAServer));
        fs::write(docs.join("paper.jar"), "x").unwrap();
        assert_eq!(check_deletable(&docs, &[], &[]), Err(Refusal::NotAServer), "a jar alone is not enough");
        fs::create_dir(docs.join("world")).unwrap();
        assert_eq!(check_deletable(&docs, &[], &[]), Ok(()), "a jar next to a world is");
    }

    #[test]
    fn the_reason_words_match_electrons() {
        let all = [Refusal::TooBroad, Refusal::Protected, Refusal::Shared, Refusal::NotAServer, Refusal::Missing, Refusal::NotAFolder];
        assert_eq!(all.map(Refusal::as_str), ["too-broad", "protected", "shared", "not-a-server", "missing", "not-a-folder"]);
    }
}

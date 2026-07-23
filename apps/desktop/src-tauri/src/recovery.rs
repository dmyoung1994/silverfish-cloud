use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;
use walkdir::WalkDir;

const MAX_CHECKPOINT_BYTES: u64 = 1024 * 1024 * 1024;
const EXCLUDED_NAMES: &[&str] = &[".git", "node_modules", "target", "dist", ".build", ".cache"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPoint {
    pub checkpoint_id: Uuid,
    pub workspace: PathBuf,
    pub created_at_ms: u64,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    point: RecoveryPoint,
    entries: Vec<Entry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Entry {
    path: PathBuf,
    kind: EntryKind,
    blob: Option<String>,
    symlink_target: Option<PathBuf>,
    mode: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum EntryKind {
    File,
    Directory,
    Symlink,
}

#[derive(Debug, Error)]
pub enum RecoveryError {
    #[error("workspace must be an existing directory")]
    InvalidWorkspace,
    #[error("checkpoint exceeds the 1 GiB safety limit")]
    TooLarge,
    #[error("unsafe path in recovery manifest")]
    UnsafePath,
    #[error("checkpoint not found")]
    NotFound,
    #[error("recovery I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("recovery manifest is invalid: {0}")]
    Json(#[from] serde_json::Error),
}

pub fn create(app_data: &Path, workspace: &Path) -> Result<RecoveryPoint, RecoveryError> {
    let workspace = workspace
        .canonicalize()
        .map_err(|_| RecoveryError::InvalidWorkspace)?;
    if !workspace.is_dir() {
        return Err(RecoveryError::InvalidWorkspace);
    }
    let recovery_root = recovery_root(app_data, &workspace);
    let blob_root = app_data.join("recovery").join("blobs");
    fs::create_dir_all(&recovery_root)?;
    fs::create_dir_all(&blob_root)?;

    let mut entries = Vec::new();
    let mut total_bytes = 0_u64;
    for item in WalkDir::new(&workspace)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_excluded(entry.path(), &workspace))
    {
        let item = item.map_err(|error| RecoveryError::Io(error.into()))?;
        if item.path() == workspace {
            continue;
        }
        let relative = item
            .path()
            .strip_prefix(&workspace)
            .map_err(|_| RecoveryError::UnsafePath)?
            .to_path_buf();
        ensure_safe_relative(&relative)?;
        let metadata = fs::symlink_metadata(item.path())?;
        let mode = unix_mode(&metadata);
        if metadata.file_type().is_symlink() {
            entries.push(Entry {
                path: relative,
                kind: EntryKind::Symlink,
                blob: None,
                symlink_target: Some(fs::read_link(item.path())?),
                mode,
            });
        } else if metadata.is_dir() {
            entries.push(Entry {
                path: relative,
                kind: EntryKind::Directory,
                blob: None,
                symlink_target: None,
                mode,
            });
        } else if metadata.is_file() {
            total_bytes = total_bytes.saturating_add(metadata.len());
            if total_bytes > MAX_CHECKPOINT_BYTES {
                return Err(RecoveryError::TooLarge);
            }
            let bytes = fs::read(item.path())?;
            let digest = hex_digest(&bytes);
            let blob_path = blob_root.join(&digest);
            if !blob_path.exists() {
                let temporary = blob_root.join(format!(".{digest}.{}", Uuid::new_v4()));
                fs::write(&temporary, &bytes)?;
                match fs::rename(&temporary, &blob_path) {
                    Ok(()) => {}
                    Err(error) if blob_path.exists() => {
                        let _ = fs::remove_file(temporary);
                        let _ = error;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            entries.push(Entry {
                path: relative,
                kind: EntryKind::File,
                blob: Some(digest),
                symlink_target: None,
                mode,
            });
        }
    }

    let point = RecoveryPoint {
        checkpoint_id: Uuid::new_v4(),
        workspace,
        created_at_ms: now_ms(),
        file_count: entries
            .iter()
            .filter(|entry| entry.kind == EntryKind::File)
            .count(),
        total_bytes,
    };
    let manifest = Manifest {
        point: point.clone(),
        entries,
    };
    let checkpoint_dir = recovery_root.join(point.checkpoint_id.to_string());
    fs::create_dir_all(&checkpoint_dir)?;
    fs::write(
        checkpoint_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    prune(&recovery_root, 20)?;
    Ok(point)
}

pub fn restore(
    app_data: &Path,
    workspace: &Path,
    checkpoint_id: Uuid,
) -> Result<RecoveryPoint, RecoveryError> {
    let workspace = workspace
        .canonicalize()
        .map_err(|_| RecoveryError::InvalidWorkspace)?;
    let manifest_path = recovery_root(app_data, &workspace)
        .join(checkpoint_id.to_string())
        .join("manifest.json");
    let manifest: Manifest = serde_json::from_slice(&fs::read(manifest_path).map_err(
        |error| match error.kind() {
            std::io::ErrorKind::NotFound => RecoveryError::NotFound,
            _ => RecoveryError::Io(error),
        },
    )?)?;
    if manifest.point.workspace != workspace {
        return Err(RecoveryError::UnsafePath);
    }
    let expected: HashSet<PathBuf> = manifest
        .entries
        .iter()
        .map(|entry| entry.path.clone())
        .collect();
    for item in WalkDir::new(&workspace)
        .min_depth(1)
        .contents_first(true)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_excluded(entry.path(), &workspace))
    {
        let item = item.map_err(|error| RecoveryError::Io(error.into()))?;
        let relative = item
            .path()
            .strip_prefix(&workspace)
            .map_err(|_| RecoveryError::UnsafePath)?;
        if !expected.contains(relative) {
            let metadata = fs::symlink_metadata(item.path())?;
            if metadata.is_dir() {
                fs::remove_dir(item.path())?;
            } else {
                fs::remove_file(item.path())?;
            }
        }
    }
    for entry in &manifest.entries {
        ensure_safe_relative(&entry.path)?;
        let destination = workspace.join(&entry.path);
        match entry.kind {
            EntryKind::Directory => fs::create_dir_all(&destination)?,
            EntryKind::File => {
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)?;
                }
                let blob = entry.blob.as_ref().ok_or(RecoveryError::UnsafePath)?;
                fs::copy(
                    app_data.join("recovery").join("blobs").join(blob),
                    &destination,
                )?;
            }
            EntryKind::Symlink => restore_symlink(
                &destination,
                entry
                    .symlink_target
                    .as_ref()
                    .ok_or(RecoveryError::UnsafePath)?,
            )?,
        }
        apply_unix_mode(&destination, entry.mode)?;
    }
    Ok(manifest.point)
}

fn recovery_root(app_data: &Path, workspace: &Path) -> PathBuf {
    app_data
        .join("recovery")
        .join("workspaces")
        .join(hex_digest(workspace.to_string_lossy().as_bytes()))
}

fn is_excluded(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .and_then(|relative| relative.components().next())
        .and_then(|component| match component {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .is_some_and(|name| EXCLUDED_NAMES.contains(&name))
}

fn ensure_safe_relative(path: &Path) -> Result<(), RecoveryError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        Err(RecoveryError::UnsafePath)
    } else {
        Ok(())
    }
}

fn prune(root: &Path, keep: usize) -> Result<(), RecoveryError> {
    let mut checkpoints: Vec<_> = fs::read_dir(root)?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .collect();
    checkpoints.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    let remove_count = checkpoints.len().saturating_sub(keep);
    for entry in checkpoints.into_iter().take(remove_count) {
        fs::remove_dir_all(entry.path())?;
    }
    Ok(())
}

fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(unix)]
fn unix_mode(metadata: &fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    Some(metadata.mode())
}

#[cfg(not(unix))]
fn unix_mode(_: &fs::Metadata) -> Option<u32> {
    None
}

#[cfg(unix)]
fn apply_unix_mode(path: &Path, mode: Option<u32>) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn apply_unix_mode(_: &Path, _: Option<u32>) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(unix)]
fn restore_symlink(path: &Path, target: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::symlink;
    if fs::symlink_metadata(path).is_ok() {
        let _ = fs::remove_file(path);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    symlink(target, path)
}

#[cfg(not(unix))]
fn restore_symlink(_: &Path, _: &Path) -> Result<(), std::io::Error> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlink restore is not supported on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_paths() {
        assert!(ensure_safe_relative(Path::new("src/lib.rs")).is_ok());
        assert!(ensure_safe_relative(Path::new("../outside")).is_err());
        assert!(ensure_safe_relative(Path::new("/outside")).is_err());
    }

    #[test]
    fn checkpoint_restores_modified_deleted_and_added_files() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app-data");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/lib.rs"), "original").unwrap();
        fs::write(workspace.join("keep.txt"), "keep").unwrap();

        let point = create(&app_data, &workspace).unwrap();
        fs::write(workspace.join("src/lib.rs"), "changed").unwrap();
        fs::remove_file(workspace.join("keep.txt")).unwrap();
        fs::write(workspace.join("new.txt"), "remove me").unwrap();

        restore(&app_data, &workspace, point.checkpoint_id).unwrap();
        assert_eq!(
            fs::read_to_string(workspace.join("src/lib.rs")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_to_string(workspace.join("keep.txt")).unwrap(),
            "keep"
        );
        assert!(!workspace.join("new.txt").exists());
    }
}

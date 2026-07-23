use std::{
    fs,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};
use uuid::Uuid;

pub fn append(
    app_data: &Path,
    room_id: Uuid,
    sequence: u64,
    event: Value,
) -> Result<(), std::io::Error> {
    let directory = app_data.join("audit");
    fs::create_dir_all(&directory)?;
    set_owner_only_directory(&directory)?;
    let path = directory.join(format!("{room_id}.jsonl"));
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    set_owner_only_file(&path)?;
    let record = json!({
        "recordedAtMs": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        "roomId": room_id,
        "sequence": sequence,
        "event": event,
    });
    serde_json::to_writer(&mut file, &record)?;
    file.write_all(b"\n")?;
    file.flush()
}

#[cfg(unix)]
fn set_owner_only_directory(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_owner_only_directory(_: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_file(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_owner_only_file(_: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

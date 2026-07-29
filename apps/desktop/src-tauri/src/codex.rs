use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use serde_json::{Value, json};
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, broadcast, oneshot},
};

use crate::mcp_bridge::McpBridge;

const MINIMUM_CODEX_VERSION: &str = "0.144.1";
const CODEX_PATH_ENV: &str = "SILVERFISH_CODEX_PATH";
const DCG_INSTALLER_URL: &str =
    "https://raw.githubusercontent.com/Dicklesworthstone/destructive_command_guard/main/install.sh";

#[derive(Debug, Error)]
pub enum CodexError {
    #[error("could not start Codex: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("Codex app-server closed unexpectedly")]
    Closed,
    #[error("Codex returned an error: {0}")]
    Rpc(String),
    #[error("invalid Codex response")]
    InvalidResponse,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, CodexError>>>>>;

pub struct CodexClient {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    events: broadcast::Sender<Value>,
    next_id: AtomicU64,
}

impl CodexClient {
    pub async fn spawn(model: Option<String>, workspace: &str, bridge: McpBridge) -> Result<Arc<Self>, CodexError> {
        let codex_path = find_codex_executable().unwrap_or_else(|| PathBuf::from("codex"));
        let mut command = Command::new(&codex_path);
        command.args(["app-server", "--listen", "stdio://"]);
        for direct_server in project_mcp_servers(workspace) {
            command.args(["-c", &format!("mcp_servers.{direct_server}.enabled=false")]);
        }
        command
            .args(["-c", &format!("mcp_servers.{}.command={:?}", bridge.name, "node")])
            .args(["-c", &format!("mcp_servers.{}.args={:?}", bridge.name, vec![bridge.script.to_string_lossy().to_string()])])
            .args(["-c", &format!("mcp_servers.{}.env={{SILVERFISH_MCP_BRIDGE_CONFIG={:?}}}", bridge.name, bridge.upstream_config.to_string_lossy())])
            .args(["-c", &format!("mcp_servers.{}.enabled=true", bridge.name)])
            .env("CODEX_HOME", bridge.codex_home);
        if let Some(model) = model.filter(|value| value != "default") {
            command.args(["-c", &format!("model={model:?}")]);
        }
        prepend_command_path(
            &mut command,
            [
                codex_path.parent().map(PathBuf::from),
                find_dcg_executable().and_then(|path| path.parent().map(PathBuf::from)),
            ]
            .into_iter()
            .flatten(),
        );
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let stdin = child.stdin.take().ok_or(CodexError::Closed)?;
        let stdout = child.stdout.take().ok_or(CodexError::Closed)?;
        let (events, _) = broadcast::channel(1024);
        let client = Arc::new(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: Arc::new(Mutex::new(HashMap::new())),
            events,
            next_id: AtomicU64::new(1),
        });

        Self::spawn_reader(stdout, client.pending.clone(), client.events.clone());
        client
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "silverfish_collaborative",
                        "title": "Silverfish",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": true
                    }
                }),
            )
            .await?;
        client.notify("initialized", json!({})).await?;
        Ok(client)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    pub async fn list_threads(&self, cwd: Option<String>) -> Result<Value, CodexError> {
        self.request(
            "thread/list",
            json!({
                "limit": 100,
                "sortKey": "updated_at",
                "sortDirection": "desc",
                "archived": false,
                "cwd": cwd
            }),
        )
        .await
    }

    pub async fn read_thread(&self, thread_id: &str) -> Result<Value, CodexError> {
        self.request(
            "thread/read",
            json!({ "threadId": thread_id, "includeTurns": true }),
        )
        .await
    }

    pub async fn start_thread(&self, cwd: &str) -> Result<Value, CodexError> {
        self.request(
            "thread/start",
            json!({
                "cwd": cwd,
                "approvalPolicy": { "granular": {
                    "sandbox_approval": true,
                    "rules": true,
                    "skill_approval": false,
                    "request_permissions": false,
                    "mcp_elicitations": false
                }},
                "approvalsReviewer": "user",
                "sandbox": "workspace-write",
                "serviceName": "Silverfish"
            }),
        )
        .await
    }

    pub async fn resume_thread(&self, thread_id: &str, cwd: &str) -> Result<Value, CodexError> {
        self.request(
            "thread/resume",
            json!({
                "threadId": thread_id,
                "cwd": cwd,
                "approvalPolicy": { "granular": {
                    "sandbox_approval": true,
                    "rules": true,
                    "skill_approval": false,
                    "request_permissions": false,
                    "mcp_elicitations": false
                }},
                "approvalsReviewer": "user",
                "sandbox": "workspace-write"
            }),
        )
        .await
    }

    pub async fn start_turn(&self, thread_id: &str, text: &str) -> Result<Value, CodexError> {
        self.request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": text, "text_elements": [] }]
            }),
        )
        .await
    }

    pub async fn steer(
        &self,
        thread_id: &str,
        turn_id: &str,
        text: &str,
    ) -> Result<Value, CodexError> {
        self.request(
            "turn/steer",
            json!({
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": [{ "type": "text", "text": text, "text_elements": [] }]
            }),
        )
        .await
    }

    pub async fn interrupt(&self, thread_id: &str, turn_id: &str) -> Result<Value, CodexError> {
        self.request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
        )
        .await
    }

    pub async fn resolve_approval(
        &self,
        request_id: Value,
        decision: &str,
    ) -> Result<(), CodexError> {
        let safe_decision = match decision {
            "approveOnce" => "accept",
            "decline" => "decline",
            _ => "cancel",
        };
        self.write_json(&json!({
            "id": request_id,
            "result": { "decision": safe_decision }
        }))
        .await
    }

    pub async fn deny_server_request(&self, request_id: Value) -> Result<(), CodexError> {
        self.write_json(&json!({
            "id": request_id,
            "error": {
                "code": -32601,
                "message": "Silverfish room policy refuses this client request"
            }
        }))
        .await
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, CodexError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        if let Err(error) = self
            .write_json(&json!({ "method": method, "id": id, "params": params }))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        rx.await.map_err(|_| CodexError::Closed)?
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), CodexError> {
        self.write_json(&json!({ "method": method, "params": params }))
            .await
    }

    async fn write_json(&self, value: &Value) -> Result<(), CodexError> {
        let mut bytes = serde_json::to_vec(value).map_err(|_| CodexError::InvalidResponse)?;
        bytes.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&bytes).await?;
        stdin.flush().await?;
        Ok(())
    }

    fn spawn_reader(
        stdout: tokio::process::ChildStdout,
        pending: Pending,
        events: broadcast::Sender<Value>,
    ) {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let response_id = value.get("id").and_then(Value::as_u64);
                let is_server_request = value.get("method").is_some();
                if let Some(id) = response_id.filter(|_| !is_server_request) {
                    if let Some(sender) = pending.lock().await.remove(&id) {
                        let result = if let Some(error) = value.get("error") {
                            Err(CodexError::Rpc(error.to_string()))
                        } else {
                            value
                                .get("result")
                                .cloned()
                                .ok_or(CodexError::InvalidResponse)
                        };
                        let _ = sender.send(result);
                    }
                } else {
                    let _ = events.send(value);
                }
            }
            let mut pending = pending.lock().await;
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(CodexError::Closed));
            }
        });
    }
}

fn project_mcp_servers(workspace: &str) -> Vec<String> {
    let config = PathBuf::from(workspace).join(".codex/config.toml");
    let Ok(contents) = std::fs::read_to_string(config) else { return Vec::new(); };
    contents.lines().filter_map(|line| {
        let header = line.trim().strip_prefix("[mcp_servers.")?.strip_suffix(']')?.trim();
        let name = header.strip_prefix('"').and_then(|value| value.strip_suffix('"')).unwrap_or(header);
        name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-').then(|| name.to_owned())
    }).collect()
}

impl Drop for CodexClient {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub compatible: bool,
    pub minimum_version: &'static str,
    pub dcg_installed: bool,
    pub dcg_hook_active: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub name: String,
    pub description: String,
    pub source: String,
}

pub async fn list_skills(workspace: Option<String>, agent: String) -> Result<Vec<AgentSkill>, String> {
    tokio::task::spawn_blocking(move || discover_skills(workspace.as_deref(), &agent))
        .await
        .map_err(|error| error.to_string())
}

pub async fn install_skill_from_github(source: String, workspace: String, agent: String) -> Result<Vec<AgentSkill>, String> {
    let source = source.trim().to_owned();
    if !source.starts_with("https://github.com/") {
        return Err("Enter a GitHub skill URL (https://github.com/owner/repo/tree/ref/path).".into());
    }
    let codex_home = codex_home().ok_or_else(|| "Could not find the host Codex home directory.".to_owned())?;
    let installer = codex_home.join("skills/.system/skill-installer/scripts/install-skill-from-github.py");
    if !installer.is_file() {
        return Err("The host Codex skill installer is unavailable. Update Codex, then try again.".into());
    }
    let output = Command::new("python3")
        .arg(installer)
        .arg("--url")
        .arg(source)
        .arg("--dest")
        .arg(skill_destination(&agent, &workspace)?)
        .env("CODEX_HOME", &codex_home)
        .output()
        .await
        .map_err(|error| format!("Could not start the Codex skill installer: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if detail.is_empty() { "Codex could not install that skill.".into() } else { detail });
    }
    list_skills(Some(workspace), agent).await
}

fn discover_skills(workspace: Option<&str>, agent: &str) -> Vec<AgentSkill> {
    let codex_home = codex_home();
    let claude_home = std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude/skills"));
    let mut roots: Vec<(PathBuf, &str)> = Vec::new();
    if let Some(workspace) = workspace.filter(|value| !value.is_empty()) {
        let workspace = PathBuf::from(workspace);
        if agent == "claude" {
            roots.push((workspace.join(".claude/skills"), "Claude project"));
        } else {
            roots.push((workspace.join(".codex/skills"), "Codex project"));
        }
    }
    if agent == "claude" {
        if let Some(home) = claude_home { roots.push((home, "Claude home")); }
    } else if let Some(home) = codex_home {
        roots.push((home.join("skills"), "Codex home"));
    }

    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    for (root, source) in roots {
        for manifest in skill_manifests(&root) {
            let Some(mut skill) = parse_skill_manifest(&manifest, source) else { continue; };
            if !seen.insert(skill.name.to_ascii_lowercase()) { continue; }
            if skill.description.is_empty() {
                skill.description = "No description provided.".to_owned();
            }
            skills.push(skill);
        }
    }
    skills.sort_by(|left, right| left.name.to_ascii_lowercase().cmp(&right.name.to_ascii_lowercase()));
    skills
}

fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
}

fn skill_destination(agent: &str, workspace: &str) -> Result<PathBuf, String> {
    if agent == "claude" {
        if workspace.trim().is_empty() {
            return Err("Choose a workspace before installing a Claude Code skill.".into());
        }
        return Ok(PathBuf::from(workspace).join(".claude/skills"));
    }
    codex_home()
        .map(|home| home.join("skills"))
        .ok_or_else(|| "Could not find the host Codex home directory.".to_owned())
}

fn skill_manifests(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new(); };
    entries.filter_map(Result::ok).flat_map(|entry| {
        let path = entry.path();
        let direct = path.join("SKILL.md");
        if direct.is_file() { return vec![direct]; }
        let Ok(nested) = std::fs::read_dir(&path) else { return Vec::new(); };
        nested.filter_map(Result::ok)
            .map(|nested| nested.path().join("SKILL.md"))
            .filter(|manifest| manifest.is_file())
            .collect()
    }).collect()
}

fn parse_skill_manifest(path: &Path, source: &str) -> Option<AgentSkill> {
    let contents = std::fs::read_to_string(path).ok()?;
    let frontmatter = contents.strip_prefix("---")?.splitn(2, "---").next()?;
    let mut name = None;
    let mut description = None;
    for line in frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else { continue; };
        let value = value.trim().trim_matches(['"', '\'']).to_owned();
        match key.trim() {
            "name" => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
    }
    let name = name.or_else(|| path.parent()?.file_name()?.to_str().map(str::to_owned))?;
    Some(AgentSkill { name, description: description.unwrap_or_default(), source: source.to_owned() })
}

pub async fn detect_status() -> CodexStatus {
    let version_output = if let Some(path) = find_codex_executable() {
        Command::new(path).arg("--version").output().await.ok()
    } else {
        None
    };
    let version = version_output.as_ref().and_then(|output| {
        String::from_utf8(output.stdout.clone())
            .ok()
            .and_then(|line| line.split_whitespace().last().map(str::to_owned))
    });
    let compatible = version
        .as_deref()
        .and_then(parse_version)
        .zip(parse_version(MINIMUM_CODEX_VERSION))
        .is_some_and(|(current, minimum)| current >= minimum);
    let dcg_installed = if let Some(path) = find_dcg_executable() {
        Command::new(path)
            .arg("--version")
            .output()
            .await
            .is_ok_and(|output| output.status.success())
    } else {
        false
    };
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".codex"))
        });
    let dcg_hook_active = codex_home
        .and_then(|home| std::fs::read_to_string(home.join("hooks.json")).ok())
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .is_some_and(|hooks| hooks.to_string().to_ascii_lowercase().contains("dcg"));
    CodexStatus {
        installed: version_output.is_some_and(|output| output.status.success()),
        version,
        compatible,
        minimum_version: MINIMUM_CODEX_VERSION,
        dcg_installed,
        dcg_hook_active,
    }
}

pub async fn install_optional_dependency(dependency: &str) -> Result<CodexStatus, String> {
    if dependency != "dcg" {
        return Err(format!("Unknown optional dependency: {dependency}"));
    }

    let temp_dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let installer = temp_dir.path().join("dcg-install.sh");
    let download = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--location"])
        .arg(DCG_INSTALLER_URL)
        .arg("--output")
        .arg(&installer)
        .output()
        .await
        .map_err(|error| format!("Could not download the dcg installer: {error}"))?;
    if !download.status.success() {
        return Err(command_error(
            "Could not download the dcg installer",
            &download,
        ));
    }

    let install = Command::new("/bin/bash")
        .arg(&installer)
        .args(["--easy-mode", "--verify"])
        .output()
        .await
        .map_err(|error| format!("Could not run the dcg installer: {error}"))?;
    if !install.status.success() {
        return Err(command_error("dcg installation failed", &install));
    }

    Ok(detect_status().await)
}

fn command_error(context: &str, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if detail.is_empty() {
        context.to_owned()
    } else {
        format!("{context}: {detail}")
    }
}

fn find_dcg_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("dcg")));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local/bin/dcg"));
        candidates.push(home.join("bin/dcg"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/dcg"));
    candidates.push(PathBuf::from("/usr/local/bin/dcg"));
    candidates.into_iter().find(|path| path.is_file())
}

fn find_codex_executable() -> Option<PathBuf> {
    let configured = std::env::var_os(CODEX_PATH_ENV);
    let path = std::env::var_os("PATH");
    let home = std::env::var_os("HOME");
    find_executable(codex_candidates(
        configured.as_deref(),
        path.as_deref(),
        home.as_deref(),
    ))
}

fn codex_candidates(
    configured: Option<&OsStr>,
    path: Option<&OsStr>,
    home: Option<&OsStr>,
) -> Vec<PathBuf> {
    let executable = executable_name("codex");
    let mut candidates = Vec::new();

    if let Some(configured) = configured.filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(configured));
    }
    if let Some(path) = path {
        candidates.extend(std::env::split_paths(path).map(|dir| dir.join(&executable)));
    }

    if let Some(home) = home {
        let home = PathBuf::from(home);
        for relative in [
            ".local/bin",
            "bin",
            ".npm/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
        ] {
            candidates.push(home.join(relative).join(&executable));
        }
        append_versioned_candidates(
            &mut candidates,
            &home.join(".nvm/versions/node"),
            "bin",
            &executable,
        );
        append_versioned_candidates(
            &mut candidates,
            &home.join(".local/share/fnm/node-versions"),
            "installation/bin",
            &executable,
        );
        append_versioned_candidates(
            &mut candidates,
            &home.join(".local/share/mise/installs/node"),
            "bin",
            &executable,
        );
    }

    for directory in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
    ] {
        candidates.push(Path::new(directory).join(&executable));
    }
    candidates
}

fn append_versioned_candidates(
    candidates: &mut Vec<PathBuf>,
    versions_dir: &Path,
    bin_suffix: &str,
    executable: &OsStr,
) {
    let Ok(entries) = std::fs::read_dir(versions_dir) else {
        return;
    };
    let mut version_dirs = entries
        .flatten()
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| entry.path())
        })
        .collect::<Vec<_>>();
    version_dirs.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    candidates.extend(
        version_dirs
            .into_iter()
            .map(|dir| dir.join(bin_suffix).join(executable)),
    );
}

fn executable_name(name: &str) -> OsString {
    if cfg!(windows) {
        format!("{name}.exe").into()
    } else {
        name.into()
    }
}

fn find_executable(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| is_executable(path))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn prepend_command_path(command: &mut Command, directories: impl IntoIterator<Item = PathBuf>) {
    let mut paths = directories
        .into_iter()
        .filter(|path| !path.as_os_str().is_empty())
        .collect::<Vec<_>>();
    if let Some(current) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&current));
    }
    if let Ok(path) = std::env::join_paths(paths) {
        command.env("PATH", path);
    }
}

fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let mut parts = value.trim_start_matches('v').split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.split('-').next()?.parse().ok()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn optional_dependency_installer_is_allowlisted() {
        let result = install_optional_dependency("unexpected").await;
        assert!(result.is_err());
    }

    #[test]
    fn semantic_version_comparison_is_numeric() {
        assert!(parse_version("0.144.1") > parse_version("0.99.9"));
        assert_eq!(parse_version("v1.2.3-beta"), Some((1, 2, 3)));
    }

    #[test]
    fn codex_candidates_cover_gui_and_version_manager_installs() {
        let home = Path::new("/Users/example");
        let candidates = codex_candidates(
            None,
            Some(OsStr::new("/usr/bin:/bin")),
            Some(home.as_os_str()),
        );

        assert!(candidates.contains(&PathBuf::from("/opt/homebrew/bin/codex")));
        assert!(candidates.contains(&home.join(".local/bin/codex")));
        assert!(candidates.contains(&home.join(".volta/bin/codex")));
    }

    #[cfg(unix)]
    #[test]
    fn executable_lookup_skips_non_executable_files() {
        let directory = tempfile::tempdir().unwrap();
        let blocked = directory.path().join("blocked-codex");
        let runnable = directory.path().join("codex");
        std::fs::write(&blocked, "not executable").unwrap();
        std::fs::write(&runnable, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&runnable, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(find_executable([blocked, runnable.clone()]), Some(runnable));
    }
}

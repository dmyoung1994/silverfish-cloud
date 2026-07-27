use std::{
    path::PathBuf,
    process::Stdio,
    sync::Arc,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, broadcast},
};

const CLAUDE_PATH_ENV: &str = "SILVERFISH_CLAUDE_PATH";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub installed: bool,
    pub version: Option<String>,
    /// Claude's bidirectional stream protocol is required so Silverfish can
    /// keep permission decisions in the shared room instead of a terminal.
    pub approval_mediated: bool,
}

pub async fn detect_status() -> ClaudeStatus {
    let version_output = find_claude_executable().and_then(|path| {
        std::process::Command::new(path).arg("--version").output().ok()
    });
    let version = version_output.as_ref().and_then(|output| {
        String::from_utf8(output.stdout.clone())
            .ok()
            .and_then(|line| line.split_whitespace().next().map(str::to_owned))
    });
    ClaudeStatus {
        installed: version_output.as_ref().is_some_and(|output| output.status.success()),
        version,
        approval_mediated: version_output.as_ref().is_some_and(|output| output.status.success()),
    }
}

pub struct ClaudeClient {
    cwd: String,
    model: Option<String>,
    active: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    events: broadcast::Sender<Value>,
}

impl ClaudeClient {
    pub fn new(cwd: String, model: Option<String>) -> Arc<Self> {
        let (events, _) = broadcast::channel(1024);
        Arc::new(Self {
            cwd,
            model: model.filter(|value| value != "default"),
            active: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
            events,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    pub async fn start_turn(&self, text: &str) -> Result<(), String> {
        if self.active.lock().await.is_some() {
            return Err("Claude Code already has an active turn".into());
        }
        let executable = find_claude_executable().ok_or_else(|| "Claude Code is not installed".to_owned())?;
        let mut command = Command::new(executable);
        command
            .current_dir(&self.cwd)
            .args([
                "--print",
                "--output-format", "stream-json",
                "--include-partial-messages",
                "--permission-mode", "manual",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        if let Some(model) = &self.model { command.args(["--model", model]); }
        command.args(["--", text]);
        let mut child = command.spawn().map_err(|error| format!("Could not start Claude Code: {error}"))?;
        let stdout = child.stdout.take().ok_or_else(|| "Claude Code did not expose stdout".to_owned())?;
        *self.stdin.lock().await = child.stdin.take();
        *self.active.lock().await = Some(child);

        let events = self.events.clone();
        let active = self.active.clone();
        let stdin = self.stdin.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
                for event in normalize_event(&value) {
                    let _ = events.send(event);
                }
            }
            let _ = events.send(json!({ "method": "turn/completed", "params": {} }));
            *stdin.lock().await = None;
            *active.lock().await = None;
        });
        let _ = self.events.send(json!({ "method": "turn/started", "params": { "turn": { "id": "claude-turn" } } }));
        Ok(())
    }

    pub async fn interrupt(&self) -> Result<(), String> {
        if let Some(child) = self.active.lock().await.as_mut() {
            child.start_kill().map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub async fn resolve_approval(&self, request_id: Value, decision: &str) -> Result<(), String> {
        let behavior = if decision == "approveOnce" { "allow" } else { "deny" };
        let message = json!({
            "type": "control_response",
            "response": {
                "request_id": request_id,
                "response": { "behavior": behavior }
            }
        });
        let mut stdin = self.stdin.lock().await;
        let stdin = stdin.as_mut().ok_or_else(|| "Claude Code is not waiting for an approval".to_owned())?;
        let mut bytes = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        stdin.write_all(&bytes).await.map_err(|error| error.to_string())?;
        stdin.flush().await.map_err(|error| error.to_string())
    }
}

fn normalize_event(value: &Value) -> Vec<Value> {
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or_default();
    if event_type == "stream_event" {
        let event = value.get("event").unwrap_or(value);
        if let Some(delta) = event.pointer("/delta/text").and_then(Value::as_str) {
            return vec![json!({ "method": "item/agentMessage/delta", "params": { "itemId": "claude-message", "delta": delta } })];
        }
    }
    if event_type == "assistant" {
        let text = value.pointer("/message/content").and_then(Value::as_array).into_iter().flatten()
            .filter_map(|block| block.get("text").and_then(Value::as_str)).collect::<String>();
        if !text.is_empty() {
            return vec![json!({ "method": "item/completed", "params": { "itemId": "claude-message", "item": { "type": "agentMessage", "text": text } } })];
        }
    }
    if event_type == "control_request" {
        let request_id = value.pointer("/request_id").cloned().unwrap_or(Value::Null);
        let detail = value.pointer("/request").cloned().unwrap_or_else(|| value.clone());
        return vec![json!({
            "id": request_id,
            "method": "item/commandExecution/requestApproval",
            "params": { "reason": detail }
        })];
    }
    Vec::new()
}

fn find_claude_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os(CLAUDE_PATH_ENV) { candidates.push(PathBuf::from(path)); }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|directory| directory.join("claude")));
    }
    candidates.extend(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].map(PathBuf::from));
    candidates.into_iter().find(|path| path.is_file())
}

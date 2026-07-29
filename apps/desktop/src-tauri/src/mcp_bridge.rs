use std::path::PathBuf;

use serde_json::json;
use tauri::{AppHandle, Manager, path::BaseDirectory};

const BRIDGE_NAME: &str = "silverfish-capability-bridge";
const BRIDGE_CONFIG_ENV: &str = "SILVERFISH_MCP_BRIDGE_CONFIG";
const BRIDGE_PATH_ENV: &str = "SILVERFISH_MCP_BRIDGE_PATH";

#[derive(Clone)]
pub struct McpBridge {
    pub name: &'static str,
    pub script: PathBuf,
    pub upstream_config: PathBuf,
    pub codex_home: PathBuf,
}

impl McpBridge {
    pub fn claude_config(&self) -> String {
        json!({
            "mcpServers": {
                self.name: {
                    "command": "node",
                    "args": [self.script],
                    "env": { BRIDGE_CONFIG_ENV: self.upstream_config }
                }
            }
        })
        .to_string()
    }
}

pub fn resolve(app: &AppHandle, workspace: &str) -> Result<McpBridge, String> {
    let script = configured_path(BRIDGE_PATH_ENV).filter(|path| path.is_file())
        .or_else(|| development_script().filter(|path| path.is_file()))
        .or_else(|| app.path().resolve("mcp-bridge/server.mjs", BaseDirectory::Resource).ok().filter(|path| path.is_file()))
        .ok_or_else(|| "Silverfish's bundled MCP capability bridge is unavailable. Rebuild or reinstall Silverfish.".to_owned())?;
    let upstream_config = configured_path(BRIDGE_CONFIG_ENV).filter(|path| path.is_file())
        .or_else(|| project_config(workspace).filter(|path| path.is_file()))
        .or_else(|| existing_broker_config().filter(|path| path.is_file()))
        .or_else(|| app.path().resolve("mcp-bridge/servers.json", BaseDirectory::Resource).ok().filter(|path| path.is_file()))
        .or_else(|| development_config().filter(|path| path.is_file()))
        .ok_or_else(|| "No MCP bridge configuration was found. Set SILVERFISH_MCP_BRIDGE_CONFIG or add .silverfish/mcp-servers.json.".to_owned())?;
    let codex_home = isolated_codex_home(app)?;
    Ok(McpBridge { name: BRIDGE_NAME, script, upstream_config, codex_home })
}

fn configured_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn project_config(workspace: &str) -> Option<PathBuf> {
    (!workspace.trim().is_empty()).then(|| PathBuf::from(workspace).join(".silverfish/mcp-servers.json"))
}

fn existing_broker_config() -> Option<PathBuf> {
    codex_home().map(|home| home.join("local-mcp-broker/servers.json"))
}

fn development_script() -> Option<PathBuf> {
    Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../mcp-bridge/dist/server.mjs"))
}

fn development_config() -> Option<PathBuf> {
    Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../mcp-bridge/servers.json"))
}

fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
}

fn isolated_codex_home(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().app_data_dir().map_err(|error| error.to_string())?.join("codex-runtime");
    std::fs::create_dir_all(&root).map_err(|error| format!("Could not prepare the Silverfish Codex runtime: {error}"))?;
    let Some(host_home) = codex_home() else { return Ok(root); };
    link_if_missing(&host_home.join("auth.json"), &root.join("auth.json"))?;
    link_if_missing(&host_home.join("skills"), &root.join("skills"))?;
    Ok(root)
}

fn link_if_missing(source: &PathBuf, destination: &PathBuf) -> Result<(), String> {
    if destination.exists() || !source.exists() { return Ok(()); }
    #[cfg(unix)]
    std::os::unix::fs::symlink(source, destination).map_err(|error| format!("Could not link {source:?} into the Silverfish Codex runtime: {error}"))?;
    #[cfg(not(unix))]
    std::fs::copy(source, destination).map_err(|error| format!("Could not copy {source:?} into the Silverfish Codex runtime: {error}"))?;
    Ok(())
}

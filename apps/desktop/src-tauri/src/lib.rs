mod audit;
mod claude;
mod codex;
mod google_auth;
mod recovery;

use std::sync::{Arc, Mutex as StdMutex};

use claude::{ClaudeClient, ClaudeStatus};
use codex::{CodexClient, CodexStatus};
use google_auth::{GoogleAuthState, GoogleLoginResult};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tokio::sync::Mutex;

#[derive(Default)]
struct RuntimeState {
    agent: Mutex<Option<ActiveAgent>>,
    google_auth: Arc<GoogleAuthState>,
    host_campaign: Arc<StdMutex<Option<String>>>,
}

#[derive(Clone)]
enum ActiveAgent {
    Codex(Arc<CodexClient>),
    Claude(Arc<ClaudeClient>),
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    codex: CodexStatus,
    claude: ClaudeStatus,
}

#[tauri::command]
async fn agent_status() -> AgentStatus {
    AgentStatus {
        codex: codex::detect_status().await,
        claude: claude::detect_status().await,
    }
}

#[tauri::command]
async fn codex_status() -> CodexStatus {
    codex::detect_status().await
}

#[tauri::command]
async fn install_optional_dependency(dependency: String) -> Result<CodexStatus, String> {
    codex::install_optional_dependency(&dependency).await
}

#[tauri::command]
async fn connect_agent(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    agent: String,
    model: Option<String>,
    cwd: String,
) -> Result<(), String> {
    let client = match agent.as_str() {
        "codex" => ActiveAgent::Codex(CodexClient::spawn(model).await.map_err(|error| error.to_string())?),
        "claude" => ActiveAgent::Claude(ClaudeClient::new(cwd, model)),
        _ => return Err("Unknown local agent".into()),
    };
    let mut events = match &client {
        ActiveAgent::Codex(client) => client.subscribe(),
        ActiveAgent::Claude(client) => client.subscribe(),
    };
    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = events.recv().await {
            let _ = event_app.emit("codex-event", event);
        }
    });
    *state.agent.lock().await = Some(client);
    Ok(())
}

#[tauri::command]
async fn connect_codex(app: AppHandle, state: State<'_, RuntimeState>) -> Result<(), String> {
    connect_agent(app, state, "codex".into(), None, String::new()).await
}

#[tauri::command]
async fn list_threads(
    cwd: Option<String>,
    state: State<'_, RuntimeState>,
) -> Result<Value, String> {
    match client(&state).await? {
        ActiveAgent::Codex(client) => client.list_threads(cwd).await.map_err(|error| error.to_string()),
        ActiveAgent::Claude(_) => Ok(serde_json::json!({ "data": [] })),
    }
}

#[tauri::command]
async fn read_thread(thread_id: String, state: State<'_, RuntimeState>) -> Result<Value, String> {
    match client(&state).await? {
        ActiveAgent::Codex(client) => client.read_thread(&thread_id).await.map_err(|error| error.to_string()),
        ActiveAgent::Claude(_) => Err("Claude Code sessions are local to this room".into()),
    }
}

#[tauri::command]
async fn start_thread(cwd: String, state: State<'_, RuntimeState>) -> Result<Value, String> {
    match client(&state).await? {
        ActiveAgent::Codex(client) => client.start_thread(&cwd).await.map_err(|error| error.to_string()),
        ActiveAgent::Claude(_) => Ok(serde_json::json!({ "thread": { "id": uuid::Uuid::new_v4().to_string(), "preview": "Claude Code room", "cwd": cwd, "updatedAt": 0 } })),
    }
}

#[tauri::command]
async fn resume_thread(
    thread_id: String,
    cwd: String,
    state: State<'_, RuntimeState>,
) -> Result<Value, String> {
    match client(&state).await? {
        ActiveAgent::Codex(client) => client.resume_thread(&thread_id, &cwd).await.map_err(|error| error.to_string()),
        ActiveAgent::Claude(_) => Err("Claude Code room sessions cannot be resumed yet".into()),
    }
}

#[tauri::command]
async fn start_turn(
    thread_id: String,
    text: String,
    state: State<'_, RuntimeState>,
) -> Result<Value, String> {
    match client(&state).await? {
        ActiveAgent::Codex(client) => client.start_turn(&thread_id, &text).await.map_err(|error| error.to_string()),
        ActiveAgent::Claude(client) => client.start_turn(&text).await.map(|_| serde_json::json!({})),
    }
}

#[tauri::command]
async fn steer_turn(
    thread_id: String,
    turn_id: String,
    text: String,
    state: State<'_, RuntimeState>,
) -> Result<Value, String> {
    match client(&state).await? {
        ActiveAgent::Codex(client) => client.steer(&thread_id, &turn_id, &text).await.map_err(|error| error.to_string()),
        ActiveAgent::Claude(_) => Err("Claude Code does not support in-turn steering in this release".into()),
    }
}

#[tauri::command]
async fn interrupt_turn(
    thread_id: String,
    turn_id: String,
    state: State<'_, RuntimeState>,
) -> Result<Value, String> {
    match client(&state).await? {
        ActiveAgent::Codex(client) => client.interrupt(&thread_id, &turn_id).await.map_err(|error| error.to_string()),
        ActiveAgent::Claude(client) => client.interrupt().await.map(|_| serde_json::json!({})),
    }
}

#[tauri::command]
async fn resolve_approval(
    request_id: Value,
    decision: String,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    match client(&state).await? {
        ActiveAgent::Codex(client) => client.resolve_approval(request_id, &decision).await.map_err(|error| error.to_string()),
        ActiveAgent::Claude(client) => client.resolve_approval(request_id, &decision).await,
    }
}

#[tauri::command]
async fn deny_server_request(
    request_id: Value,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    match client(&state).await? {
        ActiveAgent::Codex(client) => client.deny_server_request(request_id).await.map_err(|error| error.to_string()),
        ActiveAgent::Claude(client) => client.resolve_approval(request_id, "decline").await,
    }
}

#[tauri::command]
async fn create_recovery_point(
    app: AppHandle,
    workspace: String,
) -> Result<recovery::RecoveryPoint, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || {
        recovery::create(&app_data, std::path::Path::new(&workspace))
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn restore_recovery_point(
    app: AppHandle,
    workspace: String,
    checkpoint_id: String,
) -> Result<recovery::RecoveryPoint, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let checkpoint_id =
        uuid::Uuid::parse_str(&checkpoint_id).map_err(|_| "invalid checkpoint id")?;
    tokio::task::spawn_blocking(move || {
        recovery::restore(&app_data, std::path::Path::new(&workspace), checkpoint_id)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn append_audit_event(
    app: AppHandle,
    room_id: String,
    sequence: u64,
    event: Value,
) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let room_id = uuid::Uuid::parse_str(&room_id).map_err(|_| "invalid room id")?;
    tokio::task::spawn_blocking(move || audit::append(&app_data, room_id, sequence, event))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn login_with_google(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    client_id: String,
    client_secret: String,
    firebase_api_key: String,
) -> Result<GoogleLoginResult, String> {
    google_auth::login(
        app,
        state.google_auth.clone(),
        client_id,
        client_secret,
        firebase_api_key,
    )
    .await
}

#[tauri::command]
async fn cancel_google_login(state: State<'_, RuntimeState>) -> Result<(), String> {
    google_auth::cancel(state.google_auth.clone()).await;
    Ok(())
}

#[tauri::command]
fn take_host_campaign(state: State<'_, RuntimeState>) -> Option<String> {
    state.host_campaign.lock().ok()?.take()
}

async fn client(state: &State<'_, RuntimeState>) -> Result<ActiveAgent, String> {
    state
        .agent
        .lock()
        .await
        .clone()
        .ok_or_else(|| "No local agent is connected".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(RuntimeState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(handle);
            let campaign_state = app.state::<RuntimeState>().host_campaign.clone();
            if let Some(urls) = app.deep_link().get_current()? {
                store_host_campaign(&campaign_state, &urls);
            }
            let event_app = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(campaign) = campaign_from_urls(&event.urls()) {
                    if let Ok(mut stored) = campaign_state.lock() {
                        *stored = Some(campaign.clone());
                    }
                    let _ = event_app.emit("host-campaign-opened", campaign);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_status,
            codex_status,
            install_optional_dependency,
            connect_agent,
            connect_codex,
            list_threads,
            read_thread,
            start_thread,
            resume_thread,
            start_turn,
            steer_turn,
            interrupt_turn,
            resolve_approval,
            deny_server_request,
            create_recovery_point,
            restore_recovery_point,
            append_audit_event,
            login_with_google,
            cancel_google_login,
            take_host_campaign,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Silverfish");
}

fn store_host_campaign(state: &Arc<StdMutex<Option<String>>>, urls: &[url::Url]) {
    if let Some(campaign) = campaign_from_urls(urls) {
        if let Ok(mut stored) = state.lock() {
            *stored = Some(campaign);
        }
    }
}

fn campaign_from_urls(urls: &[url::Url]) -> Option<String> {
    urls.iter().find_map(|url| {
        if url.scheme() != "silverfish" || url.host_str() != Some("host-your-own") {
            return None;
        }
        url.query_pairs().find_map(|(key, value)| {
            let campaign = value.into_owned();
            (key == "campaign" && valid_campaign(&campaign)).then_some(campaign)
        })
    })
}

fn valid_campaign(value: &str) -> bool {
    (32..=128).contains(&value.len())
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

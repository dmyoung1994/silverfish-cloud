mod audit;
mod codex;
mod oauth;
mod recovery;

use std::sync::Arc;

use codex::{CodexClient, CodexStatus};
use oauth::OAuthLoopbackState;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

#[derive(Default)]
struct RuntimeState {
    codex: Mutex<Option<Arc<CodexClient>>>,
    oauth: Arc<OAuthLoopbackState>,
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
async fn connect_codex(app: AppHandle, state: State<'_, RuntimeState>) -> Result<(), String> {
    let client = CodexClient::spawn()
        .await
        .map_err(|error| error.to_string())?;
    let mut events = client.subscribe();
    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = events.recv().await {
            let _ = event_app.emit("codex-event", event);
        }
    });
    *state.codex.lock().await = Some(client);
    Ok(())
}

#[tauri::command]
async fn list_threads(
    cwd: Option<String>,
    state: State<'_, RuntimeState>,
) -> Result<Value, String> {
    client(&state)
        .await?
        .list_threads(cwd)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn read_thread(thread_id: String, state: State<'_, RuntimeState>) -> Result<Value, String> {
    client(&state)
        .await?
        .read_thread(&thread_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn start_thread(cwd: String, state: State<'_, RuntimeState>) -> Result<Value, String> {
    client(&state)
        .await?
        .start_thread(&cwd)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn resume_thread(
    thread_id: String,
    cwd: String,
    state: State<'_, RuntimeState>,
) -> Result<Value, String> {
    client(&state)
        .await?
        .resume_thread(&thread_id, &cwd)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn start_turn(
    thread_id: String,
    text: String,
    state: State<'_, RuntimeState>,
) -> Result<Value, String> {
    client(&state)
        .await?
        .start_turn(&thread_id, &text)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn steer_turn(
    thread_id: String,
    turn_id: String,
    text: String,
    state: State<'_, RuntimeState>,
) -> Result<Value, String> {
    client(&state)
        .await?
        .steer(&thread_id, &turn_id, &text)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn interrupt_turn(
    thread_id: String,
    turn_id: String,
    state: State<'_, RuntimeState>,
) -> Result<Value, String> {
    client(&state)
        .await?
        .interrupt(&thread_id, &turn_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn resolve_approval(
    request_id: Value,
    decision: String,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    client(&state)
        .await?
        .resolve_approval(request_id, &decision)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn deny_server_request(
    request_id: Value,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    client(&state)
        .await?
        .deny_server_request(request_id)
        .await
        .map_err(|error| error.to_string())
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
async fn start_google_oauth_loopback(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<u16, String> {
    oauth::start(app, state.oauth.clone()).await
}

#[tauri::command]
async fn cancel_google_oauth_loopback(state: State<'_, RuntimeState>) -> Result<(), String> {
    oauth::cancel(state.oauth.clone()).await;
    Ok(())
}

async fn client(state: &State<'_, RuntimeState>) -> Result<Arc<CodexClient>, String> {
    state
        .codex
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Codex is not connected".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(RuntimeState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            codex_status,
            install_optional_dependency,
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
            start_google_oauth_loopback,
            cancel_google_oauth_loopback,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Silverfish");
}

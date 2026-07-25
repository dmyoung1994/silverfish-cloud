use std::sync::Arc;
use std::time::Duration;

use axum::extract::Query;
use axum::response::Html;
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

/// A single-shot local HTTP listener that captures the OAuth redirect from a
/// system-browser Google sign-in and hands the result back to the frontend
/// via a Tauri event, following the RFC 8252 "installed app" loopback pattern.
#[derive(Default)]
pub struct OAuthLoopbackState {
    cancel: Mutex<Option<oneshot::Sender<()>>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OAuthCallback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

const SUCCESS_PAGE: &str = r#"<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Silverfish</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #080b0d; color: #eef1ef; display: grid; place-items: center; height: 100vh; margin: 0; }
    main { text-align: center; }
    p { color: #939b9f; }
  </style>
</head>
<body>
  <main>
    <h1>You're signed in.</h1>
    <p>Return to Silverfish to continue.</p>
  </main>
</body>
</html>"#;

pub async fn start(app: AppHandle, state: Arc<OAuthLoopbackState>) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    *state.cancel.lock().await = Some(cancel_tx);

    let (done_tx, done_rx) = oneshot::channel::<()>();
    let done_tx = Arc::new(Mutex::new(Some(done_tx)));
    let emit_app = app.clone();

    let router = Router::new().route(
        "/callback",
        get(move |Query(params): Query<OAuthCallback>| {
            let emit_app = emit_app.clone();
            let done_tx = done_tx.clone();
            async move {
                let _ = emit_app.emit("oauth-callback", params);
                if let Some(sender) = done_tx.lock().await.take() {
                    let _ = sender.send(());
                }
                Html(SUCCESS_PAGE)
            }
        }),
    );

    tauri::async_runtime::spawn(async move {
        let shutdown = async move {
            tokio::select! {
                _ = cancel_rx => {}
                _ = done_rx => {
                    // Give the response a moment to flush before tearing the listener down.
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                _ = tokio::time::sleep(Duration::from_secs(300)) => {}
            }
        };
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await;
    });

    Ok(port)
}

pub async fn cancel(state: Arc<OAuthLoopbackState>) {
    if let Some(sender) = state.cancel.lock().await.take() {
        let _ = sender.send(());
    }
}

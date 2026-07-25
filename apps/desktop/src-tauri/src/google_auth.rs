use std::sync::Arc;
use std::time::Duration;

use axum::extract::Query;
use axum::response::Html;
use axum::routing::get;
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

const OAUTH_TIMEOUT: Duration = Duration::from_secs(300);
const GOOGLE_AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const FIREBASE_SIGN_IN_ENDPOINT: &str = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp";

/// Google Sign-In for a host, done entirely on the Rust side: a single-shot
/// loopback listener catches the OAuth redirect (RFC 8252 "installed app"
/// pattern), the authorization code is exchanged directly with Google, and
/// the resulting Google ID token is handed to Firebase Auth's REST API to
/// mint a Firebase ID token. No Firebase JS SDK involved.
#[derive(Default)]
pub struct GoogleAuthState {
    cancel: Mutex<Option<oneshot::Sender<()>>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct OAuthCallback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleLoginResult {
    pub firebase_id_token: String,
    pub email: String,
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

pub async fn login(
    app: AppHandle,
    state: Arc<GoogleAuthState>,
    client_id: String,
    client_secret: String,
    firebase_api_key: String,
) -> Result<GoogleLoginResult, String> {
    let code_verifier = random_url_safe_string(64);
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    let oauth_state = random_url_safe_string(32);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    *state.cancel.lock().await = Some(cancel_tx);

    let (callback_tx, callback_rx) = oneshot::channel::<OAuthCallback>();
    let callback_tx = Arc::new(Mutex::new(Some(callback_tx)));
    let (done_tx, done_rx) = oneshot::channel::<()>();
    let done_tx = Arc::new(Mutex::new(Some(done_tx)));

    let router = Router::new().route(
        "/callback",
        get(move |Query(params): Query<OAuthCallback>| {
            let callback_tx = callback_tx.clone();
            let done_tx = done_tx.clone();
            async move {
                if let Some(sender) = callback_tx.lock().await.take() {
                    let _ = sender.send(params);
                }
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
                _ = done_rx => tokio::time::sleep(Duration::from_millis(200)).await,
                _ = tokio::time::sleep(OAUTH_TIMEOUT) => {}
            }
        };
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await;
    });

    let mut auth_url = reqwest::Url::parse(GOOGLE_AUTH_ENDPOINT).map_err(|error| error.to_string())?;
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email profile")
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &oauth_state)
        .append_pair("prompt", "select_account");

    app.opener()
        .open_url(auth_url.to_string(), None::<&str>)
        .map_err(|error| error.to_string())?;

    let callback = callback_rx.await;
    *state.cancel.lock().await = None;
    let callback = callback.map_err(|_| "Google sign-in was cancelled.".to_string())?;

    let Some(code) = callback.code else {
        let reason = callback.error.unwrap_or_else(|| "no code returned".into());
        return Err(format!("Google sign-in was not completed ({reason})."));
    };
    if callback.state.as_deref() != Some(oauth_state.as_str()) {
        return Err("Google sign-in response could not be verified.".to_string());
    }

    let http = reqwest::Client::new();

    let token_response: serde_json::Value = http
        .post(GOOGLE_TOKEN_ENDPOINT)
        .form(&[
            ("code", code.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_verifier", code_verifier.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;

    let google_id_token = token_response
        .get("id_token")
        .and_then(|value| value.as_str())
        .ok_or("Google did not return an identity token.")?;

    let firebase_response: serde_json::Value = http
        .post(FIREBASE_SIGN_IN_ENDPOINT)
        .query(&[("key", firebase_api_key.as_str())])
        .json(&serde_json::json!({
            "postBody": format!("id_token={google_id_token}&providerId=google.com"),
            "requestUri": "http://localhost",
            "returnIdpCredential": true,
            "returnSecureToken": true,
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;

    let firebase_id_token = firebase_response
        .get("idToken")
        .and_then(|value| value.as_str())
        .ok_or("Firebase did not return an identity token.")?
        .to_string();
    let email = firebase_response
        .get("email")
        .and_then(|value| value.as_str())
        .filter(|email| !email.is_empty())
        .ok_or("Google account has no email address.")?
        .to_string();

    Ok(GoogleLoginResult {
        firebase_id_token,
        email,
    })
}

pub async fn cancel(state: Arc<GoogleAuthState>) {
    if let Some(sender) = state.cancel.lock().await.take() {
        let _ = sender.send(());
    }
}

fn random_url_safe_string(byte_len: usize) -> String {
    let mut bytes = vec![0u8; byte_len];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

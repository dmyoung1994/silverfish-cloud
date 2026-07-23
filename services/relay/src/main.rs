use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{RwLock, mpsc};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::{info, warn};
use uuid::Uuid;

const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_MAX_GUESTS_PER_ROOM: usize = 32;
const MAX_ROOMS: usize = 10_000;
const MAX_MESSAGES_PER_SECOND: u32 = 120;
const ROOM_IDLE_TTL: Duration = Duration::from_secs(60 * 60 * 12);

#[derive(Clone, Copy)]
struct RelayLimits {
    max_guests_per_room: usize,
    room_lifetime: Option<Duration>,
}

impl Default for RelayLimits {
    fn default() -> Self {
        Self {
            max_guests_per_room: DEFAULT_MAX_GUESTS_PER_ROOM,
            room_lifetime: None,
        }
    }
}

impl RelayLimits {
    fn from_env() -> Self {
        let defaults = Self::default();
        let max_guests_per_room = parse_positive_env(
            "SILVERFISH_MAX_GUESTS_PER_ROOM",
            defaults.max_guests_per_room,
        );
        let room_lifetime = parse_optional_duration_env("SILVERFISH_ROOM_LIFETIME_SECONDS");
        Self {
            max_guests_per_room,
            room_lifetime,
        }
    }
}

#[derive(Clone, Default)]
struct AppState {
    rooms: Arc<RwLock<HashMap<Uuid, Room>>>,
    limits: RelayLimits,
}

struct Room {
    host_token_hash: [u8; 32],
    host: Option<Connection>,
    guests: HashMap<Uuid, Connection>,
    invites: HashMap<Uuid, Invite>,
    last_active: Instant,
    expires_at: Option<Instant>,
}

#[derive(Clone)]
struct Connection {
    id: Uuid,
    invite_id: Option<Uuid>,
    tx: mpsc::UnboundedSender<Message>,
}

struct Invite {
    token_hash: [u8; 32],
    revoked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRoomRequest {
    room_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateRoomResponse {
    room_id: Uuid,
    host_token: String,
    limits: RoomLimitsResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoomLimitsResponse {
    max_guests: usize,
    expires_at_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateInviteResponse {
    invite_id: Uuid,
    invite_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SocketQuery {
    role: SocketRole,
    invite_id: Option<Uuid>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum SocketRole {
    Host,
    Guest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientRelayMessage {
    target: RelayTarget,
    payload: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "connectionId")]
enum RelayTarget {
    Host,
    All,
    Connection(Uuid),
}

#[derive(Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
enum ServerRelayMessage {
    Ready {
        connection_id: Uuid,
        host_available: bool,
    },
    PeerConnected {
        connection_id: Uuid,
    },
    PeerDisconnected {
        connection_id: Uuid,
    },
    HostAvailable,
    HostUnavailable,
    Payload {
        from: Uuid,
        payload: String,
    },
    Error {
        code: &'static str,
        message: &'static str,
    },
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "co_dex_relay=info,tower_http=info".into()),
        )
        .init();

    let limits = RelayLimits::from_env();
    info!(
        max_guests_per_room = limits.max_guests_per_room,
        room_lifetime_seconds = limits.room_lifetime.map(|value| value.as_secs()),
        "relay limits configured"
    );
    let state = AppState {
        rooms: Arc::default(),
        limits,
    };
    spawn_room_reaper(state.clone());
    let mut app = app(state);
    if let Ok(web_dir) = std::env::var("CO_DEX_WEB_DIR") {
        let index = std::path::Path::new(&web_dir).join("index.html");
        app = app.fallback_service(ServeDir::new(web_dir).not_found_service(ServeFile::new(index)));
    }
    let addr: SocketAddr = std::env::var("CO_DEX_RELAY_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8787".into())
        .parse()
        .expect("CO_DEX_RELAY_ADDR must be a socket address");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind relay");
    info!(%addr, "co-dex relay listening");
    axum::serve(listener, app).await.expect("serve relay");
}

fn app(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { StatusCode::OK }))
        .route("/api/rooms", post(create_room))
        .route("/api/rooms/{room_id}", delete(close_room))
        .route("/api/rooms/{room_id}/invites", post(create_invite))
        .route(
            "/api/rooms/{room_id}/invites/{invite_id}",
            delete(revoke_invite),
        )
        .route(
            "/api/rooms/{room_id}/connections/{connection_id}",
            delete(eject_connection),
        )
        .route("/api/rooms/{room_id}/socket", get(socket_upgrade))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn create_room(
    State(state): State<AppState>,
    Json(request): Json<CreateRoomRequest>,
) -> Result<Json<CreateRoomResponse>, ApiError> {
    let room_id = request.room_id.unwrap_or_else(Uuid::new_v4);
    let host_token = random_token();
    let created_at = Instant::now();
    let expires_at = state
        .limits
        .room_lifetime
        .and_then(|lifetime| created_at.checked_add(lifetime));
    let expires_at_ms = state
        .limits
        .room_lifetime
        .and_then(system_time_after_duration_ms);
    let room = Room {
        host_token_hash: hash_token(&host_token),
        host: None,
        guests: HashMap::new(),
        invites: HashMap::new(),
        last_active: created_at,
        expires_at,
    };
    let mut rooms = state.rooms.write().await;
    if rooms.len() >= MAX_ROOMS {
        return Err(ApiError::too_many("relay room capacity reached"));
    }
    if rooms.insert(room_id, room).is_some() {
        return Err(ApiError::conflict("room already exists"));
    }
    Ok(Json(CreateRoomResponse {
        room_id,
        host_token,
        limits: RoomLimitsResponse {
            max_guests: state.limits.max_guests_per_room,
            expires_at_ms,
        },
    }))
}

async fn create_invite(
    State(state): State<AppState>,
    Path(room_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<CreateInviteResponse>, ApiError> {
    let token = bearer(&headers)?;
    let mut rooms = state.rooms.write().await;
    let room = rooms.get_mut(&room_id).ok_or_else(ApiError::not_found)?;
    require_live_room(room)?;
    require_token(&room.host_token_hash, token)?;

    let invite_id = Uuid::new_v4();
    let invite_token = random_token();
    room.invites.insert(
        invite_id,
        Invite {
            token_hash: hash_token(&invite_token),
            revoked: false,
        },
    );
    room.last_active = Instant::now();
    Ok(Json(CreateInviteResponse {
        invite_id,
        invite_token,
    }))
}

async fn close_room(
    State(state): State<AppState>,
    Path(room_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let token = bearer(&headers)?;
    let mut rooms = state.rooms.write().await;
    let room = rooms.get(&room_id).ok_or_else(ApiError::not_found)?;
    require_token(&room.host_token_hash, token)?;
    let room = rooms.remove(&room_id).ok_or_else(ApiError::not_found)?;
    for connection in room.guests.values().chain(room.host.iter()) {
        send_json(
            &connection.tx,
            &ServerRelayMessage::Error {
                code: "room_closed",
                message: "the host closed this room",
            },
        );
        let _ = connection.tx.send(Message::Close(None));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn revoke_invite(
    State(state): State<AppState>,
    Path((room_id, invite_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let token = bearer(&headers)?;
    let mut rooms = state.rooms.write().await;
    let room = rooms.get_mut(&room_id).ok_or_else(ApiError::not_found)?;
    require_live_room(room)?;
    require_token(&room.host_token_hash, token)?;
    let invite = room
        .invites
        .get_mut(&invite_id)
        .ok_or_else(ApiError::not_found)?;
    invite.revoked = true;
    let revoked_connections: Vec<_> = room
        .guests
        .values()
        .filter(|connection| connection.invite_id == Some(invite_id))
        .cloned()
        .collect();
    for connection in revoked_connections {
        send_json(
            &connection.tx,
            &ServerRelayMessage::Error {
                code: "invite_revoked",
                message: "this invitation was revoked by the host",
            },
        );
        let _ = connection.tx.send(Message::Close(None));
        room.guests.remove(&connection.id);
    }
    room.last_active = Instant::now();
    Ok(StatusCode::NO_CONTENT)
}

async fn eject_connection(
    State(state): State<AppState>,
    Path((room_id, connection_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let token = bearer(&headers)?;
    let mut rooms = state.rooms.write().await;
    let room = rooms.get_mut(&room_id).ok_or_else(ApiError::not_found)?;
    require_live_room(room)?;
    require_token(&room.host_token_hash, token)?;
    let connection = room
        .guests
        .remove(&connection_id)
        .ok_or_else(ApiError::not_found)?;
    if let Some(invite_id) = connection.invite_id
        && let Some(invite) = room.invites.get_mut(&invite_id)
    {
        invite.revoked = true;
    }
    send_json(
        &connection.tx,
        &ServerRelayMessage::Error {
            code: "ejected",
            message: "the host removed you from this room",
        },
    );
    let _ = connection.tx.send(Message::Close(None));
    room.last_active = Instant::now();
    Ok(StatusCode::NO_CONTENT)
}

async fn socket_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(room_id): Path<Uuid>,
    Query(query): Query<SocketQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let token = socket_token(&headers)?;
    {
        let rooms = state.rooms.read().await;
        let room = rooms.get(&room_id).ok_or_else(ApiError::not_found)?;
        require_live_room(room)?;
        match query.role {
            SocketRole::Host => require_token(&room.host_token_hash, &token)?,
            SocketRole::Guest => {
                if room.guests.len() >= state.limits.max_guests_per_room {
                    return Err(ApiError::too_many("room is full"));
                }
                let invite_id = query
                    .invite_id
                    .ok_or_else(|| ApiError::unauthorized("invite id required"))?;
                let invite = room
                    .invites
                    .get(&invite_id)
                    .ok_or_else(ApiError::not_found)?;
                if invite.revoked {
                    return Err(ApiError::unauthorized("invite revoked"));
                }
                require_token(&invite.token_hash, &token)?;
            }
        }
    }

    Ok(ws
        .protocols(["co-dex-v1"])
        .max_message_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| {
            handle_socket(socket, state, room_id, query.role, query.invite_id)
        }))
}

async fn handle_socket(
    socket: WebSocket,
    state: AppState,
    room_id: Uuid,
    role: SocketRole,
    invite_id: Option<Uuid>,
) {
    let connection_id = Uuid::new_v4();
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if ws_tx.send(message).await.is_err() {
                break;
            }
        }
    });
    let mut rate_window = Instant::now();
    let mut messages_in_window = 0_u32;

    if let Err((code, message)) =
        register_connection(&state, room_id, role, connection_id, invite_id, tx.clone()).await
    {
        send_json(&tx, &ServerRelayMessage::Error { code, message });
        let _ = tx.send(Message::Close(None));
        writer.abort();
        return;
    }

    while let Some(Ok(message)) = ws_rx.next().await {
        match message {
            Message::Text(text) if text.len() <= MAX_FRAME_BYTES => {
                if rate_window.elapsed() >= Duration::from_secs(1) {
                    rate_window = Instant::now();
                    messages_in_window = 0;
                }
                messages_in_window += 1;
                if messages_in_window > MAX_MESSAGES_PER_SECOND {
                    send_json(
                        &tx,
                        &ServerRelayMessage::Error {
                            code: "rate_limited",
                            message: "too many messages; slow down",
                        },
                    );
                    continue;
                }
                match serde_json::from_str::<ClientRelayMessage>(&text) {
                    Ok(frame) => route_payload(&state, room_id, role, connection_id, frame).await,
                    Err(_) => send_json(
                        &tx,
                        &ServerRelayMessage::Error {
                            code: "invalid_frame",
                            message: "invalid relay frame",
                        },
                    ),
                }
            }
            Message::Ping(bytes) => {
                let _ = tx.send(Message::Pong(bytes));
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    unregister_connection(&state, room_id, role, connection_id).await;
    writer.abort();
}

async fn register_connection(
    state: &AppState,
    room_id: Uuid,
    role: SocketRole,
    connection_id: Uuid,
    invite_id: Option<Uuid>,
    tx: mpsc::UnboundedSender<Message>,
) -> Result<(), (&'static str, &'static str)> {
    let mut rooms = state.rooms.write().await;
    let room = rooms
        .get_mut(&room_id)
        .ok_or(("room_not_found", "room not found"))?;
    if room_is_expired(room) {
        return Err(("room_expired", "this room has expired"));
    }
    if role == SocketRole::Guest && room.guests.len() >= state.limits.max_guests_per_room {
        return Err(("room_full", "this room has reached its guest limit"));
    }
    room.last_active = Instant::now();
    let connection = Connection {
        id: connection_id,
        invite_id,
        tx: tx.clone(),
    };
    let host_available = room.host.is_some() || role == SocketRole::Host;
    match role {
        SocketRole::Host => {
            if let Some(previous) = room.host.replace(connection) {
                send_json(
                    &previous.tx,
                    &ServerRelayMessage::Error {
                        code: "host_replaced",
                        message: "a new host connection replaced this connection",
                    },
                );
            }
            for guest in room.guests.values() {
                send_json(&guest.tx, &ServerRelayMessage::HostAvailable);
            }
        }
        SocketRole::Guest => {
            room.guests.insert(connection_id, connection);
            if let Some(host) = &room.host {
                send_json(
                    &host.tx,
                    &ServerRelayMessage::PeerConnected { connection_id },
                );
            }
        }
    }
    send_json(
        &tx,
        &ServerRelayMessage::Ready {
            connection_id,
            host_available,
        },
    );
    Ok(())
}

async fn unregister_connection(
    state: &AppState,
    room_id: Uuid,
    role: SocketRole,
    connection_id: Uuid,
) {
    let mut rooms = state.rooms.write().await;
    let Some(room) = rooms.get_mut(&room_id) else {
        return;
    };
    room.last_active = Instant::now();
    match role {
        SocketRole::Host => {
            if room
                .host
                .as_ref()
                .is_some_and(|host| host.id == connection_id)
            {
                room.host = None;
                for guest in room.guests.values() {
                    send_json(&guest.tx, &ServerRelayMessage::HostUnavailable);
                }
            }
        }
        SocketRole::Guest => {
            room.guests.remove(&connection_id);
            if let Some(host) = &room.host {
                send_json(
                    &host.tx,
                    &ServerRelayMessage::PeerDisconnected { connection_id },
                );
            }
        }
    }
}

async fn route_payload(
    state: &AppState,
    room_id: Uuid,
    role: SocketRole,
    sender: Uuid,
    frame: ClientRelayMessage,
) {
    if frame.payload.len() > MAX_FRAME_BYTES {
        return;
    }
    let rooms = state.rooms.read().await;
    let Some(room) = rooms.get(&room_id) else {
        return;
    };
    let outbound = ServerRelayMessage::Payload {
        from: sender,
        payload: frame.payload,
    };
    match (role, frame.target) {
        (SocketRole::Guest, RelayTarget::Host) => {
            if let Some(host) = &room.host {
                send_json(&host.tx, &outbound);
            }
        }
        (SocketRole::Host, RelayTarget::All) => {
            for guest in room.guests.values() {
                send_json(&guest.tx, &outbound);
            }
        }
        (SocketRole::Host, RelayTarget::Connection(id)) => {
            if let Some(guest) = room.guests.get(&id) {
                send_json(&guest.tx, &outbound);
            }
        }
        _ => {}
    }
}

fn send_json(tx: &mpsc::UnboundedSender<Message>, message: &ServerRelayMessage) {
    if let Ok(json) = serde_json::to_string(message) {
        let _ = tx.send(Message::Text(json.into()));
    }
}

fn spawn_room_reaper(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            let mut rooms = state.rooms.write().await;
            rooms.retain(|room_id, room| {
                if room_is_expired(room) {
                    close_connections(room, "room_expired", "this room reached its time limit");
                    info!(%room_id, "expired timed room");
                    return false;
                }
                let keep = room.last_active.elapsed() < ROOM_IDLE_TTL
                    || room.host.is_some()
                    || !room.guests.is_empty();
                if !keep {
                    info!(%room_id, "expired idle room");
                }
                keep
            });
        }
    });
}

fn close_connections(room: &Room, code: &'static str, message: &'static str) {
    for connection in room.guests.values().chain(room.host.iter()) {
        send_json(&connection.tx, &ServerRelayMessage::Error { code, message });
        let _ = connection.tx.send(Message::Close(None));
    }
}

fn room_is_expired(room: &Room) -> bool {
    room.expires_at
        .is_some_and(|expires_at| Instant::now() >= expires_at)
}

fn require_live_room(room: &Room) -> Result<(), ApiError> {
    if room_is_expired(room) {
        Err(ApiError::gone("room expired"))
    } else {
        Ok(())
    }
}

fn parse_positive_env(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn parse_optional_duration_env(name: &str) -> Option<Duration> {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .map(Duration::from_secs)
}

fn system_time_after_duration_ms(duration: Duration) -> Option<u64> {
    SystemTime::now()
        .checked_add(duration)?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_token(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn bearer(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| !token.is_empty())
        .ok_or_else(|| ApiError::unauthorized("bearer token required"))
}

fn socket_token(headers: &HeaderMap) -> Result<String, ApiError> {
    if let Ok(token) = bearer(headers) {
        return Ok(token.to_owned());
    }
    headers
        .get(axum::http::header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .split(',')
                .map(str::trim)
                .find_map(|protocol| protocol.strip_prefix("co-dex-token."))
        })
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ApiError::unauthorized("websocket token required"))
}

fn require_token(expected_hash: &[u8; 32], token: &str) -> Result<(), ApiError> {
    let actual = hash_token(token);
    if bool::from(expected_hash.ct_eq(&actual)) {
        Ok(())
    } else {
        Err(ApiError::unauthorized("invalid token"))
    }
}

struct ApiError {
    status: StatusCode,
    message: &'static str,
}

impl ApiError {
    fn unauthorized(message: &'static str) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message,
        }
    }
    fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: "not found",
        }
    }
    fn conflict(message: &'static str) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message,
        }
    }
    fn too_many(message: &'static str) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            message,
        }
    }
    fn gone(message: &'static str) -> Self {
        Self {
            status: StatusCode::GONE,
            message,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        warn!(status = %self.status, message = self.message, "relay request rejected");
        Response::builder()
            .status(self.status)
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"error":"{}"}}"#, self.message)))
            .expect("valid response")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_verification_is_exact() {
        let hash = hash_token("correct horse");
        assert!(require_token(&hash, "correct horse").is_ok());
        assert!(require_token(&hash, "correct Horse").is_err());
    }

    #[test]
    fn relay_message_rejects_unknown_target_shapes() {
        let invalid = r#"{"target":{"type":"connection"},"payload":"x"}"#;
        assert!(serde_json::from_str::<ClientRelayMessage>(invalid).is_err());
    }

    #[test]
    fn server_relay_messages_use_camel_case_fields() {
        let connection_id = Uuid::nil();
        assert_eq!(
            serde_json::to_value(ServerRelayMessage::Ready {
                connection_id,
                host_available: true,
            })
            .unwrap(),
            serde_json::json!({
                "type": "ready",
                "connectionId": connection_id,
                "hostAvailable": true,
            })
        );
        assert_eq!(
            serde_json::to_value(ServerRelayMessage::PeerConnected { connection_id }).unwrap(),
            serde_json::json!({
                "type": "peerConnected",
                "connectionId": connection_id,
            })
        );
        assert_eq!(
            serde_json::to_value(ServerRelayMessage::PeerDisconnected { connection_id }).unwrap(),
            serde_json::json!({
                "type": "peerDisconnected",
                "connectionId": connection_id,
            })
        );
    }

    #[test]
    fn room_expiry_is_a_hard_deadline() {
        let room = Room {
            host_token_hash: [0; 32],
            host: None,
            guests: HashMap::new(),
            invites: HashMap::new(),
            last_active: Instant::now(),
            expires_at: Some(Instant::now() - Duration::from_millis(1)),
        };
        assert!(room_is_expired(&room));
        assert_eq!(
            require_live_room(&room).unwrap_err().status,
            StatusCode::GONE
        );
    }

    #[test]
    fn room_limits_use_camel_case_fields() {
        let response = CreateRoomResponse {
            room_id: Uuid::nil(),
            host_token: "secret".into(),
            limits: RoomLimitsResponse {
                max_guests: 1,
                expires_at_ms: Some(1234),
            },
        };
        assert_eq!(
            serde_json::to_value(response).unwrap()["limits"],
            serde_json::json!({
                "maxGuests": 1,
                "expiresAtMs": 1234,
            })
        );
    }
}

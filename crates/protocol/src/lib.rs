use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_PLAINTEXT_BYTES: usize = 1024 * 1024;

pub type RoomId = Uuid;
pub type ConnectionId = Uuid;
pub type MessageId = Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub connection_id: ConnectionId,
    pub display_name: String,
    pub is_host: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientIntent {
    Identify {
        display_name: String,
    },
    EnqueuePrompt {
        prompt_id: Uuid,
        text: String,
    },
    RemovePrompt {
        prompt_id: Uuid,
    },
    MovePrompt {
        prompt_id: Uuid,
        new_index: usize,
    },
    Steer {
        text: String,
    },
    Interrupt,
    SetQueuePaused {
        paused: bool,
    },
    ApprovalDecision {
        approval_id: String,
        decision: ApprovalDecision,
    },
    RequestSnapshot {
        after_sequence: Option<u64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    ApproveOnce,
    Decline,
    Cancel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HostEvent {
    Snapshot {
        state: RoomSnapshot,
    },
    Presence {
        participants: Vec<Participant>,
    },
    QueueUpdated {
        queue: Vec<QueuedPrompt>,
        paused: bool,
    },
    TurnState {
        active: bool,
        turn_id: Option<String>,
    },
    Timeline {
        item: TimelineItem,
    },
    ApprovalOpened {
        approval: ApprovalRequest,
    },
    ApprovalResolved {
        approval_id: String,
        by: ConnectionId,
    },
    RecoveryPoint {
        point: RecoveryPointSummary,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SequencedHostEvent {
    pub sequence: u64,
    pub event: HostEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub sequence: u64,
    #[serde(default)]
    pub project_name: String,
    pub participants: Vec<Participant>,
    pub queue: Vec<QueuedPrompt>,
    pub queue_paused: bool,
    pub active_turn_id: Option<String>,
    pub timeline: Vec<TimelineItem>,
    pub approvals: Vec<ApprovalRequest>,
    pub recovery_points: Vec<RecoveryPointSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPointSummary {
    pub checkpoint_id: String,
    pub created_at_ms: u64,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueuedPrompt {
    pub id: Uuid,
    pub author: ConnectionId,
    pub author_name: String,
    pub text: String,
    pub enqueued_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TimelineItem {
    UserMessage {
        id: String,
        author_name: String,
        text: String,
    },
    AgentMessage {
        id: String,
        text: String,
        completed: bool,
    },
    Reasoning {
        id: String,
        summary: String,
    },
    Plan {
        id: String,
        text: String,
    },
    Command {
        id: String,
        command: String,
        output: String,
        status: String,
    },
    FileChange {
        id: String,
        path: String,
        diff: String,
        status: String,
    },
    Tool {
        id: String,
        name: String,
        detail: String,
        status: String,
    },
    System {
        id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    pub category: ApprovalCategory,
    pub title: String,
    pub detail: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalCategory {
    Command,
    Network,
    FileChange,
    McpTool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CipherEnvelope {
    pub version: u16,
    pub room_id: RoomId,
    pub message_id: MessageId,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("room key must be exactly 32 bytes")]
    InvalidKey,
    #[error("invalid base64 encoding")]
    InvalidEncoding,
    #[error("invalid nonce")]
    InvalidNonce,
    #[error("unsupported protocol version")]
    UnsupportedVersion,
    #[error("payload exceeds the maximum size")]
    PayloadTooLarge,
    #[error("message authentication failed")]
    AuthenticationFailed,
    #[error("invalid JSON payload")]
    InvalidJson,
}

pub fn generate_room_key() -> [u8; 32] {
    let mut key = [0_u8; 32];
    rand::rng().fill_bytes(&mut key);
    key
}

pub fn encode_room_key(key: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(key)
}

pub fn decode_room_key(value: &str) -> Result<[u8; 32], CryptoError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| CryptoError::InvalidEncoding)?;
    bytes.try_into().map_err(|_| CryptoError::InvalidKey)
}

pub fn encrypt<T: Serialize>(
    room_id: RoomId,
    key: &[u8; 32],
    value: &T,
) -> Result<CipherEnvelope, CryptoError> {
    let plaintext = serde_json::to_vec(value).map_err(|_| CryptoError::InvalidJson)?;
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err(CryptoError::PayloadTooLarge);
    }

    let mut nonce_bytes = [0_u8; 12];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let message_id = Uuid::new_v4();
    let aad = associated_data(room_id, message_id);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::InvalidKey)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::AuthenticationFailed)?;

    Ok(CipherEnvelope {
        version: PROTOCOL_VERSION,
        room_id,
        message_id,
        nonce: URL_SAFE_NO_PAD.encode(nonce_bytes),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
}

pub fn decrypt<T: DeserializeOwned>(
    envelope: &CipherEnvelope,
    key: &[u8; 32],
) -> Result<T, CryptoError> {
    if envelope.version != PROTOCOL_VERSION {
        return Err(CryptoError::UnsupportedVersion);
    }
    let nonce = URL_SAFE_NO_PAD
        .decode(&envelope.nonce)
        .map_err(|_| CryptoError::InvalidEncoding)?;
    if nonce.len() != 12 {
        return Err(CryptoError::InvalidNonce);
    }
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&envelope.ciphertext)
        .map_err(|_| CryptoError::InvalidEncoding)?;
    if ciphertext.len() > MAX_PLAINTEXT_BYTES + 16 {
        return Err(CryptoError::PayloadTooLarge);
    }
    let aad = associated_data(envelope.room_id, envelope.message_id);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::InvalidKey)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::AuthenticationFailed)?;
    serde_json::from_slice(&plaintext).map_err(|_| CryptoError::InvalidJson)
}

fn associated_data(room_id: RoomId, message_id: MessageId) -> String {
    format!("co-dex:{PROTOCOL_VERSION}:{room_id}:{message_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_round_trip_and_tamper_rejection() {
        let room_id = Uuid::new_v4();
        let key = generate_room_key();
        let intent = ClientIntent::Steer {
            text: "check the tests".into(),
        };
        let envelope = encrypt(room_id, &key, &intent).unwrap();
        assert_eq!(decrypt::<ClientIntent>(&envelope, &key).unwrap(), intent);

        let mut tampered = envelope;
        tampered.message_id = Uuid::new_v4();
        assert!(matches!(
            decrypt::<ClientIntent>(&tampered, &key),
            Err(CryptoError::AuthenticationFailed)
        ));
    }

    #[test]
    fn room_key_encoding_round_trips() {
        let key = generate_room_key();
        assert_eq!(decode_room_key(&encode_room_key(&key)).unwrap(), key);
    }
}

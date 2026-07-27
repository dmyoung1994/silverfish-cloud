export const PROTOCOL_VERSION = 1;

export type ApprovalDecision = "approveOnce" | "decline" | "cancel";

export type ClientIntent =
  | { type: "identify"; displayName: string }
  | { type: "enqueuePrompt"; promptId: string; text: string }
  | { type: "removePrompt"; promptId: string }
  | { type: "movePrompt"; promptId: string; newIndex: number }
  | { type: "steer"; text: string }
  | { type: "interrupt" }
  | { type: "setQueuePaused"; paused: boolean }
  | { type: "approvalDecision"; approvalId: string; decision: ApprovalDecision }
  | { type: "requestSnapshot"; afterSequence?: number };

export interface Participant {
  connectionId: string;
  displayName: string;
  isHost: boolean;
}

export interface QueuedPrompt {
  id: string;
  author: string;
  authorName: string;
  text: string;
  enqueuedAtMs: number;
}

export type TimelineItem =
  | { kind: "userMessage"; id: string; authorName: string; text: string }
  | { kind: "agentMessage"; id: string; text: string; completed: boolean }
  | { kind: "reasoning"; id: string; summary: string }
  | { kind: "plan"; id: string; text: string }
  | { kind: "command"; id: string; command: string; output: string; status: string }
  | { kind: "fileChange"; id: string; path: string; diff: string; status: string }
  | { kind: "tool"; id: string; name: string; detail: string; status: string }
  | { kind: "system"; id: string; message: string };

export interface ApprovalRequest {
  id: string;
  requestId: string | number;
  category: "command" | "network" | "fileChange" | "mcpTool";
  title: string;
  detail: string;
  createdAtMs: number;
}

export interface RoomSnapshot {
  sequence: number;
  projectName: string;
  agentName?: string;
  participants: Participant[];
  queue: QueuedPrompt[];
  queuePaused: boolean;
  activeTurnId?: string;
  timeline: TimelineItem[];
  approvals: ApprovalRequest[];
  recoveryPoints: RecoveryPointSummary[];
}

export interface RecoveryPointSummary {
  checkpointId: string;
  createdAtMs: number;
  fileCount: number;
  totalBytes: number;
}

export type HostEvent =
  | { type: "snapshot"; state: RoomSnapshot }
  | { type: "presence"; participants: Participant[] }
  | { type: "queueUpdated"; queue: QueuedPrompt[]; paused: boolean }
  | { type: "turnState"; active: boolean; turnId?: string }
  | { type: "timeline"; item: TimelineItem }
  | { type: "approvalOpened"; approval: ApprovalRequest }
  | { type: "approvalResolved"; approvalId: string; by: string }
  | { type: "recoveryPoint"; point: RecoveryPointSummary }
  | { type: "error"; code: string; message: string };

export interface SequencedHostEvent {
  sequence: number;
  event: HostEvent;
}

export interface CipherEnvelope {
  version: number;
  roomId: string;
  messageId: string;
  nonce: string;
  ciphertext: string;
}

export type RelayInbound =
  | { type: "ready"; connectionId: string; hostAvailable: boolean }
  | { type: "peerConnected"; connectionId: string }
  | { type: "peerDisconnected"; connectionId: string }
  | { type: "hostAvailable" }
  | { type: "hostUnavailable" }
  | { type: "payload"; from: string; payload: string }
  | { type: "error"; code: string; message: string };

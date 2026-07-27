import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface CodexStatus {
  installed: boolean;
  version?: string;
  compatible: boolean;
  minimumVersion: string;
  dcgInstalled: boolean;
  dcgHookActive: boolean;
}

export type AgentKind = "codex" | "claude";
export type AgentModel = "default" | "gpt-5.6-terra" | "gpt-5.6-sol" | "opus" | "sonnet";

export interface ClaudeStatus {
  installed: boolean;
  version?: string;
  approvalMediated: boolean;
}

export interface AgentStatus {
  codex: CodexStatus;
  claude: ClaudeStatus;
}

export const AGENT_MODELS: Record<AgentKind, ReadonlyArray<{ value: AgentModel; label: string }>> = {
  codex: [
    { value: "default", label: "Default" },
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  ],
  claude: [
    { value: "default", label: "Default" },
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
  ],
};

export type OptionalDependency = "dcg";

export interface CodexThread {
  id: string;
  preview: string;
  name?: string;
  cwd: string;
  updatedAt: number;
}

export interface RecoveryPoint {
  checkpointId: string;
  workspace: string;
  createdAtMs: number;
  fileCount: number;
  totalBytes: number;
}

export const codex = {
  status: () => invoke<AgentStatus>("agent_status"),
  installOptionalDependency: (dependency: OptionalDependency) => invoke<CodexStatus>("install_optional_dependency", { dependency }),
  connect: (agent: AgentKind, model: AgentModel, cwd: string) => invoke<void>("connect_agent", { agent, model, cwd }),
  listThreads: (cwd?: string) => invoke<{ data: CodexThread[] }>("list_threads", { cwd }),
  startThread: (cwd: string) => invoke<{ thread: CodexThread }>("start_thread", { cwd }),
  resumeThread: (threadId: string, cwd: string) => invoke<{ thread: CodexThread }>("resume_thread", { threadId, cwd }),
  startTurn: (threadId: string, text: string) => invoke<unknown>("start_turn", { threadId, text }),
  steer: (threadId: string, turnId: string, text: string) => invoke<unknown>("steer_turn", { threadId, turnId, text }),
  interrupt: (threadId: string, turnId: string) => invoke<unknown>("interrupt_turn", { threadId, turnId }),
  resolveApproval: (requestId: string | number, decision: string) => invoke<void>("resolve_approval", { requestId, decision }),
  denyRequest: (requestId: string | number) => invoke<void>("deny_server_request", { requestId }),
  createRecoveryPoint: (workspace: string) => invoke<RecoveryPoint>("create_recovery_point", { workspace }),
  restoreRecoveryPoint: (workspace: string, checkpointId: string) => invoke<RecoveryPoint>("restore_recovery_point", { workspace, checkpointId }),
  appendAuditEvent: (roomId: string, sequence: number, event: unknown) => invoke<void>("append_audit_event", { roomId, sequence, event }),
  onEvent: (callback: (event: Record<string, unknown>) => void): Promise<UnlistenFn> =>
    listen<Record<string, unknown>>("codex-event", ({ payload }) => callback(payload)),
};

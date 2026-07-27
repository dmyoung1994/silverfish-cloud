import { codex, type AgentKind, type AgentModel } from "./codex";
import { decryptJson, encryptJson } from "./crypto";
import type {
  ApprovalRequest,
  CipherEnvelope,
  ClientIntent,
  HostEvent,
  Participant,
  QueuedPrompt,
  RelayInbound,
  RecoveryPointSummary,
  RoomSnapshot,
  SequencedHostEvent,
  TimelineItem,
} from "./protocol";
import { parseRelayMessage, sendEncrypted } from "./relay";

type StateListener = (snapshot: RoomSnapshot) => void;
type ErrorListener = (message: string) => void;

export class HostRoomController {
  private sequence = 0;
  private ownConnectionId = "host";
  private participants = new Map<string, Participant>();
  private queue: QueuedPrompt[] = [];
  private queuePaused = false;
  private activeTurnId: string | undefined;
  private timeline: TimelineItem[] = [];
  private approvals = new Map<string, ApprovalRequest>();
  private recoveryPoints: RecoveryPointSummary[] = [];
  private draining = false;
  private pendingHandoff = "";
  private unlistenCodex?: () => void;

  constructor(
    private readonly socket: WebSocket,
    private readonly roomId: string,
    private readonly key: Uint8Array<ArrayBuffer>,
    private threadId: string,
    private readonly workspace: string,
    private agentName: string,
    private readonly onState: StateListener,
    private readonly onError: ErrorListener,
  ) {
    socket.addEventListener("message", (event) => void this.handleRelay(parseRelayMessage(event)));
    socket.addEventListener("close", () => onError("Relay connection closed"));
    void codex.onEvent((event) => void this.handleCodexEvent(event)).then((unlisten) => {
      this.unlistenCodex = unlisten;
    });
  }

  close(): void {
    this.unlistenCodex?.();
    this.socket.close();
  }

  snapshot(): RoomSnapshot {
    return {
      sequence: this.sequence,
      projectName: workspaceName(this.workspace),
      agentName: this.agentName,
      participants: [...this.participants.values()],
      queue: [...this.queue],
      queuePaused: this.queuePaused,
      activeTurnId: this.activeTurnId,
      timeline: [...this.timeline],
      approvals: [...this.approvals.values()],
      recoveryPoints: [...this.recoveryPoints],
    };
  }

  async submitHostPrompt(text: string): Promise<void> {
    await this.handleIntent(this.ownConnectionId, {
      type: "enqueuePrompt",
      promptId: crypto.randomUUID(),
      text,
    });
  }

  async steerHost(text: string): Promise<void> {
    await this.handleIntent(this.ownConnectionId, { type: "steer", text });
  }

  async interruptHost(): Promise<void> {
    await this.handleIntent(this.ownConnectionId, { type: "interrupt" });
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.handleIntent(this.ownConnectionId, { type: "setQueuePaused", paused });
  }

  async decideApproval(approvalId: string, decision: "approveOnce" | "decline" | "cancel"): Promise<void> {
    await this.handleIntent(this.ownConnectionId, { type: "approvalDecision", approvalId, decision });
  }

  async restoreCheckpoint(checkpointId: string): Promise<void> {
    this.queuePaused = true;
    await this.publishQueue();
    if (this.activeTurnId) await codex.interrupt(this.threadId, this.activeTurnId);
    await codex.restoreRecoveryPoint(this.workspace, checkpointId);
    const item: TimelineItem = {
      kind: "system",
      id: crypto.randomUUID(),
      message: `Host restored workspace checkpoint ${checkpointId.slice(0, 8)}.`,
    };
    this.upsertTimeline(item);
    await this.publish({ type: "timeline", item });
  }

  async switchAgent(agent: AgentKind, model: AgentModel): Promise<void> {
    this.queuePaused = true;
    await this.publishQueue();
    if (this.activeTurnId) await codex.interrupt(this.threadId, this.activeTurnId);
    const nextName = agent === "codex" ? "Codex" : "Claude Code";
    const handoff = buildHandoff(this.workspace, this.timeline, this.queue);
    await codex.connect(agent, model, this.workspace);
    const thread = (await codex.startThread(this.workspace)).thread;
    this.threadId = thread.id;
    this.agentName = nextName;
    this.pendingHandoff = handoff;
    const item: TimelineItem = {
      kind: "system",
      id: crypto.randomUUID(),
      message: `Host switched the room to ${nextName}${model === "default" ? "" : ` (${model})`}. The next turn receives a redacted handoff.`,
    };
    this.upsertTimeline(item);
    await this.publish({ type: "timeline", item });
    this.queuePaused = false;
    await this.publishQueue();
    void this.drainQueue();
  }

  private async handleRelay(message: RelayInbound): Promise<void> {
    switch (message.type) {
      case "ready":
        this.ownConnectionId = message.connectionId;
        this.participants.set(message.connectionId, {
          connectionId: message.connectionId,
          displayName: "Host",
          isHost: true,
        });
        await this.publish({ type: "presence", participants: [...this.participants.values()] });
        break;
      case "peerConnected":
        await this.sendSnapshot(message.connectionId);
        break;
      case "peerDisconnected":
        this.participants.delete(message.connectionId);
        await this.publish({ type: "presence", participants: [...this.participants.values()] });
        break;
      case "payload": {
        try {
          const envelope = JSON.parse(message.payload) as CipherEnvelope;
          if (envelope.roomId !== this.roomId) throw new Error("Room mismatch");
          const intent = await decryptJson<ClientIntent>(envelope, this.key);
          await this.handleIntent(message.from, intent);
        } catch {
          await this.sendError(message.from, "invalid_envelope", "The encrypted message could not be authenticated");
        }
        break;
      }
      case "error":
        this.onError(message.message);
        break;
    }
  }

  private async handleIntent(sender: string, intent: ClientIntent): Promise<void> {
    const participant = this.participants.get(sender);
    if (intent.type !== "identify" && !participant) {
      await this.sendError(sender, "identify_first", "Choose a display name before controlling the session");
      return;
    }

    switch (intent.type) {
      case "identify": {
        const displayName = cleanText(intent.displayName, 48) || "Guest";
        this.participants.set(sender, { connectionId: sender, displayName, isHost: false });
        await this.publish({ type: "presence", participants: [...this.participants.values()] });
        await this.sendSnapshot(sender);
        break;
      }
      case "enqueuePrompt": {
        const text = cleanText(intent.text, 32_000);
        if (!text) return;
        const author = this.participants.get(sender)!;
        const prompt: QueuedPrompt = {
          id: intent.promptId,
          author: sender,
          authorName: author.displayName,
          text,
          enqueuedAtMs: Date.now(),
        };
        this.queue.push(prompt);
        this.upsertTimeline({
          kind: "userMessage",
          id: prompt.id,
          authorName: prompt.authorName,
          text: prompt.text,
        });
        await this.publish({ type: "timeline", item: this.timeline.at(-1)! });
        await this.publishQueue();
        void this.drainQueue();
        break;
      }
      case "removePrompt":
        this.queue = this.queue.filter((prompt) => prompt.id !== intent.promptId);
        await this.publishQueue();
        break;
      case "movePrompt": {
        const index = this.queue.findIndex((prompt) => prompt.id === intent.promptId);
        if (index < 0) return;
        const [prompt] = this.queue.splice(index, 1);
        this.queue.splice(Math.min(Math.max(intent.newIndex, 0), this.queue.length), 0, prompt);
        await this.publishQueue();
        break;
      }
      case "steer":
        if (!this.activeTurnId) {
          await this.sendError(sender, "no_active_turn", "There is no active turn to steer");
          return;
        }
        await codex.steer(this.threadId, this.activeTurnId, cleanText(intent.text, 32_000));
        break;
      case "interrupt":
        if (this.activeTurnId) await codex.interrupt(this.threadId, this.activeTurnId);
        break;
      case "setQueuePaused":
        this.queuePaused = intent.paused;
        await this.publishQueue();
        if (!intent.paused) void this.drainQueue();
        break;
      case "approvalDecision": {
        const approval = this.approvals.get(intent.approvalId);
        if (!approval) return;
        this.approvals.delete(intent.approvalId);
        await codex.resolveApproval(approval.requestId, intent.decision);
        await this.publish({ type: "approvalResolved", approvalId: approval.id, by: sender });
        break;
      }
      case "requestSnapshot":
        await this.sendSnapshot(sender);
        break;
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.draining || this.queuePaused || this.activeTurnId || this.queue.length === 0) return;
    this.draining = true;
    const next = this.queue.shift()!;
    await this.publishQueue();
    try {
      const checkpoint = await codex.createRecoveryPoint(this.workspace);
      const point: RecoveryPointSummary = {
        checkpointId: checkpoint.checkpointId,
        createdAtMs: checkpoint.createdAtMs,
        fileCount: checkpoint.fileCount,
        totalBytes: checkpoint.totalBytes,
      };
      this.recoveryPoints = [point, ...this.recoveryPoints].slice(0, 20);
      await this.publish({ type: "recoveryPoint", point });
      const text = this.pendingHandoff
        ? `${this.pendingHandoff}\n\nNew room request:\n${next.text}`
        : next.text;
      this.pendingHandoff = "";
      await codex.startTurn(this.threadId, text);
    } catch (error) {
      this.queue.unshift(next);
      this.queuePaused = true;
      await this.publishQueue();
      this.onError(String(error));
    } finally {
      this.draining = false;
    }
  }

  private async handleCodexEvent(raw: Record<string, unknown>): Promise<void> {
    const method = String(raw.method ?? "");
    const params = (raw.params ?? {}) as Record<string, unknown>;
    if ((typeof raw.id === "number" || typeof raw.id === "string") && method) {
      await this.handleServerRequest(raw.id, method, params);
      return;
    }
    if (method === "turn/started") {
      const turn = (params.turn ?? {}) as Record<string, unknown>;
      this.activeTurnId = String(turn.id ?? "");
      await this.publish({ type: "turnState", active: true, turnId: this.activeTurnId });
      return;
    }
    if (method === "turn/completed") {
      this.activeTurnId = undefined;
      await this.publish({ type: "turnState", active: false });
      void this.drainQueue();
      return;
    }

    const item = normalizeCodexEvent(method, params, this.timeline);
    if (item) {
      this.upsertTimeline(item);
      await this.publish({ type: "timeline", item });
    }
  }

  private async handleServerRequest(requestId: string | number, method: string, params: Record<string, unknown>): Promise<void> {
    const allowed = method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
    if (!allowed) {
      await codex.denyRequest(requestId);
      return;
    }
    const approval: ApprovalRequest = {
      id: String(requestId),
      requestId,
      category: method.includes("fileChange") ? "fileChange" : params.networkApprovalContext ? "network" : "command",
      title: method.includes("fileChange") ? "Approve file change" : "Approve command",
      detail: redactSecrets(JSON.stringify(params.command ?? params.reason ?? params, null, 2)),
      createdAtMs: Date.now(),
    };
    this.approvals.set(approval.id, approval);
    await this.publish({ type: "approvalOpened", approval });
  }

  private upsertTimeline(item: TimelineItem): void {
    const index = this.timeline.findIndex((existing) => existing.id === item.id);
    if (index >= 0) this.timeline[index] = item;
    else this.timeline.push(item);
    if (this.timeline.length > 2_000) this.timeline.splice(0, this.timeline.length - 2_000);
    this.onState(this.snapshot());
  }

  private async publishQueue(): Promise<void> {
    await this.publish({ type: "queueUpdated", queue: [...this.queue], paused: this.queuePaused });
  }

  private async publish(event: HostEvent): Promise<void> {
    this.sequence += 1;
    const message: SequencedHostEvent = { sequence: this.sequence, event };
    try {
      await codex.appendAuditEvent(this.roomId, this.sequence, event);
    } catch (error) {
      this.onError(`Local audit write failed: ${String(error)}`);
    }
    const envelope = await encryptJson(this.roomId, this.key, message);
    sendEncrypted(this.socket, "all", envelope);
    this.onState(this.snapshot());
  }

  private async sendSnapshot(connectionId: string): Promise<void> {
    const message: SequencedHostEvent = {
      sequence: this.sequence,
      event: { type: "snapshot", state: this.snapshot() },
    };
    const envelope = await encryptJson(this.roomId, this.key, message);
    sendEncrypted(this.socket, { connection: connectionId }, envelope);
  }

  private async sendError(connectionId: string, code: string, message: string): Promise<void> {
    const envelope = await encryptJson(this.roomId, this.key, {
      sequence: this.sequence,
      event: { type: "error", code, message },
    } satisfies SequencedHostEvent);
    sendEncrypted(this.socket, { connection: connectionId }, envelope);
  }
}

export function workspaceName(workspace: string): string {
  const segments = workspace.trim().split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) || workspace.trim() || "Project";
}

function buildHandoff(workspace: string, timeline: TimelineItem[], queue: QueuedPrompt[]): string {
  const recent = timeline.slice(-24).map((item) => {
    if (item.kind === "userMessage") return `User (${item.authorName}): ${item.text}`;
    if (item.kind === "agentMessage") return `Agent: ${item.text}`;
    if (item.kind === "fileChange") return `File change: ${item.path}`;
    if (item.kind === "command") return `Command: ${item.command} (${item.status})`;
    if (item.kind === "system") return `System: ${item.message}`;
    return item.kind;
  }).join("\n");
  const waiting = queue.slice(0, 8).map((prompt) => `${prompt.authorName}: ${prompt.text}`).join("\n");
  return cleanText(`You are taking over an existing shared coding room. Workspace: ${workspace}.\nRecent room context:\n${recent || "No earlier activity."}\nQueued work:\n${waiting || "None."}\nContinue safely; request approval for commands and file changes.`, 16_000);
}

function normalizeCodexEvent(method: string, params: Record<string, unknown>, timeline: TimelineItem[]): TimelineItem | undefined {
  const itemId = String(params.itemId ?? ((params.item as Record<string, unknown> | undefined)?.id) ?? crypto.randomUUID());
  const prior = timeline.find((item) => item.id === itemId);
  const delta = redactSecrets(String(params.delta ?? ""));
  if (method === "item/agentMessage/delta") {
    return { kind: "agentMessage", id: itemId, text: `${prior?.kind === "agentMessage" ? prior.text : ""}${delta}`, completed: false };
  }
  if (method === "item/reasoning/summaryTextDelta") {
    return { kind: "reasoning", id: itemId, summary: `${prior?.kind === "reasoning" ? prior.summary : ""}${delta}` };
  }
  if (method === "item/plan/delta") {
    return { kind: "plan", id: itemId, text: `${prior?.kind === "plan" ? prior.text : ""}${delta}` };
  }
  if (method === "item/commandExecution/outputDelta") {
    return {
      kind: "command",
      id: itemId,
      command: prior?.kind === "command" ? prior.command : "Command",
      output: `${prior?.kind === "command" ? prior.output : ""}${delta}`,
      status: "inProgress",
    };
  }
  if (method === "item/fileChange/patchUpdated" || method === "item/fileChange/outputDelta") {
    return {
      kind: "fileChange",
      id: itemId,
      path: prior?.kind === "fileChange" ? prior.path : "Workspace changes",
      diff: `${prior?.kind === "fileChange" ? prior.diff : ""}${delta || redactSecrets(JSON.stringify(params.patch ?? ""))}`,
      status: "inProgress",
    };
  }
  if (method === "item/completed" || method === "item/started") {
    const rawItem = (params.item ?? {}) as Record<string, unknown>;
    const type = String(rawItem.type ?? "");
    if (type === "agentMessage") {
      const text = rawItem.text ?? (prior?.kind === "agentMessage" ? prior.text : "");
      return { kind: "agentMessage", id: itemId, text: redactSecrets(String(text)), completed: method === "item/completed" };
    }
    if (type === "commandExecution") {
      const command = Array.isArray(rawItem.command) ? rawItem.command.join(" ") : String(rawItem.command ?? "Command");
      return { kind: "command", id: itemId, command: redactSecrets(command), output: prior?.kind === "command" ? prior.output : "", status: String(rawItem.status ?? "inProgress") };
    }
  }
  return undefined;
}

function cleanText(value: string, maxLength: number): string {
  return value.replaceAll("\0", "").trim().slice(0, maxLength);
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bgh[opusr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]")
    .slice(0, 512_000);
}

import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  Bot,
  Check,
  ChevronRight,
  CircleStop,
  Clipboard,
  Command,
  Download,
  FileDiff,
  FolderOpen,
  KeyRound,
  Link2,
  LoaderCircle,
  MessageSquarePlus,
  Pause,
  Play,
  Send,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Users,
  X,
} from "lucide-react";
import { LandingPage } from "./LandingPage";
import { SilverfishMark } from "./SilverfishMark";
import { codex, type CodexStatus, type OptionalDependency } from "./codex";
import { decodeBase64Url, decryptJson, encodeBase64Url, encryptJson, generateRoomKey } from "./crypto";
import type {
  ApprovalDecision,
  CipherEnvelope,
  ClientIntent,
  HostEvent,
  RelayInbound,
  RoomSnapshot,
  SequencedHostEvent,
  TimelineItem,
} from "./protocol";
import { HostRoomController, workspaceName } from "./room-controller";
import {
  createRelayInvite,
  createRelayRoom,
  closeRelayRoom,
  ejectRelayGuest,
  normalizeRelayUrl,
  openRelaySocket,
  parseRelayMessage,
  type RelayRoomLimits,
  sendEncrypted,
  socketUrl,
} from "./relay";

const emptySnapshot: RoomSnapshot = {
  sequence: 0,
  projectName: "",
  participants: [],
  queue: [],
  queuePaused: false,
  timeline: [],
  approvals: [],
  recoveryPoints: [],
};

const configuredRelayUrl = (
  import.meta.env.VITE_SILVERFISH_RELAY_URL ?? import.meta.env.VITE_CO_DEX_RELAY_URL
)?.trim();
const configuredPublicUrl = import.meta.env.VITE_SILVERFISH_PUBLIC_URL?.trim();
const subscribeHref = import.meta.env.VITE_SILVERFISH_SUBSCRIBE_URL?.trim();
const isManagedService = import.meta.env.VITE_SILVERFISH_MANAGED_SERVICE === "true";
const defaultRelayUrl = configuredRelayUrl || "http://127.0.0.1:8787";

interface RoomActions {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  interrupt(): Promise<void>;
  pause(paused: boolean): Promise<void>;
  decide(id: string, decision: ApprovalDecision): Promise<void>;
  restore?(checkpointId: string): Promise<void>;
}

export default function App() {
  const guestCredentials = useMemo(parseGuestCredentials, []);
  if (guestCredentials) return <GuestApp credentials={guestCredentials} />;
  return isTauriApp() ? <HostApp /> : <LandingPage />;
}

function isTauriApp(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function HostApp() {
  const [status, setStatus] = useState<CodexStatus>();
  const [cwd, setCwd] = useState("");
  const [relayUrl, setRelayUrl] = useState(defaultRelayUrl);
  const [starting, setStarting] = useState(false);
  const [installingDependency, setInstallingDependency] = useState<OptionalDependency>();
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [controller, setController] = useState<HostRoomController>();
  const [inviteToast, setInviteToast] = useState("");
  const [creatingInvite, setCreatingInvite] = useState(false);
  const inviteToastTimeout = useRef<number | undefined>(undefined);
  const [roomSecrets, setRoomSecrets] = useState<{
    roomId: string;
    hostToken: string;
    limits: RelayRoomLimits;
    key: Uint8Array<ArrayBuffer>;
  }>();
  const [error, setError] = useState("");

  useEffect(() => {
    void codex.status().then(setStatus).catch(() => setError("Open this page in the Silverfish desktop app to host a room."));
  }, []);

  async function chooseWorkspace() {
    setError("");
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose a workspace folder",
        defaultPath: cwd || undefined,
      });
      if (selected) setCwd(selected);
    } catch (reason) {
      setError(`Could not open the folder picker: ${String(reason)}`);
    }
  }

  async function installDependency(dependency: OptionalDependency) {
    setInstallingDependency(dependency);
    setError("");
    try {
      const nextStatus = await codex.installOptionalDependency(dependency);
      setStatus(nextStatus);
      if (dependency === "dcg" && (!nextStatus.dcgInstalled || !nextStatus.dcgHookActive)) {
        setError("dcg was installed, but its Codex hook could not be verified. Click the dependency again to retry configuration.");
      }
    } catch (reason) {
      setError(`Could not install ${dependency}: ${String(reason)}`);
    } finally {
      setInstallingDependency(undefined);
    }
  }

  async function connectAndHostRoom() {
    if (!cwd.trim()) {
      setError("Choose the workspace directory before sharing a session.");
      return;
    }
    setStarting(true);
    setError("");
    try {
      await codex.connect();
      const thread = (await codex.startThread(cwd)).thread;
      const room = await createRelayRoom(relayUrl);
      const key = generateRoomKey();
      const socket = openRelaySocket(socketUrl(relayUrl, room.roomId, "host"), room.hostToken);
      const nextController = new HostRoomController(
        socket,
        room.roomId,
        key,
        thread.id,
        cwd,
        setSnapshot,
        setError,
      );
      await waitForSocket(socket);
      setRoomSecrets({ ...room, key });
      setController(nextController);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setStarting(false);
    }
  }

  async function createInvite() {
    if (!roomSecrets || creatingInvite) return;
    setCreatingInvite(true);
    try {
      const invite = await createRelayInvite(relayUrl, roomSecrets.roomId, roomSecrets.hostToken);
      const base = `${normalizeRelayUrl(configuredPublicUrl || relayUrl)}/join`;
      const fragment = new URLSearchParams({
        room: roomSecrets.roomId,
        invite: invite.inviteId,
        token: invite.inviteToken,
        key: encodeBase64Url(roomSecrets.key),
        relay: normalizeRelayUrl(relayUrl),
      });
      await navigator.clipboard.writeText(`${base}#${fragment}`);
      window.clearTimeout(inviteToastTimeout.current);
      setInviteToast("Room link copied to clipboard.");
      inviteToastTimeout.current = window.setTimeout(() => setInviteToast(""), 2400);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setCreatingInvite(false);
    }
  }

  async function endRoom() {
    if (!roomSecrets || !controller) return;
    if (!confirm("End this room and disconnect every collaborator?")) return;
    try {
      await closeRelayRoom(relayUrl, roomSecrets.roomId, roomSecrets.hostToken);
    } finally {
      controller.close();
      setController(undefined);
      setRoomSecrets(undefined);
      setInviteToast("");
      setSnapshot(emptySnapshot);
    }
  }

  useEffect(() => () => controller?.close(), [controller]);
  useEffect(() => () => window.clearTimeout(inviteToastTimeout.current), []);

  if (controller) {
    const actions: RoomActions = {
      prompt: (text) => controller.submitHostPrompt(text),
      steer: (text) => controller.steerHost(text),
      interrupt: () => controller.interruptHost(),
      pause: (paused) => controller.setPaused(paused),
      decide: (id, decision) => controller.decideApproval(id, decision),
      restore: (checkpointId) => controller.restoreCheckpoint(checkpointId),
    };
    return (
      <RoomShell
        snapshot={snapshot}
        actions={actions}
        isHost
        projectName={workspaceName(cwd)}
        connectionLabel="Host · encrypted"
        roomLimits={roomSecrets?.limits}
        managedService={isManagedService}
        subscribeHref={subscribeHref}
        inviteToast={inviteToast}
        creatingInvite={creatingInvite}
        onCreateInvite={createInvite}
        onCloseRoom={endRoom}
        onEject={(connectionId) => roomSecrets && ejectRelayGuest(relayUrl, roomSecrets.roomId, roomSecrets.hostToken, connectionId)}
        error={error}
      />
    );
  }

  const connectBlocker = connectDisabledReason(status, cwd, starting, installingDependency);

  return (
    <main className="setup-shell">
      <section className="brand-panel">
        <div className="brand-mark"><SilverfishMark size={28} /></div>
        <div>
          <p className="eyebrow">MULTIPLAYER AGENTIC DEVELOPMENT</p>
          <h1>Build together,<br /><span>through one agent.</span></h1>
          <p className="lede">A shared Codex session with live prompts, steering, approvals, commands, and diffs. Your machine stays the host.</p>
        </div>
        <div className="security-strip">
          <ShieldCheck size={18} />
          <span>Credentials stay local</span>
          <span className="dot" />
          <span>End-to-end encrypted</span>
        </div>
      </section>
      <section className="setup-panel">
        <div className="setup-card">
          <div className="step-number">01</div>
          <div>
            <h2>Connect the host</h2>
            <p>Silverfish uses your existing Codex login and starts a new thread automatically.</p>
          </div>
          <StatusGrid status={status} installing={installingDependency} onInstall={installDependency} />
          <label>
            <span>Workspace directory</span>
            <div className="path-picker">
              <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="Choose a project folder…" />
              <button type="button" onClick={() => void chooseWorkspace()} disabled={starting} aria-label="Browse for workspace folder" title="Browse for workspace folder">
                <FolderOpen size={18} />
                Browse
              </button>
            </div>
          </label>
          {!configuredRelayUrl ? (
            <label>
              <span>Self-hosted relay</span>
              <input value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} placeholder="https://relay.example.com" />
            </label>
          ) : null}
          {isManagedService ? <HostedPlanCard subscribeUrl={subscribeHref} /> : null}
          <div
            className="button-tooltip"
            data-tooltip={connectBlocker || undefined}
            tabIndex={connectBlocker ? 0 : undefined}
          >
            <button className="primary" onClick={connectAndHostRoom} disabled={Boolean(connectBlocker)}>
              {starting ? <LoaderCircle className="spin" size={18} /> : <KeyRound size={18} />}
              Connect &amp; create room
            </button>
          </div>
          {error && <div className="error-banner">{error}</div>}
        </div>
      </section>
    </main>
  );
}

function connectDisabledReason(
  status: CodexStatus | undefined,
  cwd: string,
  starting: boolean,
  installing: OptionalDependency | undefined,
): string {
  if (starting) return "Codex is already connecting.";
  if (installing) return `Wait for the optional ${installing} installation to finish.`;
  if (!status) return "Checking the required Codex dependency…";
  if (!status.installed) return "Install and authenticate the Codex CLI before connecting.";
  if (!status.compatible) return `Update Codex to version ${status.minimumVersion} or newer before connecting.`;
  if (!cwd.trim()) return "Choose a workspace directory before connecting.";
  return "";
}

function StatusGrid({ status, installing, onInstall }: {
  status?: CodexStatus;
  installing?: OptionalDependency;
  onInstall: (dependency: OptionalDependency) => Promise<void>;
}) {
  const requiredRows = [
    ["Codex CLI", status?.installed, status?.version || "Checking…"],
    ["App-server API", status?.compatible, status ? `≥ ${status.minimumVersion}` : "Checking…"],
  ] as const;
  const optionalRows: Array<{
    id: OptionalDependency;
    label: string;
    ready: boolean;
    detail: string;
  }> = [{
    id: "dcg",
    label: "Destructive guard",
    ready: Boolean(status?.dcgInstalled && status?.dcgHookActive),
    detail: installing === "dcg"
      ? "Installing…"
      : status?.dcgHookActive
        ? "Optional · hook active"
        : status?.dcgInstalled
          ? "Optional · click to configure"
          : "Optional · click to install",
  }];
  return (
    <div className="status-grid">
      {requiredRows.map(([label, ready, detail]) => (
        <div key={label} className="status-row">
          <span className={ready ? "status-dot ready" : "status-dot"} />
          <span>{label}</span>
          <code>{detail}</code>
        </div>
      ))}
      {optionalRows.map((dependency) => (
        <button
          type="button"
          key={dependency.id}
          className="status-row dependency-row"
          onClick={() => void onInstall(dependency.id)}
          disabled={!status || dependency.ready || installing === dependency.id}
          title={dependency.ready ? `${dependency.label} is installed` : `Install ${dependency.label}`}
        >
          <span className={dependency.ready ? "status-dot ready" : "status-dot optional"} />
          <span>{dependency.label}</span>
          <code>
            {dependency.detail}
            {installing === dependency.id
              ? <LoaderCircle className="spin" size={13} />
              : !dependency.ready && <Download size={13} />}
          </code>
        </button>
      ))}
    </div>
  );
}

function HostedPlanCard({ subscribeUrl }: { subscribeUrl?: string }) {
  return (
    <div className="hosted-plan-card">
      <div>
        <span>HOSTED FREE</span>
        <strong>1 guest · 60-minute rooms</strong>
        <p>No account or card required. Self-hosted relays are always separate and use their own limits.</p>
      </div>
      {subscribeUrl ? (
        <a href={subscribeUrl} target="_blank" rel="noreferrer">
          Founding Host · $15/month
          <ChevronRight size={15} />
        </a>
      ) : (
        <span className="hosted-plan-pending">Founding Host · $15/month · checkout opening soon</span>
      )}
    </div>
  );
}

interface GuestCredentials {
  roomId: string;
  inviteId: string;
  token: string;
  key: Uint8Array<ArrayBuffer>;
  relayUrl: string;
}

function GuestApp({ credentials }: { credentials: GuestCredentials }) {
  const [name, setName] = useState("");
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [socket, setSocket] = useState<WebSocket>();
  const [connectionId, setConnectionId] = useState("");
  const [error, setError] = useState("");
  const lastSequence = useRef(0);

  async function send(intent: ClientIntent) {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Room is not connected");
    const envelope = await encryptJson(credentials.roomId, credentials.key, intent);
    sendEncrypted(socket, "host", envelope);
  }

  async function join() {
    setError("");
    try {
      const nextSocket = openRelaySocket(
        socketUrl(credentials.relayUrl, credentials.roomId, "guest", credentials.inviteId),
        credentials.token,
      );
      nextSocket.addEventListener("message", (event) => {
        void handleGuestRelay(parseRelayMessage(event), credentials, setSnapshot, setConnectionId, setError, lastSequence);
      });
      nextSocket.addEventListener("close", () => setError("Disconnected from the room"));
      await waitForSocket(nextSocket);
      setSocket(nextSocket);
      const envelope = await encryptJson(credentials.roomId, credentials.key, {
        type: "identify",
        displayName: name,
      } satisfies ClientIntent);
      sendEncrypted(nextSocket, "host", envelope);
    } catch (reason) {
      setError(String(reason));
    }
  }

  useEffect(() => () => {
    socket?.close();
  }, [socket]);

  if (!socket) {
    return (
      <main className="join-shell">
        <div className="join-card">
          <div className="brand-mark"><SilverfishMark size={27} /></div>
          <p className="eyebrow">YOU’VE BEEN INVITED</p>
          <h1>Join the session</h1>
          <p>Your prompts and actions will be visible and attributed to this name.</p>
          <label><span>Display name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && name.trim() && void join()} /></label>
          <button className="primary" onClick={join} disabled={!name.trim()}><ChevronRight size={18} /> Enter room</button>
          <div className="encrypted-note"><ShieldCheck size={16} /> End-to-end encrypted with the host</div>
          {error && <div className="error-banner">{error}</div>}
        </div>
      </main>
    );
  }

  if (!connectionId) {
    return (
      <main className="join-shell">
        <div className="join-card">
          <LoaderCircle className="spin" size={28} />
          <h2>Joining room…</h2>
          <p>Waiting for the relay to finish the secure connection.</p>
          {error ? <div className="error-banner">{error}</div> : null}
        </div>
      </main>
    );
  }

  const actions: RoomActions = {
    prompt: (text) => send({ type: "enqueuePrompt", promptId: crypto.randomUUID(), text }),
    steer: (text) => send({ type: "steer", text }),
    interrupt: () => send({ type: "interrupt" }),
    pause: (paused) => send({ type: "setQueuePaused", paused }),
    decide: (approvalId, decision) => send({ type: "approvalDecision", approvalId, decision }),
  };
  return <RoomShell snapshot={snapshot} actions={actions} isHost={false} connectionLabel={`${name} · ${connectionId.slice(0, 5)}`} error={error} />;
}

async function handleGuestRelay(
  relay: RelayInbound,
  credentials: GuestCredentials,
  setSnapshot: (value: RoomSnapshot | ((current: RoomSnapshot) => RoomSnapshot)) => void,
  setConnectionId: (value: string) => void,
  setError: (value: string) => void,
  lastSequence: React.MutableRefObject<number>,
) {
  if (relay.type === "ready") {
    if (!relay.connectionId) {
      setError("The relay returned invalid connection metadata.");
      return;
    }
    setConnectionId(relay.connectionId);
    if (!relay.hostAvailable) setError("The host is offline. Waiting for them to reconnect…");
  } else if (relay.type === "hostUnavailable") {
    setError("The host disconnected. This room is temporarily unavailable.");
  } else if (relay.type === "hostAvailable") {
    setError("");
  } else if (relay.type === "error") {
    setError(isManagedService ? friendlyRelayError(relay.code, relay.message) : relay.message);
  } else if (relay.type === "payload") {
    try {
      const envelope = JSON.parse(relay.payload) as CipherEnvelope;
      const message = await decryptJson<SequencedHostEvent>(envelope, credentials.key);
      if (message.sequence < lastSequence.current) return;
      lastSequence.current = message.sequence;
      setSnapshot((current) => applyHostEvent(current, message.event, message.sequence));
    } catch {
      setError("An encrypted room event failed authentication.");
    }
  }
}

function applyHostEvent(current: RoomSnapshot, event: HostEvent, sequence: number): RoomSnapshot {
  if (event.type === "snapshot") return event.state;
  if (event.type === "presence") return { ...current, sequence, participants: event.participants };
  if (event.type === "queueUpdated") return { ...current, sequence, queue: event.queue, queuePaused: event.paused };
  if (event.type === "turnState") return { ...current, sequence, activeTurnId: event.active ? event.turnId : undefined };
  if (event.type === "approvalOpened") return { ...current, sequence, approvals: [...current.approvals.filter((item) => item.id !== event.approval.id), event.approval] };
  if (event.type === "approvalResolved") return { ...current, sequence, approvals: current.approvals.filter((item) => item.id !== event.approvalId) };
  if (event.type === "recoveryPoint") return { ...current, sequence, recoveryPoints: [event.point, ...current.recoveryPoints.filter((point) => point.checkpointId !== event.point.checkpointId)].slice(0, 20) };
  if (event.type === "timeline") {
    const index = current.timeline.findIndex((item) => item.id === event.item.id);
    const timeline = [...current.timeline];
    if (index >= 0) timeline[index] = event.item;
    else timeline.push(event.item);
    return { ...current, sequence, timeline };
  }
  return current;
}

function RoomShell({ snapshot, actions, isHost, projectName, connectionLabel, roomLimits, managedService, subscribeHref, inviteToast, creatingInvite, onCreateInvite, onCloseRoom, onEject, error }: {
  snapshot: RoomSnapshot;
  actions: RoomActions;
  isHost: boolean;
  projectName?: string;
  connectionLabel: string;
  roomLimits?: RelayRoomLimits;
  managedService?: boolean;
  subscribeHref?: string;
  inviteToast?: string;
  creatingInvite?: boolean;
  onCreateInvite?: () => Promise<void>;
  onCloseRoom?: () => void;
  onEject?: (connectionId: string) => Promise<void> | undefined;
  error?: string;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"prompt" | "steer">("prompt");
  const [now, setNow] = useState(Date.now());
  const endRef = useRef<HTMLDivElement>(null);
  const displayProjectName = projectName || snapshot.projectName || "Project";
  const roomConnectionLabel = roomLimits ? hostConnectionLabel(roomLimits, now) : connectionLabel;
  const stickyAgentMessageIndex = snapshot.timeline.reduce(
    (lastIndex, item, index) => item.kind === "agentMessage" && item.completed ? index : lastIndex,
    -1,
  );
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [snapshot.timeline.length]);
  useEffect(() => {
    if (!roomLimits?.expiresAtMs) return;
    const interval = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, [roomLimits?.expiresAtMs]);

  async function submit() {
    const value = text.trim();
    if (!value) return;
    setText("");
    if (mode === "steer") await actions.steer(value);
    else await actions.prompt(value);
  }

  return (
    <main className="room-shell">
      <header className="room-header">
        <div className="room-brand"><div className="brand-mark small"><SilverfishMark size={21} /></div><strong>Silverfish</strong><span>/</span><span className="project-name" title={displayProjectName}>{displayProjectName}</span></div>
        <div className="room-status"><span className="live-dot" /> LIVE <span className="room-divider" /> {roomConnectionLabel}</div>
        <div className="header-actions">
          {isHost ? <button className="invite-link" onClick={() => void onCreateInvite?.()} disabled={creatingInvite} aria-label="Copy invite link">Invite <Link2 size={15} /></button> : null}
          {isHost && <button className="secondary end-room" onClick={onCloseRoom}>End room</button>}
          <button className="icon-button danger" title="Interrupt turn" disabled={!snapshot.activeTurnId} onClick={() => void actions.interrupt()}><CircleStop size={18} /></button>
        </div>
      </header>
      {inviteToast ? <div className="invite-toast" role="status"><Check size={16} /><span>{inviteToast}</span></div> : null}
      <div className="room-banners">
        {isHost && managedService && roomLimits ? (
          <div className="hosted-room-banner">
            <span><strong>Hosted free room</strong> · {roomLimitSummary(roomLimits, now)}</span>
            {subscribeHref ? <a href={subscribeHref} target="_blank" rel="noreferrer">Upgrade</a> : null}
          </div>
        ) : null}
        {error && <div className="room-error">{error}</div>}
      </div>
      <div className="room-grid">
        <section className="timeline-panel">
          <div className="timeline-scroll">
            {snapshot.timeline.length === 0 ? (
              <div className="empty-timeline"><Bot size={34} /><h2>The room is ready</h2><p>Send the first prompt to begin working together.</p></div>
            ) : snapshot.timeline.map((item, index) => (
              <TimelineCard
                key={item.id}
                item={item}
                sticky={index === stickyAgentMessageIndex}
              />
            ))}
            <div ref={endRef} />
          </div>
          <div className="composer-wrap">
            <div className="mode-tabs">
              <button className={mode === "prompt" ? "active" : ""} onClick={() => setMode("prompt")}><MessageSquarePlus size={14} /> Queue prompt</button>
              <button className={mode === "steer" ? "active" : ""} disabled={!snapshot.activeTurnId} onClick={() => setMode("steer")}><Activity size={14} /> Steer now</button>
            </div>
            <div className="composer">
              <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
              }} placeholder={mode === "steer" ? "Redirect the active turn…" : "Ask Codex to build, inspect, or change something…"} />
              <button onClick={() => void submit()} disabled={!text.trim()}><Send size={18} /></button>
            </div>
            <div className="composer-foot"><span>Enter to send · Shift+Enter for newline</span><span>{text.length.toLocaleString()} / 32,000</span></div>
          </div>
        </section>
        <aside className="room-sidebar">
          <SidebarSection icon={<Users size={15} />} title="In this room" count={snapshot.participants.length}>
            <div className="participants">{snapshot.participants.map((person) => <div className="participant" key={person.connectionId}><span className="avatar">{person.displayName.slice(0, 1).toUpperCase()}</span><span>{person.displayName}</span>{person.isHost ? <em>HOST</em> : isHost && <button className="eject-button" title="Remove and revoke guest" onClick={() => void onEject?.(person.connectionId)}><X size={12} /></button>}<span className="online-dot" /></div>)}</div>
          </SidebarSection>
          <SidebarSection icon={<Activity size={15} />} title="Prompt queue" count={snapshot.queue.length} action={
            <button className="tiny-button" onClick={() => void actions.pause(!snapshot.queuePaused)}>{snapshot.queuePaused ? <Play size={13} /> : <Pause size={13} />}</button>
          }>
            {snapshot.queue.length === 0 ? <p className="sidebar-empty">Nothing waiting</p> : snapshot.queue.map((prompt, index) => <div className="queue-item" key={prompt.id}><span>{index + 1}</span><div><strong>{prompt.authorName}</strong><p>{prompt.text}</p></div></div>)}
          </SidebarSection>
          <SidebarSection icon={<ShieldCheck size={15} />} title="Approvals" count={snapshot.approvals.length}>
            {snapshot.approvals.length === 0 ? <p className="sidebar-empty">No action needed</p> : snapshot.approvals.map((approval) => (
              <div className="approval" key={approval.id}><strong>{approval.title}</strong><pre>{approval.detail}</pre><div><button className="approve" onClick={() => void actions.decide(approval.id, "approveOnce")}><Check size={13} /> Once</button><button onClick={() => void actions.decide(approval.id, "decline")}><X size={13} /> Deny</button></div></div>
            ))}
          </SidebarSection>
          {isHost && <SidebarSection icon={<FileDiff size={15} />} title="Recovery" count={snapshot.recoveryPoints.length}>
            {snapshot.recoveryPoints.length === 0 ? <p className="sidebar-empty">Created before each turn</p> : snapshot.recoveryPoints.slice(0, 5).map((point) => (
              <div className="recovery-item" key={point.checkpointId}>
                <div><strong>{new Date(point.createdAtMs).toLocaleTimeString()}</strong><span>{point.fileCount} files · {formatBytes(point.totalBytes)}</span></div>
                <button onClick={() => {
                  if (confirm("Pause the room and replace the workspace with this checkpoint?")) void actions.restore?.(point.checkpointId);
                }}>Restore</button>
              </div>
            ))}
          </SidebarSection>}
          <div className="safety-card"><ShieldCheck size={17} /><div><strong>Protected session</strong><span>Sandboxed · approval gated · E2E encrypted</span></div></div>
        </aside>
      </div>
    </main>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function hostConnectionLabel(limits: RelayRoomLimits, now: number): string {
  const guestLabel = `${limits.maxGuests} guest${limits.maxGuests === 1 ? "" : "s"}`;
  if (!limits.expiresAtMs) return `Host · ${guestLabel}`;
  const minutes = Math.max(0, Math.ceil((limits.expiresAtMs - now) / 60_000));
  return `Host · ${guestLabel} · ${minutes} min`;
}

function roomLimitSummary(limits: RelayRoomLimits, now: number): string {
  const guestLabel = `${limits.maxGuests} guest${limits.maxGuests === 1 ? "" : "s"} max`;
  if (!limits.expiresAtMs) return guestLabel;
  const minutes = Math.max(0, Math.ceil((limits.expiresAtMs - now) / 60_000));
  return `${guestLabel} · ${minutes} min remaining`;
}

function friendlyRelayError(code: string, fallback: string): string {
  if (code === "room_full") return "This hosted free room already has its one guest.";
  if (code === "room_expired") return "This hosted free room reached its 60-minute limit. Ask the host to start a new room.";
  return fallback;
}

function SidebarSection({ icon, title, count, action, children }: { icon: React.ReactNode; title: string; count: number; action?: React.ReactNode; children: React.ReactNode }) {
  return <section className="sidebar-section"><header>{icon}<strong>{title}</strong><span>{count}</span>{action}</header>{children}</section>;
}

function TimelineCard({ item, sticky = false }: { item: TimelineItem; sticky?: boolean }) {
  if (item.kind === "userMessage") return <article className="timeline-card user-card"><div className="timeline-meta"><span className="avatar">{item.authorName.slice(0, 1)}</span><strong>{item.authorName}</strong><span>prompted</span></div><p>{item.text}</p></article>;
  if (item.kind === "agentMessage") return <article className={`timeline-card agent-card${sticky ? " sticky-agent-card" : ""}`}><div className="timeline-meta"><Bot size={17} /><strong>Codex</strong>{!item.completed && <span className="streaming">working</span>}</div><div className="agent-copy">{item.text}</div></article>;
  if (item.kind === "command") return <article className="tool-card"><header><TerminalSquare size={16} /><strong>{item.command}</strong><span>{item.status}</span></header>{item.output && <pre>{item.output}</pre>}</article>;
  if (item.kind === "fileChange") return <article className="tool-card diff-card"><header><FileDiff size={16} /><strong>{item.path}</strong><span>{item.status}</span></header><pre>{item.diff}</pre></article>;
  if (item.kind === "reasoning" || item.kind === "plan") return <article className="thought-card"><header>{item.kind === "plan" ? <Clipboard size={15} /> : <Sparkles size={15} />}<strong>{item.kind === "plan" ? "Plan" : "Reasoning"}</strong></header><p>{item.kind === "plan" ? item.text : item.summary}</p></article>;
  if (item.kind === "tool") return <article className="tool-card"><header><Command size={16} /><strong>{item.name}</strong><span>{item.status}</span></header><pre>{item.detail}</pre></article>;
  return <div className="system-event">{item.message}</div>;
}

function parseGuestCredentials(): GuestCredentials | undefined {
  if (!location.hash) return undefined;
  const params = new URLSearchParams(location.hash.slice(1));
  const roomId = params.get("room");
  const inviteId = params.get("invite");
  const token = params.get("token");
  const encodedKey = params.get("key");
  const relayUrl = params.get("relay");
  if (!roomId || !inviteId || !token || !encodedKey || !relayUrl) return undefined;
  try {
    return { roomId, inviteId, token, key: decodeBase64Url(encodedKey), relayUrl };
  } catch {
    return undefined;
  }
}

function waitForSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect to the relay")), { once: true });
  });
}

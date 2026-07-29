import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  CircleStop,
  Clipboard,
  Command,
  Download,
  ExternalLink,
  FileDiff,
  FolderOpen,
  Infinity,
  KeyRound,
  Link2,
  LoaderCircle,
  MessageSquarePlus,
  MonitorDown,
  Pause,
  Play,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Users,
  X,
} from "lucide-react";
import { LandingPage } from "./LandingPage";
import { HostYourOwnRoomPage } from "./HostYourOwnRoomPage";
import { SilverfishMark } from "./SilverfishMark";
import {
  attachHostEntitlement,
  checkoutUrl,
  fetchManagedEntitlement,
  getOrCreateEntitlementCredential,
  type ManagedEntitlement,
} from "./billing";
import { AGENT_MODELS, codex, type AgentKind, type AgentModel, type AgentStatus, type OptionalDependency } from "./codex";
import { googleLoginAvailable, loginWithGoogle } from "./googleAuth";
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
import { PLANS } from "./plans";
import { getHostCampaign, recordConversionEvent, saveHostCampaign } from "./conversion";
import { checkForDesktopUpdate, installDesktopUpdate, type DesktopUpdate } from "./desktop-updater";
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
  agentName: "Codex",
  participants: [],
  skills: [],
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
  const previewParams = import.meta.env.DEV ? new URLSearchParams(window.location.search) : undefined;
  if (previewParams?.has("plan-preview")) {
    return <PlanPreview paid={previewParams.has("paid-preview")} />;
  }
  if (!isTauriApp() && window.location.pathname === "/billing/success") {
    return <BillingSuccess />;
  }
  if (!isTauriApp() && window.location.pathname === "/host-your-own") {
    return <HostYourOwnRoomPage />;
  }
  const guestCredentials = useMemo(parseGuestCredentials, []);
  if (guestCredentials) return <GuestApp credentials={guestCredentials} />;
  return isTauriApp() ? <HostApp /> : <LandingPage />;
}

function isTauriApp(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function PlanPreview({ paid }: { paid: boolean }) {
  const [starting, setStarting] = useState(false);
  const entitlement = paid
    ? { active: true, plan: "founding_host" as const, maxGuests: 8, roomLifetimeSeconds: null }
    : freeEntitlement;
  const start = async () => setStarting(true);
  return (
    <PlanChooser
      subscribeUrl={subscribeHref ? checkoutUrl(subscribeHref, `sf_${"a".repeat(43)}`) : undefined}
      starting={starting}
      checkingSubscription={false}
      loggingIn={false}
      entitlement={entitlement}
      onBack={() => undefined}
      onChooseFree={start}
      onChoosePaid={start}
      onRefreshSubscription={async () => undefined}
      onGoogleLogin={async () => undefined}
    />
  );
}

function HostApp() {
  const [status, setStatus] = useState<AgentStatus>();
  const [agent, setAgent] = useState<AgentKind>("codex");
  const [model, setModel] = useState<AgentModel>("default");
  const [cwd, setCwd] = useState("");
  const [relayUrl, setRelayUrl] = useState(defaultRelayUrl);
  const [starting, setStarting] = useState(false);
  const [installingDependency, setInstallingDependency] = useState<OptionalDependency>();
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [controller, setController] = useState<HostRoomController>();
  const [inviteToast, setInviteToast] = useState("");
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [showPlans, setShowPlans] = useState(false);
  const [entitlementCredential] = useState(() => (
    isManagedService ? getOrCreateEntitlementCredential() : ""
  ));
  const [entitlement, setEntitlement] = useState<ManagedEntitlement>(freeEntitlement);
  const [checkingSubscription, setCheckingSubscription] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const inviteToastTimeout = useRef<number | undefined>(undefined);
  const [roomSecrets, setRoomSecrets] = useState<{
    roomId: string;
    hostToken: string;
    limits: RelayRoomLimits;
    key: Uint8Array<ArrayBuffer>;
  }>();
  const [error, setError] = useState("");
  const [hostCampaign, setHostCampaign] = useState(() => getHostCampaign());
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdate | null>(null);
  const [updateStatus, setUpdateStatus] = useState("");

  useEffect(() => {
    void codex.status().then(setStatus).catch(() => setError("Open this page in the Silverfish desktop app to host a room."));
  }, []);

  useEffect(() => {
    if (!isManagedService) return;
    let current = true;
    void checkForDesktopUpdate().then((update) => {
      if (current) setDesktopUpdate(update);
    }).catch(() => undefined);
    return () => { current = false; };
  }, []);

  async function applyDesktopUpdate() {
    if (!desktopUpdate || updateStatus) return;
    try {
      await installDesktopUpdate(desktopUpdate, setUpdateStatus);
    } catch {
      setUpdateStatus("Could not install the update. Please try again shortly.");
    }
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void codex.takeHostCampaign().then((campaign) => {
      if (campaign && saveHostCampaign(campaign)) setHostCampaign(campaign);
    });
    void codex.onHostCampaign((campaign) => {
      if (saveHostCampaign(campaign)) setHostCampaign(campaign);
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!isManagedService || !hostCampaign) return;
    recordConversionEvent(relayUrl, hostCampaign, "app_activated", entitlementCredential);
    recordConversionEvent(relayUrl, hostCampaign, "host_setup_opened", entitlementCredential);
  }, [entitlementCredential, hostCampaign, relayUrl]);

  useEffect(() => {
    if (!AGENT_MODELS[agent].some((option) => option.value === model)) setModel("default");
  }, [agent, model]);

  useEffect(() => {
    if (!isManagedService || !showPlans || !entitlementCredential) return;
    let current = true;
    const refresh = async () => {
      setCheckingSubscription(true);
      try {
        const next = await fetchManagedEntitlement(relayUrl, entitlementCredential);
        if (current) {
          setEntitlement(next);
          if (next.active) setError("");
        }
      } catch {
        // The managed relay is authoritative at room creation, so a transient
        // status-check failure should not discard a previously active plan.
      } finally {
        if (current) setCheckingSubscription(false);
      }
    };
    const onFocus = () => void refresh();
    void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [entitlementCredential, relayUrl, showPlans]);

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
      setStatus((current) => current ? { ...current, codex: nextStatus } : current);
      if (dependency === "dcg" && (!nextStatus.dcgInstalled || !nextStatus.dcgHookActive)) {
        setError("dcg was installed, but its Codex hook could not be verified. Click the dependency again to retry configuration.");
      }
    } catch (reason) {
      setError(`Could not install ${dependency}: ${String(reason)}`);
    } finally {
      setInstallingDependency(undefined);
    }
  }

  async function connectAndHostRoom(credential?: string) {
    if (!cwd.trim()) {
      setError("Choose the workspace directory before sharing a session.");
      return;
    }
    setStarting(true);
    setError("");
    try {
      await codex.connect(agent, model, cwd);
      const thread = (await codex.startThread(cwd)).thread;
      const skills = await codex.listSkills(cwd, agent).catch(() => []);
      const room = await createRelayRoom(relayUrl, credential);
      if (isManagedService) recordConversionEvent(relayUrl, hostCampaign, "room_started", entitlementCredential);
      const key = generateRoomKey();
      const socket = openRelaySocket(socketUrl(relayUrl, room.roomId, "host"), room.hostToken);
      const nextController = new HostRoomController(
        socket,
        room.roomId,
        key,
        thread.id,
        cwd,
        agent === "codex" ? "Codex" : "Claude Code",
        skills,
        setSnapshot,
        setError,
      );
      await waitForSocket(socket);
      setRoomSecrets({ ...room, key });
      setController(nextController);
      setSnapshot(nextController.snapshot());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setStarting(false);
    }
  }

  async function refreshSubscription() {
    if (!entitlementCredential) return;
    setCheckingSubscription(true);
    setError("");
    try {
      const next = await fetchManagedEntitlement(relayUrl, entitlementCredential);
      setEntitlement(next);
      if (!next.active) {
        setError("Stripe has not activated this subscription yet. If you just paid, wait a few seconds and check again.");
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setCheckingSubscription(false);
    }
  }

  async function loginWithGoogleAccount() {
    if (!entitlementCredential || loggingIn) return;
    setLoggingIn(true);
    setError("");
    try {
      const { firebaseIdToken } = await loginWithGoogle();
      const next = await attachHostEntitlement(relayUrl, firebaseIdToken, entitlementCredential);
      setEntitlement(next);
      if (!next.active) {
        setError("Signed in, but no active Founding Host subscription was found for that Google account.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoggingIn(false);
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
        subscribeHref={subscribeHref && entitlementCredential
          ? checkoutUrl(subscribeHref, entitlementCredential)
          : undefined}
        inviteToast={inviteToast}
        creatingInvite={creatingInvite}
        onCreateInvite={createInvite}
        onCloseRoom={endRoom}
        onEject={(connectionId) => roomSecrets && ejectRelayGuest(relayUrl, roomSecrets.roomId, roomSecrets.hostToken, connectionId)}
        agent={agent}
        model={model}
        onSwitchAgent={async (nextAgent, nextModel) => {
          if (nextAgent === agent && nextModel === model) return;
          if (!confirm(`Switch this room to ${nextAgent === "codex" ? "Codex" : "Claude Code"}? The active turn will stop and the next prompt receives a handoff.`)) return;
          await controller.switchAgent(nextAgent, nextModel);
          const skills = await codex.listSkills(cwd, nextAgent);
          await controller.setSkills(skills);
          setAgent(nextAgent);
          setModel(nextModel);
        }}
        onInstallSkill={async (source) => {
          await codex.installSkillFromGitHub(source, cwd, agent);
          const skills = await codex.listSkills(cwd, agent);
          await controller.setSkills(skills);
        }}
        error={error}
      />
    );
  }

  const connectBlocker = connectDisabledReason(status, agent, cwd, starting, installingDependency);

  if (showPlans && isManagedService) {
    return (
      <PlanChooser
        subscribeUrl={subscribeHref && entitlementCredential
          ? checkoutUrl(subscribeHref, entitlementCredential)
          : undefined}
        starting={starting}
        checkingSubscription={checkingSubscription}
        loggingIn={loggingIn}
        entitlement={entitlement}
        onBack={() => {
          if (!starting) setShowPlans(false);
        }}
        onChooseFree={() => connectAndHostRoom()}
        onChoosePaid={() => connectAndHostRoom(entitlementCredential)}
        onRefreshSubscription={refreshSubscription}
        onGoogleLogin={loginWithGoogleAccount}
        onCheckout={() => recordConversionEvent(relayUrl, hostCampaign, "checkout_opened", entitlementCredential)}
        error={error}
      />
    );
  }

  return (
    <main className="setup-shell">
      <section className="brand-panel">
        <div className="brand-mark"><SilverfishMark size={28} /></div>
        <div>
          <p className="eyebrow">MULTIPLAYER AGENTIC DEVELOPMENT</p>
          <h1>Build together,<br /><span>through one agent.</span></h1>
          <p className="lede">A shared local-agent session with live prompts, approvals, commands, and diffs. Your machine stays the host.</p>
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
            <p>Choose a local coding agent and model. Silverfish keeps its login and workspace on this Mac.</p>
          </div>
          {hostCampaign ? <div className="host-campaign-banner"><Sparkles size={16} /><span>Ready to host your first room. Choose a workspace, then invite collaborators.</span></div> : null}
          {desktopUpdate ? <div className="desktop-update-banner"><Sparkles size={16} /><div><strong>Silverfish {desktopUpdate.version} is ready</strong><span>{updateStatus || "Install the verified update and restart before starting a room."}</span></div><button type="button" onClick={() => void applyDesktopUpdate()} disabled={Boolean(updateStatus)}>{updateStatus || "Update & restart"}</button></div> : null}
          <label>
            <span>Local agent</span>
            <select value={agent} onChange={(event) => setAgent(event.target.value as AgentKind)} disabled={starting}>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <label>
            <span>Model</span>
            <select value={model} onChange={(event) => setModel(event.target.value as AgentModel)} disabled={starting}>
              {AGENT_MODELS[agent].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <StatusGrid status={status} agent={agent} installing={installingDependency} onInstall={installDependency} />
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
          <div
            className="button-tooltip"
            data-tooltip={connectBlocker || undefined}
            tabIndex={connectBlocker ? 0 : undefined}
          >
            <button
              className="primary"
              onClick={() => {
                if (isManagedService) {
                  setError("");
                  setShowPlans(true);
                } else {
                  void connectAndHostRoom();
                }
              }}
              disabled={Boolean(connectBlocker)}
            >
              {starting ? <LoaderCircle className="spin" size={18} /> : <KeyRound size={18} />}
              Start session
            </button>
          </div>
          {isManagedService && googleLoginAvailable() && !entitlement.active ? (
            <button
              type="button"
              className="plan-refresh"
              onClick={() => void loginWithGoogleAccount()}
              disabled={loggingIn}
            >
              <RefreshCw className={loggingIn ? "spin" : undefined} size={14} />
              {loggingIn ? "Signing in…" : "Already a Founding Host? Log in with Google"}
            </button>
          ) : null}
          {error && <div className="error-banner">{error}</div>}
        </div>
      </section>
    </main>
  );
}

function connectDisabledReason(
  status: AgentStatus | undefined,
  agent: AgentKind,
  cwd: string,
  starting: boolean,
  installing: OptionalDependency | undefined,
): string {
  if (starting) return "A local agent is already connecting.";
  if (installing) return `Wait for the optional ${installing} installation to finish.`;
  if (!status) return "Checking local agents…";
  if (agent === "codex") {
    if (!status.codex.installed) return "Install and authenticate the Codex CLI before connecting.";
    if (!status.codex.compatible) return `Update Codex to version ${status.codex.minimumVersion} or newer before connecting.`;
  } else {
    if (!status.claude.installed) return "Install and authenticate Claude Code before connecting.";
    if (!status.claude.approvalMediated) return "This Claude Code installation cannot provide shared approvals.";
  }
  if (!cwd.trim()) return "Choose a workspace directory before connecting.";
  return "";
}

function StatusGrid({ status, agent, installing, onInstall }: {
  status?: AgentStatus;
  agent: AgentKind;
  installing?: OptionalDependency;
  onInstall: (dependency: OptionalDependency) => Promise<void>;
}) {
  const requiredRows = agent === "codex"
    ? [["Codex CLI", status?.codex.installed, status?.codex.version || "Checking…"], ["App-server API", status?.codex.compatible, status ? `≥ ${status.codex.minimumVersion}` : "Checking…"]] as const
    : [["Claude Code", status?.claude.installed, status?.claude.version || "Checking…"], ["Shared approvals", status?.claude.approvalMediated, status?.claude.approvalMediated ? "Ready" : "Unavailable"]] as const;
  const optionalRows: Array<{
    id: OptionalDependency;
    label: string;
    ready: boolean;
    detail: string;
  }> = [{
    id: "dcg",
    label: "Destructive guard",
    ready: Boolean(status?.codex.dcgInstalled && status?.codex.dcgHookActive),
    detail: installing === "dcg"
      ? "Installing…"
      : status?.codex.dcgHookActive
        ? "Optional · hook active"
        : status?.codex.dcgInstalled
          ? "Optional · click to configure"
          : "Optional · click to install",
  }];
  if (agent === "claude") return <div className="status-grid">{requiredRows.map(([label, ready, detail]) => <div key={label} className="status-row"><span className={ready ? "status-dot ready" : "status-dot"} /><span>{label}</span><code>{detail}</code></div>)}</div>;
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

const freeEntitlement: ManagedEntitlement = {
  active: false,
  plan: "free",
  maxGuests: PLANS.free.maxGuests,
  roomLifetimeSeconds: 60 * 60,
};

function PlanChooser({
  subscribeUrl,
  starting,
  checkingSubscription,
  loggingIn,
  entitlement,
  onBack,
  onChooseFree,
  onChoosePaid,
  onRefreshSubscription,
  onGoogleLogin,
  onCheckout,
  error,
}: {
  subscribeUrl?: string;
  starting: boolean;
  checkingSubscription: boolean;
  loggingIn: boolean;
  entitlement: ManagedEntitlement;
  onBack: () => void;
  onChooseFree: () => Promise<void>;
  onChoosePaid: () => Promise<void>;
  onRefreshSubscription: () => Promise<void>;
  onGoogleLogin: () => Promise<void>;
  onCheckout?: () => void;
  error?: string;
}) {
  const [pendingPlan, setPendingPlan] = useState<"free" | "founding_host">();
  const startingFree = starting && pendingPlan === "free";
  const startingPaid = starting && pendingPlan === "founding_host";
  return (
    <main className="plan-shell">
      <header className="plan-topbar">
        <div className="plan-brand">
          <span><SilverfishMark size={24} /></span>
          <strong>Silverfish</strong>
        </div>
      </header>

      <section className="plan-content" aria-labelledby="plan-title">
        <button type="button" className="plan-back" onClick={onBack} disabled={starting}>
          <ArrowLeft size={17} />
          Back
        </button>
        <div className="plan-heading">
          <h1 id="plan-title">Choose how you want to host</h1>
          <p>Start free, or unlock longer rooms for your team.</p>
        </div>

        <div className="plan-grid">
          <article className="plan-card free-plan">
            <header>
              <h2>{PLANS.free.name}</h2>
              <div className="plan-price"><sup>$</sup><strong>{PLANS.free.priceLabel.replace("$", "")}</strong></div>
              <p>{PLANS.free.tagline}</p>
            </header>
            <ul>
              <PlanFeature icon={<Users size={21} />}>{`${PLANS.free.maxGuests} guest`}</PlanFeature>
              <PlanFeature icon={<Clock3 size={21} />}>{PLANS.free.roomLifetimeLabel}</PlanFeature>
              <PlanFeature icon={<ShieldCheck size={21} />}>End-to-end encrypted</PlanFeature>
            </ul>
            <button
              type="button"
              className="plan-cta free-cta"
              onClick={() => {
                setPendingPlan("free");
                void onChooseFree();
              }}
              disabled={starting}
            >
              {startingFree ? <LoaderCircle className="spin" size={18} /> : null}
              {startingFree ? "Starting session…" : "Start free session"}
            </button>
          </article>

          <article className="plan-card founding-plan">
            <header>
              <div className="founding-title">
                <h2>{PLANS.founding_host.name}</h2>
                <span>{entitlement.active ? "Active" : "Recommended"}</span>
              </div>
              <div className="plan-price"><sup>$</sup><strong>{PLANS.founding_host.priceLabel.replace("$", "")}</strong><small>{PLANS.founding_host.priceSuffix}</small></div>
              <p>{PLANS.founding_host.tagline}</p>
            </header>
            <ul>
              <PlanFeature icon={<Users size={21} />}>{`Up to ${PLANS.founding_host.maxGuests} guests`}</PlanFeature>
              <PlanFeature icon={<Infinity size={21} />}>{PLANS.founding_host.roomLifetimeLabel}</PlanFeature>
              <PlanFeature icon={<ShieldCheck size={21} />}>End-to-end encrypted</PlanFeature>
              <PlanFeature icon={<MonitorDown size={21} />}>Maintained desktop builds</PlanFeature>
              <PlanFeature icon={<Sparkles size={21} />}>Early access to hosted features</PlanFeature>
            </ul>
            {entitlement.active ? (
              <button
                type="button"
                className="plan-cta founding-cta"
                onClick={() => {
                  setPendingPlan("founding_host");
                  void onChoosePaid();
                }}
                disabled={starting}
              >
                {startingPaid ? <LoaderCircle className="spin" size={18} /> : null}
                {startingPaid ? "Starting session…" : "Start Founding Host session"}
              </button>
            ) : subscribeUrl ? (
              <a className="plan-cta founding-cta" href={subscribeUrl} target="_blank" rel="noreferrer" onClick={onCheckout}>
                Choose Founding Host
                <ExternalLink size={17} />
              </a>
            ) : (
              <span className="plan-cta founding-cta unavailable" aria-disabled="true">
                Checkout opening soon
              </span>
            )}
            {!entitlement.active && subscribeUrl ? (
              <button
                type="button"
                className="plan-refresh"
                onClick={() => void onRefreshSubscription()}
                disabled={checkingSubscription || starting}
              >
                <RefreshCw className={checkingSubscription ? "spin" : undefined} size={14} />
                {checkingSubscription ? "Checking subscription…" : "Already subscribed? Check status"}
              </button>
            ) : null}
            {!entitlement.active && googleLoginAvailable() ? (
              <button
                type="button"
                className="plan-refresh"
                onClick={() => void onGoogleLogin()}
                disabled={loggingIn || starting}
              >
                <RefreshCw className={loggingIn ? "spin" : undefined} size={14} />
                {loggingIn ? "Signing in…" : "Already a Founding Host? Log in with Google"}
              </button>
            ) : null}
          </article>
        </div>

        {error ? <div className="plan-error">{error}</div> : null}
        <p className="plan-footnote">You can change plans any time.</p>
      </section>
    </main>
  );
}

function BillingSuccess() {
  return (
    <main className="plan-shell billing-success-shell">
      <header className="plan-topbar">
        <div className="plan-brand">
          <span><SilverfishMark size={24} /></span>
          <strong>Silverfish</strong>
        </div>
      </header>
      <section className="billing-success">
        <span className="billing-success-mark"><Check size={30} /></span>
        <p className="eyebrow">FOUNDING HOST</p>
        <h1>Subscription received.</h1>
        <p>Return to the Silverfish desktop app. It verifies your subscription automatically when the app regains focus.</p>
        <p className="billing-success-note">If activation takes more than a few seconds, choose “Already subscribed? Check status.”</p>
      </section>
    </main>
  );
}

function PlanFeature({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li>
      <span>{icon}</span>
      {children}
    </li>
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
  const [disconnected, setDisconnected] = useState(false);
  const lastSequence = useRef(0);

  async function send(intent: ClientIntent) {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Room is not connected");
    const envelope = await encryptJson(credentials.roomId, credentials.key, intent);
    sendEncrypted(socket, "host", envelope);
  }

  async function join() {
    setError("");
    setDisconnected(false);
    try {
      const nextSocket = openRelaySocket(
        socketUrl(credentials.relayUrl, credentials.roomId, "guest", credentials.inviteId),
        credentials.token,
      );
      nextSocket.addEventListener("message", (event) => {
        void handleGuestRelay(parseRelayMessage(event), credentials, setSnapshot, setConnectionId, setError, lastSequence);
      });
      nextSocket.addEventListener("close", () => {
        setSocket(undefined);
        setConnectionId("");
        setDisconnected(true);
        setError("Disconnected from the room");
      });
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

  if (!socket && disconnected) {
    return <GuestDisconnected error={error} />;
  }

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
  return <RoomShell snapshot={snapshot} actions={actions} isHost={false} connectionLabel={`${name} · ${connectionId.slice(0, 5)}`} error={error} guestHostHref="/host-your-own?source=guest_room" />;
}

function GuestDisconnected({ error }: { error: string }) {
  return (
    <main className="join-shell">
      <div className="join-card guest-disconnected-card">
        <div className="brand-mark"><SilverfishMark size={27} /></div>
        <p className="eyebrow">SESSION ENDED</p>
        <h1>Host the next room.</h1>
        <p>{error || "This room is no longer available."} Start your own private, shared local-agent session instead.</p>
        <a className="primary guest-host-cta" href="/host-your-own?source=guest_room" target="_blank" rel="noreferrer"><MonitorDown size={18} /> Get Silverfish for macOS</a>
        <div className="guest-host-detail">Start free with 1 guest and 60-minute rooms. Founding Host adds up to 8 guests and no room limit.</div>
      </div>
    </main>
  );
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
  if (event.type === "skillsUpdated") return { ...current, sequence, skills: event.skills };
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

function RoomShell({ snapshot, actions, isHost, projectName, connectionLabel, roomLimits, managedService, subscribeHref, inviteToast, creatingInvite, onCreateInvite, onCloseRoom, onEject, agent, model, onSwitchAgent, onInstallSkill, guestHostHref, error }: {
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
  agent?: AgentKind;
  model?: AgentModel;
  onSwitchAgent?: (agent: AgentKind, model: AgentModel) => Promise<void>;
  onInstallSkill?: (source: string) => Promise<void>;
  guestHostHref?: string;
  error?: string;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"prompt" | "steer">("prompt");
  const [skillQuery, setSkillQuery] = useState("");
  const [showSkillInstall, setShowSkillInstall] = useState(false);
  const [skillSource, setSkillSource] = useState("");
  const [installingSkill, setInstallingSkill] = useState(false);
  const [skillInstallError, setSkillInstallError] = useState("");
  const [now, setNow] = useState(Date.now());
  const endRef = useRef<HTMLDivElement>(null);
  const displayProjectName = projectName || snapshot.projectName || "Project";
  const roomConnectionLabel = roomLimits ? hostConnectionLabel(roomLimits, now) : connectionLabel;
  const activeAgentMessage = snapshot.timeline.reduce<TimelineItem | undefined>(
    (active, item) => item.kind === "agentMessage" && !item.completed ? item : active,
    undefined,
  );
  const timelineItems = activeAgentMessage
    ? snapshot.timeline.filter((item) => item.id !== activeAgentMessage.id)
    : snapshot.timeline;
  const visibleSkills = useMemo(() => {
    const query = skillQuery.trim().toLocaleLowerCase();
    if (!query) return snapshot.skills;
    return snapshot.skills.filter((skill) => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query));
  }, [skillQuery, snapshot.skills]);
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

  function addSkillToPrompt(skill: typeof snapshot.skills[number]) {
    const instruction = `Use the ${skill.name} skill for this task.`;
    setMode("prompt");
    setText((current) => current.trim() ? `${instruction}\n\n${current}` : `${instruction}\n\n`);
  }

  async function installSkill() {
    const source = skillSource.trim();
    if (!source || !onInstallSkill) return;
    setInstallingSkill(true);
    setSkillInstallError("");
    try {
      await onInstallSkill(source);
      setSkillSource("");
      setShowSkillInstall(false);
    } catch (reason) {
      setSkillInstallError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setInstallingSkill(false);
    }
  }

  return (
    <main className="room-shell">
      <header className="room-header">
        <div className="room-brand"><div className="brand-mark small"><SilverfishMark size={21} /></div><strong>Silverfish</strong><span>/</span><span className="project-name" title={displayProjectName}>{displayProjectName}</span></div>
        <div className="room-status"><span className="live-dot" /> LIVE <span className="room-divider" /> {roomConnectionLabel}</div>
        <div className="header-actions">
          {isHost && agent && model && onSwitchAgent ? <span className="agent-switcher">
            <select value={agent} aria-label="Active agent" onChange={(event) => void onSwitchAgent(event.target.value as AgentKind, "default")}>
              <option value="codex">Codex</option><option value="claude">Claude Code</option>
            </select>
            <select value={model} aria-label="Active model" onChange={(event) => void onSwitchAgent(agent, event.target.value as AgentModel)}>
              {AGENT_MODELS[agent].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </span> : null}
          {isHost ? <button className="invite-link" onClick={() => void onCreateInvite?.()} disabled={creatingInvite} aria-label="Copy invite link">Invite <Link2 size={15} /></button> : null}
          {isHost && <button className="secondary end-room" onClick={onCloseRoom}>End room</button>}
          <button className="icon-button danger" title="Interrupt turn" disabled={!snapshot.activeTurnId} onClick={() => void actions.interrupt()}><CircleStop size={18} /></button>
        </div>
      </header>
      {snapshot.activeTurnId ? (
        <CurrentWorkRail agentName={snapshot.agentName || "Local agent"} text={activeAgentMessage?.kind === "agentMessage" ? activeAgentMessage.text : ""} />
      ) : null}
      {inviteToast ? <div className="invite-toast" role="status"><Check size={16} /><span>{inviteToast}</span></div> : null}
      <div className="room-banners">
        {isHost && managedService && roomLimits?.expiresAtMs ? (
          <div className="hosted-room-banner">
            <span><strong>Hosted free room</strong> · {roomLimitSummary(roomLimits, now)}</span>
            {subscribeHref ? <a href={subscribeHref} target="_blank" rel="noreferrer">Upgrade</a> : null}
          </div>
        ) : null}
        {!isHost && guestHostHref ? <div className="guest-host-mobile"><span>Ready to lead the next session?</span><a href={guestHostHref} target="_blank" rel="noreferrer">Host your own room <ExternalLink size={13} /></a></div> : null}
        {error && <div className="room-error">{error}</div>}
      </div>
      <div className="room-grid">
        <section className="timeline-panel">
          <div className="timeline-scroll">
            {timelineItems.length === 0 && !activeAgentMessage ? (
              <div className="empty-timeline"><Bot size={34} /><h2>The room is ready</h2><p>Send the first prompt to begin working together.</p></div>
            ) : timelineItems.map((item) => (
              <TimelineCard
                key={item.id}
                item={item}
                agentName={snapshot.agentName || "Local agent"}
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
              }} placeholder={mode === "steer" ? "Redirect the active turn…" : `Ask ${snapshot.agentName || "the agent"} to build, inspect, or change something…`} />
              <button onClick={() => void submit()} disabled={!text.trim()}><Send size={18} /></button>
            </div>
            <div className="composer-foot"><span>Enter to send · Shift+Enter for newline</span><span>{text.length.toLocaleString()} / 32,000</span></div>
          </div>
        </section>
        <aside className="room-sidebar">
          <SidebarSection icon={<Users size={15} />} title="In this room" count={snapshot.participants.length}>
            <div className="participants">{snapshot.participants.map((person) => <div className="participant" key={person.connectionId}><span className="avatar">{person.displayName.slice(0, 1).toUpperCase()}</span><span>{person.displayName}</span>{person.isHost ? <em>HOST</em> : isHost && <button className="eject-button" title="Remove and revoke guest" onClick={() => void onEject?.(person.connectionId)}><X size={12} /></button>}<span className="online-dot" /></div>)}</div>
          </SidebarSection>
          <SidebarSection icon={<Sparkles size={15} />} title="Agent skills" count={snapshot.skills.length} action={isHost ? <button className="tiny-button skill-install-toggle" onClick={() => setShowSkillInstall((visible) => !visible)} title="Install a GitHub skill"><Download size={13} /></button> : undefined}>
            <p className="skills-note">Available on the host. Add one to the next prompt so everyone sees the capability in play.</p>
            {showSkillInstall ? <div className="skill-install-form"><label><span>GitHub skill URL</span><input value={skillSource} onChange={(event) => setSkillSource(event.target.value)} placeholder="https://github.com/owner/repo/tree/main/skills/example" /></label><button onClick={() => void installSkill()} disabled={!skillSource.trim() || installingSkill}>{installingSkill ? "Installing…" : `Install to ${agent === "claude" ? "Claude Code" : "Codex"}`}</button><small>Installs to this host’s active {agent === "claude" ? ".claude/skills" : "Codex skills"} directory. Available on the next turn.</small>{skillInstallError ? <p>{skillInstallError}</p> : null}</div> : null}
            <label className="skill-search"><Search size={13} /><input value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder="Search skills" aria-label="Search agent skills" /></label>
            <div className="skill-list">
              {visibleSkills.length === 0 ? <p className="sidebar-empty">{snapshot.skills.length === 0 ? "No skills shared by the host" : "No matching skills"}</p> : visibleSkills.slice(0, 12).map((skill) => (
                <button className="skill-row" key={skill.name} onClick={() => addSkillToPrompt(skill)} title={`Add ${skill.name} to the next prompt`}>
                  <span><strong>{skill.name}</strong><small>{skill.description}</small></span><ChevronRight size={14} />
                </button>
              ))}
            </div>
          </SidebarSection>
          <SidebarSection icon={<Command size={15} />} title="MCP bridge" count={2}>
            <p className="skills-note">The agent sees one bridge, then discovers only the MCP API it needs.</p>
            <div className="bridge-tools"><span><code>search_capabilities</code><small>find a matching API</small></span><span><code>execute</code><small>run the selected tool</small></span></div>
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
          {!isHost && guestHostHref ? <div className="guest-host-card"><MonitorDown size={18} /><div><strong>Host your own room</strong><span>Start free, then unlock longer rooms when your team needs them.</span><a href={guestHostHref} target="_blank" rel="noreferrer">Get Silverfish for macOS <ExternalLink size={13} /></a></div></div> : null}
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
  if (code === "room_full") return "This room has reached its guest limit.";
  if (code === "room_expired") return "This room reached its time limit. Ask the host to start a new room.";
  return fallback;
}

function SidebarSection({ icon, title, count, action, children }: { icon: React.ReactNode; title: string; count: number; action?: React.ReactNode; children: React.ReactNode }) {
  return <section className="sidebar-section"><header>{icon}<strong>{title}</strong><span>{count}</span>{action}</header>{children}</section>;
}

function CurrentWorkRail({ agentName, text }: { agentName: string; text: string }) {
  return <section className="current-work-rail" aria-label={`${agentName} current work`}>
    <header><span className="current-work-dot" /><strong>{agentName}</strong><span>Working now</span></header>
    <div className="current-work-copy">{text || "Preparing response…"}</div>
  </section>;
}

function TimelineCard({ item, agentName }: { item: TimelineItem; agentName: string }) {
  if (item.kind === "userMessage") return <article className="timeline-card user-card"><div className="timeline-meta"><span className="avatar">{item.authorName.slice(0, 1)}</span><strong>{item.authorName}</strong><span>prompted</span></div><p>{item.text}</p></article>;
  if (item.kind === "agentMessage") return <article className="timeline-card agent-card"><div className="timeline-meta"><Bot size={17} /><strong>{agentName}</strong>{!item.completed && <span className="streaming">working</span>}</div><div className="agent-copy">{item.text}</div></article>;
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

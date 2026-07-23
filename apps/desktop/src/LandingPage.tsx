import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  FileDiff,
  Link2,
  LockKeyhole,
  MessageSquarePlus,
  ShieldCheck,
  TerminalSquare,
  Users,
} from "lucide-react";
import { SilverfishMark } from "./SilverfishMark";
import "./landing.css";

const downloadHref = "/downloads/Silverfish-macOS-arm64.dmg";
const subscribeHref = import.meta.env.VITE_SILVERFISH_SUBSCRIBE_URL?.trim();
const isManagedService = import.meta.env.VITE_SILVERFISH_MANAGED_SERVICE === "true";

const steps = [
  {
    number: "01",
    title: "Start locally",
    copy: "Choose a workspace. Silverfish starts a fresh Codex thread on your Mac.",
  },
  {
    number: "02",
    title: "Copy one link",
    copy: "Invite collaborators without sharing your Codex login or workspace credentials.",
  },
  {
    number: "03",
    title: "Work together",
    copy: "Queue prompts, steer active work, review commands and diffs, and answer approvals.",
  },
] as const;

const securityPoints = [
  ["Credentials stay local", "Your Codex login never leaves the host Mac."],
  ["End-to-end encrypted", "Room content is encrypted before it reaches the relay."],
  ["Approval gated", "Sensitive commands still require an explicit human decision."],
  ["Recovery before every turn", "The host can restore a local checkpoint when work goes sideways."],
] as const;

function Brand() {
  return (
    <a className="landing-brand" href="#top" aria-label="Silverfish home">
      <span className="landing-mark"><SilverfishMark size={23} /></span>
      <strong>Silverfish</strong>
    </a>
  );
}

function DownloadLink({ compact = false }: { compact?: boolean }) {
  return (
    <a className={compact ? "download-link compact" : "download-link"} href={downloadHref} download>
      <ArrowDownToLine size={compact ? 16 : 18} />
      Download for macOS
    </a>
  );
}

function SubscriptionLink() {
  if (!subscribeHref) {
    return (
      <span className="subscription-link unavailable" aria-disabled="true">
        Checkout opening soon
      </span>
    );
  }

  return (
    <a className="subscription-link" href={subscribeHref} target="_blank" rel="noreferrer">
      Become a Founding Host
      <ArrowRight size={17} />
    </a>
  );
}

function RoomPreview({ detailed = false }: { detailed?: boolean }) {
  return (
    <div className={detailed ? "room-preview detailed" : "room-preview"} aria-label="Silverfish collaborative room preview">
      <div className="preview-titlebar">
        <div className="preview-brand"><span><SilverfishMark size={14} /></span> Silverfish <i>/</i> graphite</div>
        <div className="preview-live"><b /> LIVE · 3 IN ROOM</div>
        <div className="preview-invite">Invite <Link2 size={12} /></div>
      </div>
      <div className="preview-body">
        <div className="preview-timeline">
          <div className="preview-message human">
            <div><span className="preview-avatar">M</span><strong>Maya</strong><small>prompted</small></div>
            <p>Make connecting create the room on a new thread automatically.</p>
          </div>
          <div className="preview-message agent">
            <div><span className="preview-agent"><SilverfishMark size={14} /></span><strong>Codex</strong><small className="working">working</small></div>
            <p>I’ll move room creation behind a successful connection and start a clean thread for the selected workspace.</p>
          </div>
          <div className="preview-tool">
            <header><TerminalSquare size={13} /><strong>npm run typecheck</strong><small>complete</small></header>
            <code>✓ Found 0 errors</code>
          </div>
          {detailed ? (
            <div className="preview-tool diff">
              <header><FileDiff size={13} /><strong>src/App.tsx</strong><small>3 changes</small></header>
              <code>+ await codex.startThread(cwd)</code>
            </div>
          ) : null}
          <div className="preview-composer"><MessageSquarePlus size={14} /><span>Ask Codex to build, inspect, or change something…</span><b>↵</b></div>
        </div>
        <aside className="preview-sidebar">
          <header><Users size={12} /> IN THIS ROOM <span>3</span></header>
          <div className="preview-person"><i>M</i><span>Maya <small>HOST</small></span><b /></div>
          <div className="preview-person"><i>D</i><span>Devon</span><b /></div>
          <div className="preview-person"><i>A</i><span>Ari</span><b /></div>
          <header className="preview-queue">PROMPT QUEUE <span>1</span></header>
          <div className="preview-queued"><em>1</em><p><strong>Devon</strong>Run the focused tests next.</p></div>
          <div className="preview-protected"><ShieldCheck size={14} /><span><strong>Protected session</strong>Encrypted · approval gated</span></div>
        </aside>
      </div>
    </div>
  );
}

export function LandingPage() {
  return (
    <main className="landing-shell" id="top">
      <header className="landing-header">
        <Brand />
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#security">Security</a>
          {isManagedService ? <a href="#pricing">Pricing</a> : null}
          <DownloadLink compact />
        </nav>
      </header>

      <section className="landing-hero">
        <div className="hero-copy">
          <h1>Build together.<br />One agent,<br /><span>everyone in the room.</span></h1>
          <p>Silverfish turns a local Codex session into a shared workspace for prompts, steering, approvals, commands, and diffs—while your machine stays in control.</p>
          <div className="hero-actions">
            <DownloadLink />
            <a className="text-link" href="#how-it-works">See how it works <ArrowRight size={17} /></a>
          </div>
          <div className="platform-note"><span>Apple silicon</span><i />macOS 13+</div>
        </div>
        <RoomPreview />
      </section>

      <section className="process-section" id="how-it-works">
        <div className="section-heading">
          <h2>One host. One room.<br />A shared flow.</h2>
          <p>The real agent and workspace stay on the host. Everyone else joins from a browser.</p>
        </div>
        <div className="process-rail">
          {steps.map((step) => (
            <article key={step.number}>
              <span>{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="session-section">
        <div className="session-copy">
          <h2>The whole session,<br />in view.</h2>
          <p>Everyone sees the same timeline. The host keeps the real agent, files, credentials, and recovery points local.</p>
          <ul>
            <li><Check size={15} /> Shared prompts and live steering</li>
            <li><Check size={15} /> Streamed commands and readable diffs</li>
            <li><Check size={15} /> One-time approvals with attribution</li>
          </ul>
        </div>
        <RoomPreview detailed />
      </section>

      <section className="security-section" id="security">
        <div className="section-heading security-heading">
          <h2>Private by<br />architecture.</h2>
          <p>The relay coordinates the room, but it cannot read names, prompts, tool output, diffs, or approvals.</p>
        </div>
        <div className="architecture" aria-label="Host to encrypted relay to browser collaborators">
          <div><span><SilverfishMark size={24} /></span><strong>Host Mac</strong><small>Agent · files · credentials</small></div>
          <i><LockKeyhole size={16} /><b /></i>
          <div className="relay-node"><span><ShieldCheck size={23} /></span><strong>Encrypted relay</strong><small>Routes ciphertext only</small></div>
          <i><LockKeyhole size={16} /><b /></i>
          <div><span><Users size={24} /></span><strong>Collaborators</strong><small>Join from a browser</small></div>
        </div>
        <div className="security-list">
          {securityPoints.map(([title, copy]) => (
            <article key={title}><ShieldCheck size={18} /><div><h3>{title}</h3><p>{copy}</p></div></article>
          ))}
        </div>
      </section>

      {isManagedService ? (
        <section className="pricing-section" id="pricing">
          <div className="pricing-copy">
            <p className="pricing-eyebrow">FOUNDING PLAN</p>
            <h2>Pay for the host.<br />Bring everyone else.</h2>
            <p>
              Back the preview, lock in the founding rate, and help shape the collaboration layer
              around the agent you already use.
            </p>
          </div>
          <article className="pricing-card">
            <header>
              <div>
                <span>Founding Host</span>
                <strong><sup>$</sup>15<small>/ month</small></strong>
              </div>
              <em>Guests stay free</em>
            </header>
            <ul>
              <li><Check size={16} /> Founding price locked while subscribed</li>
              <li><Check size={16} /> Every Pro feature as it is released</li>
              <li><Check size={16} /> Direct input into the product roadmap</li>
              <li><Check size={16} /> Cancel anytime in the customer portal</li>
            </ul>
            <SubscriptionLink />
            <p>Hosted preview rooms are free for one guest and up to 60 minutes. Self-hosted limits are configurable.</p>
          </article>
        </section>
      ) : null}

      <section className="landing-cta">
        <div>
          <h2>Bring your people<br />into the room.</h2>
          <p>Download Silverfish for an Apple silicon Mac and start a shared Codex session in minutes.</p>
        </div>
        <div className="cta-download"><DownloadLink /><span>Apple silicon · macOS 13+ · preview build</span></div>
      </section>

      <footer className="landing-footer">
        <Brand />
        <p>A small creature for shared work around one powerful agent.</p>
        <div>{isManagedService ? <a href="#pricing">Pricing</a> : null}<a href="#security">Security</a><a href="#top">Back to top</a></div>
      </footer>
    </main>
  );
}

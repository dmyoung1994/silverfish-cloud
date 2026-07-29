import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  Github,
  Link2,
  LockKeyhole,
  MessageSquarePlus,
  ShieldCheck,
  TerminalSquare,
  Users,
  WandSparkles,
} from "lucide-react";
import agentConduit from "./assets/agent-conduit.png";
import socialAgentCore from "./assets/social-agent-core.png";
import { SilverfishMark } from "./SilverfishMark";
import { PLANS } from "./plans";
import "./landing.css";

const downloadHref = "/downloads/Silverfish-macOS-arm64.dmg";
const githubHref = "https://github.com/dmyoung1994/silverfish";
const subscribeHref = import.meta.env.VITE_SILVERFISH_SUBSCRIBE_URL || "/host-your-own";

const waysOfWorking = [
  ["01", "Run the agent you choose", "Keep the coding agent, model, and workflow your team already trusts."],
  ["02", "Open one shared room", "Invite the people who need to shape the work—not just the person at the keyboard."],
  ["03", "Pair in public", "Prompts, decisions, tool calls, and handoffs stay in one visible flow."],
] as const;

const roomBenefits = [
  "See every prompt, tool call, and diff as it happens",
  "Let collaborators steer the work without taking over",
  "Keep approvals human and clearly attributed",
  "See skills and MCP capability requests in the room",
];

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

function SessionCanvas() {
  return (
    <div className="session-canvas" aria-label="A shared collaborative coding session">
      <div className="canvas-topbar">
        <div><span className="canvas-status" /> shared session</div>
        <div>4 collaborators <Link2 size={12} /></div>
      </div>
      <div className="canvas-main">
        <aside className="canvas-rail">
          <span className="canvas-rail-label">IN THE ROOM</span>
          <div className="canvas-person"><i className="p-one">M</i><span>Maya<small>product</small></span></div>
          <div className="canvas-person"><i className="p-two">D</i><span>Devon<small>engineering</small></span></div>
          <div className="canvas-person"><i className="p-three">A</i><span>Ari<small>design</small></span></div>
          <div className="canvas-person"><i className="p-agent"><SilverfishMark size={13} /></i><span>Build agent<small>working</small></span></div>
          <div className="canvas-skills">
            <span className="canvas-rail-label">MCP BRIDGE <b>2</b></span>
            <div><i /> search_capabilities <small>discover</small></div>
            <div><i /> execute <small>run tool</small></div>
            <div><i /> Active skills <small>visible</small></div>
            <button type="button">Discover APIs <ArrowRight size={11} /></button>
          </div>
        </aside>
        <div className="canvas-thread">
          <div className="canvas-event prompt-event">
            <span className="event-person p-one">M</span>
            <p><strong>Maya</strong> Tighten the onboarding flow and preserve the existing auth behavior.</p>
          </div>
          <div className="canvas-event agent-event">
            <span className="event-agent"><WandSparkles size={15} /></span>
            <p><strong>Build agent</strong> I’ll map the current path, update the UI, then run focused checks.</p>
          </div>
          <div className="canvas-command"><TerminalSquare size={15} /><span>search_capabilities "onboarding tests"</span><b>ready</b></div>
          <div className="canvas-event steer-event">
            <span className="event-person p-three">A</span>
            <p><strong>Ari</strong> Keep the success state quiet—let the next action carry the weight.</p>
          </div>
          <div className="canvas-composer"><MessageSquarePlus size={15} /><span>Steer the work or add a prompt…</span><b>↵</b></div>
        </div>
      </div>
    </div>
  );
}

export function LandingPage() {
  return (
    <main className="landing-shell refreshed-landing" id="top">
      <header className="landing-header">
        <Brand />
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#plans">Plans</a>
          <a href="#security">Security</a>
          <a className="icon-nav-button" href={githubHref} target="_blank" rel="noreferrer" aria-label="View source on GitHub"><Github size={18} /></a>
          <DownloadLink compact />
        </nav>
      </header>

      <section className="landing-hero">
        <div className="hero-copy">
          <h1>Build together.<br /><span>Same agent.</span></h1>
          <p>Turn one live agent session into a shared project space. Invite the people you want to create with—without asking everyone to share your model, skills, or workflow.</p>
          <div className="hero-actions"><DownloadLink /><a className="text-link" href="#how-it-works">Explore the workflow <ArrowRight size={17} /></a></div>
          <div className="platform-note"><span>Apple silicon</span><i /> macOS 13+ <i /> preview build</div>
        </div>
        <div className="hero-art">
          <img src={socialAgentCore} alt="A single luminous core receiving signals from several collaborators" />
          <div className="hero-art-caption"><span>ONE ACTIVE AGENT</span><b>A shared place for the work.</b></div>
        </div>
      </section>

      <section className="agent-band" aria-label="Social agentic development">
        <p>One running agent. One project space. Whoever you invite.</p>
        <div><span>steer live work</span><i /> <span>add context</span><i /> <span>review diffs</span><i /> <span>make decisions</span></div>
      </section>

      <section className="process-section" id="how-it-works">
        <div className="section-heading">
          <h2>Pair on the<br />project. Not<br /><em>the setup.</em></h2>
          <p>Silverfish centralizes the work around one agent session. The people you invite get the context, a voice, and a way to move the project forward—without needing to mirror the host’s skills, MCPs, or workflow.</p>
        </div>
        <div className="process-rail">
          {waysOfWorking.map(([number, title, copy]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{copy}</p></article>)}
        </div>
      </section>

      <section className="conduit-section">
        <div className="conduit-art"><img src={agentConduit} alt="Many colored paths flowing together through a transparent conduit" /></div>
        <div className="conduit-copy">
          <p className="section-label">ONE CAPABILITY BRIDGE</p>
          <h2>Tools on<br /><em>demand.</em></h2>
          <p>The agent gets two bridge calls—not every MCP schema. It discovers the API it needs, then executes it, keeping capability context compact while the room stays in the loop.</p>
          <a className="text-link" href="#session">See a room in motion <ArrowRight size={17} /></a>
        </div>
      </section>

      <section className="session-section" id="session">
        <div className="session-copy">
          <p className="section-label">A ROOM, NOT A SCREEN SHARE</p>
          <h2>Everyone can<br />see the work.<br /><em>Everyone can shape it.</em></h2>
          <p>The session is a living record: what was asked, what the agent did, what changed, the human thinking that shaped it, and the capabilities the agent is drawing on.</p>
          <ul>{roomBenefits.map((benefit) => <li key={benefit}><Check size={15} /> {benefit}</li>)}</ul>
        </div>
        <SessionCanvas />
      </section>

      <section className="security-section" id="security">
        <div className="section-heading security-heading">
          <h2>Collaborate<br />freely. Keep<br /><em>control local.</em></h2>
          <p>Your host stays the source of truth. Credentials, files, and authority stay where they belong while the room carries the shared context.</p>
        </div>
        <div className="architecture" aria-label="Host to encrypted relay to browser collaborators">
          <div><span><SilverfishMark size={24} /></span><strong>Host machine</strong><small>Agent · files · credentials</small></div>
          <i><LockKeyhole size={16} /><b /></i>
          <div className="relay-node"><span><ShieldCheck size={23} /></span><strong>Encrypted room</strong><small>Context in motion</small></div>
          <i><LockKeyhole size={16} /><b /></i>
          <div><span><Users size={24} /></span><strong>Collaborators</strong><small>See · steer · approve</small></div>
        </div>
        <div className="security-list">
          <article><ShieldCheck size={18} /><div><h3>Credentials stay local</h3><p>Your machine remains the place where agent access lives.</p></div></article>
          <article><ShieldCheck size={18} /><div><h3>Encrypted in transit</h3><p>Room content is protected before it reaches the relay.</p></div></article>
          <article><ShieldCheck size={18} /><div><h3>Humans keep authority</h3><p>Important actions still wait for a clear, attributable approval.</p></div></article>
          <article><ShieldCheck size={18} /><div><h3>Recovery is built in</h3><p>The host can return to a local checkpoint when work goes sideways.</p></div></article>
        </div>
      </section>

      <section className="plans-section" id="plans">
        <div className="section-heading"><h2>Start with a<br />room. Scale<br /><em>when it sticks.</em></h2><p>Guests join from a link—no account, no login. Hosts can start free, then unlock more time for longer-running work.</p></div>
        <div className="plans-grid">
          {Object.values(PLANS).map((plan) => <article key={plan.id} className={plan.id === "founding_host" ? "plans-card highlighted" : "plans-card"}><h3>{plan.name}</h3><div className="plans-price"><span>{plan.priceLabel}</span>{plan.priceSuffix ? <small>{plan.priceSuffix}</small> : null}</div><p>{plan.tagline}</p><ul>{plan.features.map((feature) => <li key={feature}><Check size={15} /> {feature}</li>)}</ul><a className="plan-action" href={plan.id === "founding_host" ? subscribeHref : downloadHref} download={plan.id === "free"}>{plan.id === "founding_host" ? "Become a Founding Host" : "Download free"}<ArrowRight size={15} /></a></article>)}
        </div>
      </section>

      <section className="landing-cta">
        <div><p className="section-label">ONE SESSION. MORE POSSIBILITY.</p><h2>Open up the<br />project.</h2><p>Download Silverfish and give the people you want to build with a shared place to move the work forward.</p></div>
        <div className="cta-download"><DownloadLink /><span>Apple silicon · macOS 13+ · preview build</span></div>
      </section>

      <footer className="landing-footer"><Brand /><p>One agent session, opened up for shared creation.</p><div><a href="#plans">Plans</a><a href="#security">Security</a><a href={githubHref} target="_blank" rel="noreferrer">GitHub</a><a href="#top">Back to top</a></div></footer>
    </main>
  );
}

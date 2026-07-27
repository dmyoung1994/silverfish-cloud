import { ArrowDownToLine, Check, ExternalLink, LoaderCircle, MonitorDown, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { createGuestCampaign, recordConversionEvent } from "./conversion";
import { SilverfishMark } from "./SilverfishMark";
import "./landing.css";

const downloadHref = "/downloads/Silverfish-macOS-arm64.dmg";
const githubHref = "https://github.com/dmyoung1994/silverfish";
const configuredRelayUrl = import.meta.env.VITE_SILVERFISH_RELAY_URL?.trim() || window.location.origin;

export function HostYourOwnRoomPage() {
  const [campaign, setCampaign] = useState<string>();
  const [campaignError, setCampaignError] = useState(false);

  useEffect(() => {
    let current = true;
    void createGuestCampaign(configuredRelayUrl)
      .then((value) => current && setCampaign(value))
      .catch(() => current && setCampaignError(true));
    return () => { current = false; };
  }, []);

  const deepLink = campaign ? `silverfish://host-your-own?campaign=${encodeURIComponent(campaign)}` : undefined;
  return (
    <main className="landing-shell host-your-own-shell">
      <header className="landing-header">
        <a className="landing-brand" href="/" aria-label="Silverfish home">
          <span className="landing-mark"><SilverfishMark size={23} /></span><strong>Silverfish</strong>
        </a>
        <a className="text-link" href={githubHref} target="_blank" rel="noreferrer">View on GitHub <ExternalLink size={15} /></a>
      </header>
      <section className="host-conversion-content">
        <div className="host-conversion-copy">
          <p className="eyebrow">YOUR TURN TO HOST</p>
          <h1>Run the next room<br /><span>from your own Mac.</span></h1>
          <p>Silverfish lets collaborators steer a local Codex or Claude Code session without sharing your workspace or credentials.</p>
          <div className="host-platform-note"><MonitorDown size={16} /> macOS 13+ · Apple silicon</div>
        </div>
        <div className="host-conversion-card">
          <div className="host-plan-summary">
            <article><span>Start free</span><strong>$0</strong><p>1 guest · 60-minute rooms</p></article>
            <article><span>Founding Host</span><strong>$15<small>/ month</small></strong><p>Up to 8 guests · no room limit</p></article>
          </div>
          {campaign ? <>
            <a className="download-link host-download" href={downloadHref} download onClick={() => recordConversionEvent(configuredRelayUrl, campaign, "download_clicked")}>
              <ArrowDownToLine size={18} /> Download Silverfish
            </a>
            <p className="host-install-copy">Install it in Applications, then come back here to open your host setup.</p>
            <a className="host-open-link" href={deepLink} onClick={() => recordConversionEvent(configuredRelayUrl, campaign, "app_activated")}>
              I’ve installed it — open Silverfish <ExternalLink size={15} />
            </a>
          </> : campaignError ? <a className="download-link host-download" href={downloadHref} download><ArrowDownToLine size={18} /> Download Silverfish</a> : <div className="host-preparing"><LoaderCircle className="spin" size={18} /> Preparing your download…</div>}
          <div className="host-security-note"><Check size={16} /> Free to start · credentials stay on your Mac</div>
        </div>
      </section>
      <section className="host-alternative"><Users size={18} /><span>Not on an Apple-silicon Mac? <a href={githubHref} target="_blank" rel="noreferrer">Use the public project instead.</a></span></section>
    </main>
  );
}

# Silverfish

Silverfish is a multiplayer client for a host-owned local coding-agent session. The host runs the real agent and workspace locally; invited collaborators join in a browser and share prompts, steering, interruption, streamed commands and diffs, and one-time approvals.

Silverfish is MIT-licensed and designed to be self-hosted. The paid product is the convenience of the managed relay, maintained desktop builds, and support—not an artificial restriction in the source.

This repository contains a working macOS-first foundation:

- a Tauri 2 host application for Codex or Claude Code over local stdio;
- a shared React room UI for the host and browser guests;
- a self-hosted Rust WebSocket relay with per-invite capability tokens;
- browser/Rust AES-256-GCM room envelopes whose key never reaches the relay;
- an ordered host-authoritative prompt queue and reconnect snapshots;
- fail-closed pre-turn recovery checkpoints in the host's application data;
- a narrow Codex method allowlist with no direct shell, account, configuration, or filesystem API exposure.

## Prerequisites

- macOS with Rust 1.96+, Node 22+, and npm
- an authenticated `codex` CLI 0.144.1 or newer, or Claude Code
- optionally, [`dcg`](https://github.com/Dicklesworthstone/destructive_command_guard) for an additional destructive-command guard

The desktop verifies the selected harness before connecting. `dcg` is optional defense in depth for Codex and can be installed from its dependency row in the app. Codex remains pinned to `workspace-write` with granular interactive approvals and permission escalation disabled.

Finder-launched macOS apps do not inherit your terminal's `PATH`. Silverfish therefore checks common Homebrew, local npm, Volta, asdf, mise, nvm, and fnm install locations in addition to `PATH`. Set `SILVERFISH_CODEX_PATH` to the absolute path of the CLI if Codex is installed elsewhere.

## Skills and the MCP capability bridge

Silverfish keeps the host's agent setup useful without making every collaborator reproduce it.

- The room shows the host agent's installed skills and lets a host install a GitHub skill with Codex's own installer. Codex skills are installed in the existing Codex skills directory; Claude Code skills are installed in the workspace's `.claude/skills`. The app does not replace Codex's `/skills` command—it reads the same on-disk skill manifests so the room can see what the active harness can use.
- Codex runs in a small Silverfish runtime home that links the host's existing authentication and skills, but does not load the host's direct MCP configuration. Any direct MCP entries in the selected workspace's `.codex/config.toml` are disabled for the room. Claude Code receives `--strict-mcp-config` for the same reason.
- Both harnesses receive exactly one MCP server: `silverfish-capability-bridge`. It exposes only `search_capabilities` and `execute`. The bridge starts upstream stdio MCPs only when the agent searches for them, returns only matching schemas, and forwards an execution only after that tool has been discovered.

This is code-mode capability discovery: the agent searches for an API, receives the compact input schema for the relevant operation, then calls it through the bridge. It reduces MCP tool-schema context; it does **not** shrink the result returned by the upstream tool.

Configure the bridge's upstream MCPs with a JSON file. Silverfish uses the first available path in this order:

1. `SILVERFISH_MCP_BRIDGE_CONFIG`
2. `<workspace>/.silverfish/mcp-servers.json`
3. `$CODEX_HOME/local-mcp-broker/servers.json` (compatible with an existing local broker setup)
4. Silverfish's bundled empty configuration

For example:

```json
{
  "servers": {
    "project-tools": {
      "command": "node",
      "args": ["./mcp/server.mjs"],
      "cwd": "/absolute/path/to/project",
      "env": { "EXAMPLE_FLAG": "true" },
      "startupTimeoutMs": 30000
    }
  }
}
```

An upstream entry may instead use `pluginRoot`; the bridge selects its newest version directory before starting the command. Upstream credentials and authorization stay with the upstream MCP. The bridge is a schema and routing boundary, not an authorization bypass.

## Develop locally

Install dependencies and run the relay:

```sh
npm install
npm run build
cargo run -p co-dex-relay
```

In another terminal, launch the Tauri application:

```sh
npm run tauri -- dev
```

The default relay is `http://127.0.0.1:8787`. For browser invite pages in a development build, build the web UI and point the relay at it:

```sh
npm run build
CO_DEX_WEB_DIR=apps/desktop/dist cargo run -p co-dex-relay
```

To bake a deployed relay into the desktop app, set `VITE_SILVERFISH_RELAY_URL` in the repository-root `.env` before starting or building it:

```sh
VITE_SILVERFISH_RELAY_URL=https://relay.example.com
```

When set, this relay is used automatically and the relay URL field is hidden from the host setup screen. Leave it unset to keep the editable localhost default.

If browser invites are hosted separately from the relay, set the public site used to build invite URLs:

```sh
VITE_SILVERFISH_PUBLIC_URL=https://silverfish.example.com
```

The official managed-service build can link to a Founding Host subscription without putting payment credentials in the application. Create a $15/month recurring Price in Stripe Billing, use Stripe-hosted Checkout or a Payment Link, and set:

```sh
VITE_SILVERFISH_MANAGED_SERVICE=true
VITE_SILVERFISH_SUBSCRIBE_URL=https://buy.stripe.com/your-payment-link
```

`VITE_SILVERFISH_MANAGED_SERVICE` is false by default. Open-source and self-hosted builds therefore contain no subscription UI or license checks. If the official build has no checkout URL yet, it marks checkout as not yet open. Checkout, renewal, cancellation, receipts, and tax collection stay on Stripe-hosted pages.

The official managed build creates a random per-install entitlement credential and passes it to Stripe Checkout as `client_reference_id`. Signed Stripe webhooks activate or revoke the credential in Cloudflare D1. The managed Worker validates that credential on room creation and asks the relay origin for the paid room limits over a separately authenticated proxy channel. Credentials are stored only as SHA-256 hashes at the edge, and payment details never enter Silverfish. Free managed rooms remain limited to one guest and 60 minutes; active Founding Host subscriptions receive up to eight guests without a hard room deadline.

For internet use, terminate TLS in front of the relay. Plain `ws://` is intended only for localhost development.

## Deploy the relay

The relay and guest UI are packaged into one unprivileged container:

```sh
docker compose up --build
```

The relay stores room registrations only in memory, never stores transcript payloads, and cannot decrypt the ciphertext it forwards. A restart disconnects rooms; the host's Codex threads and recovery data remain local and guests resynchronize after reconnecting.

Room capacity and hard lifetime are deployment settings. `SILVERFISH_MAX_GUESTS_PER_ROOM` defaults to 32, while `SILVERFISH_ROOM_LIFETIME_SECONDS` defaults to `0` (no hard deadline). The managed relay uses `1` guest and `3600` seconds for its free tier. Self-hosters can set either value independently and do not need Stripe, D1, or the managed proxy secret.

Production deployments should add a TLS reverse proxy, request-level rate limiting at the edge, and an origin allowlist appropriate to their domain. Health checks are available at `/healthz`.

### Current managed test deployment

The public site, DMG, and public relay endpoint are served from a Cloudflare Worker:

```text
https://try.silverfish-app.workers.dev
```

The Worker serves the static application and proxies only `/healthz` and `/api/rooms*` to the IPv6-only Free Tier `e2-micro` origin. Collaborators therefore use a normal dual-stack `workers.dev` hostname and do not need IPv6. The Cloudflare Workers Free plan has a hard daily request cap instead of usage overage billing. Room state remains on the e2 instance and is held only in memory.

Build and publish an updated image:

```sh
gcloud builds submit . \
  --config=cloudbuild.yaml \
  --substitutions=_IMAGE=us-west1-docker.pkg.dev/gen-lang-client-0308672059/co-dex/relay:latest \
  --project=gen-lang-client-0308672059
```

Apply relay startup-script changes and restart the empty relay:

```sh
gcloud compute instances add-metadata co-dex-relay \
  --zone=us-west1-b \
  --metadata-from-file=startup-script=scripts/gcp-startup.sh \
  --project=gen-lang-client-0308672059

gcloud compute instances reset co-dex-relay \
  --zone=us-west1-b \
  --project=gen-lang-client-0308672059
```

Build and deploy the public site and download:

```sh
npm run build
npx wrangler deploy --config workers/relay-proxy/wrangler.jsonc
```

The Worker is a narrow availability bridge, not a trust boundary: end-to-end room encryption remains unchanged and the Worker cannot decrypt payloads. Keep the e2 VM and Artifact Registry within Google Cloud's Free Tier limits.

## Security model

- Every guest receives a unique revocable relay token. Revocation closes its active socket and prevents reconnection.
- The invite URL fragment carries the room key and is not included in the HTTP request to the relay.
- The relay sees room IDs, connection metadata, and ciphertext sizes/timing. It cannot see names, prompts, tool output, diffs, or approvals.
- Only the host process talks to app-server. Guest intents map to a fixed command set; raw JSON-RPC is never forwarded.
- The agent receives only Silverfish's two-tool MCP bridge. Upstream MCP schemas are fetched only after a capability search, and the room records bridge activity as a tool event.
- `thread/shellCommand`, `fs/*`, account/login, config, plugin/marketplace, persistent command-rule approvals, permission profiles, and unsupported server requests are not exposed.
- Command and file-change approvals accept only once. First valid response wins.
- Before a queued turn starts, Silverfish snapshots workspace files into a content-addressed local store. `.git`, `node_modules`, `target`, `dist`, `.build`, and `.cache` are excluded. A snapshot over 1 GiB pauses the queue.

Collaborators are trusted project participants: they intentionally see project content and command output produced in the room. Basic token patterns are redacted, but redaction is not a substitute for keeping secrets outside agent-readable project files.

## Verification

```sh
cargo fmt --all -- --check
cargo test --workspace
npm run typecheck
npm run build
npm run smoke:codex
npm run smoke:relay
npm run test:mcp-bridge --workspace @silverfish/desktop
```

The current app-server adapter is pinned and contract-checked against Codex 0.144.1. When Codex changes its protocol, update the minimum version only after regenerating and reviewing `codex app-server generate-ts` output.

# Silverfish

Silverfish is a multiplayer client for a host-owned Codex session. The host runs the real agent and workspace locally; invited collaborators join in a browser and share prompts, steering, interruption, streamed commands and diffs, and one-time approvals.

Silverfish is MIT-licensed and designed to be self-hosted. The paid product is the convenience of the managed relay, maintained desktop builds, and support—not an artificial restriction in the source.

This repository contains a working macOS-first foundation:

- a Tauri 2 host application using `codex app-server` over local stdio;
- a shared React room UI for the host and browser guests;
- a self-hosted Rust WebSocket relay with per-invite capability tokens;
- browser/Rust AES-256-GCM room envelopes whose key never reaches the relay;
- an ordered host-authoritative prompt queue and reconnect snapshots;
- fail-closed pre-turn recovery checkpoints in the host's application data;
- a narrow Codex method allowlist with no direct shell, account, configuration, or filesystem API exposure.

## Prerequisites

- macOS with Rust 1.96+, Node 22+, and npm
- an authenticated `codex` CLI 0.144.1 or newer
- optionally, [`dcg`](https://github.com/Dicklesworthstone/destructive_command_guard) for an additional destructive-command guard

The desktop refuses to connect when Codex is missing or incompatible. `dcg` is optional defense in depth and can be installed from its dependency row in the app. Codex remains pinned to `workspace-write` with granular interactive approvals and permission escalation disabled.

Finder-launched macOS apps do not inherit your terminal's `PATH`. Silverfish therefore checks common Homebrew, local npm, Volta, asdf, mise, nvm, and fnm install locations in addition to `PATH`. Set `SILVERFISH_CODEX_PATH` to the absolute path of the CLI if Codex is installed elsewhere.

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
VITE_SILVERFISH_RELAY_URL=https://[2600:1900:4041:40e:0:1::]
```

When set, this relay is used automatically and the relay URL field is hidden from the host setup screen. Leave it unset to keep the editable localhost default.

The public landing page can link to a hosted Founding Host subscription checkout without putting payment credentials in the application. Create a $15/month recurring product in Stripe Managed Payments, create its hosted checkout link, then set the public checkout URL:

```sh
VITE_SILVERFISH_SUBSCRIBE_URL=https://buy.stripe.com/your-payment-link
```

If this variable is unset, the pricing section remains visible but clearly marks checkout as not yet open. Payment, renewal, cancellation, receipts, and merchant-of-record tax handling stay on Stripe-hosted pages.

For internet use, terminate TLS in front of the relay. Plain `ws://` is intended only for localhost development.

## Deploy the relay

The relay and guest UI are packaged into one unprivileged container:

```sh
docker compose up --build
```

The relay stores room registrations only in memory, never stores transcript payloads, and cannot decrypt the ciphertext it forwards. A restart disconnects rooms; the host's Codex threads and recovery data remain local and guests resynchronize after reconnecting.

Room capacity and hard lifetime are deployment settings, not application license checks. `SILVERFISH_MAX_GUESTS_PER_ROOM` defaults to 32, while `SILVERFISH_ROOM_LIFETIME_SECONDS` defaults to `0` (no hard deadline). The managed friends-and-family relay uses `1` guest and `3600` seconds for its free tier. Self-hosters can set either value independently.

Production deployments should add a TLS reverse proxy, request-level rate limiting at the edge, and an origin allowlist appropriate to their domain. Health checks are available at `/healthz`.

### Current GCP test relay

The friends-and-family relay is deployed to an IPv6-only Free Tier `e2-micro` in `us-west1-b`:

```text
https://[2600:1900:4041:40e:0:1::]
```

It runs in project `gen-lang-client-0308672059` as instance `co-dex-relay` (the infrastructure keeps its original internal name). Nginx terminates a trusted Let's Encrypt IP-address certificate, HTTP redirects to HTTPS, and a systemd timer checks for certificate renewal twice daily. Only inbound IPv6 ports 80 and 443 are open; the relay process on port 8787 is not publicly reachable.

Build and publish an updated image:

```sh
gcloud builds submit . \
  --config=cloudbuild.yaml \
  --substitutions=_IMAGE=us-west1-docker.pkg.dev/gen-lang-client-0308672059/co-dex/relay:latest \
  --project=gen-lang-client-0308672059
```

Apply startup-script changes and restart the empty relay:

```sh
gcloud compute instances add-metadata co-dex-relay \
  --zone=us-west1-b \
  --metadata-from-file=startup-script=scripts/gcp-startup.sh \
  --project=gen-lang-client-0308672059

gcloud compute instances reset co-dex-relay \
  --zone=us-west1-b \
  --project=gen-lang-client-0308672059
```

The address is IPv6-only. Each collaborator must have working IPv6 connectivity. Keep usage within Google Cloud's current Free Tier limits, particularly outbound transfer and Artifact Registry storage.

## Security model

- Every guest receives a unique revocable relay token. Revocation closes its active socket and prevents reconnection.
- The invite URL fragment carries the room key and is not included in the HTTP request to the relay.
- The relay sees room IDs, connection metadata, and ciphertext sizes/timing. It cannot see names, prompts, tool output, diffs, or approvals.
- Only the host process talks to app-server. Guest intents map to a fixed command set; raw JSON-RPC is never forwarded.
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
```

The current app-server adapter is pinned and contract-checked against Codex 0.144.1. When Codex changes its protocol, update the minimum version only after regenerating and reviewing `codex app-server generate-ts` output.

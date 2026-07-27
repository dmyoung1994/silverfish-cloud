const CAMPAIGN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CAMPAIGN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const ENTITLEMENT_CREDENTIAL_PATTERN = /^sf_[A-Za-z0-9_-]{43}$/;

const EVENT_TYPES = new Set([
  "download_clicked",
  "app_activated",
  "host_setup_opened",
  "room_started",
  "checkout_opened",
]);
const requestWindows = new Map<string, { count: number; resetAt: number }>();

type ConversionEventType = "download_clicked" | "app_activated" | "host_setup_opened" | "room_started" | "checkout_opened";

export async function issueGuestCampaign(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);
  if (!body || body.source !== "guest_room") return Response.json({ error: "Unsupported conversion source" }, { status: 400 });

  const campaign = randomToken();
  const campaignHash = await hashValue(campaign);
  const issuedAt = nowSeconds();
  const expiresAt = issuedAt + CAMPAIGN_TTL_SECONDS;
  await env.ENTITLEMENTS.batch([
    env.ENTITLEMENTS
      .prepare("INSERT INTO conversion_campaigns (campaign_hash, source, issued_at, expires_at) VALUES (?, 'guest_room', ?, ?)")
      .bind(campaignHash, issuedAt, expiresAt),
    env.ENTITLEMENTS
      .prepare("INSERT INTO conversion_events (campaign_hash, event_type, occurred_at) VALUES (?, 'guest_cta_opened', ?)")
      .bind(campaignHash, issuedAt),
  ]);
  return Response.json({ campaign, expiresAt });
}

export async function recordConversionEvent(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);
  const campaign = typeof body?.campaign === "string" ? body.campaign : "";
  const eventType = typeof body?.eventType === "string" ? body.eventType : "";
  const credential = typeof body?.credential === "string" ? body.credential : undefined;
  if (!CAMPAIGN_TOKEN_PATTERN.test(campaign) || !EVENT_TYPES.has(eventType)) {
    return Response.json({ error: "Invalid conversion event" }, { status: 400 });
  }
  if (credential && !ENTITLEMENT_CREDENTIAL_PATTERN.test(credential)) {
    return Response.json({ error: "Invalid device credential" }, { status: 400 });
  }

  const campaignHash = await hashValue(campaign);
  const now = nowSeconds();
  const current = await env.ENTITLEMENTS
    .prepare("SELECT credential_hash FROM conversion_campaigns WHERE campaign_hash = ? AND expires_at > ? LIMIT 1")
    .bind(campaignHash, now)
    .first<{ credential_hash: string | null }>();
  if (!current) return Response.json({ error: "Campaign expired" }, { status: 410 });

  const credentialHash = credential ? await hashValue(credential) : undefined;
  if (credentialHash && current.credential_hash && current.credential_hash !== credentialHash) {
    return Response.json({ error: "Campaign already activated" }, { status: 409 });
  }

  const statements: D1PreparedStatement[] = [];
  if (credentialHash && !current.credential_hash) {
    statements.push(env.ENTITLEMENTS
      .prepare("UPDATE conversion_campaigns SET credential_hash = ?, activated_at = ? WHERE campaign_hash = ?")
      .bind(credentialHash, now, campaignHash));
  }
  statements.push(env.ENTITLEMENTS
    .prepare("INSERT OR IGNORE INTO conversion_events (campaign_hash, event_type, occurred_at) VALUES (?, ?, ?)")
    .bind(campaignHash, eventType, now));
  await env.ENTITLEMENTS.batch(statements);
  return Response.json({ recorded: true });
}

export async function recordSubscriptionConversion(credentialHash: string, env: Env): Promise<void> {
  const campaign = await env.ENTITLEMENTS
    .prepare("SELECT campaign_hash FROM conversion_campaigns WHERE credential_hash = ? LIMIT 1")
    .bind(credentialHash)
    .first<{ campaign_hash: string }>();
  if (!campaign) return;
  await env.ENTITLEMENTS
    .prepare("INSERT OR IGNORE INTO conversion_events (campaign_hash, event_type, occurred_at) VALUES (?, 'subscription_activated', ?)")
    .bind(campaign.campaign_hash, nowSeconds())
    .run();
}

// This is intentionally isolate-local: it limits abusive bursts without retaining IP data in D1.
export function conversionRateLimited(request: Request): boolean {
  const now = Date.now();
  const client = request.headers.get("cf-connecting-ip") || "unknown";
  const current = requestWindows.get(client);
  if (!current || current.resetAt <= now) {
    requestWindows.set(client, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  current.count += 1;
  return current.count > 30;
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hashValue(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

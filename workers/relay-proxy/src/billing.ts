import { verifyFirebaseIdToken } from "./firebaseAuth";

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);
const COMPLETED_PAYMENT_STATUSES = new Set(["paid", "no_payment_required"]);
const ENTITLEMENT_CREDENTIAL_PATTERN = /^sf_[A-Za-z0-9_-]{43}$/;

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  object: Record<string, unknown>;
}

export interface EntitlementStatus {
  active: boolean;
  plan: "free" | "founding_host";
  maxGuests: number;
  roomLifetimeSeconds: number | null;
}

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "Missing Stripe signature" }, { status: 400 });

  const rawBody = await request.text();
  if (!await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET)) {
    return Response.json({ error: "Invalid Stripe signature" }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = parseStripeEvent(JSON.parse(rawBody));
  } catch {
    return Response.json({ error: "Invalid Stripe event" }, { status: 400 });
  }

  try {
    await processStripeEvent(event, env);
    return Response.json({ received: true });
  } catch (error) {
    console.error(JSON.stringify({
      message: "stripe webhook processing failed",
      eventId: event.id,
      eventType: event.type,
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

export async function readEntitlementStatus(request: Request, env: Env): Promise<EntitlementStatus> {
  const credential = bearerCredential(request.headers);
  if (!credential || !ENTITLEMENT_CREDENTIAL_PATTERN.test(credential)) return freeEntitlement();

  const credentialHash = await hashCredential(credential);
  const row = await env.ENTITLEMENTS
    .prepare("SELECT status FROM subscription_entitlements WHERE credential_hash = ? LIMIT 1")
    .bind(credentialHash)
    .first<{ status: string }>();

  if (!row || !ACTIVE_SUBSCRIPTION_STATUSES.has(row.status)) return freeEntitlement();
  return {
    active: true,
    plan: "founding_host",
    maxGuests: positiveInteger(env.PAID_MAX_GUESTS, 8),
    roomLifetimeSeconds: null,
  };
}

export async function hasActiveEntitlement(request: Request, env: Env): Promise<boolean> {
  return (await readEntitlementStatus(request, env)).active;
}

export function hasEntitlementCredential(request: Request): boolean {
  return bearerCredential(request.headers) !== undefined;
}

function freeEntitlement(): EntitlementStatus {
  return {
    active: false,
    plan: "free",
    maxGuests: 1,
    roomLifetimeSeconds: 60 * 60,
  };
}

async function processStripeEvent(event: StripeEvent, env: Env): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await activateCheckoutEntitlement(event, env);
      return;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await updateSubscriptionEntitlement(event, env);
      return;
    default:
      await recordIgnoredEvent(event, env);
  }
}

async function activateCheckoutEntitlement(event: StripeEvent, env: Env): Promise<void> {
  const session = event.object;
  const credential = stringField(session, "client_reference_id");
  const customerId = expandableId(session.customer);
  const subscriptionId = expandableId(session.subscription);
  const paymentLinkId = expandableId(session.payment_link);
  const paymentStatus = stringField(session, "payment_status");
  const email = customerEmail(session);

  if (
    stringField(session, "mode") !== "subscription"
    || paymentLinkId !== env.EXPECTED_STRIPE_PAYMENT_LINK_ID
    || !credential
    || !ENTITLEMENT_CREDENTIAL_PATTERN.test(credential)
    || !customerId
    || !subscriptionId
    || !paymentStatus
    || !COMPLETED_PAYMENT_STATUSES.has(paymentStatus)
  ) {
    await recordIgnoredEvent(event, env);
    return;
  }

  const credentialHash = await hashCredential(credential);
  const processedAt = Math.floor(Date.now() / 1000);
  await env.ENTITLEMENTS.batch([
    env.ENTITLEMENTS
      .prepare("INSERT OR IGNORE INTO stripe_events (event_id, processed_at) VALUES (?, ?)")
      .bind(event.id, processedAt),
    env.ENTITLEMENTS.prepare(`
      INSERT INTO subscription_entitlements (
        credential_hash,
        customer_id,
        subscription_id,
        status,
        email,
        stripe_event_created,
        updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(credential_hash) DO UPDATE SET
        customer_id = excluded.customer_id,
        subscription_id = excluded.subscription_id,
        status = excluded.status,
        email = excluded.email,
        stripe_event_created = excluded.stripe_event_created,
        updated_at = excluded.updated_at
      WHERE excluded.stripe_event_created >= subscription_entitlements.stripe_event_created
    `).bind(
      credentialHash,
      customerId,
      subscriptionId,
      email,
      event.created,
      processedAt,
    ),
  ]);
}

export async function attachAccountEntitlement(
  request: Request,
  env: Env,
): Promise<{ status: number; body: EntitlementStatus | { error: string } }> {
  const idToken = bearerCredential(request.headers);
  if (!idToken) return { status: 401, body: { error: "Missing Google sign-in token" } };

  const identity = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  if (!identity) return { status: 401, body: { error: "Invalid or expired Google sign-in token" } };

  let credential: string | undefined;
  try {
    const parsed = await request.json() as { credential?: unknown };
    credential = typeof parsed.credential === "string" ? parsed.credential : undefined;
  } catch {
    credential = undefined;
  }
  if (!credential || !ENTITLEMENT_CREDENTIAL_PATTERN.test(credential)) {
    return { status: 400, body: { error: "Missing device credential" } };
  }

  const existing = await env.ENTITLEMENTS
    .prepare(`
      SELECT customer_id, subscription_id, status
      FROM subscription_entitlements
      WHERE email = ? AND status IN ('active', 'trialing')
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .bind(identity.email)
    .first<{ customer_id: string; subscription_id: string; status: string }>();

  if (!existing) {
    return {
      status: 404,
      body: { error: "No active Founding Host subscription found for this Google account" },
    };
  }

  const credentialHash = await hashCredential(credential);
  const now = Math.floor(Date.now() / 1000);
  await env.ENTITLEMENTS.prepare(`
    INSERT INTO subscription_entitlements (
      credential_hash, customer_id, subscription_id, status, email, stripe_event_created, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(credential_hash) DO UPDATE SET
      customer_id = excluded.customer_id,
      subscription_id = excluded.subscription_id,
      status = excluded.status,
      email = excluded.email,
      stripe_event_created = excluded.stripe_event_created,
      updated_at = excluded.updated_at
  `).bind(
    credentialHash,
    existing.customer_id,
    existing.subscription_id,
    existing.status,
    identity.email,
    now,
    now,
  ).run();

  return {
    status: 200,
    body: {
      active: true,
      plan: "founding_host",
      maxGuests: positiveInteger(env.PAID_MAX_GUESTS, 8),
      roomLifetimeSeconds: null,
    },
  };
}

async function updateSubscriptionEntitlement(event: StripeEvent, env: Env): Promise<void> {
  const subscriptionId = stringField(event.object, "id");
  const status = event.type === "customer.subscription.deleted"
    ? "canceled"
    : stringField(event.object, "status");
  if (!subscriptionId || !status) {
    await recordIgnoredEvent(event, env);
    return;
  }

  const processedAt = Math.floor(Date.now() / 1000);
  await env.ENTITLEMENTS.batch([
    env.ENTITLEMENTS
      .prepare("INSERT OR IGNORE INTO stripe_events (event_id, processed_at) VALUES (?, ?)")
      .bind(event.id, processedAt),
    env.ENTITLEMENTS.prepare(`
      UPDATE subscription_entitlements
      SET status = ?, stripe_event_created = ?, updated_at = ?
      WHERE subscription_id = ? AND stripe_event_created <= ?
    `).bind(status, event.created, processedAt, subscriptionId, event.created),
  ]);
}

async function recordIgnoredEvent(event: StripeEvent, env: Env): Promise<void> {
  await env.ENTITLEMENTS
    .prepare("INSERT OR IGNORE INTO stripe_events (event_id, processed_at) VALUES (?, ?)")
    .bind(event.id, Math.floor(Date.now() / 1000))
    .run();
}

async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
): Promise<boolean> {
  const signatureParts = header.split(",");
  const timestampPart = signatureParts.find((part) => part.startsWith("t="));
  const timestamp = timestampPart ? Number(timestampPart.slice(2)) : Number.NaN;
  if (
    !Number.isSafeInteger(timestamp)
    || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > WEBHOOK_TOLERANCE_SECONDS
  ) {
    return false;
  }

  const signatures = signatureParts
    .filter((part) => part.startsWith("v1="))
    .map((part) => hexBytes(part.slice(3)))
    .filter((value): value is Uint8Array<ArrayBuffer> => value !== undefined);
  if (signatures.length === 0) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${payload}`),
  ));
  return signatures.some((candidate) => (
    candidate.byteLength === expected.byteLength
    && crypto.subtle.timingSafeEqual(candidate, expected)
  ));
}

async function hashCredential(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bearerCredential(headers: Headers): string | undefined {
  const authorization = headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const credential = authorization.slice("Bearer ".length).trim();
  return credential || undefined;
}

function parseStripeEvent(value: unknown): StripeEvent {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.object)) {
    throw new Error("Invalid Stripe event envelope");
  }
  const id = stringField(value, "id");
  const type = stringField(value, "type");
  const created = numberField(value, "created");
  if (!id || !type || created === undefined) throw new Error("Missing Stripe event fields");
  return { id, type, created, object: value.data.object };
}

function expandableId(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  return isRecord(value) ? stringField(value, "id") : undefined;
}

function customerEmail(session: Record<string, unknown>): string | undefined {
  if (!isRecord(session.customer_details)) return undefined;
  const email = stringField(session.customer_details, "email");
  return email ? email.toLowerCase().trim() : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isSafeInteger(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hexBytes(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    return undefined;
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

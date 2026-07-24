import { createHmac, randomBytes, randomUUID } from "node:crypto";

const worker = process.env.SILVERFISH_WORKER_URL ?? "http://127.0.0.1:8788";
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "test_webhook_secret";
const credential = `sf_${randomBytes(32).toString("base64url")}`;
const subscriptionId = `sub_${randomUUID().replaceAll("-", "")}`;
const customerId = `cus_${randomUUID().replaceAll("-", "")}`;

const freeRoom = await createRoom();
assert(freeRoom.limits.maxGuests === 1, "free room must allow one guest");
assert(typeof freeRoom.limits.expiresAtMs === "number", "free room must expire");

const beforeCheckout = await entitlementStatus();
assert(!beforeCheckout.active, "new entitlement must start inactive");

const checkoutEvent = stripeEvent("checkout.session.completed", {
  id: `cs_${randomUUID().replaceAll("-", "")}`,
  mode: "subscription",
  payment_link: "plink_test",
  payment_status: "paid",
  client_reference_id: credential,
  customer: customerId,
  subscription: subscriptionId,
});
await deliverWebhook(checkoutEvent);
await deliverWebhook(checkoutEvent);

const active = await entitlementStatus();
assert(active.active && active.plan === "founding_host", "checkout must activate the subscription");
assert(active.maxGuests === 8, "active plan must report eight guests");
assert(active.roomLifetimeSeconds === null, "active plan must report unlimited room time");

const paidRoom = await createRoom(credential);
assert(paidRoom.limits.maxGuests === 8, "paid room must allow eight guests");
assert(paidRoom.limits.expiresAtMs == null, "paid room must not expire");

const invalidSignature = await fetch(`${worker}/api/stripe/webhook`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "stripe-signature": "t=1,v1=invalid",
  },
  body: JSON.stringify(checkoutEvent),
});
assert(invalidSignature.status === 400, "invalid webhook signatures must be rejected");

await deliverWebhook(stripeEvent("customer.subscription.updated", {
  id: subscriptionId,
  status: "past_due",
}));
const revoked = await entitlementStatus();
assert(!revoked.active, "past-due subscriptions must lose paid access");

const rejectedRoom = await fetch(`${worker}/api/rooms`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${credential}`,
    "content-type": "application/json",
  },
  body: "{}",
});
assert(rejectedRoom.status === 403, "inactive paid credentials must not silently fall back to free");

await deliverWebhook(stripeEvent("customer.subscription.updated", {
  id: subscriptionId,
  status: "active",
}));
assert((await entitlementStatus()).active, "renewed subscriptions must restore paid access");

await deliverWebhook(stripeEvent("customer.subscription.deleted", {
  id: subscriptionId,
  status: "canceled",
}));
assert(!(await entitlementStatus()).active, "canceled subscriptions must lose paid access");

await deliverWebhook(stripeEvent("checkout.session.completed", {
  id: `cs_${randomUUID().replaceAll("-", "")}`,
  mode: "subscription",
  payment_link: "plink_wrong",
  payment_status: "paid",
  client_reference_id: credential,
  customer: customerId,
  subscription: `sub_${randomUUID().replaceAll("-", "")}`,
}));
assert(!(await entitlementStatus()).active, "unrecognized payment links must not grant access");

console.log("billing smoke test passed: free, activation, paid limits, signature rejection, renewal, cancellation, and product validation");

async function createRoom(entitlementCredential) {
  const headers = { "content-type": "application/json" };
  if (entitlementCredential) headers.authorization = `Bearer ${entitlementCredential}`;
  const response = await fetch(`${worker}/api/rooms`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert(response.ok, `room creation failed (${response.status})`);
  return response.json();
}

async function entitlementStatus() {
  const response = await fetch(`${worker}/api/billing/status`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  assert(response.ok, `entitlement check failed (${response.status})`);
  return response.json();
}

async function deliverWebhook(event) {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  const response = await fetch(`${worker}/api/stripe/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: payload,
  });
  assert(response.ok, `webhook delivery failed (${response.status})`);
}

function stripeEvent(type, object) {
  return {
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

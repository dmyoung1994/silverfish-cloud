import {
  attachAccountEntitlement,
  handleStripeWebhook,
  hasActiveEntitlement,
  hasEntitlementCredential,
  readEntitlementStatus,
} from "./billing";
import { conversionRateLimited, issueGuestCampaign, recordConversionEvent } from "./conversions";

const STRIPE_WEBHOOK_PATH = "/api/stripe/webhook";
const ENTITLEMENT_STATUS_PATH = "/api/billing/status";
const ATTACH_ACCOUNT_PATH = "/api/billing/attach-account";
const CONVERSION_CAMPAIGNS_PATH = "/api/conversions/campaigns";
const CONVERSION_EVENTS_PATH = "/api/conversions/events";
const MANAGED_PLAN_HEADER = "x-silverfish-managed-plan";
const PROXY_SECRET_HEADER = "x-silverfish-proxy-secret";
const MACOS_DOWNLOAD_PATH = "/downloads/Silverfish-macOS-arm64.dmg";
const MACOS_DOWNLOAD_URL = "https://github.com/dmyoung1994/silverfish/releases/latest/download/Silverfish-macOS-arm64.dmg";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    if (incoming.pathname === "/updates/latest.json") {
      const response = await env.ASSETS.fetch(request);
      const fresh = new Response(response.body, response);
      fresh.headers.set("cache-control", "no-store");
      return fresh;
    }
    if (incoming.pathname === MACOS_DOWNLOAD_PATH) {
      return Response.redirect(MACOS_DOWNLOAD_URL, 302);
    }
    if (incoming.pathname === STRIPE_WEBHOOK_PATH) {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleStripeWebhook(request, env);
    }

    if (incoming.pathname === ENTITLEMENT_STATUS_PATH) {
      if (request.method === "OPTIONS") return corsResponse(new Response(null, { status: 204 }));
      if (request.method !== "GET") return corsResponse(new Response("Method not allowed", { status: 405 }));
      return corsResponse(Response.json(await readEntitlementStatus(request, env)));
    }

    if (incoming.pathname === ATTACH_ACCOUNT_PATH) {
      if (request.method === "OPTIONS") return corsResponse(new Response(null, { status: 204 }));
      if (request.method !== "POST") return corsResponse(new Response("Method not allowed", { status: 405 }));
      const { status, body } = await attachAccountEntitlement(request, env);
      return corsResponse(Response.json(body, { status }));
    }

    if (incoming.pathname === CONVERSION_CAMPAIGNS_PATH) {
      if (request.method === "OPTIONS") return corsResponse(new Response(null, { status: 204 }));
      if (request.method !== "POST") return corsResponse(new Response("Method not allowed", { status: 405 }));
      if (conversionRateLimited(request)) return corsResponse(Response.json({ error: "Too many conversion requests" }, { status: 429 }));
      return corsResponse(await issueGuestCampaign(request, env));
    }

    if (incoming.pathname === CONVERSION_EVENTS_PATH) {
      if (request.method === "OPTIONS") return corsResponse(new Response(null, { status: 204 }));
      if (request.method !== "POST") return corsResponse(new Response("Method not allowed", { status: 405 }));
      if (conversionRateLimited(request)) return corsResponse(Response.json({ error: "Too many conversion requests" }, { status: 429 }));
      return corsResponse(await recordConversionEvent(request, env));
    }

    if (incoming.pathname !== "/healthz" && !incoming.pathname.startsWith("/api/rooms")) {
      return env.ASSETS.fetch(request);
    }

    const isRoomCreation = incoming.pathname === "/api/rooms" && request.method === "POST";
    const suppliedEntitlement = isRoomCreation && hasEntitlementCredential(request);
    const paidRoom = suppliedEntitlement && await hasActiveEntitlement(request, env);
    if (suppliedEntitlement && !paidRoom) {
      return corsResponse(Response.json({ error: "Active subscription required" }, { status: 403 }));
    }

    const origin = new URL(env.ORIGIN_URL);
    origin.pathname = incoming.pathname;
    origin.search = incoming.search;

    const headers = new Headers(request.headers);
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ipcountry");
    headers.delete("cf-ray");
    headers.delete("cf-visitor");
    headers.delete("host");
    headers.delete("x-forwarded-for");
    headers.delete(MANAGED_PLAN_HEADER);
    headers.delete(PROXY_SECRET_HEADER);
    headers.set("x-forwarded-proto", "https");
    if (isRoomCreation) headers.delete("authorization");
    if (paidRoom) {
      headers.set(MANAGED_PLAN_HEADER, "founding_host");
      headers.set(PROXY_SECRET_HEADER, env.RELAY_PROXY_SECRET);
    }

    try {
      const response = await fetch(new Request(origin, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      }));
      return isRoomCreation ? corsResponse(response) : response;
    } catch (error) {
      console.error(JSON.stringify({
        message: "relay origin unavailable",
        error: error instanceof Error ? error.message : String(error),
        method: request.method,
        path: incoming.pathname,
      }));
      return Response.json({ error: "Relay temporarily unavailable" }, { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;

function corsResponse(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set("access-control-allow-origin", "*");
  result.headers.set("access-control-allow-headers", "authorization, content-type");
  result.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  result.headers.set("vary", "Origin");
  return result;
}

import { normalizeRelayUrl } from "./relay";

const ENTITLEMENT_STORAGE_KEY = "silverfish.managed-entitlement.v1";

export interface ManagedEntitlement {
  active: boolean;
  plan: "free" | "founding_host";
  maxGuests: number;
  roomLifetimeSeconds: number | null;
}

export function getOrCreateEntitlementCredential(): string {
  try {
    const existing = window.localStorage.getItem(ENTITLEMENT_STORAGE_KEY);
    if (isEntitlementCredential(existing)) return existing;
    const created = createEntitlementCredential();
    window.localStorage.setItem(ENTITLEMENT_STORAGE_KEY, created);
    return created;
  } catch {
    return createEntitlementCredential();
  }
}

export function checkoutUrl(baseUrl: string, credential: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("client_reference_id", credential);
  return url.toString();
}

export async function fetchManagedEntitlement(
  relayUrl: string,
  credential: string,
): Promise<ManagedEntitlement> {
  const response = await fetch(`${normalizeRelayUrl(relayUrl)}/api/billing/status`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  if (!response.ok) throw new Error(`Could not verify subscription (${response.status})`);
  return response.json() as Promise<ManagedEntitlement>;
}

export async function attachHostEntitlement(
  relayUrl: string,
  firebaseIdToken: string,
  credential: string,
): Promise<ManagedEntitlement> {
  const response = await fetch(`${normalizeRelayUrl(relayUrl)}/api/billing/attach-account`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${firebaseIdToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ credential }),
  });
  const body = await response.json() as ManagedEntitlement | { error: string };
  if (!response.ok) {
    const message = "error" in body ? body.error : `Could not attach subscription (${response.status})`;
    throw new Error(message);
  }
  return body as ManagedEntitlement;
}

function createEntitlementCredential(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const binary = String.fromCharCode(...bytes);
  return `sf_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

function isEntitlementCredential(value: string | null): value is string {
  return Boolean(value && /^sf_[A-Za-z0-9_-]{43}$/.test(value));
}

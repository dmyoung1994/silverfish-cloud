const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const JWKS_CACHE_TTL_SECONDS = 60 * 60;

interface Jwk {
  kid: string;
  n: string;
  e: string;
  kty: string;
  alg?: string;
}

export interface FirebaseIdentity {
  uid: string;
  email: string;
}

export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
): Promise<FirebaseIdentity | undefined> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !projectId) return undefined;
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = parseJson(headerPart);
  const payload = parseJson(payloadPart);
  if (!header || !payload) return undefined;
  if (header.alg !== "RS256" || typeof header.kid !== "string") return undefined;

  const jwk = await findJwk(header.kid);
  if (!jwk) return undefined;

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = decodeBase64Url(signaturePart);
  const signedData = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
  if (!valid) return undefined;

  const now = Math.floor(Date.now() / 1000);
  const uid = typeof payload.sub === "string" ? payload.sub : undefined;
  const email = typeof payload.email === "string" ? payload.email.toLowerCase().trim() : undefined;
  if (
    !uid
    || !email
    || payload.email_verified !== true
    || payload.iss !== `https://securetoken.google.com/${projectId}`
    || payload.aud !== projectId
    || typeof payload.exp !== "number"
    || payload.exp <= now
    || typeof payload.iat !== "number"
    || payload.iat > now + 60
  ) {
    return undefined;
  }

  return { uid, email };
}

let cachedJwks: { keys: Jwk[]; expiresAt: number } | undefined;

async function findJwk(kid: string): Promise<Jwk | undefined> {
  if (!cachedJwks || cachedJwks.expiresAt <= Date.now()) {
    const response = await fetch(JWKS_URL);
    if (!response.ok) return undefined;
    const body = await response.json() as { keys?: Jwk[] };
    cachedJwks = {
      keys: body.keys ?? [],
      expiresAt: Date.now() + JWKS_CACHE_TTL_SECONDS * 1000,
    };
  }
  return cachedJwks.keys.find((key) => key.kid === kid);
}

function parseJson(base64UrlPart: string): Record<string, unknown> | undefined {
  try {
    const bytes = decodeBase64Url(base64UrlPart);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

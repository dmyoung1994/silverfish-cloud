import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;

const googleClientId = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID?.trim();
const googleClientSecret = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_SECRET?.trim();

interface OAuthCallbackPayload {
  code?: string;
  state?: string;
  error?: string;
}

export interface GoogleLoginResult {
  firebaseIdToken: string;
  email: string;
}

export function googleLoginAvailable(): boolean {
  return Boolean(googleClientId && googleClientSecret && firebaseConfigured());
}

export async function loginWithGoogle(): Promise<GoogleLoginResult> {
  if (!googleClientId || !googleClientSecret) {
    throw new Error("Google sign-in is not configured for this build.");
  }

  const codeVerifier = randomUrlSafeString(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = randomUrlSafeString(32);

  const port = await invoke<number>("start_google_oauth_loopback");
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", googleClientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");

  const callback = waitForCallback(state);
  await openUrl(authUrl.toString());
  const { code } = await callback;

  const tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) throw new Error("Could not complete Google sign-in.");
  const { id_token: googleIdToken } = await tokenResponse.json() as { id_token?: string };
  if (!googleIdToken) throw new Error("Google did not return an identity token.");

  const { getApps, initializeApp } = await import("firebase/app");
  const { getAuth, GoogleAuthProvider, signInWithCredential } = await import("firebase/auth");
  const app = getApps()[0] ?? initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  });
  const auth = getAuth(app);
  const credential = GoogleAuthProvider.credential(googleIdToken);
  const { user } = await signInWithCredential(auth, credential);
  if (!user.email) throw new Error("Google account has no email address.");

  return { firebaseIdToken: await user.getIdToken(), email: user.email };
}

export async function cancelGoogleLogin(): Promise<void> {
  await invoke("cancel_google_oauth_loopback");
}

function firebaseConfigured(): boolean {
  return Boolean(
    import.meta.env.VITE_FIREBASE_API_KEY
    && import.meta.env.VITE_FIREBASE_AUTH_DOMAIN
    && import.meta.env.VITE_FIREBASE_PROJECT_ID
    && import.meta.env.VITE_FIREBASE_APP_ID,
  );
}

function waitForCallback(expectedState: string): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    let unlisten: (() => void) | undefined;
    const timeout = window.setTimeout(() => {
      unlisten?.();
      void cancelGoogleLogin();
      reject(new Error("Google sign-in timed out."));
    }, LOOPBACK_TIMEOUT_MS);

    void listen<OAuthCallbackPayload>("oauth-callback", (event) => {
      window.clearTimeout(timeout);
      unlisten?.();
      const { code, state, error } = event.payload;
      if (error) {
        reject(new Error(`Google sign-in was not completed (${error}).`));
      } else if (!code || state !== expectedState) {
        reject(new Error("Google sign-in response could not be verified."));
      } else {
        resolve({ code });
      }
    }).then((stop) => { unlisten = stop; });
  });
}

function randomUrlSafeString(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

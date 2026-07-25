import { invoke } from "@tauri-apps/api/core";

export interface GoogleLoginResult {
  firebaseIdToken: string;
  email: string;
}

export function googleLoginAvailable(): boolean {
  return Boolean(
    import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID?.trim()
    && import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_SECRET?.trim()
    && import.meta.env.VITE_FIREBASE_API_KEY?.trim(),
  );
}

export async function loginWithGoogle(): Promise<GoogleLoginResult> {
  const clientId = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const firebaseApiKey = import.meta.env.VITE_FIREBASE_API_KEY?.trim();
  if (!clientId || !clientSecret || !firebaseApiKey) {
    throw new Error("Google sign-in is not configured for this build.");
  }
  return invoke<GoogleLoginResult>("login_with_google", { clientId, clientSecret, firebaseApiKey });
}

export async function cancelGoogleLogin(): Promise<void> {
  await invoke("cancel_google_login");
}

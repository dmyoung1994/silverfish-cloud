import { PROTOCOL_VERSION, type CipherEnvelope } from "./protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function generateRoomKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new Error("Invalid room key");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson<T>(roomId: string, key: Uint8Array<ArrayBuffer>, value: T): Promise<CipherEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const messageId = crypto.randomUUID();
  const aad = encoder.encode(`co-dex:${PROTOCOL_VERSION}:${roomId}:${messageId}`);
  const plaintext = encoder.encode(JSON.stringify(value));
  if (plaintext.byteLength > 1024 * 1024) throw new Error("Message is too large");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
    await importKey(key),
    plaintext,
  );
  return {
    version: PROTOCOL_VERSION,
    roomId,
    messageId,
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptJson<T>(envelope: CipherEnvelope, key: Uint8Array<ArrayBuffer>): Promise<T> {
  if (envelope.version !== PROTOCOL_VERSION) throw new Error("Unsupported room protocol");
  const aad = encoder.encode(`co-dex:${PROTOCOL_VERSION}:${envelope.roomId}:${envelope.messageId}`);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decodeBase64Url(envelope.nonce),
      additionalData: aad,
      tagLength: 128,
    },
    await importKey(key),
    decodeBase64Url(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}


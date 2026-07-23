import type { CipherEnvelope, RelayInbound } from "./protocol";

export function normalizeRelayUrl(value: string): string {
  return value.trim().replace(/\/$/, "");
}

export function socketUrl(relayUrl: string, roomId: string, role: "host" | "guest", inviteId?: string): string {
  const url = new URL(`${normalizeRelayUrl(relayUrl)}/api/rooms/${roomId}/socket`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", role);
  if (inviteId) url.searchParams.set("inviteId", inviteId);
  return url.toString();
}

export function openRelaySocket(url: string, token: string): WebSocket {
  return new WebSocket(url, ["co-dex-v1", `co-dex-token.${token}`]);
}

export function parseRelayMessage(event: MessageEvent<string>): RelayInbound {
  return JSON.parse(event.data) as RelayInbound;
}

export function sendEncrypted(
  socket: WebSocket,
  target: "host" | "all" | { connection: string },
  envelope: CipherEnvelope,
): void {
  const wireTarget = typeof target === "string"
    ? { type: target }
    : { type: "connection", connectionId: target.connection };
  socket.send(JSON.stringify({ target: wireTarget, payload: JSON.stringify(envelope) }));
}

export interface InviteCredentials {
  inviteId: string;
  inviteToken: string;
}

export interface RelayRoomLimits {
  maxGuests: number;
  expiresAtMs?: number;
}

export interface RelayRoomCredentials {
  roomId: string;
  hostToken: string;
  limits: RelayRoomLimits;
}

export async function createRelayRoom(relayUrl: string): Promise<RelayRoomCredentials> {
  const response = await fetch(`${normalizeRelayUrl(relayUrl)}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`Relay rejected room creation (${response.status})`);
  return response.json() as Promise<RelayRoomCredentials>;
}

export async function createRelayInvite(relayUrl: string, roomId: string, hostToken: string): Promise<InviteCredentials> {
  const response = await fetch(`${normalizeRelayUrl(relayUrl)}/api/rooms/${roomId}/invites`, {
    method: "POST",
    headers: { authorization: `Bearer ${hostToken}` },
  });
  if (!response.ok) throw new Error(`Relay rejected invite creation (${response.status})`);
  return response.json() as Promise<InviteCredentials>;
}

export async function ejectRelayGuest(relayUrl: string, roomId: string, hostToken: string, connectionId: string): Promise<void> {
  const response = await fetch(`${normalizeRelayUrl(relayUrl)}/api/rooms/${roomId}/connections/${connectionId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${hostToken}` },
  });
  if (!response.ok) throw new Error(`Relay rejected guest removal (${response.status})`);
}

export async function closeRelayRoom(relayUrl: string, roomId: string, hostToken: string): Promise<void> {
  const response = await fetch(`${normalizeRelayUrl(relayUrl)}/api/rooms/${roomId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${hostToken}` },
  });
  if (!response.ok) throw new Error(`Relay rejected room closure (${response.status})`);
}

const relay = process.env.CO_DEX_RELAY_URL ?? "http://127.0.0.1:8787";

const roomResponse = await fetch(`${relay}/api/rooms`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
if (!roomResponse.ok) throw new Error(`room creation failed: ${roomResponse.status}`);
const room = await roomResponse.json();

const inviteResponse = await fetch(`${relay}/api/rooms/${room.roomId}/invites`, {
  method: "POST",
  headers: { authorization: `Bearer ${room.hostToken}` },
});
if (!inviteResponse.ok) throw new Error(`invite creation failed: ${inviteResponse.status}`);
const invite = await inviteResponse.json();
const socketBase = relay.replace(/^http/, "ws");
const host = new WebSocket(
  `${socketBase}/api/rooms/${room.roomId}/socket?role=host`,
  ["co-dex-v1", `co-dex-token.${room.hostToken}`],
);
await opened(host);
const hostReady = await messageOfType(host, "ready");
assertExactKeys(hostReady, ["connectionId", "hostAvailable", "type"]);

const peerConnected = messageOfType(host, "peerConnected");
const guest = new WebSocket(
  `${socketBase}/api/rooms/${room.roomId}/socket?role=guest&inviteId=${invite.inviteId}`,
  ["co-dex-v1", `co-dex-token.${invite.inviteToken}`],
);
await opened(guest);
const guestReady = await messageOfType(guest, "ready");
assertExactKeys(guestReady, ["connectionId", "hostAvailable", "type"]);
assertExactKeys(await peerConnected, ["connectionId", "type"]);

guest.send(JSON.stringify({ target: { type: "host" }, payload: "opaque-ciphertext" }));
const routed = await messageOfType(host, "payload");
if (routed.payload !== "opaque-ciphertext") throw new Error("payload was altered");

const inviteRevoked = messageOfType(guest, "error");
const revoked = await fetch(
  `${relay}/api/rooms/${room.roomId}/invites/${invite.inviteId}`,
  { method: "DELETE", headers: { authorization: `Bearer ${room.hostToken}` } },
);
if (revoked.status !== 204) throw new Error(`invite revocation failed: ${revoked.status}`);
await inviteRevoked;

const closed = await fetch(`${relay}/api/rooms/${room.roomId}`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${room.hostToken}` },
});
if (closed.status !== 204) throw new Error(`room closure failed: ${closed.status}`);

host.close();
guest.close();
console.log("relay smoke test passed: auth, routing, revocation, and room closure");

function opened(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
  });
}

function messageOfType(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error(`timed out waiting for ${type}`));
    }, 3_000);
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
      resolve(message);
    };
    socket.addEventListener("message", listener);
  });
}

function assertExactKeys(message, expected) {
  const actual = Object.keys(message).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`unexpected ${message.type} fields: ${actual.join(", ")}`);
  }
}

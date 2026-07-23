import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = readline.createInterface({ input: child.stdout });
const pending = new Map();
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method || message.id == null) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

try {
  await request("initialize", {
    clientInfo: { name: "silverfish_smoke", title: "Silverfish smoke test", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  const result = await request("thread/list", {
    limit: 1,
    sortKey: "updated_at",
    sortDirection: "desc",
    archived: false,
    useStateDbOnly: true,
  });
  let resumeProbeError;
  try {
    await request("thread/resume", {
      threadId: randomUUID(),
      cwd: process.cwd(),
      approvalPolicy: { granular: {
        sandbox_approval: true,
        rules: true,
        skill_approval: false,
        request_permissions: false,
        mcp_elicitations: false,
      } },
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
  } catch (error) {
    resumeProbeError = error;
  }
  if (!resumeProbeError) throw new Error("Expected the nonexistent thread probe to fail");
  if (String(resumeProbeError).includes("requires experimentalApi capability")) throw resumeProbeError;
  console.log(`codex app-server smoke test passed: granular approvals accepted; ${result.data.length} thread(s) sampled`);
} finally {
  child.kill("SIGTERM");
}

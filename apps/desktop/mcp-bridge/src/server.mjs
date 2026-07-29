import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const configPath = process.env.SILVERFISH_MCP_BRIDGE_CONFIG || new URL("../servers.json", import.meta.url).pathname;
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const connections = new Map();

async function newestDirectory(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const absolute = path.join(root, entry.name);
    return { absolute, stat: await fs.stat(absolute) };
  }));
  directories.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  if (!directories[0]) throw new Error(`No plugin versions found under ${root}`);
  return directories[0].absolute;
}

async function resolvedSpec(name) {
  const spec = config.servers?.[name];
  if (!spec) throw new Error(`Unknown upstream server: ${name}`);
  const cwd = spec.pluginRoot ? await newestDirectory(spec.pluginRoot) : spec.cwd;
  return { ...spec, cwd };
}

async function connect(name) {
  if (connections.has(name)) return connections.get(name);
  const pending = (async () => {
    const spec = await resolvedSpec(name);
    if (!spec.command) throw new Error(`Upstream server ${name} has no command`);
    const client = new Client({ name: "silverfish-capability-bridge", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args || [],
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env || {}) },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
    const timeoutMs = spec.startupTimeoutMs || 30_000;
    let timer;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Startup timed out after ${timeoutMs}ms`)), timeoutMs); }),
      ]);
    } catch (error) {
      await transport.close().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const listed = await client.listTools();
    return { client, tools: listed.tools || [] };
  })();
  connections.set(name, pending);
  try {
    return await pending;
  } catch (error) {
    connections.delete(name);
    throw error;
  }
}

function score(tool, words) {
  const name = tool.name.toLowerCase();
  const text = `${tool.name} ${tool.title || ""} ${tool.description || ""}`.toLowerCase();
  return words.reduce((total, word) => total + (name.includes(word) ? 8 : 0) + (text.includes(word) ? 2 : 0), 0);
}

async function searchCapabilities({ query, server, limit }) {
  const names = server ? [server] : Object.keys(config.servers || {});
  const words = query.toLowerCase().split(/\W+/).filter(Boolean);
  const results = [];
  const failures = [];
  await Promise.all(names.map(async (name) => {
    try {
      const upstream = await connect(name);
      for (const tool of upstream.tools) {
        const rank = score(tool, words);
        if (rank > 0 || words.length === 0) {
          results.push({ server: name, tool: tool.name, description: tool.description || "", inputSchema: tool.inputSchema, rank });
        }
      }
    } catch (error) {
      failures.push({ server: name, error: error instanceof Error ? error.message : String(error) });
    }
  }));
  results.sort((left, right) => right.rank - left.rank || left.server.localeCompare(right.server) || left.tool.localeCompare(right.tool));
  return { results: results.slice(0, limit), failures };
}

export function createCapabilityBridge() {
  const server = new McpServer({ name: "silverfish-capability-bridge", version: "1.0.0" });
  server.registerTool("search_capabilities", {
    description: "Search the host's MCP capabilities on demand. Returns only matching tool schemas; use before execute when the server or tool is unknown.",
    inputSchema: {
      query: z.string().describe("Words describing the needed capability"),
      server: z.string().optional().describe("Optional upstream server name"),
      limit: z.number().int().min(1).max(20).default(8),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchCapabilities(args)) }] }));
  server.registerTool("execute", {
    description: "Execute a discovered MCP tool. Use the server, tool, and input schema returned by search_capabilities.",
    inputSchema: {
      server: z.string().describe("Upstream server name returned by search_capabilities"),
      tool: z.string().describe("Upstream tool name returned by search_capabilities"),
      arguments: z.record(z.unknown()).default({}),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ server: serverName, tool, arguments: toolArguments }) => {
    const upstream = await connect(serverName);
    if (!upstream.tools.some((candidate) => candidate.name === tool)) throw new Error(`Unknown tool ${serverName}.${tool}`);
    return upstream.client.callTool({ name: tool, arguments: toolArguments });
  });
  return server;
}

const bridge = createCapabilityBridge();
await bridge.connect(new StdioServerTransport());

async function shutdown() {
  await Promise.allSettled([...connections.values()].map(async (pending) => (await pending).client.close()));
  await bridge.close();
}
process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

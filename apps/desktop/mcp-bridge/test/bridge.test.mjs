import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("exposes only discovery and execute while deferring an upstream schema", async () => {
  const root = path.resolve(new URL("..", import.meta.url).pathname);
  const configPath = path.join(root, "test", `servers-${process.pid}.json`);
  await fs.writeFile(configPath, JSON.stringify({
    servers: { fake: { command: process.execPath, args: [path.join(root, "test", "fake-upstream.mjs")] } },
  }));
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "server.mjs")],
    env: { ...process.env, SILVERFISH_MCP_BRIDGE_CONFIG: configPath },
  });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["search_capabilities", "execute"]);
    const found = await client.callTool({ name: "search_capabilities", arguments: { query: "add numbers" } });
    const result = JSON.parse(found.content[0].text);
    assert.equal(result.results[0].server, "fake");
    assert.equal(result.results[0].tool, "add_numbers");
    const executed = await client.callTool({ name: "execute", arguments: { server: "fake", tool: "add_numbers", arguments: { a: 2, b: 3 } } });
    assert.equal(executed.content[0].text, "5");
  } finally {
    await client.close();
    await fs.rm(configPath, { force: true });
  }
});

import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["mcp-bridge/src/server.mjs"],
  format: "esm",
  outfile: "mcp-bridge/dist/server.mjs",
  platform: "node",
  target: "node22",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});

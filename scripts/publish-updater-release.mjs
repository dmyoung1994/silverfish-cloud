import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error(`Missing value for ${key || "argument"}`);
  args.set(key.slice(2), value);
}

const required = ["version", "artifact", "signature", "notes", "output-dir"];
for (const key of required) if (!args.has(key)) throw new Error(`Missing --${key}`);

const artifact = args.get("artifact");
const signature = readFileSync(args.get("signature"), "utf8").trim();
if (!signature) throw new Error("Updater signature is empty");

const outputDir = args.get("output-dir");
const updateName = "Silverfish-macOS-arm64.app.tar.gz";
const artifactUrl = args.has("artifact-url")
  ? args.get("artifact-url")
  : `${args.get("base-url")?.replace(/\/$/, "")}/updates/${updateName}`;
if (!artifactUrl || !URL.canParse(artifactUrl)) {
  throw new Error("Provide --artifact-url or a valid --base-url");
}
mkdirSync(outputDir, { recursive: true });
if (!args.has("artifact-url")) {
  copyFileSync(artifact, join(outputDir, updateName));
  copyFileSync(args.get("signature"), join(outputDir, `${updateName}.sig`));
}

const manifest = {
  version: args.get("version"),
  notes: args.get("notes"),
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": {
      url: artifactUrl,
      signature,
    },
  },
};
writeFileSync(join(outputDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Published updater manifest for ${manifest.version} from ${basename(artifact)}`);

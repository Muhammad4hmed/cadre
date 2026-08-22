/** Does an attached image actually reach the model through TeamSession? */
import * as esbuild from "esbuild";
import { baseOptions } from "./esbuild-shared.mjs";
import Module from "node:module";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const stub = {
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  window: { showWarningMessage: async (_m, _o, ...c) => c[0], showQuickPick: async () => undefined },
  commands: { executeCommand: async () => undefined },
  Disposable: class { constructor(f) { this.dispose = f || (() => {}); } },
};
const orig = Module._load;
Module._load = (r, p, m) => (r === "vscode" ? stub : orig.call(Module, r, p, m));

const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cadre-img-")), "o.cjs");
await esbuild.build({ ...baseOptions({ entry: "src/team/orchestrator.ts", outfile }), logLevel: "warning" });
const require = createRequire(import.meta.url);
const { TeamSession } = require(outfile);
const exe = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);

const data = fs.readFileSync("/tmp/cadre-vision-probe.png").toString("base64");
let text = "";
const done = Promise.withResolvers();

const session = new TeamSession(
  { cwd: os.tmpdir(), executablePath: exe, autonomy: "plan", inheritGlobalConfig: false,
    directLine: false, models: {}, efforts: { lead: "low" }, skills: undefined, connectors: {},
    thinking: "off", fallbackModel: "", maxSpendUsd: 0, checkpoints: false,
    additionalDirectories: [], plugins: [], exclusiveConnectors: false, persistSessions: false,
    documentation: "off", docsPath: "docs" },
  { environment: async () => ({ ...process.env }),
    status: async () => ({ ok: true, mode: "subscription", describe: "sub" }) },
  (e) => {
    if (e.kind === "say") { text += e.delta; process.stdout.write(e.delta); }
    if (e.kind === "spend") done.resolve();
    if (e.kind === "notice" && e.level === "error") console.log("\n[error]", e.text);
  },
  { info: () => {}, warn: () => {}, error: (m) => console.log("[err]", m), debug: () => {} },
);
await session.prepare();

console.log("--- sending an image with no caption beyond the question ---\n");
session.send("Read the two words in this image. Reply with only those two words.",
  [{ name: "probe.png", mediaType: "image/png", data, bytes: data.length }]);

await Promise.race([done.promise, new Promise((r) => setTimeout(r, 240000))]);
session.dispose();

const saw = /purple\s+otter/i.test(text);
console.log("\n\n=== VERDICT ===");
console.log(`${saw ? "PASS" : "FAIL"}  the model read text that exists only inside the image`);
process.exit(saw ? 0 : 1);

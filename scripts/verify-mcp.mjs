/**
 * Drives the REAL in-process MCP server the CLI talks to — createSdkMcpServer
 * from the shipped SDK, over an in-memory transport.
 *
 * verify-tools.mjs builds against scripts/fake-sdk.mjs, so it checks the zod
 * shape and nothing about the server that actually validates a call. Two real
 * defects lived in exactly that gap: every brief being rejected for "expected
 * array, received string", and .describe() being silently dropped from a field
 * whose schema is a union.
 *
 * The fixtures are not invented. They are every call a real Lead made that the
 * server rejected, lifted verbatim from the stored sessions.
 */
import * as esbuild from "esbuild";
import { baseOptions } from "./esbuild-shared.mjs";
import Module, { createRequire } from "node:module";
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const stub = { workspace: {}, window: {}, commands: {} };
const originalLoad = Module._load;
Module._load = (r, p, m) => (r === "vscode" ? stub : originalLoad.call(Module, r, p, m));

// No SDK alias: this build links the real thing.
const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cadre-mcp-")), "tools.cjs");
await esbuild.build({ ...baseOptions({ entry: "scripts/entry-workflow.ts", outfile }), logLevel: "warning" });
const bundle = createRequire(import.meta.url)(outfile);
const { createWorkflowServer } = bundle.tools;

// The fixtures were captured against agents called researcher and engineer, so
// the graph that gives the entry agent those arrows is the software template.
const WORKFLOW = {
  ...bundle.templates.templateById("software-team").build(0),
  id: "t", createdAt: 0, updatedAt: 0, revision: 1,
};

let lastBrief = "";
const config = createWorkflowServer({
  cwd: process.cwd(),
  signal: new AbortController().signal,
  workflow: WORKFLOW,
  runAgent: async ({ prompt }) => { lastBrief = prompt; return "VERDICT: DONE\nHEADLINE: ok"; },
}, "lead");

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await config.instance.connect(serverTransport);
const client = new Client({ name: "verify-mcp", version: "1.0.0" });
await client.connect(clientTransport);

const checks = [];
const check = (label, ok) => checks.push([label, ok]);

const { tools } = await client.listTools();
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

check("the real server publishes the tools this agent's arrows imply",
  ["brief_researcher", "brief_engineer", "ask_researcher", "ask_engineer", "git_view", "paper"]
    .every((n) => n in byName));

// A field the model is not told the purpose of is a field it fills in badly.
// .describe() is dropped if it is applied before .optional() on a union, and
// nothing else catches that: the call still validates.
for (const tool of tools) {
  const undescribed = Object.entries(tool.inputSchema.properties ?? {})
    .filter(([, v]) => !v.description?.trim())
    .map(([k]) => k);
  check(`${tool.name}: every field is described to the model${undescribed.length ? ` (missing: ${undescribed})` : ""}`,
    undescribed.length === 0);
}

const rejected = JSON.parse(fs.readFileSync(new URL("./fixtures/rejected-calls.json", import.meta.url), "utf8"));
check("the rejected-call fixtures are present", rejected.length >= 8);

let n = 0;
for (const call of rejected) {
  n += 1;
  const result = await client.callTool({ name: call.tool, arguments: call.args });
  const detail = String(result.content?.[0]?.text ?? "").replace(/\s+/g, " ").slice(0, 110);
  check(`real rejected call ${n} (${call.tool}) is now accepted${result.isError ? ` — ${detail}` : ""}`,
    result.isError !== true);
}

// Accepting the string is only half of it: the teammate must read a list, not
// a JSON blob pasted into its brief.
const blobbed = rejected.find((c) => typeof c.args.context === "string" && c.args.context.startsWith("["));
if (blobbed) {
  await client.callTool({ name: blobbed.tool, arguments: blobbed.args });
  const items = JSON.parse(blobbed.args.context);
  check("a stringified context is unpacked into the brief the teammate reads",
    items.every((item) => lastBrief.includes(item)));
  check("no JSON escaping survives into the brief",
    !lastBrief.includes('\\"') && !lastBrief.includes('", "'));
}

// The looser schema must not have loosened what a brief genuinely requires.
const bad = await client.callTool({
  name: "brief_researcher",
  arguments: { objective: "o", done_when: "d", decide_yourself: [] },
});
check("a brief that delegates no decision is still refused", bad.isError === true);
const missing = await client.callTool({ name: "brief_researcher", arguments: { objective: "o" } });
check("a brief with no done_when is still refused", missing.isError === true);
const proper = await client.callTool({
  name: "brief_researcher",
  arguments: { objective: "o", done_when: "d", decide_yourself: ["pick the runtime"], context: ["a"] },
});
check("a properly-typed brief still works", proper.isError !== true);

console.log("=== real mcp server ===");
let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
process.exit(failed ? 1 : 0);

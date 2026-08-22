/**
 * The team's tools are described to the model by a JSON Schema derived from
 * zod. If that schema demands a field the model was told is optional, the call
 * is rejected and the teammate can never be briefed at all — which is exactly
 * what happened: `.default([])` emits the field as REQUIRED.
 *
 * These assert the schema the model actually receives, not the zod source.
 */
import * as esbuild from "esbuild";
import { baseOptions } from "./esbuild-shared.mjs";
import Module from "node:module";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const stub = { workspace: {}, window: {}, commands: {} };
const originalLoad = Module._load;
Module._load = (r, p, m) => (r === "vscode" ? stub : originalLoad.call(Module, r, p, m));

const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cadre-tools-")), "tools.cjs");
// Shares the shipped build config so the .md prompt loader applies.
// The real createSdkMcpServer returns an opaque server; the fake returns the
// tool definitions, which is what we need to inspect.
await esbuild.build({
  ...baseOptions({ entry: "src/team/tools.ts", outfile }),
  alias: { "@anthropic-ai/claude-agent-sdk": path.resolve("scripts/fake-sdk.mjs") },
  logLevel: "warning",
});
const require = createRequire(import.meta.url);
const { createTeamServer } = require(outfile);
const { toJSONSchema } = require("zod");
const z = require("zod");

const server = createTeamServer({
  cwd: "/tmp", signal: new AbortController().signal,
  runTeammate: async () => "VERDICT: DONE",
});

const checks = [];
const check = (label, ok) => checks.push([label, ok]);

const tools = Object.fromEntries(server.tools.map((t) => [t.name, t]));
check("all team tools are registered",
  ["brief_researcher", "brief_engineer", "ask_researcher", "ask_engineer", "git_view", "paper"]
    .every((n) => n in tools));

/** The schema the CLI hands the model. */
const schemaFor = (name) => toJSONSchema(z.object(tools[name].inputSchema));

// What each tool genuinely cannot work without.
const MUST_REQUIRE = {
  brief_researcher: ["objective", "done_when", "decide_yourself"],
  brief_engineer: ["objective", "done_when", "decide_yourself", "authority"],
  ask_researcher: ["question", "why"],
  ask_engineer: ["question", "why"],
  git_view: ["subcommand"],
  paper: ["action"],
};

for (const [name, expected] of Object.entries(MUST_REQUIRE)) {
  const required = schemaFor(name).required ?? [];
  const surprising = required.filter((f) => !expected.includes(f));
  check(`${name}: requires exactly what it needs`, surprising.length === 0);
  check(`${name}: does not drop a genuinely required field`,
    expected.every((f) => required.includes(f)));
}

// The specific regression: a minimal, reasonable call must validate.
const minimal = {
  brief_researcher: { objective: "Find X.", done_when: "X is known.", decide_yourself: ["sources"] },
  brief_engineer: { objective: "Fix Y.", done_when: "Tests pass.", decide_yourself: ["naming"], authority: "PATCH" },
  ask_researcher: { question: "Is this deprecated?", why: "Decides the approach." },
  ask_engineer: { question: "Does it repro?", why: "Decides the fix." },
  git_view: { subcommand: "status" },
  paper: { action: "check" },
};
for (const [name, payload] of Object.entries(minimal)) {
  const parsed = z.object(tools[name].inputSchema).safeParse(payload);
  check(`${name}: a minimal call is accepted`, parsed.success);
}

// A defaulted field is the trap: zod emits it as required.
check("no team tool uses .default() on an input field",
  server.tools.every((t) =>
    Object.values(t.inputSchema).every((field) => {
      const emitted = toJSONSchema(z.object({ f: field }));
      return !(emitted.required ?? []).includes("f") || !("default" in (emitted.properties?.f ?? {}));
    })));

console.log("=== tool schemas ===");
let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
process.exit(failed ? 1 : 0);

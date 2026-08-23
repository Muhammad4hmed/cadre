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
  ...baseOptions({ entry: "scripts/entry-workflow.ts", outfile }),
  alias: { "@anthropic-ai/claude-agent-sdk": path.resolve("scripts/fake-sdk.mjs") },
  logLevel: "warning",
});
const require = createRequire(import.meta.url);
const bundle = require(outfile);
const { createWorkflowServer } = bundle.tools;
const { toJSONSchema } = require("zod");
const z = require("zod");

// The delegate tools an agent gets ARE its outgoing arrows, so a graph is the
// only way to have any. The software-team template is the one whose agent ids
// match the captured fixtures.
const WORKFLOW = {
  ...bundle.templates.templateById("software-team").build(0),
  id: "t", createdAt: 0, updatedAt: 0, revision: 1,
};
const serverFor = (who) => createWorkflowServer({
  cwd: "/tmp",
  signal: new AbortController().signal,
  workflow: WORKFLOW,
  runAgent: async () => "VERDICT: DONE",
}, who);
const server = serverFor("lead");

const checks = [];
const check = (label, ok) => checks.push([label, ok]);

/**
 * The arguments a real Lead really sent, lifted verbatim from the stored
 * session where every one was rejected with "expected array, received string".
 * The model stringifies array arguments however plainly the schema asks for an
 * array, so the tool has to cope rather than be right.
 */
const REJECTED_BRIEF = JSON.parse(
  fs.readFileSync(new URL("./fixtures/rejected-brief.json", import.meta.url), "utf8"),
);

const tools = Object.fromEntries(server.tools.map((t) => [t.name, t]));
check("an agent's arrows become its delegate tools",
  ["brief_researcher", "brief_engineer", "ask_researcher", "ask_engineer", "git_view", "paper"]
    .every((n) => n in tools));

// Capability follows the graph: the Researcher has no arrow to the Lead, so no
// amount of asking gets it one.
const researcherTools = Object.fromEntries(serverFor("researcher").tools.map((t) => [t.name, t]));
check("an agent gets no tool for an arrow it does not have", !("brief_lead" in researcherTools));
check("...but does get the ones it has", "brief_engineer" in researcherTools);
check("an agent with no arrows still gets the read-only tools",
  Object.keys(Object.fromEntries(serverFor("nobody").tools.map((t) => [t.name, t]))).sort().join() === "git_view,paper");

/** The schema the CLI hands the model. */
const schemaFor = (name) => toJSONSchema(z.object(tools[name].inputSchema));

// What each tool genuinely cannot work without.
const MUST_REQUIRE = {
  brief_researcher: ["objective", "done_when", "decide_yourself"],
  brief_engineer: ["objective", "done_when", "decide_yourself"],
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

// ------------------------------------------------- the shapes a model sends

const accepts = (name, payload) => z.object(tools[name].inputSchema).safeParse(payload).success;

check("the exact brief that was rejected in a real session is now accepted",
  accepts("brief_researcher", REJECTED_BRIEF));
check("the fixture really is the broken shape (or this proves nothing)",
  typeof REJECTED_BRIEF.context === "string" &&
  typeof REJECTED_BRIEF.decide_yourself === "string" &&
  typeof REJECTED_BRIEF.boundaries === "string");

const proper = {
  objective: "o", done_when: "d",
  context: ["a", "b"], decide_yourself: ["pick one"], boundaries: ["no"],
};
check("a properly-typed array brief is still accepted",
  accepts("brief_researcher", proper));
check("an empty decide_yourself array is still refused",
  !accepts("brief_researcher", { ...proper, decide_yourself: [] }));
check("an empty decide_yourself string is still refused",
  !accepts("brief_researcher", { ...proper, decide_yourself: "" }));
check("a stringified paths list is accepted by brief_engineer",
  accepts("brief_engineer", { ...proper, authority: "PATCH", paths: '["src/a.ts","src/b.ts"]' }));
check("a stringified paths list is accepted by git_view",
  accepts("git_view", { subcommand: "diff", paths: '["src/a.ts"]' }));

// Normalising is the other half: accepting the string is useless if the
// teammate then reads a brief with a JSON blob in it.
const { toList } = bundle.tools;
check("a JSON-encoded array becomes a list",
  JSON.stringify(toList('["a","b"]')) === '["a","b"]');
check("a real stringified field becomes its real items",
  toList(REJECTED_BRIEF.decide_yourself).length ===
    JSON.parse(REJECTED_BRIEF.decide_yourself).length);
check("a bulleted prose list becomes a list",
  JSON.stringify(toList("- one\n- two\n- three")) === '["one","two","three"]');
check("a numbered prose list becomes a list",
  JSON.stringify(toList("1. one\n2) two")) === '["one","two"]');
check("one prose sentence stays one item, not shredded on its commas",
  JSON.stringify(toList("Decide the runtime, the model, and the dataset")) ===
    '["Decide the runtime, the model, and the dataset"]');
check("a malformed JSON array is kept as prose rather than dropped",
  JSON.stringify(toList('["unterminated')) === JSON.stringify(['["unterminated']));

// The brief the teammate actually reads must contain the items, not the blob.
let rendered = "";
const capturing = createWorkflowServer({
  cwd: "/tmp", signal: new AbortController().signal, workflow: WORKFLOW,
  runAgent: async ({ prompt }) => { rendered = prompt; return "VERDICT: DONE"; },
}, "lead");
const briefTool = capturing.tools.find((t) => t.name === "brief_researcher");
await briefTool.handler(REJECTED_BRIEF, {});
const realItems = JSON.parse(REJECTED_BRIEF.context);
check("the rendered brief lists the context items",
  realItems.every((item) => rendered.includes(item)));
check("the rendered brief carries no JSON punctuation from the blob",
  !rendered.includes('\\"') && !rendered.includes('["'));

// ---------------------------------------------- credentials stay unreadable
//
// The CLI's deny rules bind the Read tool. git_view reaches files another way,
// and printed a live secret straight past them until it checked for itself —
// which made "denied at every level" untrue as written.
const { execFileSync } = await import("node:child_process");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cadre-git-"));
const git = (...args) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" });

fs.writeFileSync(path.join(repo, ".env"), "API_KEY=super-secret-value\n");
fs.writeFileSync(path.join(repo, "app.ts"), "export const x = 1;\n");
git("init", "-q");
git("add", "-A");
git("commit", "-qm", "first");
fs.writeFileSync(path.join(repo, ".env"), "API_KEY=rotated-secret\n");
fs.writeFileSync(path.join(repo, "app.ts"), "export const x = 2;\n");

const repoServer = createWorkflowServer({
  cwd: repo, signal: new AbortController().signal, workflow: WORKFLOW, runAgent: async () => "x",
}, "lead");
const git_view = repoServer.tools.find((t) => t.name === "git_view");
const view = async (subcommand, paths) =>
  (await git_view.handler(paths ? { subcommand, paths } : { subcommand }, {})).content[0].text;

const shown = await view("show", [".env"]);
check("git_view refuses to print a credential file", shown.startsWith("Refused"));
check("...and the secret is nowhere in the reply", !/super-secret-value/.test(shown));
check("...and it says the rule applies to everyone", /any autonomy level/i.test(shown));

for (const protectedPath of [
  ".env", ".env.production", "sub/.env", ".ssh/id_rsa", "deploy.pem",
  "config/.aws/credentials", "id_ed25519", ".netrc", ".npmrc",
]) {
  check(`git_view refuses ${protectedPath}`,
    (await view("show", [protectedPath])).startsWith("Refused"));
}

const diff = await view("diff");
check("a diff does not leak a protected file's contents", !/rotated-secret/.test(diff));
check("...but does show the real change", /export const x = 2/.test(diff));
const stat = await view("stat");
check("a diff summary excludes protected files", !/\.env/.test(stat));
check("...and still summarises the rest", /app\.ts/.test(stat));

check("an ordinary file is still readable", /export const x = 1/.test(await view("show", ["app.ts"])));
check("a scoped diff still works", /export const x = 2/.test(await view("diff", ["app.ts"])));
check("status still reports what changed", /app\.ts/.test(await view("status")));

fs.rmSync(repo, { recursive: true, force: true });

console.log("=== tool schemas ===");
let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
process.exit(failed ? 1 : 0);

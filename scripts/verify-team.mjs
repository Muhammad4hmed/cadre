/**
 * Live end-to-end test of the three-agent team against the real SDK.
 *
 * Runs in a throwaway git repo so `git_view` behaves as it would in a real
 * workspace. Asserts that the Lead actually delegates rather than doing the work
 * itself, that the teammate's activity is attributed to its own lane, and that
 * the file on disk really changed.
 */
import * as esbuild from "esbuild";
import { baseOptions } from "./esbuild-shared.mjs";
import Module from "node:module";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---- a disposable workspace -------------------------------------------------
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ai-team-live-"));
fs.writeFileSync(
  path.join(repo, "scratch.py"),
  'def fizzbuzz(n):\n    if n % 15 == 0:\n        return "FizzBuzz"\n    if n % 3 == 0:\n        return "Fizz"\n    if n % 5 == 0:\n        return "Buzz"\n    return str(n)\n',
);
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Test");
git("add", "-A");
git("commit", "-qm", "initial");
console.log("workspace:", repo);

// ---- permissions auto-approve so the run is non-interactive -----------------
const prompts = [];
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  window: {
    showWarningMessage: async (message, _opts, ...choices) => {
      prompts.push(message);
      return choices[0];
    },
  },
  commands: { executeCommand: async () => undefined },
  Disposable: class { constructor(fn) { this.dispose = fn || (() => {}); } },
};
const originalLoad = Module._load;
Module._load = (r, p, m) => (r === "vscode" ? vscodeStub : originalLoad.call(Module, r, p, m));

const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-team-build-")), "orchestrator.cjs");
await esbuild.build({ ...baseOptions({ entry: "src/team/orchestrator.ts", outfile }), logLevel: "warning" });

const require = createRequire(import.meta.url);
const { TeamSession } = require(outfile);
const executablePath = require.resolve(
  `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
);

// ---- run --------------------------------------------------------------------
const events = [];
const seen = new Set();
const session = new TeamSession(
  {
    cwd: repo,
    executablePath,
    autonomy: "standard",
    inheritGlobalConfig: false,
    directLine: false,
    // Effort is dialled down: this exercises wiring, not judgement.
    models: {}, efforts: { lead: "low", researcher: "low", engineer: "low" },
    skills: undefined, connectors: {},
    thinking: "adaptive", fallbackModel: "", maxSpendUsd: 0, checkpoints: true,
    additionalDirectories: [], plugins: [], exclusiveConnectors: false,
    persistSessions: true, documentation: "substantial", docsPath: "docs",
  },
  {
    environment: async () => ({ ...process.env }),
    status: async () => ({ ok: true, mode: "subscription", describe: "subscription" }),
  },
  (e) => {
    events.push(e);
    const key = `${e.kind}:${e.who ?? ""}`;
    if (!seen.has(key) && !["say", "think"].includes(e.kind)) {
      seen.add(key);
    }
    if (e.kind === "assign") console.log(`  [assign] ${e.assignment.from} → ${e.assignment.to}: ${e.assignment.brief.slice(0, 90)}`);
    if (e.kind === "deliver") console.log(`  [deliver] ${e.id} ${e.outcome}: ${e.summary.slice(0, 90)}`);
    if (e.kind === "act") console.log(`  [${e.who}] ${e.tool} ${String(e.summary).slice(0, 80)}`);
    if (e.kind === "notice") console.log(`  [${e.level}] ${e.text.slice(0, 120)}`);
    if (e.kind === "spend") console.log(`  [spend] ${e.turns} turns  $${e.usd.toFixed(4)}`);
  },
  { info: (m) => console.log("  [log]", m), warn: () => {}, error: (m) => console.log("  [err]", m), debug: () => {} },
);

await session.prepare();

const finished = new Promise((resolve) => {
  const timer = setInterval(() => {
    if (events.some((e) => e.kind === "spend")) { clearInterval(timer); resolve("done"); }
  }, 500);
  setTimeout(() => { clearInterval(timer); resolve("timeout"); }, 600_000);
});

console.log("\n--- asking the Lead for a change that requires the Engineer ---\n");
session.send(
  "Add a one-line docstring to the fizzbuzz function in scratch.py saying what it returns. Nothing else.",
);
const outcome = await finished;
session.dispose();

// ---- assertions --------------------------------------------------------------
const kinds = (k) => events.filter((e) => e.kind === k);
const laneSaid = (who) => events.some((e) => e.kind === "say" && e.who === who);
const laneActed = (who) => events.some((e) => e.kind === "act" && e.who === who);
const fileNow = fs.readFileSync(path.join(repo, "scratch.py"), "utf8");
const diff = git("diff");

const checks = [
  ["run completed (not timed out)", outcome === "done"],
  ["the Lead spoke", laneSaid("lead")],
  ["the Lead delegated instead of editing", kinds("assign").length > 0],
  ["work was delivered back", kinds("deliver").length > 0],
  ["a teammate's activity is attributed to its own lane", laneActed("engineer") || laneActed("researcher")],
  ["the Engineer actually edited the file", /"""|'''|#/.test(fileNow) && fileNow.includes("fizzbuzz")],
  ["the change is real on disk", diff.trim().length > 0],
  ["cost was reported", kinds("spend").length > 0],
  // Proportionality: a one-line docstring is below the documentation threshold.
  // Producing a PROJECT.md or a changelog for it would be gold-plating.
  ["a trivial change produces no documentation", !fs.existsSync(path.join(repo, "docs"))],
];

console.log("\n=== live team run ===");
let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
console.log("\nassignments:", kinds("assign").map((e) => `${e.assignment.to}`).join(", ") || "(none)");
console.log("lanes with activity:", ["lead", "researcher", "engineer"].filter((w) => laneSaid(w) || laneActed(w)).join(", "));
console.log("permission prompts raised:", prompts.length);
console.log("\n--- resulting diff ---\n" + diff);

fs.rmSync(repo, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

/**
 * Regression tests for the session lifecycle defects the foundation audit found.
 * These originally guarded the single-agent AgentSession; they now guard
 * TeamSession, which replaced it, because the same failure modes are worse when
 * a Lead is mid-delegation.
 *
 * The real SDK is aliased out for a controllable fake so a silent stream end, a
 * mid-run crash, and disposal-while-busy can be provoked deterministically.
 */
import * as esbuild from "esbuild";
import { baseOptions } from "./esbuild-shared.mjs";
import Module from "node:module";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const answers = { pick: (choices) => choices[0], offered: [] };
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  window: {
    showWarningMessage: async (_msg, _opts, ...choices) => {
      answers.offered = choices;
      // A native modal cannot be dismissed by the extension, so it can still be
      // on screen after Stop. `answers.hold` leaves it open the way a real one
      // stays open, and resolving the returned deferred is the user clicking.
      if (answers.hold) {
        return new Promise((resolve) => { answers.click = (choice) => resolve(choice); });
      }
      return answers.pick(choices);
    },
    showQuickPick: async (items) => answers.pick(await items),
    showInputBox: async () => answers.typed,
  },
  commands: { executeCommand: async () => undefined },
  Disposable: class { constructor(fn) { this.dispose = fn || (() => {}); } },
};
const originalLoad = Module._load;
Module._load = (r, p, m) => (r === "vscode" ? vscodeStub : originalLoad.call(Module, r, p, m));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-team-life-"));
const outfile = path.join(dir, "runner.cjs");
await esbuild.build({
  ...baseOptions({ entry: "src/workflow/runner.ts", outfile }),
  alias: { "@anthropic-ai/claude-agent-sdk": path.resolve("scripts/fake-sdk.mjs") },
  logLevel: "warning",
});

const require = createRequire(import.meta.url);
const { WorkflowSession, shortPath } = require(outfile);
const TeamSession = WorkflowSession;
const fake = await import("./fake-sdk.mjs");

const checks = [];
const check = (label, ok) => checks.push([label, ok]);
const tick = () => new Promise((r) => setTimeout(r, 25));
/**
 * Awaits a run that should already be finished.
 *
 * A regression here does not produce a wrong value, it produces a promise that
 * never settles — the chain starts an agent nobody drives and waits forever. A
 * bare `await` turns that into a hung suite, which reads as "no failures".
 */
async function settled(promise, label) {
  const timeout = Symbol("timeout");
  const result = await Promise.race([
    promise,
    new Promise((r) => setTimeout(() => r(timeout), 1500)),
  ]);
  if (result === timeout) {
    check(`${label} (it never finished — something is still running)`, false);
    return "";
  }
  return typeof result === "string" ? result : JSON.stringify(result);
}

/** A three-agent graph, so delegation and lanes have something to be about. */
const agent = (id, name, preset) => ({
  id, name, role: "", prompt: `You are ${name}.`, preset, x: 0, y: 0,
});
const WORKFLOW = {
  id: "w", name: "Test workflow", entry: "lead",
  agents: [agent("lead", "Lead", "readonly"), agent("researcher", "Researcher", "research"), agent("engineer", "Engineer", "build")],
  edges: [
    { from: "lead", to: "researcher", kind: "delegate" },
    { from: "lead", to: "engineer", kind: "delegate" },
  ],
  createdAt: 0, updatedAt: 0, revision: 1,
};

/** The shipped software template, whose prompts carry the docs markers. */
const TEMPLATE = {
  ...require(outfile).__templates.templateById("software-team").build(0),
  id: "tpl", createdAt: 0, updatedAt: 0, revision: 1,
};

const CONFIG = {
  workflow: WORKFLOW,
  maxContinues: 0,
  cwd: "/tmp", executablePath: "/fake/claude", autonomy: "standard",
  inheritGlobalConfig: false, model: "opus", maxDepth: 3,
  skills: undefined, connectors: {},
  thinking: "adaptive", fallbackModel: "", maxSpendUsd: 0, checkpoints: true,
  additionalDirectories: [], plugins: [], exclusiveConnectors: false,
  persistSessions: true, documentation: "substantial", docsPath: "docs",
};
const BILLING = {
  environment: async () => ({ PATH: "/usr/bin" }),
  status: async () => ({ ok: true, mode: "subscription", describe: "test" }),
};

function makeSession(config = CONFIG) {
  const events = [];
  const session = new TeamSession(config, BILLING, (e) => events.push(e), {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  });
  const of = (kind) => events.filter((e) => e.kind === kind);
  const lastBusy = () => of("busy").at(-1)?.busy;
  return { session, events, of, lastBusy };
}

// ---- A. a stream that ends silently must not wedge the session -------------
fake.__instances.length = 0;
{
  const { session, lastBusy } = makeSession();
  await session.prepare();
  session.send("first");
  await tick();
  const first = fake.__instances[0];
  first.emit(fake.initMessage());
  first.emit(fake.resultMessage());
  await tick();
  check("A1 busy cleared after a normal result", lastBusy() === false);

  first.end();                        // the CLI exits underneath us
  await tick();

  session.send("second");
  await tick();
  check("A2 a dead stream is replaced, not reused", fake.__instances.length === 2);
  check("A3 the second message reaches the new stream",
    fake.__instances[1].received.includes("second"));
  session.dispose();
}

// ---- B. a crash mid-run must report and stay recoverable -------------------
fake.__instances.length = 0;
{
  const { session, of, lastBusy } = makeSession();
  await session.prepare();
  session.send("go");
  await tick();
  fake.__instances[0].emit(fake.initMessage());
  fake.__instances[0].fail(new Error("cli exited with code 1"));
  await tick();

  const notices = of("notice");
  check("B1 crash surfaces an error notice",
    notices.some((n) => n.level === "error" && /cli exited/.test(n.text)));
  check("B2 crash clears busy", lastBusy() === false);
  check("B3 crash warns the session ended",
    notices.some((n) => n.level === "warn" && /next message/i.test(n.text)));

  session.send("again");
  await tick();
  check("B4 a crashed session is recoverable", fake.__instances.length === 2);
  session.dispose();
}

// ---- C. disposing mid-run must release the composer ------------------------
fake.__instances.length = 0;
{
  const { session, lastBusy } = makeSession();
  await session.prepare();
  session.send("working");
  await tick();
  check("C1 busy raised while running", lastBusy() === true);

  session.dispose();                  // e.g. the New Session button
  await tick();
  check("C2 dispose clears busy", lastBusy() === false);
  check("C3 dispose closes the underlying query", fake.__instances[0].closed === true);
}

// ---- D. permission scoping -------------------------------------------------
fake.__instances.length = 0;
{
  const { session } = makeSession();
  await session.prepare();
  session.send("x");
  await tick();
  const gate = fake.__instances[0].options.canUseTool;
  const ctx = (extra = {}) => ({
    signal: new AbortController().signal, toolUseID: "t", requestId: "r", ...extra,
  });

  // The SDK's own scoped suggestions win when it provides them.
  const suggestions = [{
    type: "addRules", behavior: "allow", destination: "session",
    rules: [{ toolName: "Bash", ruleContent: "git status" }],
  }];
  answers.pick = (c) => c.find((x) => /always allow/i.test(x));
  const scoped = await gate("Bash", { command: "git status" }, ctx({ suggestions }));
  check("D1 session grant reuses the SDK's scoped suggestions",
    JSON.stringify(scoped.updatedPermissions) === JSON.stringify(suggestions));

  // With no suggestions we derive one ourselves — and it must stay narrow.
  answers.pick = (c) => c.find((x) => /always allow/i.test(x));
  const derived = await gate("Bash", { command: "tesseract --version 2>&1 | head -5" }, ctx());
  check("D2 a derived grant is offered when the SDK gives none",
    answers.offered.includes("Always allow tesseract"));
  check("D3 the derived grant is scoped to the program, not the tool",
    derived.updatedPermissions?.[0]?.rules?.[0]?.ruleContent === "tesseract:*");

  // The blanket option exists, but only as an explicit, clearly-labelled choice.
  answers.pick = (c) => c.find((x) => /don't ask again/i.test(x));
  const blanket = await gate("Bash", { command: "ls" }, ctx());
  check("D4 'don't ask again' is offered so the user can stop the prompting",
    answers.offered.some((x) => /don't ask again/i.test(x)));
  check("D5 it is session-scoped, not permanent",
    blanket.updatedPermissions?.[0]?.destination === "session");

  answers.pick = () => undefined;   // user dismissed the modal
  const dismissed = await gate("Bash", { command: "rm -rf /" }, ctx());
  check("D6 dismissing the modal denies", dismissed.behavior === "deny");

  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await gate("Bash", { command: "x" }, ctx({ signal: aborted.signal }));
  check("D7 an aborted run denies instead of hanging", cancelled.behavior === "deny");

  answers.pick = (c) => c[0];
  session.dispose();
}

// ---- D2. derived scopes for other tools ------------------------------------
fake.__instances.length = 0;
{
  const { session } = makeSession({ ...CONFIG, cwd: "/repo" });
  await session.prepare();
  session.send("x");
  await tick();
  const gate = fake.__instances[0].options.canUseTool;
  const ctx = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };

  answers.pick = (c) => c.find((x) => /always allow/i.test(x));
  await gate("Bash", { command: "cd /repo && npm test" }, ctx);
  check("D8 a `cd x && y` preamble is stepped past",
    answers.offered.includes("Always allow npm test"));

  await gate("Bash", { command: "NODE_ENV=test pytest -q" }, ctx);
  check("D9 env-var prefixes are skipped", answers.offered.includes("Always allow pytest"));

  const web = await gate("WebFetch", { url: "https://docs.python.org/3/library/os.html" }, ctx);
  check("D10 web fetches scope to the host",
    web.updatedPermissions?.[0]?.rules?.[0]?.ruleContent === "domain:docs.python.org");

  answers.pick = (c) => c[0];
  session.dispose();
}

// ---- E. the team wiring the orchestrator hands to the SDK ------------------
fake.__instances.length = 0;
{
  const { session } = makeSession();
  await session.prepare();
  session.send("hello");
  await tick();
  const options = fake.__instances[0].options;

  check("E1 the Lead has no shell",
    options.disallowedTools.includes("Bash") && !options.tools.includes("Bash"));
  check("E2 the Lead cannot spawn raw subagents",
    options.disallowedTools.includes("Agent") && options.disallowedTools.includes("Task"));
  check("E2b the Lead cannot message live agents out of band",
    options.disallowedTools.includes("SendMessage"));
  // These each multiply what a run costs, off-screen. A brief is the only
  // fan-out the team gets, and it is visible and counted.
  for (const tool of ["Workflow", "CronCreate", "ScheduleWakeup", "RemoteTrigger", "Monitor"]) {
    check(`E2c ${tool} is unavailable to the Lead`,
      options.disallowedTools.includes(tool) && !options.tools.includes(tool));
  }
  check("E3 the Lead can brief both teammates",
    options.allowedTools.includes("mcp__team__brief_researcher") &&
    options.allowedTools.includes("mcp__team__brief_engineer"));
  check("E3b tools restricts availability; allowedTools only auto-approves",
    options.tools.every((t) => !t.startsWith("mcp__")) &&
    options.allowedTools.every((t) => t.startsWith("mcp__")));
  check("E4 the team MCP server is registered", Boolean(options.mcpServers?.team));
  check("E5 short tool names alias to the namespaced ones",
    options.toolAliases?.brief_engineer === "mcp__team__brief_engineer");
  const ask = options.managedSettings?.permissions?.ask ?? [];
  check("E6 policy is enforced as a restrictive-only managed tier", Array.isArray(ask) && ask.length > 0);
  check("E6b destructive commands are asked about", ask.includes("Bash(rm:*)") && ask.includes("Bash(sudo:*)"));
  check("E6c benign commands are NOT blanket-asked",
    !ask.includes("Bash"));
  check("E7 secret reads are denied",
    options.managedSettings?.permissions?.deny?.some((r) => r.includes(".env")));
  check("E8 global blanket allow-rules are not loaded by default",
    !options.settingSources.includes("user"));
  check("E9 billing environment is applied", options.env?.PATH === "/usr/bin");
  session.dispose();
}

// ---- F. the Lead and Researcher cannot edit production code ----------------
fake.__instances.length = 0;
{
  const { session } = makeSession({ ...CONFIG, cwd: "/repo" });
  await session.prepare();
  session.send("x");
  await tick();
  const gate = fake.__instances[0].options.canUseTool;
  const ctx = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };

  const leadOutside = await gate("Edit", { file_path: "/repo/src/app.ts" }, ctx);
  check("F1 the Lead cannot edit production code",
    leadOutside.behavior === "deny" && /only write inside/i.test(leadOutside.message));
  check("F1b and the refusal names who can",
    /brief Engineer/i.test(leadOutside.message));

  const leadRelative = await gate("Write", { file_path: "src/app.ts" }, ctx);
  check("F2 a relative path does not slip past the gate", leadRelative.behavior === "deny");

  const leadEscape = await gate("Write", { file_path: ".cadre/../src/app.ts" }, ctx);
  check("F3 traversal out of the scratchpad is denied", leadEscape.behavior === "deny");

  answers.permission = "Allow once";
  const leadSpec = await gate("Write", { file_path: "/repo/.cadre/spec.md" }, ctx);
  check("F4 the Lead may write its own spec", leadSpec.behavior === "allow");

  const leadReads = await gate("Read", { file_path: "/repo/src/app.ts" }, ctx);
  check("F5 reading production code is still fine", leadReads.behavior === "allow");
  session.dispose();
}

// ---- G. a failing connector must be visible, not silent -------------------
fake.__instances.length = 0;
{
  const { session, of } = makeSession();
  await session.prepare();
  session.send("x");
  await tick();
  fake.__instances[0].emit(fake.initMessage({
    mcp_servers: [
      { name: "team", status: "connected" },
      { name: "kaggle", status: "connected" },
      { name: "apify", status: "failed" },
    ],
  }));
  await tick();

  const roster = of("roster").at(-1);
  check("G1 our own server is not shown as a user connector",
    !roster?.connectors?.some((c) => c.name === "team"));
  check("G2 connector health reaches the UI",
    roster?.connectors?.length === 2 &&
    roster.connectors.find((c) => c.name === "kaggle")?.ok === true &&
    roster.connectors.find((c) => c.name === "apify")?.ok === false);
  check("G3 a failed connector is called out, not swallowed",
    of("notice").some((n) => n.level === "warn" && /apify/.test(n.text)));
  session.dispose();
}

// ---- H. the parity options actually reach the SDK --------------------------
fake.__instances.length = 0;
{
  const { session } = makeSession({
    ...CONFIG,
    thinking: "off",
    fallbackModel: "claude-sonnet-5",
    maxSpendUsd: 2.5,
    checkpoints: true,
    additionalDirectories: ["/extra"],
    plugins: ["/plug"],
    exclusiveConnectors: true,
    persistSessions: false,
  });
  await session.prepare();
  session.send("x");
  await tick();
  const o = fake.__instances[0].options;

  check("H1 thinking can be turned off", o.thinking?.type === "disabled");
  check("H2 fallback model is passed", o.fallbackModel === "claude-sonnet-5");
  check("H3 spend cap is passed", o.maxBudgetUsd === 2.5);
  check("H4 checkpointing is on so rewind can work", o.enableFileCheckpointing === true);
  check("H5 extra directories are passed", o.additionalDirectories?.[0] === "/extra");
  check("H6 local plugins are shaped correctly",
    o.plugins?.[0]?.type === "local" && o.plugins[0].path === "/plug");
  check("H7 exclusive connectors maps to strictMcpConfig", o.strictMcpConfig === true);
  check("H8 session persistence can be disabled", o.persistSession === false);
  check("H9 the abort controller reaches the query", Boolean(o.abortController));
  session.dispose();
}

// ---- I. defaults stay sane -------------------------------------------------
fake.__instances.length = 0;
{
  const { session } = makeSession();
  await session.prepare();
  session.send("x");
  await tick();
  const o = fake.__instances[0].options;
  check("I1 thinking defaults to adaptive", o.thinking?.type === "adaptive");
  check("I2 no spend cap unless asked", o.maxBudgetUsd === undefined);
  check("I3 no fallback unless configured", o.fallbackModel === undefined);
  session.dispose();
}

// ---- J6. what rewind says when it cannot run -------------------------------
// Rewind Files is the safety net: it puts the workspace back to before a turn.
// It needs the live query, because that is what holds the checkpoints — so once
// a run's stream has ended, it cannot. That is a real constraint, and the thing
// to get right is what the user is told, since the command sits in the palette
// either way and they will reach for it exactly when something has gone wrong.
fake.__instances.length = 0;
{
  const { session } = makeSession({ ...CONFIG, checkpoints: false });
  await session.prepare();
  session.send("go");
  await tick();
  const off = await session.rewind("some-turn");
  check("J6 with checkpoints turned off, rewind says that is why",
    off.ok === false && /checkpoint/i.test(off.detail));
  session.dispose();
}

fake.__instances.length = 0;
{
  const { session } = makeSession();
  await session.prepare();
  session.send("go");
  await tick();
  const id = session.history()[0].id;

  const live = await session.rewind(id, true);
  check("J7 a live run can be rewound", live.ok === true);

  // The stream ends the way it does when the CLI is finished with it.
  fake.__instances[0].end();
  await tick();
  const after = await session.rewind(id, true);
  check("J8 once the run has ended it cannot be, and says so plainly",
    after.ok === false && /ended/i.test(after.detail));
  check("J9 ...and does not just say there is no session, which reads as a bug",
    !/^No live session/.test(after.detail));
  session.dispose();
}

// ---- I1b. the read-only confinement holds when nothing prompts -------------
// A read-only agent HAS Write and Edit — it needs them for `.cadre/` and the
// docs folder. What keeps it out of everything else used to be a check inside
// `canUseTool`, and the SDK says what `bypassPermissions` does to that:
//
//   "canUseTool will not be invoked: permissionMode 'bypassPermissions'
//    auto-approves every tool call (except explicit deny rules) before the
//    callback is consulted. To gate every tool call, use a PreToolUse hook."
//
// So the confinement held on the three levels that prompt, and not on
// `autonomous` — the one built to run unwatched, where a coordinator quietly
// doing the work itself is the failure the roles exist to prevent. It is a
// PreToolUse hook now, which runs whatever the mode.
fake.__instances.length = 0;
for (const level of ["standard", "supervised", "plan", "autonomous"]) {
  const { session } = makeSession({ ...CONFIG, cwd: "/repo", autonomy: level });
  await session.prepare();
  session.send("x");
  await tick();
  const o = fake.__instances.at(-1).options;
  const ctx = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };

  check(`I1b a permission handler is supplied on ${level}`, typeof o.canUseTool === "function");
  const gate = await o.canUseTool("Write", { file_path: "/repo/src/app.ts" }, ctx);
  check(`...and it refuses a write outside the roots on ${level}`, gate.behavior === "deny");

  // The hook is the half that survives a mode which never calls the handler.
  const hook = o.hooks?.PreToolUse?.[0]?.hooks?.[0];
  check(`I1c a PreToolUse hook is installed on ${level}`, typeof hook === "function");
  // A missing hook is a failed check, not a crash that takes the rest with it.
  const ask = typeof hook === "function" ? hook : async () => ({});
  const outside = await ask(
    { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/repo/src/app.ts" }, tool_use_id: "t" },
    "t", { signal: ctx.signal },
  );
  check(`...and it denies a write outside the roots on ${level}`,
    outside.hookSpecificOutput?.permissionDecision === "deny");
  check(`...saying where the agent may write, on ${level}`,
    /only write inside/i.test(outside.hookSpecificOutput?.permissionDecisionReason ?? ""));

  // Its own scratchpad is untouched, or a read-only agent cannot take notes.
  const inside = await ask(
    { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/repo/.cadre/notes.md" }, tool_use_id: "t" },
    "t", { signal: ctx.signal },
  );
  check(`...while its own scratchpad is left alone on ${level}`,
    inside.hookSpecificOutput === undefined);

  // And it has no opinion about anything that is not an edit.
  const reading = await ask(
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/repo/src/app.ts" }, tool_use_id: "t" },
    "t", { signal: ctx.signal },
  );
  check(`...and does not interfere with reading on ${level}`,
    reading.hookSpecificOutput === undefined);
  session.dispose();
}

// ---- I2. a cycle of briefs stops at the cap --------------------------------
// A delegate arrow may loop: A briefs B, B briefs A back. That is how a peer
// asks a question, so the shape of the graph cannot bound the recursion — a
// counter does.
//
// The server registers a brief tool for every arrow an agent has, at any depth.
// So dropping it from the allow list at the cap only meant the call was not
// pre-approved and fell to the permission prompt — and `autonomous` sets
// bypassPermissions precisely so nothing asks. The bound held everywhere except
// the level built to run unattended. It has to be a denial, not an omission.
fake.__instances.length = 0;
{
  const cyclic = {
    ...WORKFLOW,
    edges: [
      { from: "lead", to: "engineer", kind: "delegate" },
      { from: "engineer", to: "lead", kind: "delegate" },
    ],
  };
  const { session } = makeSession({ ...CONFIG, workflow: cyclic, maxDepth: 3, autonomy: "autonomous" });
  await session.prepare();
  session.send("go");
  await tick();

  const briefsOf = (inst) => (inst?.options?.mcpServers?.team?.tools ?? [])
    .filter((t) => t.name.startsWith("brief_"));
  const allowed = (inst) => (inst?.options?.allowedTools ?? []).filter((t) => t.includes("brief_"));
  const denied = (inst) => (inst?.options?.disallowedTools ?? []).filter((t) => t.includes("brief_"));

  const running = [];
  const trail = [];
  let inst = fake.__instances[0];
  for (let step = 0; step < 6; step += 1) {
    trail.push({ allowed: allowed(inst).length, denied: denied(inst).length });
    const offered = briefsOf(inst);
    if (!offered.length || denied(inst).length) break;
    running.push(offered[0].handler({
      objective: "keep going", done_when: "y", decide_yourself: ["z"],
      context: [], authority: "EXPLORE", paths: [],
    }));
    await tick();
    const next = fake.__instances.at(-1);
    if (next === inst) break;
    inst = next;
  }

  check(`I6 the loop is stopped by depth ${CONFIG.maxDepth}, not left to run`,
    trail.length === 4 && trail.at(-1).allowed === 0);
  check("I7 ...and the agent at the cap is denied the tool, not merely unapproved",
    trail.at(-1).denied > 0);
  check("I8 ...while every level above it could still delegate",
    trail.slice(0, -1).every((t) => t.allowed > 0 && t.denied === 0));

  // Denied at the cap must not mean crippled: everything else still works.
  const deepest = fake.__instances.at(-1);
  check("I9 the agent at the cap keeps its other tools",
    (deepest?.options?.mcpServers?.team?.tools ?? []).some((t) => t.name === "git_view"));
  check("I10 ...and no prompt is what stands between the loop and going deeper",
    deepest?.options?.permissionMode === "bypassPermissions" && denied(deepest).length > 0);

  for (const i of fake.__instances) i.end();
  await Promise.allSettled(running);
  session.dispose();
}

// ---- J. rewind needs a turn to aim at --------------------------------------
fake.__instances.length = 0;
{
  const { session } = makeSession();
  await session.prepare();
  check("J1 no turns before anything is sent", session.history().length === 0);
  session.send("first thing");
  session.send("second thing");
  await tick();
  const turns = session.history();
  check("J2 every user turn is recorded for rewind", turns.length === 2);
  check("J3 turns carry the text the user typed", turns[0].text === "first thing");
  check("J4 turn ids are distinct", turns[0].id !== turns[1].id);
  check("J5 the id sent to the CLI matches the recorded turn",
    fake.__instances[0].receivedUuids?.includes(turns[0].id) ?? true);
  session.dispose();
}

// ---- K. documentation duty -------------------------------------------------
fake.__instances.length = 0;
{
  const { session } = makeSession({ ...CONFIG, workflow: TEMPLATE, cwd: "/repo", docsPath: "documentation" });
  await session.prepare();
  session.send("x");
  await tick();
  const prompt = fake.__instances[0].options.systemPrompt;
  const gate = fake.__instances[0].options.canUseTool;
  const ctx = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };

  check("K1 the configured docs path reaches the prompt", prompt.includes("documentation/PROJECT.md"));
  check("K2 no unsubstituted token is left", !prompt.includes("{{DOCS}}"));
  check("K3 the section markers are stripped", !prompt.includes("docs:start"));

  answers.pick = (c) => c[0];
  const docWrite = await gate("Write", { file_path: "/repo/documentation/PROJECT.md" }, ctx);
  check("K4 the Lead may write its own documentation", docWrite.behavior === "allow");
  const scratch = await gate("Write", { file_path: "/repo/.cadre/spec.md" }, ctx);
  check("K5 the scratchpad is still writable", scratch.behavior === "allow");
  const source = await gate("Edit", { file_path: "/repo/src/app.ts" }, ctx);
  check("K6 production code is still denied to the Lead", source.behavior === "deny");
  const escape = await gate("Write", { file_path: "/repo/documentation/../src/app.ts" }, ctx);
  check("K7 traversal out of the docs root is denied", escape.behavior === "deny");
  session.dispose();
}

// ---- L. documentation off --------------------------------------------------
fake.__instances.length = 0;
{
  const { session } = makeSession({ ...CONFIG, workflow: TEMPLATE, cwd: "/repo", documentation: "off" });
  await session.prepare();
  session.send("x");
  await tick();
  const prompt = fake.__instances[0].options.systemPrompt;
  const gate = fake.__instances[0].options.canUseTool;
  const ctx = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };

  check("L1 the documentation section is removed from the prompt",
    !prompt.includes("PROJECT.md") && !prompt.includes("docs:start"));
  const docWrite = await gate("Write", { file_path: "/repo/docs/PROJECT.md" }, ctx);
  check("L2 and the docs root is not writable when it is off", docWrite.behavior === "deny");
  check("L3 the rest of the prompt survives", prompt.includes("Opening moves"));
  session.dispose();
}

// ---- M. project orientation ------------------------------------------------
fake.__instances.length = 0;
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ai-team-proj-"));
  fs.writeFileSync(path.join(repo, "package.json"), "{}");
  fs.writeFileSync(path.join(repo, "tsconfig.json"), "{}");
  fs.mkdirSync(path.join(repo, "docs", "research"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "PROJECT.md"), "# x");
  fs.writeFileSync(path.join(repo, "docs", "research", "ocr.md"), "# x");
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "conventions");

  const { session } = makeSession({ ...CONFIG, cwd: repo });
  await session.prepare();
  session.send("x");
  await tick();
  const prompt = fake.__instances[0].options.systemPrompt;

  check("M1 the stack is identified from markers",
    prompt.includes("Node") && prompt.includes("TypeScript"));
  check("M2 durable artifacts from earlier sessions are listed",
    prompt.includes("docs/PROJECT.md"));
  check("M3 existing research reports are surfaced", prompt.includes("ocr.md"));
  check("M4 CLAUDE.md is called out as binding", /CLAUDE\.md/.test(prompt));
  check("M5 the preamble states where the project is", prompt.includes(repo));
  check("M6 stale documents lose to the code",
    prompt.includes("the code is right and the document is stale"));
  session.dispose();
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- N. a cold project says so ---------------------------------------------
fake.__instances.length = 0;
{
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ai-team-bare-"));
  const { session } = makeSession({ ...CONFIG, cwd: bare });
  await session.prepare();
  session.send("x");
  await tick();
  const prompt = fake.__instances[0].options.systemPrompt;
  check("N1 an empty project is described as cold, not silently blank",
    prompt.includes("starting cold"));
  // PROJECT.md appears in the documentation-duty section regardless; what must
  // be absent is the "earlier sessions left this behind" list.
  check("N2 no prior-session artifacts are invented",
    !prompt.includes("Earlier sessions left this behind"));
  session.dispose();
  fs.rmSync(bare, { recursive: true, force: true });
}

// ---- O. an auth failure is not a "model error" -----------------------------
fake.__instances.length = 0;
{
  const { session, of } = makeSession();
  await session.prepare();
  session.send("x");
  await tick();
  fake.__instances[0].emit(fake.initMessage());
  fake.__instances[0].emit({
    type: "assistant", parent_tool_use_id: null, error: "authentication_failed",
    message: { role: "assistant", content: [] },
  });
  await tick();

  check("O1 an auth failure raises authProblem, not a transcript notice",
    of("authProblem").length === 1 && of("notice").every((n) => !/model error/i.test(n.text)));
  check("O2 it explains the credential is the problem",
    /not signed in/i.test(of("authProblem")[0]?.detail ?? ""));

  fake.__instances[0].emit({
    type: "assistant", parent_tool_use_id: null, error: "overloaded",
    message: { role: "assistant", content: [] },
  });
  await tick();
  check("O3 a genuine model error still reads as one",
    of("notice").some((n) => /model error: overloaded/i.test(n.text)));
  session.dispose();
}

// ---- P. the production ordering: send() WITHOUT awaiting prepare() ---------
// Every other test in this file awaits prepare() first, which is exactly why
// this defect survived: the real controller does not.
fake.__instances.length = 0;
{
  const { session } = makeSession();
  session.send("first message of the session");   // deliberately not awaited
  await tick();
  await tick();
  const o = fake.__instances[0]?.options;
  check("P1 a session starts even without an awaited prepare", Boolean(o));
  check("P2 the CLI is never spawned with an empty environment",
    Boolean(o?.env) && Object.keys(o.env).length > 0);
  check("P3 PATH survives — env REPLACES rather than extends",
    typeof o?.env?.PATH === "string" && o.env.PATH.length > 0);
  check("P4 the billing environment is the one actually used", o?.env?.PATH === "/usr/bin");
  check("P5 the message still reaches the stream",
    fake.__instances[0].received.includes("first message of the session"));
  session.dispose();
}

// ---- Q. Stop must reach the teammates, not just the Lead -------------------
fake.__instances.length = 0;
{
  const { session } = makeSession();
  await session.prepare();
  session.send("go");
  await tick();
  const main = fake.__instances[0];
  main.emit(fake.initMessage());

  // Invoke the brief tool exactly as the Lead would.
  const server = main.options.mcpServers.team;
  const brief = server.tools.find((t) => t.name === "brief_engineer");
  check("Q1 the Lead's brief tool is reachable", Boolean(brief));

  const running = brief.handler({
    objective: "do a thing", done_when: "it is done",
    decide_yourself: ["everything"], context: [], authority: "PATCH", paths: ["x.ts"],
  });
  await tick();
  check("Q2 briefing spawns a second query for the teammate", fake.__instances.length === 2);
  const teammate = fake.__instances[1];
  check("Q3 the teammate has its own abort controller, not the session's",
    teammate.options.abortController !== main.options.abortController);

  await session.interrupt();
  await tick();
  check("Q4 Stop closes the teammate's run, not only the Lead's", teammate.closed === true);
  check("Q5 the teammate's abort signal actually fired",
    teammate.options.abortController?.signal?.aborted === true);

  teammate.end();
  await running.catch(() => {});
  session.dispose();
}

// ---- R. a truncated teammate must not read as a success --------------------
fake.__instances.length = 0;
{
  const { session, of } = makeSession();
  await session.prepare();
  session.send("go");
  await tick();
  const main = fake.__instances[0];
  main.emit(fake.initMessage());
  const brief = main.options.mcpServers.team.tools.find((t) => t.name === "brief_engineer");
  const running = brief.handler({
    objective: "big job", done_when: "done", decide_yourself: ["x"], context: [],
    authority: "PATCH", paths: ["a.ts"],
  });
  await tick();

  // It does real work first — writes a file, runs a command, narrates — and
  // only then runs out of turns. Everything it wrote is still on disk, so the
  // report has to say so or the Lead re-briefs the identical work.
  const worker = fake.__instances[1];
  worker.emit(fake.initMessage());
  worker.emit(fake.messageStart());
  worker.emit(fake.textDelta("Scaffolded the exporter and started training."));
  worker.emit(fake.assistantMessage([
    { type: "tool_use", id: "u1", name: "Write", input: { file_path: "/repo/export.py" } },
    { type: "tool_use", id: "u2", name: "Bash", input: { command: "python export.py --quantize" } },
    { type: "tool_use", id: "u3", name: "Read", input: { file_path: "/repo/train.log" } },
  ]));
  await tick();
  worker.emit(fake.resultMessage({ subtype: "error_max_turns", is_error: true, result: undefined }));
  worker.end();
  const report = await running;
  await tick();

  const text = typeof report === "string" ? report : JSON.stringify(report);
  check("R1 a truncated run reports BLOCKED, not an empty success", /BLOCKED/.test(text));
  check("R2 it says why in terms the Lead can act on", /turn limit/i.test(text));
  check("R3 the user is told the teammate stopped",
    of("notice").some((n) => n.level === "error" && /turn limit/.test(n.text)));
  check("R4 the assignment is not marked delivered",
    of("deliver").at(-1)?.outcome === "blocked");

  check("R5 the report says which files were already written", /wrote \/repo\/export\.py/.test(text));
  check("R6 ...and which commands already ran", /ran: python export\.py --quantize/.test(text));
  check("R7 ...but not every file it merely read", !/train\.log/.test(text));
  check("R8 it carries the agent's own account of where it got to",
    /Scaffolded the exporter/.test(text));
  check("R9 it tells the Lead to re-brief only what is left",
    /re-brief only what is left/i.test(text));
  check("R10 and is explicit that the changes are on disk", /on disk/i.test(text));
  session.dispose();
}

// ---- R2. a truncated run that did nothing must not pretend otherwise -------
fake.__instances.length = 0;
{
  const { session } = makeSession();
  await session.prepare();
  session.send("go");
  await tick();
  const main = fake.__instances[0];
  main.emit(fake.initMessage());
  const brief = main.options.mcpServers.team.tools.find((t) => t.name === "brief_engineer");
  const running = brief.handler({
    objective: "job", done_when: "done", decide_yourself: ["x"], authority: "EXPLORE",
  });
  await tick();
  fake.__instances[1].emit(fake.resultMessage({ subtype: "error_max_turns", is_error: true, result: undefined }));
  fake.__instances[1].end();
  const result = await running;
  const text = typeof result === "string" ? result : JSON.stringify(result);
  check("R11 a run that achieved nothing says so plainly", /nothing was accomplished/i.test(text));
  check("R12 ...and does not invent a list of work already done", !/ALREADY DONE/.test(text));
  session.dispose();
}

// ---- R3. running out of turns continues rather than giving up --------------
// The context window is Claude Code's problem and it summarises and carries on.
// The turn limit is ours: the run just stops. So we hand the agent its own
// account of what it did and let it finish, in the same lane.
fake.__instances.length = 0;
{
  const { session, of } = makeSession({ ...CONFIG, maxContinues: 2 });
  await session.prepare();
  session.send("go");
  await tick();
  const main = fake.__instances[0];
  main.emit(fake.initMessage());
  const brief = main.options.mcpServers.team.tools.find((t) => t.name === "brief_engineer");
  const running = brief.handler({
    objective: "long job", done_when: "done", decide_yourself: ["x"], authority: "BUILD",
  });
  await tick();

  // First attempt: does work, narrates, runs out of turns.
  const first = fake.__instances[1];
  first.emit(fake.initMessage());
  first.emit(fake.messageStart("a"));
  first.emit(fake.textDelta("Wrote the exporter, training is running."));
  first.emit(fake.assistantMessage([
    { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/repo/export.py" } },
  ]));
  await tick();
  first.emit(fake.resultMessage({ subtype: "error_max_turns", is_error: true, result: undefined }));
  first.end();
  await tick();

  check("C1 a second run is started rather than the work being abandoned",
    fake.__instances.length === 3);
  check("C2 the user is told it is carrying on, and how many attempts remain",
    of("notice").some((n) => /carrying on \(1 of 2\)/.test(n.text)));

  // Guarded: if continuation regresses there is no second run, and a stack
  // trace here would hide which assertion actually broke.
  const second = fake.__instances[2];
  const carried = second ? String(second.prompt ?? "") : "";
  check("C3 the continuation is given the original brief", /long job/.test(carried));
  check("C4 ...and what it already wrote", /wrote \/repo\/export\.py/.test(carried));
  check("C5 ...and its own last words, not a paraphrase",
    /Wrote the exporter, training is running\./.test(carried));
  check("C6 ...and is told the work on disk is real",
    /on disk/i.test(carried) && /rather than repeating/i.test(carried));

  // It finishes this time.
  second?.emit(fake.initMessage());
  second?.emit(fake.resultMessage({ result: "VERDICT: DONE\nHEADLINE: exporter shipped" }));
  second?.end();
  if (!second) { first.end(); }
  const report = await running;
  const text = typeof report === "string" ? report : JSON.stringify(report);
  check("C7 the finished report is what comes back, not the truncation notice",
    /VERDICT: DONE/.test(text) && !/BLOCKED/.test(text));
  check("C8 the whole thing reads as one delegation, not two",
    of("assign").filter((a) => a.assignment.to === "engineer").length === 1);
  check("C9 ...and is delivered once", of("deliver").at(-1)?.outcome === "delivered");
  session.dispose();
}

// ---- R4. continuing is bounded ---------------------------------------------
fake.__instances.length = 0;
{
  const { session } = makeSession({ ...CONFIG, maxContinues: 1 });
  await session.prepare();
  session.send("go");
  await tick();
  fake.__instances[0].emit(fake.initMessage());
  const brief = fake.__instances[0].options.mcpServers.team.tools.find((t) => t.name === "brief_engineer");
  const running = brief.handler({
    objective: "endless", done_when: "done", decide_yourself: ["x"], authority: "BUILD",
  });
  await tick();

  // Every attempt runs out of turns.
  for (let i = 1; i <= 2; i += 1) {
    const run = fake.__instances[i];
    if (!run) break;
    run.emit(fake.initMessage());
    run.emit(fake.resultMessage({ subtype: "error_max_turns", is_error: true, result: undefined }));
    run.end();
    await tick();
  }
  const result = await running;
  const text = typeof result === "string" ? result : JSON.stringify(result);
  check("C10 an agent that never finishes is not continued forever",
    fake.__instances.length === 3);
  check("C11 ...and reports BLOCKED at the limit rather than hanging", /BLOCKED/.test(text));
  session.dispose();
}

// ---- R5. the context window filling is visible, in every lane --------------
fake.__instances.length = 0;
{
  const { session, of } = makeSession();
  await session.prepare();
  session.send("go");
  await tick();
  const main = fake.__instances[0];
  main.emit(fake.initMessage());
  const brief = main.options.mcpServers.team.tools.find((t) => t.name === "brief_researcher");
  const running = brief.handler({ objective: "read a lot", done_when: "done", decide_yourself: ["x"] });
  await tick();

  const worker = fake.__instances[1];
  worker.emit(fake.initMessage());
  worker.emit(fake.compactBoundary("auto"));
  await tick();
  check("C12 a nested agent filling its window is reported, not silent",
    of("compacted").length === 1);
  check("C13 ...and explained in the lane it happened in",
    of("notice").some((n) => n.who === "researcher" && /summarised/i.test(n.text)));
  check("C14 ...saying detail was condensed rather than lost",
    of("notice").some((n) => /condensed, not lost/i.test(n.text)));

  worker.emit(fake.resultMessage({ result: "VERDICT: DONE" }));
  worker.end();
  await running;
  check("C15 the run carries on in the same conversation afterwards",
    of("compacted").length === 1);
  session.dispose();
}

// ---- R6. Stop must stop work that chains or continues ----------------------
// A handoff chain and a turn-limit continuation both start new runs after one
// finishes. Neither used to notice an interrupt, so Stop aborted the run in
// flight and the next one started anyway — spending money after the user
// pressed the button that means "no more".
fake.__instances.length = 0;
{
  const chained = {
    ...WORKFLOW,
    edges: [
      { from: "lead", to: "researcher", kind: "delegate" },
      { from: "researcher", to: "engineer", kind: "then" },
    ],
  };
  const { session, of } = makeSession({ ...CONFIG, workflow: chained });
  await session.prepare();
  session.send("go");
  await tick();
  const main = fake.__instances[0];
  main.emit(fake.initMessage());
  const brief = main.options.mcpServers.team.tools.find((t) => t.name === "brief_researcher");
  const running = brief.handler({ objective: "x", done_when: "y", decide_yourself: ["z"] });
  await tick();

  const worker = fake.__instances[1];
  worker.emit(fake.initMessage());
  await session.interrupt();
  worker.emit(fake.resultMessage({ result: "VERDICT: DONE" }));
  worker.end();
  await running;
  await tick();

  check("X1 an interrupt stops the handoff chain instead of starting the next agent",
    fake.__instances.length === 2);
  check("X1b ...and the session knows it is stopping, not merely that a query threw",
    session["stopping"] === true);
  check("X2 ...and says the run was interrupted",
    of("notice").some((n) => /Interrupted/i.test(n.text)));
  session.dispose();
}

fake.__instances.length = 0;
{
  const { session } = makeSession({ ...CONFIG, maxContinues: 3 });
  await session.prepare();
  session.send("go");
  await tick();
  fake.__instances[0].emit(fake.initMessage());
  const brief = fake.__instances[0].options.mcpServers.team.tools.find((t) => t.name === "brief_engineer");
  const running = brief.handler({
    objective: "long", done_when: "y", decide_yourself: ["z"], authority: "BUILD",
  });
  await tick();

  const first = fake.__instances[1];
  first.emit(fake.initMessage());
  await session.interrupt();
  first.emit(fake.resultMessage({ subtype: "error_max_turns", is_error: true, result: undefined }));
  first.end();
  const result = await running;
  await tick();

  check("X3 an interrupt stops a run being continued after its turn limit",
    fake.__instances.length === 2);
  check("X4 ...and the caller still gets an answer rather than hanging",
    typeof result === "object" || typeof result === "string");
  session.dispose();
}

// ---- R6b. the guard itself, not the accident -------------------------------
// The tests above pass even without the guard, because aborting the query makes
// the run throw and the chain never reaches its next node. That is the accident
// the guard replaces, so it has to be exercised directly: a node that completes
// CLEANLY after Stop was pressed must not start the next one. `stopping` is set
// here rather than by interrupt() precisely to separate the two.
fake.__instances.length = 0;
{
  const chained = {
    ...WORKFLOW,
    edges: [
      { from: "lead", to: "researcher", kind: "delegate" },
      { from: "researcher", to: "engineer", kind: "then" },
    ],
  };
  const { session } = makeSession({ ...CONFIG, workflow: chained });
  await session.prepare();
  session.send("go");
  await tick();
  fake.__instances[0].emit(fake.initMessage());
  const brief = fake.__instances[0].options.mcpServers.team.tools.find((t) => t.name === "brief_researcher");
  const running = brief.handler({ objective: "x", done_when: "y", decide_yourself: ["z"] });
  await tick();

  session["stopping"] = true;
  const worker = fake.__instances[1];
  worker.emit(fake.initMessage());
  worker.emit(fake.resultMessage({ result: "VERDICT: DONE" }));
  worker.end();
  await settled(running, "X7 the run finishes rather than waiting on an agent Stop should have prevented");
  await tick();

  check("X7 a node finishing cleanly after Stop does not start the next one",
    fake.__instances.length === 2);
  session.dispose();
}

fake.__instances.length = 0;
{
  const { session } = makeSession({ ...CONFIG, maxContinues: 3 });
  await session.prepare();
  session.send("go");
  await tick();
  fake.__instances[0].emit(fake.initMessage());
  const brief = fake.__instances[0].options.mcpServers.team.tools.find((t) => t.name === "brief_engineer");
  const running = brief.handler({
    objective: "long", done_when: "y", decide_yourself: ["z"], authority: "BUILD",
  });
  await tick();

  session["stopping"] = true;
  const first = fake.__instances[1];
  first.emit(fake.initMessage());
  first.emit(fake.resultMessage({ subtype: "error_max_turns", is_error: true, result: undefined }));
  first.end();
  const text = await settled(running, "X8 the continuation stops rather than hanging");
  check("X8 a run out of turns after Stop is not continued", fake.__instances.length === 2);
  check("X9 ...and still reports rather than hanging", /BLOCKED/.test(text));
  session.dispose();
}

// ---- R7. sending again after Stop works ------------------------------------
fake.__instances.length = 0;
{
  const { session } = makeSession();
  await session.prepare();
  session.send("first");
  await tick();
  fake.__instances[0].emit(fake.initMessage());
  await session.interrupt();
  session.send("second");
  await tick();
  const brief = fake.__instances[0].options.mcpServers.team.tools.find((t) => t.name === "brief_engineer");
  const running = brief.handler({
    objective: "after stop", done_when: "y", decide_yourself: ["z"], authority: "BUILD",
  });
  await tick();
  check("X5 an interrupt does not wedge the session — delegation works again",
    fake.__instances.length >= 2);
  check("X6 ...because sending again clears the stop", session["stopping"] === false);
  fake.__instances.at(-1).emit(fake.resultMessage({ result: "VERDICT: DONE" }));
  fake.__instances.at(-1).end();
  await running;
  session.dispose();
}

// ---- F6. the docs root cannot be pointed outside the workspace -------------
// `cadre.docsPath` is where an agent with no editor may nonetheless write, and
// it is resource-scoped — a cloned repository can set it. Pointed at ../../.ssh
// or /etc it would turn that narrow exception into a write anywhere on the
// machine, with no prompt at all on `autonomous`. The trust layer clamps it;
// this is the guarantee underneath, for anything that reaches the runner
// without being vetted.
for (const hostile of ["../../.ssh", "/etc", "..", "docs/../.."]) {
  fake.__instances.length = 0;
  const { session } = makeSession({ ...CONFIG, cwd: "/repo", docsPath: hostile });
  await session.prepare();
  session.send("x");
  await tick();
  const gate = fake.__instances[0].options.canUseTool;
  const ctx = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };

  for (const target of ["/home/someone/.ssh/authorized_keys", "/etc/passwd", "/repo/../outside.txt"]) {
    const result = await gate("Write", { file_path: target }, ctx);
    check(`docsPath ${JSON.stringify(hostile)} does not permit writing ${target}`,
      result.behavior === "deny" && /only write inside/i.test(result.message ?? ""));
  }
  // And the refusal must not advertise the bogus root as somewhere writable.
  const shown = await gate("Write", { file_path: "/repo/src/app.ts" }, ctx);
  check(`docsPath ${JSON.stringify(hostile)} is not offered as a writable place`,
    !new RegExp(hostile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(shown.message ?? ""));
  session.dispose();
}

// A legitimate docs root still works, or the guard has broken the feature.
fake.__instances.length = 0;
{
  const { session } = makeSession({ ...CONFIG, cwd: "/repo", docsPath: "documentation" });
  await session.prepare();
  session.send("x");
  await tick();
  const gate = fake.__instances[0].options.canUseTool;
  const ctx = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
  answers.permission = "Allow once";
  const inside = await gate("Write", { file_path: "/repo/documentation/notes.md" }, ctx);
  check("F6b a docs root inside the workspace is still writable", inside.behavior === "allow");
  session.dispose();
}

// ---- S. the spend cap is per session, not per query ------------------------
fake.__instances.length = 0;
{
  const { session } = makeSession({ ...CONFIG, maxSpendUsd: 10 });
  await session.prepare();
  session.send("go");
  await tick();
  const main = fake.__instances[0];
  check("S1 the first run gets the full ceiling", main.options.maxBudgetUsd === 10);

  main.emit(fake.initMessage());
  main.emit(fake.resultMessage({ total_cost_usd: 4 }));
  await tick();

  const brief = main.options.mcpServers.team.tools.find((t) => t.name === "brief_engineer");
  const running = brief.handler({
    objective: "x", done_when: "y", decide_yourself: ["z"], context: [],
    authority: "EXPLORE", paths: [],
  });
  await tick();
  check("S2 a teammate gets only what is left, not a fresh ceiling",
    fake.__instances[1].options.maxBudgetUsd === 6);

  fake.__instances[1].end();
  await running.catch(() => {});
  session.dispose();
}

// ---- S2. what the user is told they have spent ----------------------------
// The header shows a running total. It is the only place the cost of a run is
// visible while it is happening, and `cadre.maxSpendUsd` exists because that
// cost is real money.
fake.__instances.length = 0;
{
  const { session, of } = makeSession({ ...CONFIG, maxSpendUsd: 100 });
  await session.prepare();
  session.send("go");
  await tick();
  const main = fake.__instances[0];
  main.emit(fake.initMessage());

  const brief = main.options.mcpServers.team.tools.find((t) => t.name === "brief_engineer");
  const running = brief.handler({
    objective: "x", done_when: "y", decide_yourself: ["z"], context: [],
    authority: "EXPLORE", paths: [],
  });
  await tick();
  const teammate = fake.__instances[1];
  teammate.emit(fake.initMessage());
  teammate.emit(fake.resultMessage({ total_cost_usd: 3 }));
  teammate.end();
  await running.catch(() => {});
  await tick();
  main.emit(fake.resultMessage({ total_cost_usd: 1 }));
  await tick();

  const spendEvents = of("spend");
  const reported = spendEvents.reduce((sum, m) => sum + m.usd, 0);
  check("S3 the running total includes what teammates cost, not just the lead",
    Math.abs(reported - 4) < 1e-9);
  session.dispose();
}

// ---- S4. two teammates started together cannot each spend the whole cap ---
// A run's cost is only known when it ends, so two briefs issued in the same
// turn are both built before either reports. They used to read the same
// remaining figure and the pair could spend twice the ceiling; with N teammates
// and a chain of delegations, N times it.
//
// A slice is now held for each run that is still going. Sequential delegation
// is unaffected — the first releases before the second starts — but siblings
// started together share one ceiling, so the second is refused rather than
// handed money that is already committed.
fake.__instances.length = 0;
{
  const { session, of } = makeSession({ ...CONFIG, maxSpendUsd: 10 });
  await session.prepare();
  session.send("go");
  await tick();
  const main = fake.__instances[0];
  main.emit(fake.initMessage());
  const tools = main.options.mcpServers.team.tools;
  const args = {
    objective: "x", done_when: "y", decide_yourself: ["z"], context: [],
    authority: "EXPLORE", paths: [],
  };
  const a = tools.find((t) => t.name === "brief_engineer").handler({ ...args });
  const b = tools.find((t) => t.name === "brief_researcher").handler({ ...args });
  await tick();

  const granted = fake.__instances.slice(1).map((i) => i.options.maxBudgetUsd);
  check("S5 concurrent teammates cannot between them be granted more than the ceiling",
    granted.reduce((x, y) => x + y, 0) <= 10);
  check("S6 the one that could not be funded is refused rather than started",
    granted.length === 1);
  check("S7 ...and is told the cap is what stopped it",
    of("notice").some((n) => /spend cap of \$10\.00 is committed/.test(n.text)));
  check("S8 ...and its brief comes back failed rather than silently empty",
    of("deliver").some((d) => d.outcome === "failed" && /spend cap/.test(d.summary)));

  for (const inst of fake.__instances.slice(1)) inst.end();
  await Promise.allSettled([a, b]);
  session.dispose();
}

// ---- S9. a slice is released when its run ends ---------------------------
// Otherwise the first delegation would permanently consume the whole ceiling
// and every later one would be refused, which is the same bug pointing the
// other way.
fake.__instances.length = 0;
{
  const { session } = makeSession({ ...CONFIG, maxSpendUsd: 10 });
  await session.prepare();
  session.send("go");
  await tick();
  const main = fake.__instances[0];
  main.emit(fake.initMessage());
  const tools = main.options.mcpServers.team.tools;
  const args = {
    objective: "x", done_when: "y", decide_yourself: ["z"], context: [],
    authority: "EXPLORE", paths: [],
  };

  const first = tools.find((t) => t.name === "brief_engineer").handler({ ...args });
  await tick();
  fake.__instances[1].emit(fake.initMessage());
  fake.__instances[1].emit(fake.resultMessage({ total_cost_usd: 2 }));
  fake.__instances[1].end();
  await first.catch(() => {});
  await tick();

  const second = tools.find((t) => t.name === "brief_researcher").handler({ ...args });
  await tick();
  check("S10 a second delegation after the first finished still runs",
    fake.__instances.length === 3);
  check("S11 ...and gets what is genuinely left, not a fresh ceiling",
    fake.__instances[2]?.options.maxBudgetUsd === 8);

  fake.__instances[2]?.end();
  await second.catch(() => {});
  session.dispose();
}

// ---- T. questions render in the lane and wait for a real answer -----------
fake.__instances.length = 0;
{
  const { session, of } = makeSession();
  await session.prepare();
  session.send("x");
  await tick();
  const gate = fake.__instances[0].options.canUseTool;
  const ctx = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
  const long =
    "Native Urdu quality comes from either a paid API or a self-hosted model you fine-tune. " +
    "Which fits your constraints — this changes the whole plan, so I want your answer before committing?";
  const ask = {
    questions: [{
      question: long, header: "Ownership", multiSelect: false,
      options: [
        { label: "Paid API is fine", description: "ElevenLabs or Azure ur-PK." },
        { label: "Must be self-hosted", description: "Fine-tune on an Urdu corpus." },
      ],
    }],
  };

  const pending = gate("AskUserQuestion", ask, ctx);
  await tick();
  const asked = of("ask").at(-1);
  check("T1 the question is emitted to the UI, not a native picker", Boolean(asked));
  check("T2 the full question text is carried, untruncated",
    asked?.questions?.[0]?.question === long);
  check("T3 options keep their descriptions",
    asked?.questions?.[0]?.options?.[1]?.description === "Fine-tune on an Urdu corpus.");
  check("T4 the teammate is shown as waiting",
    of("status").some((e) => e.status === "waiting"));

  session.answer(asked.id, { [long]: "Paid API is fine" });
  const answered = await pending;
  check("T5 the answer reaches the model on the tool input",
    answered.updatedInput?.answers?.[long] === "Paid API is fine");
  check("T6 the card is told it was settled",
    of("askClosed").at(-1)?.answered === true);

  // Skipping is a real answer.
  const second = gate("AskUserQuestion", ask, ctx);
  await tick();
  session.answer(of("ask").at(-1).id, null);
  const skipped = await second;
  check("T7 skipping denies rather than inventing an answer",
    skipped.behavior === "deny" && /dismissed/i.test(skipped.message));

  // A question left open must not survive an interrupt.
  const third = gate("AskUserQuestion", ask, ctx);
  await tick();
  await session.interrupt();
  const abandoned = await third;
  check("T8 an interrupt settles an open question instead of hanging",
    abandoned.behavior === "deny");
  session.dispose();
}

// ---- V. a lane must not go back to "working" after the run was stopped ----
// A permission prompt is a native modal, so it stays on screen after Stop —
// nothing can dismiss it. Answering it then ran the tidy-up that puts the agent
// back to "working", after the interrupt had already set every lane idle. The
// run was over, and the lane sat there with a pulsing light claiming otherwise.
fake.__instances.length = 0;
{
  const { session, of } = makeSession();
  await session.prepare();
  session.send("go");
  await tick();
  const gate = fake.__instances[0].options.canUseTool;
  const ctx = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };

  answers.hold = true;             // the modal stays on screen, as a real one does
  const pending = gate("Bash", { command: "pytest -q" }, ctx);
  await tick();
  check("V0 the lane shows it is waiting on the user",
    of("status").at(-1)?.status === "waiting");

  await session.interrupt();
  check("V1 stopping sets every lane idle",
    of("status").at(-1)?.status === "idle");

  // The modal is still on screen — nothing can take it away — but the tool call
  // it was gating must not go on waiting for a click that can no longer matter.
  const settledEarly = await Promise.race([
    pending.then((r) => r.behavior),
    new Promise((r) => setTimeout(() => r("STILL WAITING"), 200)),
  ]);
  check("V1b stopping resolves the call the modal was gating",
    settledEarly === "deny");

  // And the click, when it finally comes, changes nothing.
  answers.click("Allow once");
  answers.hold = false;
  await pending.catch(() => {});
  await tick();
  const last = of("status").filter((e) => e.who === "lead").at(-1);
  check("V2 answering a modal after Stop does not restart the lane",
    last?.status !== "working");
  session.dispose();
}

// ---- V2. switching teammate with a modal still on screen ------------------
// The same tidy-up, on the path that does not set the lanes idle afterwards.
// Switching who you are talking to drops the running query, but the native
// modal it was waiting on is still on the screen — nothing can take it away.
// The tidy-up then put the agent you just left back to "working", and nothing
// came along after to correct it.
fake.__instances.length = 0;
{
  const { session, of } = makeSession();
  await session.prepare();
  session.send("go");
  await tick();
  const gate = fake.__instances[0].options.canUseTool;
  const ctx = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };

  answers.hold = true;
  const pending = gate("Bash", { command: "pytest -q" }, ctx);
  await tick();

  session.setChannel("engineer");
  await tick();
  await tick();
  answers.hold = false;
  await pending.catch(() => {});
  await tick();

  const leadStatus = of("status").filter((e) => e.who === "lead").at(-1)?.status;
  // This one self-corrects: dropping the query ends the stream, and that sets
  // every lane idle. The check is here because nothing else pins that, and
  // without it the correction could be removed without a test noticing.
  check("V3 the agent you left ends up idle, not still working",
    leadStatus === "idle");
  session.dispose();
}

// ---- U. a question left open when the CLI dies ---------------------------
// Interrupt, teardown and dispose all settle an open question. The path where
// the stream itself fails did not: the promise was never resolved, so the code
// that emits askClosed never ran, and the card sat in the lane waiting for an
// answer that could no longer go anywhere. Exactly the state an unattended run
// gets stuck in.
fake.__instances.length = 0;
{
  const { session, of } = makeSession();
  await session.prepare();
  session.send("go");
  await tick();
  const main = fake.__instances[0];
  const gate = main.options.canUseTool;
  const ctx = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
  const ask = {
    questions: [{
      question: "Which corpus should I fine-tune on, since it changes the whole plan?",
      header: "Corpus", multiSelect: false,
      options: [{ label: "Common Voice", description: "Open, smaller." },
                { label: "Licensed set", description: "Costs money." }],
    }],
  };

  const open = gate("AskUserQuestion", ask, ctx);
  await tick();
  check("U1 the question is put to the user", of("ask").length > 0);

  // The CLI falls over with the question still on screen.
  main.fail(new Error("the CLI exited unexpectedly"));
  await tick();
  await tick();

  const settled = await Promise.race([
    open,
    new Promise((r) => setTimeout(() => r("HUNG"), 500)),
  ]);
  check("U2 a stream that dies settles the open question rather than hanging",
    settled !== "HUNG");
  check("U3 ...and the card is told, so it stops waiting",
    of("askClosed").some((e) => e.answered === false));
  check("U4 ...and the composer is released", of("busy").at(-1)?.busy === false);
  session.dispose();
}

// ---- the workspace chip on someone else's machine -------------------------
// The chip has room for about thirty characters, so the path is shortened to
// its last two segments. It read process.env.HOME, which Windows does not set,
// and split on "/" alone, which a Windows path does not contain. Both failed
// silently and both the same way: the whole path was shown, and the part the
// chip then cut off was the end, which is the only part naming the project.
{
  const home = os.homedir();
  check("a deep path is shortened to what identifies it",
    shortPath("/srv/work/clients/acme/pipeline") === "…/acme/pipeline");
  check("a Windows path is shortened too, not left whole",
    shortPath("C:\\Users\\me\\code\\pipeline") === "…/code/pipeline");
  check("a short path is left alone", shortPath("/a/b") === "/a/b");
  check("a short Windows path is left alone too", shortPath("C:\\proj") === "C:\\proj");
  check("a path under home is written with a tilde",
    shortPath(home + "/x").startsWith("~"));

  // The case Windows is always in: no HOME in the environment. homedir() knows
  // where home is anyway; reading the variable directly did not.
  const savedHome = process.env.HOME;
  delete process.env.HOME;
  const withoutHome = shortPath(home + "/x");
  if (savedHome !== undefined) process.env.HOME = savedHome;
  check("...even with no HOME set, which is where Windows always is",
    withoutHome.startsWith("~"));
}

console.log("=== session lifecycle + team wiring ===");
let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
process.exit(failed ? 1 : 0);

/**
 * The demo film, rendered from the real interface.
 *
 * Every frame is the shipped webview — media/team.js and media/team.css, and
 * the markup extracted from src/extension.ts — driven by genuine TeamEvents.
 * Nothing here is a mockup, and nothing is a screen recording of a staged run:
 * the events are the same ones the runner emits, so a change to the product
 * changes the film.
 *
 * Frames come out of headless Chrome one launch at a time, which is slow but
 * needs no browser driver. Motion that matters — arrows carrying work — is
 * rendered as a real frame sequence by stepping the dash offset, rather than
 * faked in post.
 *
 *   node .shots/film.mjs          # render frames and encode
 *   node .shots/film.mjs --frames # frames only, for iterating on timing
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { page } from "./harness.mjs";
import * as opener from "./opener.mjs";

const OUT = ".shots/film";
const W = 1280;
const H = 720;
const FPS = 30;

const CHROME = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
  .find((bin) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0);
if (!CHROME) throw new Error("no Chrome — cannot render the film");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let shot = 0;
/** Renders a bare HTML string — used for the explainer, which is not the UI. */
function card(html, label) {
  const file = path.join(OUT, `card-${shot}.html`);
  fs.writeFileSync(file, html);
  const png = path.join(OUT, `f${String(shot).padStart(4, "0")}.png`);
  execFileSync(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--force-device-scale-factor=1", `--window-size=${W},${H}`,
    "--virtual-time-budget=1500", `--screenshot=${png}`, `file://${path.resolve(file)}`,
  ], { stdio: "ignore" });
  process.stdout.write(`  ${String(shot).padStart(3)}  ${label}\n`);
  shot += 1;
}
/** Renders one frame of the real UI at the film's aspect ratio. */
function frame(events, { extraCss = "", after = "", label = "" } = {}) {
  const file = path.join(OUT, `page-${shot}.html`);
  fs.writeFileSync(file, page(events, { width: W, height: H, extraCss, after }));
  const png = path.join(OUT, `f${String(shot).padStart(4, "0")}.png`);
  execFileSync(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--force-device-scale-factor=1", `--window-size=${W},${H}`,
    "--virtual-time-budget=2500", `--screenshot=${png}`, `file://${path.resolve(file)}`,
  ], { stdio: "ignore" });
  if (label) process.stdout.write(`  ${String(shot).padStart(3)}  ${label}\n`);
  shot += 1;
  return png;
}

/* ------------------------------------------------------------- the cast */

const AGENTS = [
  { id: "product", name: "Product", role: "Decides what ships and what does not", preset: "readonly", x: 40, y: 300 },
  { id: "architect", name: "Architect", role: "Designs it before anyone writes code", preset: "readonly", x: 330, y: 130 },
  { id: "research", name: "Research", role: "Answers what needs a source", preset: "research", x: 330, y: 470 },
  { id: "builder", name: "Implementer", role: "Writes the change", preset: "build", x: 640, y: 300 },
  { id: "reviewer", name: "Reviewer", role: "Reads the diff as though it is wrong", preset: "readonly", x: 950, y: 130 },
  { id: "tester", name: "Test engineer", role: "Proves it works", preset: "build", x: 950, y: 470 },
];
const EDGES = [
  { from: "product", to: "architect", kind: "delegate", label: "design it first" },
  { from: "product", to: "builder", kind: "delegate", label: "build the design" },
  { from: "product", to: "reviewer", kind: "delegate", label: "read the diff" },
  { from: "architect", to: "research", kind: "delegate" },
  { from: "builder", to: "architect", kind: "delegate", label: "ask when unclear" },
  { from: "reviewer", to: "builder", kind: "delegate", label: "send defects back" },
  { from: "builder", to: "tester", kind: "then", label: "prove it" },
];

const roster = (over = {}) => ({
  kind: "roster",
  workflowId: "ship", workflowName: "Ship a feature",
  autonomy: "Standard — edits flow, risky commands ask",
  billing: "Claude subscription", workspace: "…/checkout", connectors: [],
  edges: EDGES,
  members: AGENTS.map((a) => ({
    ...a, model: "opus", effort: "high", status: "idle", activity: "", entry: a.id === "product",
  })),
  ...over,
});

const busy = (map) =>
  roster({
    members: AGENTS.map((a) => ({
      ...a, model: "opus", effort: "high", entry: a.id === "product",
      status: map[a.id] ? "working" : "idle",
      activity: map[a.id] ?? "",
    })),
  });

const say = (who, turn, delta) => ({ kind: "say", who, turn, delta });
const open = `document.getElementById("livemap").open = true;
  document.getElementById("livemap").dispatchEvent(new Event("toggle"));`;

/* ------------------------------------------------------------- the scenes */

console.log("rendering frames");

// The explainer. A viewer who has never seen this cannot learn what it is from
// the UI alone — they have to know what they are looking at first.
card(opener.one(), "explainer: one assistant");
card(opener.team(false), "explainer: a team");
card(opener.team(true), "explainer: wired up");
card(opener.arrows("delegate"), "explainer: delegate arrow");
card(opener.arrows("then"), "explainer: then arrow");
card(opener.enforced(), "explainer: enforced");
card(opener.end(), "end card");

// 1. The home screen: what you come back to.
const HOME = [
  { kind: "screen", screen: "home" },
  { kind: "workflows", project: "checkout", items: [
    { id: "ship", name: "Ship a feature", scope: "local", description: "Design, build, review, prove, document.",
      agents: 6, edges: 7, updatedAt: Date.now() - 5400_000, sessions: 12,
      agentNames: AGENTS.map((a) => a.name), problems: 0 },
    { id: "sec", name: "Security review", scope: "global", description: "Four lenses, and one agent that tries to exploit what they find.",
      agents: 6, edges: 7, updatedAt: Date.now() - 86400_000, sessions: 3,
      agentNames: ["Security lead", "Code auditor", "Dependency auditor", "Config auditor", "Exploit prover", "Report"], problems: 0 },
  ], templates: [] },
];
frame(HOME, { label: "home" });

// 2. Describe a pipeline in prose.
const TYPED = "Read incoming support tickets, work out which are real bugs, reproduce them against our repo, and draft a reply for each one.";
for (const upto of [46, 92, TYPED.length]) {
  frame(HOME, {
    label: `typing ${upto}`,
    after: `document.getElementById("home-build").click();
      document.getElementById("build-input").value = ${JSON.stringify(TYPED.slice(0, upto))};`,
  });
}
frame(HOME, {
  label: "designing",
  after: `document.getElementById("home-build").click();
    document.getElementById("build-input").value = ${JSON.stringify(TYPED)};
    send({ kind: "building", busy: true, note: "Designing the workflow…" });`,
});

// 3. The graph, on the canvas.
const EDITING = [
  { kind: "screen", screen: "builder" },
  { kind: "editing", authoritative: true, problems: [],
    workflow: {
      id: "ship", name: "Ship a feature", scope: "local", entry: "product",
      createdAt: 0, updatedAt: 0, revision: 4,
      agents: AGENTS.map((a) => ({ ...a, prompt: "You decide what is actually being built, and you are the only one who can say no.\n\nBefore anything is designed, settle three things and say them: the user-visible outcome, the smallest version worth shipping, and what is explicitly out of scope." })),
      edges: EDGES,
    },
    presets: [
      { id: "readonly", name: "Read-only", blurb: "Reads the project and delegates. No shell." },
      { id: "research", name: "Research", blurb: "Web search and fetch, plus read-only access." },
      { id: "build", name: "Build", blurb: "Files and a shell. The one that changes things." },
      { id: "full", name: "Everything", blurb: "Every tool at once." },
    ],
    catalogue: [{ group: "Running", tools: [{ name: "Bash", blurb: "Run shell commands" }] }],
    skills: [
      { name: "code-review", description: "Review the current diff for correctness bugs" },
      { name: "verify", description: "Verify a change actually does what it should" },
    ],
    connectors: ["sentry"], models: [
      { value: "claude-fable-5[1m]", label: "Fable", efforts: ["low", "high", "max"] },
      { value: "opus[1m]", label: "Opus", efforts: ["low", "high", "xhigh", "max"] },
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
];
frame(EDITING, { label: "builder" });

// 4. One agent, opened.
frame(EDITING, {
  label: "inspector",
  after: `const n = document.querySelector('.agent-node[data-id="product"]');
    n.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 60, clientY: 320 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 60, clientY: 320 }));
    document.querySelector("details.advanced").open = true;`,
});

// 5. Running: the board, with work moving.
const RUN_BASE = [
  { kind: "screen", screen: "run" },
  busy({ architect: "reading src/checkout/", research: "docs — idempotency keys" }),
  { kind: "sendability", ok: true },
  { kind: "userSaid", to: "product", text: "Checkout double-charges when the retry lands after the webhook. Fix it." },
  say("product", "t1", "**Goal:** one charge per intent, whatever order the retry and the webhook arrive in.\n**Not doing:** the refund path — different code, and you did not ask.\n**Riskiest assumption:** the provider's idempotency key is honoured on retry. If it is not, the fix moves into our own ledger.\n\nDesign first, then build."),
  { kind: "sayEnd", who: "product", turn: "t1" },
  { kind: "assign", assignment: { id: "A1", from: "product", to: "architect", brief: "Design the deduplication, name the files", startedAt: 0 } },
  say("architect", "t2", "Reading the two write paths before proposing anything."),
  { kind: "act", who: "architect", act: "a1", tool: "Read", summary: "src/checkout/webhook.ts" },
  { kind: "actEnd", who: "architect", act: "a1", ok: true, summary: "" },
  { kind: "assign", assignment: { id: "A2", from: "architect", to: "research", brief: "Is the provider key honoured on retry?", startedAt: 0 } },
  say("research", "t3", "Checking the installed version rather than the current docs."),
  { kind: "act", who: "research", act: "a2", tool: "WebFetch", summary: "docs — idempotent requests" },
  { kind: "actEnd", who: "research", act: "a2", ok: true, summary: "" },
];

// The arrows actually move: one frame per dash phase, real CSS, no fakery.
const flowing = { active: ["architect", "research"], edge: { from: "product", to: "architect" } };
for (let i = 0; i < 10; i += 1) {
  frame([...RUN_BASE, { kind: "active", ...flowing }], {
    label: i === 0 ? "run (10 frames of flow)" : "",
    extraCss: `.map .wire.live { animation: none !important; stroke-dashoffset: ${-i * 1.8}px; }`,
    after: open,
  });
}

// 6. Further in: the implementer has hands, the tester is proving it.
const LATER = [
  { kind: "screen", screen: "run" },
  busy({ builder: "pytest -k idempotent", tester: "writing the failing test" }),
  { kind: "sendability", ok: true },
  say("architect", "t4", "Design: a `charge_intents` row written inside the same transaction as the charge, keyed on the provider intent id. Rejected the in-memory lock — it does not survive two workers."),
  { kind: "sayEnd", who: "architect", turn: "t4" },
  { kind: "assign", assignment: { id: "A3", from: "product", to: "builder", brief: "Build the agreed design", startedAt: 0, finishedAt: 0, outcome: "delivered" } },
  say("builder", "t5", "Reproduced the double charge with two concurrent workers first, so there is something to prove against."),
  { kind: "act", who: "builder", act: "b1", tool: "Edit", summary: "src/checkout/charge.ts" },
  { kind: "actEnd", who: "builder", act: "b1", ok: true, summary: "" },
  { kind: "act", who: "builder", act: "b2", tool: "Bash", summary: "pytest -k idempotent" },
  { kind: "actEnd", who: "builder", act: "b2", ok: true, summary: "3 passed" },
  { kind: "assign", assignment: { id: "A4", from: "builder", to: "tester", brief: "prove it", startedAt: 0, handoff: true } },
  say("tester", "t6", "The test fails against the old code and passes against the new one — checked both."),
  { kind: "spend", usd: 0.41, turns: 18, durationMs: 214000 },
];
for (let i = 0; i < 10; i += 1) {
  frame([...LATER, { kind: "active", agents: ["builder", "tester"], edge: { from: "builder", to: "tester" } }], {
    label: i === 0 ? "later (10 frames of flow)" : "",
    extraCss: `.map .wire.live { animation: none !important; stroke-dashoffset: ${-i * 1.8}px; }`,
    after: open,
  });
}

console.log(`${shot} frames`);
if (process.argv.includes("--frames")) process.exit(0);

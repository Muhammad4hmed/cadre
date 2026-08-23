/**
 * Renders the real webview — media/team.css and media/team.js, unmodified —
 * against a scripted sequence of genuine TeamEvents, so the listing images are
 * the actual interface rather than a mockup of it.
 */
import * as fs from "node:fs";

// Extracted on every run, not read from a checked-in copy. A separate
// extraction step goes stale silently, which is exactly what "cannot drift"
// was supposed to prevent — and did not.
const source = fs.readFileSync("src/extension.ts", "utf8");
const body = source.slice(
  source.indexOf('  <header class="bar">'),
  source.indexOf("  <script nonce="),
);
if (!body.includes("screen-projects")) throw new Error("markup extraction failed — anchors moved");
const css = fs.readFileSync("media/team.css", "utf8");
const js = fs.readFileSync("media/team.js", "utf8");
const theme = fs.readFileSync(".shots/theme.css", "utf8");

const page = (events, { width, settle = 0 }) => `<!doctype html>
<html><head><meta charset="utf-8">
<style>${theme}</style><style>${css}</style>
<style>html,body{width:${width}px;height:100%;margin:0;overflow:hidden}</style>
</head><body>
${body.replace(/\$\{[^}]*\}/g, "")}
<script>
  // The webview's only host dependency.
  window.acquireVsCodeApi = () => ({ postMessage(){}, getState(){}, setState(){} });
</script>
<script>${js}</script>
<script>
  const send = (e) => window.dispatchEvent(new MessageEvent("message", { data: e }));
  const script = ${JSON.stringify(events)};
  // Deltas are delivered in one pass; the streaming path is the same code.
  for (const e of script) send(e);
  const live = document.getElementById("livemap");
  if (live && document.getElementById("screen-run")?.dataset.active === "true") {
    live.open = true;
    live.dispatchEvent(new Event("toggle"));
  }
  document.title = "ready";
</script>
</body></html>`;

const roster = (over = {}) => ({
  kind: "roster",
  workflowId: "software_team",
  workflowName: "Software team",
  edges: [
    { from: "lead", to: "researcher", kind: "delegate" },
    { from: "lead", to: "engineer", kind: "delegate" },
  ],
  workspace: "…/pipeline",
  autonomy: "Standard — edits flow, risky commands ask",
  billing: "Claude subscription",
  connectors: [{ name: "kaggle", ok: true, status: "connected" }],
  members: [
    { id: "lead", name: "Lead", role: "Interrogates the brief, decides scope, delegates", preset: "readonly",
      model: "opus", effort: "high", status: "thinking", activity: "reading the report", entry: true, x: 60, y: 200 },
    { id: "researcher", name: "Researcher", role: "Reads papers, docs and the web", preset: "research",
      model: "opus", effort: "high", status: "working", activity: "arxiv.org — CTC vs attention", entry: false, x: 420, y: 80 },
    { id: "engineer", name: "Engineer", role: "Writes, edits and runs the code", preset: "build",
      model: "opus", effort: "xhigh", status: "working", activity: "pytest tests/test_decode.py", entry: false, x: 420, y: 320 },
  ],
  ...over,
});

const say = (who, turn, text) => ({ kind: "say", who, turn, delta: text });

const TEAM = [
  { kind: "screen", screen: "run" },
  roster(),
  { kind: "sendability", ok: true },
  { kind: "userSaid", to: "lead", text: "Our ASR pipeline drops the last word on long audio. Fix it." },
  say("lead", "t1",
    "Reproduced from your description, not yet from a run — I have no shell.\n\n**Goal:** stop the final token being truncated on utterances over ~30s.\n**Not doing:** the streaming path. Different code, and you did not ask.\n**Riskiest assumption:** this is the decoder's length cap, not the VAD trimming audio. If I am wrong we have spent one Engineer run.\n\nTwo briefs going out together."),
  { kind: "assign", assignment: { id: "R-01", from: "lead", to: "researcher",
      brief: "Does CTC beam search truncate the final token when the encoder output is padded? Answer for our installed version.", startedAt: 0 } },
  { kind: "assign", assignment: { id: "E-01", from: "lead", to: "engineer",
      brief: "Reproduce the dropped final word with a failing test over a 45s sample.", startedAt: 0 } },
  say("researcher", "t2", "Reading the decoder source rather than the docs — the docs describe 0.9 and the lockfile pins 1.2."),
  { kind: "act", who: "researcher", act: "a1", tool: "WebFetch", summary: "github.com/…/ctc_decoder.py" },
  { kind: "actEnd", who: "researcher", act: "a1", ok: true, summary: "fetched" },
  { kind: "act", who: "researcher", act: "a2", tool: "Grep", summary: "max_length  in  site-packages/asr" },
  { kind: "actEnd", who: "researcher", act: "a2", ok: true, summary: "3 matches" },
  say("engineer", "t3", "Writing the failing test first — a fix for a failure I never saw is unverified."),
  { kind: "act", who: "engineer", act: "b1", tool: "Read", summary: "src/decode.py" },
  { kind: "actEnd", who: "engineer", act: "b1", ok: true, summary: "read 212 lines" },
  { kind: "act", who: "engineer", act: "b2", tool: "Bash", summary: "pytest tests/test_decode.py -k long_audio" },
  { kind: "actEnd", who: "engineer", act: "b2", ok: false, summary: "1 failed — assert 'four' in transcript" },
  { kind: "act", who: "engineer", act: "b3", tool: "Edit", summary: "src/decode.py" },
  { kind: "deliver", id: "R-01", outcome: "delivered",
    summary: "Confirmed in 1.2: the beam ends at encoder_len, which excludes the pad frame carrying the final token." },
  { kind: "spend", usd: 0.4127, turns: 6, durationMs: 74300 },
  { kind: "ask", id: "q1", who: "lead", questions: [{
    question: "Native Urdu quality comes from either a paid API or a self-hosted model you fine-tune. Which fits your constraints? This changes the whole plan, so I want your answer before committing.",
    header: "Ownership", multiSelect: false,
    options: [
      { label: "Paid API is fine", description: "ElevenLabs or Azure ur-PK. Native quality, working in an afternoon, per-use cost, no model to maintain." },
      { label: "Must be self-hosted", description: "Fine-tune F5-TTS or VITS on an Urdu corpus. No per-use fees and full control, but days of data and GPU work." },
      { label: "Start cheap, own it later", description: "Prototype on an API now to prove quality, then invest in a fine-tune if it is worth it." },
    ],
  }] },
];

const SESSIONS = {
  kind: "sessions", project: "pipeline",
  items: [
    { id: "1", title: "Urdu TTS under 10 MB — feasibility", when: Date.now() - 3 * 3600_000 },
    { id: "2", title: "fix the decoder dropping the final word", when: Date.now() - 26 * 3600_000 },
    { id: "3", title: "set up CI and the release workflow", when: Date.now() - 4 * 86400_000 },
  ],
};

const PROJECTS = [
  { kind: "auth", signedIn: true, detail: "you@example.com · max", billing: "Claude subscription", usingApiKey: false },
  { kind: "screen", screen: "projects" },
  { kind: "projects", roots: ["/home/you/code"], active: "/home/you/code/pipeline", items: [
    { path: "/home/you/code/pipeline", name: "pipeline", open: true, known: true, stack: ["Python", "Docker"], lastTouched: 0 },
    { path: "/home/you/code/web-console", name: "web-console", open: true, known: false, stack: ["Node", "TypeScript"], lastTouched: 0 },
    { path: "/home/you/code/infra", name: "infra", open: false, known: true, stack: ["Docker"], lastTouched: 0 },
    { path: "/home/you/code/label-tool", name: "label-tool", open: false, known: false, stack: ["Python"], lastTouched: 0 },
  ] },
  SESSIONS,
];

const AUTH = [
  { kind: "auth", signedIn: false, detail: "Not signed in to Claude.", billing: "—", usingApiKey: false },
  { kind: "screen", screen: "auth" },
];

/** Exactly what TeamController.replayTranscript emits when you reopen a session. */
const RESUMED = [
  { kind: "screen", screen: "run" },
  roster({ members: roster().members.map((m) => ({ ...m, status: "idle", activity: "" })) }),
  { kind: "sendability", ok: true },
  { kind: "notice", level: "info", text: "Resumed: fix the dropped final word on long audio" },
  { kind: "userSaid", to: "lead", text: "Our ASR pipeline drops the last word on long audio. Fix it." },
  { kind: "think", who: "lead", turn: "replay-0",
    delta: "Two candidates: the decoder length cap, or the VAD trimming the tail. The test settles it." },
  say("lead", "replay-1",
    "Reproduced from your description, not yet from a run — I have no shell. Briefing the Engineer to get a failing test first."),
  { kind: "sayEnd", who: "lead", turn: "replay-1" },
  { kind: "assign", assignment: { id: "replay-t1", from: "lead", to: "engineer",
      brief: "Reproduce the dropped final word with a failing test over a 45s sample.",
      startedAt: 0, finishedAt: 0, outcome: "delivered" } },
  { kind: "deliver", id: "replay-t1", outcome: "delivered",
    summary: "the tokenizer drops a trailing space; the decoder is not at fault" },
  { kind: "act", who: "lead", act: "replay-t2", tool: "git_view", summary: "diff" },
  { kind: "actEnd", who: "lead", act: "replay-t2", ok: true, summary: "1 file changed, 6 insertions(+)" },
  { kind: "act", who: "lead", act: "replay-t3", tool: "brief_researcher",
    summary: '{"objective":"Determine whether a natural-sounding, offline, on-device Urdu TTS can ship…' },
  { kind: "actEnd", who: "lead", act: "replay-t3", ok: false,
    summary: 'MCP error -32602: Input validation error: Invalid arguments for tool brief_researcher: context — expected array, received string' },
  { kind: "notice", level: "info", text: "— end of the earlier conversation —" },
];

// Read from the real template list, so the shot cannot drift from what ships.
const { execFileSync } = await import("node:child_process");
const TEMPLATE_CARDS = JSON.parse(execFileSync("node", ["-e", `
  const esbuild = require("esbuild");
  esbuild.buildSync({ entryPoints: ["src/workflow/templates.ts"], bundle: true, platform: "node",
    format: "cjs", outfile: "/tmp/.tpl.cjs", loader: { ".md": "text" }, logLevel: "silent" });
  process.stdout.write(JSON.stringify(require("/tmp/.tpl.cjs").templateCards()));
`], { encoding: "utf8" }));

const HOME = [
  { kind: "screen", screen: "home" },
  { kind: "workflows", project: "pipeline", items: [
    { id: "software_team", name: "Software team", description: "A lead who decides and delegates, a researcher with the web, an engineer with the shell.",
      agents: 3, edges: 4, updatedAt: 0, sessions: 6, agentNames: ["Lead", "Researcher", "Engineer"], problems: 0 },
    { id: "incident", name: "Incident review", description: "Triage, root-cause and a written postmortem.",
      agents: 4, edges: 5, updatedAt: 0, sessions: 2, agentNames: ["Triage", "Investigator", "Reviewer", "Writer"], problems: 0 },
    { id: "half", name: "Contract review", description: "",
      agents: 2, edges: 0, updatedAt: 0, sessions: 0, agentNames: ["Reader", "Redliner"], problems: 2 },
  ], templates: TEMPLATE_CARDS },
];

const wfAgent = (id, name, role, preset, x, y) => ({
  id, name, role, preset, prompt: "You do the thing, and you do it well.", x, y,
});

const BUILDER = [
  { kind: "screen", screen: "builder" },
  { kind: "editing",
    workflow: {
      id: "incident", name: "Incident review", entry: "triage", createdAt: 0, updatedAt: 0, revision: 3,
      agents: [
        wfAgent("triage", "Triage", "Decides severity and what to look at first", "readonly", 40, 150),
        wfAgent("investigator", "Investigator", "Reads logs and reproduces", "build", 330, 40),
        wfAgent("historian", "Historian", "Finds prior incidents like this one", "research", 330, 260),
        wfAgent("writer", "Writer", "Writes the postmortem", "readonly", 620, 150),
      ],
      edges: [
        { from: "triage", to: "investigator", kind: "delegate", label: "reproduce it" },
        { from: "triage", to: "historian", kind: "delegate" },
        { from: "investigator", to: "historian", kind: "delegate" },
        { from: "investigator", to: "writer", kind: "then", label: "findings to the draft" },
        { from: "historian", to: "writer", kind: "then" },
      ],
    },
    problems: [
      { level: "warning", message: "Writer has no arrows leaving it, so nothing happens after it.", where: "writer" },
    ],
    presets: [
      { id: "readonly", name: "Read-only", blurb: "Reads the project and delegates. No shell, no editing outside its own notes." },
      { id: "research", name: "Research", blurb: "Web search and fetch, plus read-only project access. Writes reports, not code." },
      { id: "build", name: "Build", blurb: "Files and a shell. This is the one that actually changes things." },
      { id: "full", name: "Everything", blurb: "Every tool at once. Convenient, and the least likely to keep its lane." },
    ],
    catalogue: [
      { group: "Reading", tools: [{ name: "Read", blurb: "Open a file" }, { name: "Grep", blurb: "Search file contents" }] },
      { group: "Running", tools: [{ name: "Bash", blurb: "Run shell commands" }] },
    ],
    skills: ["postmortem"], connectors: ["sentry"], models: ["opus", "sonnet", "haiku"],
    efforts: ["low", "medium", "high", "xhigh"],
  },
];

/** Six agents: the case the three-lane layout could not express at all. */
const MANY = [
  { kind: "screen", screen: "run" },
  roster({
    workflowName: "Release train",
    members: ["Planner", "Researcher", "Backend", "Frontend", "Reviewer", "Release"].map((name, i) => ({
      id: name.toLowerCase(), name,
      role: ["Decides scope", "Checks the outside world", "Server changes", "Client changes", "Reads the diff", "Ships it"][i],
      preset: ["readonly", "research", "build", "build", "readonly", "build"][i],
      model: "opus", effort: "high",
      status: ["thinking", "working", "working", "idle", "idle", "idle"][i],
      activity: ["deciding what ships", "changelog since v3", "pytest -x", "", "", ""][i],
      entry: i === 0,
    })),
  }),
  { kind: "sendability", ok: true },
  { kind: "userSaid", to: "planner", text: "Cut the 3.4 release." },
  say("planner", "m1", "Two blockers and a doc gap. Fanning out."),
  { kind: "assign", assignment: { id: "A", from: "planner", to: "backend", brief: "Fix the migration ordering bug", startedAt: 0 } },
  { kind: "assign", assignment: { id: "B", from: "planner", to: "researcher", brief: "What changed in the upstream client?", startedAt: 0 } },
  say("researcher", "m2", "Upstream renamed two fields in 4.1 and kept aliases until 5.0."),
  say("backend", "m3", "Reproduced. The migration sorts lexically, so 10 lands before 9."),
  { kind: "act", who: "backend", act: "a1", tool: "Bash", summary: "pytest -x tests/test_migrate.py" },
  { kind: "assign", assignment: { id: "C", from: "backend", to: "release", brief: "cut the tag once green", startedAt: 0, handoff: true } },
  { kind: "spend", usd: 0.82, turns: 11, durationMs: 91000 },
];

const DETAIL_WF = {
  id: "incident", name: "Incident review", scope: "global",
  description: "Triage, a reproducer and a historian in parallel, then a postmortem.",
  entry: "triage", createdAt: 0, updatedAt: 0, revision: 3,
  agents: [
    wfAgent("triage", "Triage", "Decides severity and what to look at first", "readonly", 40, 150),
    wfAgent("investigator", "Reproducer", "Makes it happen on demand", "build", 330, 40),
    wfAgent("historian", "Historian", "Finds prior incidents like this one", "research", 330, 260),
    wfAgent("writer", "Postmortem", "Writes it up", "readonly", 620, 150),
  ],
  edges: [
    { from: "triage", to: "investigator", kind: "delegate", label: "reproduce it" },
    { from: "triage", to: "historian", kind: "delegate" },
    { from: "investigator", to: "writer", kind: "then" },
    { from: "historian", to: "writer", kind: "then" },
  ],
};

const hoursAgo = (h) => 1787000000000 - h * 3600_000;
const DETAIL = [
  { kind: "screen", screen: "workflow" },
  { kind: "detail", workflow: DETAIL_WF, problems: [], sessions: [
    { id: "s1", title: "Checkout 500s after the Tuesday deploy", when: hoursAgo(2) },
    { id: "s2", title: "Queue backlog during the migration", when: hoursAgo(30) },
    { id: "s3", title: "Intermittent auth timeouts in eu-west", when: hoursAgo(72) },
  ] },
];

const LIVE = [
  { kind: "screen", screen: "run" },
  roster(),
  { kind: "sendability", ok: true },
  { kind: "active", agents: ["researcher", "engineer"], edge: { from: "lead", to: "engineer" } },
  { kind: "userSaid", to: "lead", text: "Our ASR pipeline drops the last word on long audio. Fix it." },
  say("lead", "t1", "Two briefs going out together."),
  { kind: "assign", assignment: { id: "R-01", from: "lead", to: "researcher", brief: "Does CTC beam search truncate the final token?", startedAt: 0 } },
  { kind: "assign", assignment: { id: "E-01", from: "lead", to: "engineer", brief: "Reproduce it with a failing test.", startedAt: 0 } },
  say("engineer", "t2", "Reproduced — the tokenizer drops a trailing space."),
];

const shots = [
  { name: "team-floor", events: TEAM, width: 1180 },
  { name: "sidebar", events: TEAM, width: 420 },
  { name: "projects", events: PROJECTS, width: 420 },
  { name: "signed-out", events: AUTH, width: 420 },
  { name: "resumed", events: RESUMED, width: 1180 },
  { name: "home", events: HOME, width: 1180 },
  { name: "builder", events: BUILDER, width: 1180 },
  { name: "many", events: MANY, width: 1180 },
  { name: "detail", events: DETAIL, width: 1180 },
  { name: "live", events: LIVE, width: 1180 },
];

for (const shot of shots) {
  fs.writeFileSync(`.shots/${shot.name}.html`, page(shot.events, shot));
  console.log(`  ${shot.name}.html  ${shot.width}px`);
}

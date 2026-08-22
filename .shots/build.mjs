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
  document.title = "ready";
</script>
</body></html>`;

const roster = (over = {}) => ({
  kind: "roster",
  workspace: "…/pipeline",
  autonomy: "Standard — edits flow, risky commands ask",
  billing: "Claude subscription",
  connectors: [{ name: "kaggle", ok: true, status: "connected" }],
  members: [
    { id: "lead", name: "Lead", role: "Interrogates the brief, decides scope, delegates",
      model: "opus", effort: "high", status: "thinking", activity: "reading the report" },
    { id: "researcher", name: "Researcher", role: "Reads papers, docs and the web",
      model: "opus", effort: "high", status: "working", activity: "arxiv.org — CTC vs attention" },
    { id: "engineer", name: "Engineer", role: "Writes, edits and runs the code",
      model: "opus", effort: "xhigh", status: "working", activity: "pytest tests/test_decode.py" },
  ],
  ...over,
});

const say = (who, turn, text) => ({ kind: "say", who, turn, delta: text });

const TEAM = [
  { kind: "screen", screen: "team" },
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

const shots = [
  { name: "team-floor", events: TEAM, width: 1180 },
  { name: "sidebar", events: TEAM, width: 420 },
  { name: "projects", events: PROJECTS, width: 420 },
  { name: "signed-out", events: AUTH, width: 420 },
];

for (const shot of shots) {
  fs.writeFileSync(`.shots/${shot.name}.html`, page(shot.events, shot));
  console.log(`  ${shot.name}.html  ${shot.width}px`);
}

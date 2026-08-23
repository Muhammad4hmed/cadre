/**
 * The same webview, at the width people actually use it.
 *
 * verify-webview renders at 1180px, which is the full editor tab. The sidebar
 * is 300–450px, it is where most of this product is used, and below 760px the
 * board switches to a single merged lane — a different rendering path that
 * nothing exercised. The per-agent board went untested for months for the same
 * reason: the harness only ever produced one of the two layouts.
 *
 * Skips loudly rather than failing when Chrome is absent.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CHROME = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
  .find((bin) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0);

if (!CHROME) {
  console.log("=== sidebar ===");
  console.log("SKIP  no Chrome on this machine — the narrow layout was NOT exercised");
  process.exit(0);
}

const source = fs.readFileSync("src/extension.ts", "utf8");
const body = source.slice(source.indexOf('  <header class="bar">'), source.indexOf("  <script nonce="));
if (!body.includes("screen-builder")) throw new Error("markup extraction failed — anchors moved");
const css = fs.readFileSync("media/team.css", "utf8");
const js = fs.readFileSync("media/team.js", "utf8");

const DRIVER = String.raw`
const results = [];
const check = (label, ok) => results.push([label, ok]);
const send = (e) => window.dispatchEvent(new MessageEvent("message", { data: e }));

const members = ["lead", "researcher", "engineer"].map((id, i) => ({
  id, name: id[0].toUpperCase() + id.slice(1), role: "does " + id, preset: "build",
  model: "opus", effort: "high", status: "idle", entry: i === 0, x: i * 260, y: 0,
}));

send({ kind: "screen", screen: "run" });
send({ kind: "roster", workflowId: "w", workflowName: "Team", autonomy: "Standard",
  billing: "Subscription", workspace: "…/proj", connectors: [],
  edges: [{ from: "lead", to: "researcher", kind: "delegate" },
          { from: "lead", to: "engineer", kind: "delegate" }],
  members });

check("the narrow layout is the merged one, not a lane per agent",
  document.body.dataset.layout === "stream");
const merged = document.getElementById("stream-all");
check("there is one lane to write into", merged !== null);
check("...and no per-agent lanes were built", document.getElementById("stream-lead") === null);

// Everything from every agent has to land somewhere, or the sidebar shows
// nothing while the team is working.
send({ kind: "clear" });
for (const who of ["lead", "researcher", "engineer"]) {
  send({ kind: "say", who, turn: "t", delta: "output from " + who });
  send({ kind: "sayEnd", who, turn: "t" });
}
const text = () => document.getElementById("stream-all").textContent;
check("every agent's output reaches the merged lane",
  ["lead", "researcher", "engineer"].every((w) => text().includes("output from " + w)));
check("...and each is attributed, since the lane no longer says who is speaking",
  ["Lead", "Researcher", "Engineer"].every((n) => text().includes(n)));

// The things a sidebar user still has to be able to do.
const composer = document.querySelector(".composer");
check("the composer is present", composer !== null);
const input = document.getElementById("input");
check("...with somewhere to type", input !== null && input.offsetWidth > 120);
const channel = document.getElementById("channel");
check("...and the picker for who to talk to", channel !== null && channel.options.length === 3);

send({ kind: "sendability", ok: true });
const sendBtn = document.getElementById("send");
check("the send button is reachable, not pushed off the edge",
  sendBtn !== null && sendBtn.getBoundingClientRect().right <= document.body.clientWidth + 1);

// Nothing may spill sideways: a horizontally scrolling sidebar is unusable.
check("the page does not scroll sideways at this width",
  document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

// The header chips are the first thing squeezed out.
const bar = document.querySelector("header.bar");
check("the header stays inside the panel",
  bar !== null && bar.scrollWidth <= bar.clientWidth + 1);

// A delegation still has to read as one.
send({ kind: "assign", assignment: { id: "d", from: "lead", to: "researcher", brief: "look into it", startedAt: 0 } });
check("a delegation card appears in the merged lane", text().includes("look into it"));
send({ kind: "deliver", id: "d", outcome: "delivered", summary: "found it" });
check("...and its report lands on the same card", text().includes("delivered: found it"));

document.body.setAttribute("data-results", JSON.stringify(results));
document.body.setAttribute("data-noise", JSON.stringify(window.__noise || []));
`;

const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style>
<style>html,body{width:380px;height:900px;margin:0}</style></head><body>
${body.replace(/\$\{[^}]*\}/g, "")}
<script>
  window.__noise = [];
  window.addEventListener("error", (e) => window.__noise.push("error: " + (e.message || String(e.error))));
  window.addEventListener("unhandledrejection", (e) => window.__noise.push("rejection: " + String(e.reason)));
  const realErr = console.error.bind(console);
  console.error = (...a) => { window.__noise.push("console.error: " + a.map(String).join(" ")); realErr(...a); };
  window.__sent = [];
  window.acquireVsCodeApi = () => ({ postMessage(m) { window.__sent.push(m); }, getState() {}, setState() {} });
</script>
<script>${js}</script>
<script>
try { ${DRIVER} } catch (err) {
  window.__results = [["the sidebar driver threw: " + String(err && err.stack ? String(err.stack).split("\\n")[0] : err), false]];
  document.body.setAttribute("data-results", JSON.stringify(window.__results));
}
</script>
</body></html>`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadre-sidebar-"));
const file = path.join(dir, "page.html");
fs.writeFileSync(file, page);

const dom = execFileSync(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=20000",
   "--window-size=380,900", "--dump-dom", `file://${file}`],
  { encoding: "utf8", maxBuffer: 64_000_000 },
);

const decode = (s) =>
  s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const match = /data-results="([^"]*)"/.exec(dom);

console.log("=== sidebar ===");
if (!match) {
  console.log("FAIL  the page never reported results — it threw before assigning them");
  process.exit(1);
}
const results = JSON.parse(decode(match[1]));
const noiseMatch = /data-noise="([^"]*)"/.exec(dom);
const noise = noiseMatch ? JSON.parse(decode(noiseMatch[1])) : [];
results.push([
  noise.length ? `the page reported no errors of its own (${noise.slice(0, 3).join(" | ")})` : "the page reported no errors of its own",
  noise.length === 0,
]);

let failed = false;
for (const [label, ok] of results) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
if (!results.length) { console.log("FAIL  no assertions ran"); failed = true; }
process.exit(failed ? 1 : 0);

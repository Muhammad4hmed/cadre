/**
 * Runs the REAL webview — media/team.js and media/team.css, and the markup
 * extracted from src/extension.ts — in headless Chrome, and drives it.
 *
 * Everything the builder does with its own state lives here and nowhere else:
 * the undo stack, the Advanced panel staying open, the autosave timer, and the
 * rule that a background event must not overwrite an unsaved draft. verify-ui
 * drives the extension host against a stub `vscode` and never executes this
 * file, so none of it was covered.
 *
 * Skips loudly rather than failing when Chrome is absent, so a CI runner
 * without a browser does not turn red for the wrong reason.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CHROME = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
  .find((bin) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0);

if (!CHROME) {
  console.log("=== webview ===");
  console.log("SKIP  no Chrome on this machine — the builder's own logic was NOT exercised");
  process.exit(0);
}

const source = fs.readFileSync("src/extension.ts", "utf8");
const body = source.slice(
  source.indexOf('  <header class="bar">'),
  source.indexOf("  <script nonce="),
);
if (!body.includes("screen-builder")) throw new Error("markup extraction failed — anchors moved");

const css = fs.readFileSync("media/team.css", "utf8");
const js = fs.readFileSync("media/team.js", "utf8");

/**
 * The scenario, run inside the page. Returns [label, ok] pairs.
 *
 * String.raw, because this is JavaScript inside a template literal: without it
 * every backslash in a regex is eaten before the browser ever sees it, and a
 * pattern like /a\.b/ silently becomes /a.b/ — which matches, so the test
 * passes and proves nothing.
 */
const DRIVER = String.raw`
const results = [];
window.__partial = results;
const check = (label, ok) => results.push([label, Boolean(ok)]);
const send = (e) => window.dispatchEvent(new MessageEvent("message", { data: e }));
const sent = window.__sent;

const workflow = () => ({
  id: "wf", name: "Test", entry: "a", createdAt: 0, updatedAt: 1700000000000, revision: 1,
  agents: [
    { id: "a", name: "Alpha", role: "", prompt: "does a", preset: "readonly", x: 40, y: 40 },
    { id: "b", name: "Beta", role: "", prompt: "does b", preset: "build", x: 300, y: 40 },
  ],
  edges: [{ from: "a", to: "b", kind: "delegate" }],
});

const editing = (over = {}) => ({
  kind: "editing", workflow: workflow(), authoritative: true, problems: [],
  presets: [
    { id: "readonly", name: "Read-only", blurb: "reads" },
    { id: "build", name: "Build", blurb: "builds" },
  ],
  catalogue: [{ group: "Running", tools: [{ name: "Bash", blurb: "shell" }] }],
  skills: [
    { name: "code-review", description: "Review the current diff for correctness bugs" },
    { name: "loop", description: "Run a prompt on a recurring interval" },
  ],
  connectors: ["sentry"],
  models: [
    { value: "opus[1m]", label: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { value: "claude-fable-5[1m]", label: "Fable", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { value: "haiku", label: "Haiku", efforts: [] },
  ],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  ...over,
});

send({ kind: "screen", screen: "builder" });
send(editing());

const canvas = document.getElementById("canvas");
const nodes = () => [...canvas.querySelectorAll(".agent-node")];
check("the builder draws a node per agent", nodes().length === 2);

// ---- dragging a node, and letting go somewhere it cannot see --------------
// The drag listens on window for pointermove and pointerup and removes both on
// release. But pointerup only arrives if the pointer is released over the
// webview. Let go outside the panel, over the editor or off the window, and the
// release is never seen: the node goes on following the cursor with no button
// held, and the only way out is to click again. Every click and no drag was
// tested before this.
{
  const nodeAt = () => {
    const n = nodes()[0];
    return { x: Math.round(n.getBoundingClientRect().left), y: Math.round(n.getBoundingClientRect().top) };
  };
  const before = nodeAt();

  nodes()[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 60, clientY: 60, buttons: 1 }));
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 160, clientY: 130, buttons: 1 }));
  const dragged = nodeAt();
  check("a node follows the pointer while the button is held",
    dragged.x !== before.x || dragged.y !== before.y);

  // The release happened somewhere this document never hears about. The next
  // movement carries no buttons, which is the only evidence there is.
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 200, clientY: 200, buttons: 0 }));
  const settled = nodeAt();
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 400, clientY: 380, buttons: 0 }));
  const after = nodeAt();
  check("letting go outside the panel ends the drag rather than sticking the node to the cursor",
    after.x === settled.x && after.y === settled.y);

  // A cancelled pointer, which is what a touch drag interrupted by the system
  // sends instead of a pointerup, has to end it too.
  nodes()[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 60, clientY: 60, buttons: 1 }));
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 120, clientY: 120, buttons: 1 }));
  window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
  const cancelled = nodeAt();
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 500, clientY: 460, buttons: 1 }));
  check("a cancelled pointer ends the drag too",
    nodeAt().x === cancelled.x && nodeAt().y === cancelled.y);

  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 60, clientY: 60 }));

  // Dragging an arrow out of a port has exactly the same problem: a ghost wire
  // trailing the cursor with nothing holding it.
  // The real port, not a fallback: a fallback to .agent-node starts a node drag
  // and creates no ghost, so the check would pass without testing anything.
  const port = canvas.querySelector(".port.out");
  const ghosts = () => document.getElementById("wires").querySelectorAll(".wire.ghost").length;
  check("the canvas has an arrow port to drag from", port !== null);
  if (port) {
    port.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 70, clientY: 70, buttons: 1 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 200, clientY: 150, buttons: 1 }));
    check("dragging from a port draws an arrow that follows the pointer", ghosts() === 1);
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 260, clientY: 190, buttons: 0 }));
    check("an arrow let go outside the panel does not trail the cursor", ghosts() === 0);
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 260, clientY: 190 }));
  }
}

// ---- selecting an agent, then opening Advanced ----------------------------
nodes()[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 50 }));
window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 50, clientY: 50 }));
const inspector = document.getElementById("inspector");
check("clicking an agent opens the inspector", inspector.hidden === false);

const details = () => inspector.querySelector("details.advanced");
check("the Advanced panel exists", Boolean(details()));
check("...and starts closed", details().open === false);

details().open = true;
details().dispatchEvent(new Event("toggle"));

// Ticking a tool re-renders the inspector. It must not close the panel.
const tick = [...inspector.querySelectorAll(".tool-row input[type=checkbox]")].pop();
tick.checked = true;
tick.dispatchEvent(new Event("change"));
check("changing a setting keeps Advanced open", details() && details().open === true);

// A preset radio re-renders too, via a different path.
const radio = inspector.querySelector(".preset-row input[type=radio]");
radio.checked = true;
radio.dispatchEvent(new Event("change"));
check("choosing a preset also keeps Advanced open", details() && details().open === true);

// ---- undo ------------------------------------------------------------------
const nameField = inspector.querySelector(".field input");
nameField.value = "Renamed";
nameField.dispatchEvent(new Event("input"));
nameField.dispatchEvent(new Event("change"));
check("renaming reaches the canvas",
  nodes().some((n) => n.textContent.includes("Renamed")));

const press = (key, shift = false) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: shift, bubbles: true }));

document.body.focus();
press("z");
check("undo reverts the rename", nodes().some((n) => n.textContent.includes("Alpha")));
press("z", true);
check("redo reapplies it", nodes().some((n) => n.textContent.includes("Renamed")));
press("y");
check("redo past the end is harmless", nodes().length === 2);

// Undo must walk back more than one step.
press("z");
press("z");
check("undo past the first change stops cleanly", nodes().length === 2);

// ---- undo must not steal Ctrl+Z from a text field --------------------------
const prompt = inspector.querySelector(".field textarea");
prompt.focus();
const before = nodes().map((n) => n.textContent).join("|");
prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
check("Ctrl+Z inside a text box is left to the text box",
  nodes().map((n) => n.textContent).join("|") === before);
document.body.focus();

// ---- deleting an arrow, then undoing it ------------------------------------
const wire = document.querySelector(".wire-hit");
wire.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const editor = document.querySelector(".edge-editor");
check("clicking an arrow opens its editor", Boolean(editor));
[...editor.querySelectorAll("button")].find((b) => /Delete this arrow/.test(b.textContent)).click();
const wiresAfter = document.querySelectorAll(".wire-hit").length;
check("deleting the arrow removes it", wiresAfter === 0);
press("z");
check("undo brings the arrow back", document.querySelectorAll(".wire-hit").length === 1);

// ---- an unsaved draft must survive a background refresh --------------------
sent.length = 0;
const stale = editing({ authoritative: false });
stale.workflow.agents[0].name = "FromDisk";
send(stale);
check("a non-authoritative event does not overwrite the local draft",
  !nodes().some((n) => n.textContent.includes("FromDisk")));

const fresh = editing({ authoritative: true });
fresh.workflow.agents[0].name = "Reopened";
send(fresh);
check("an authoritative event does replace it",
  nodes().some((n) => n.textContent.includes("Reopened")));
check("...and it resets undo, so you cannot undo into another workflow",
  (press("z"), !nodes().some((n) => n.textContent.includes("Renamed"))));

// ---- autosave ----------------------------------------------------------------
const savedChip = document.getElementById("builder-saved");
check("a freshly opened workflow reads as saved", savedChip.dataset.state === "saved");

nodes()[1].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 320, clientY: 60 }));
window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 320, clientY: 60 }));
const beta = inspector.querySelector(".field input");
beta.value = "Beta 2";
beta.dispatchEvent(new Event("change"));
check("an edit marks the workflow unsaved", savedChip.dataset.state === "dirty");

sent.length = 0;
// Dispatching the event is not enough: the handler reads visibilityState, and
// in a headless render the document is always visible.
Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
document.dispatchEvent(new Event("visibilitychange"));
const auto = sent.find((m) => m.kind === "saveWorkflow" && m.auto === true);
check("hiding the view flushes an autosave", Boolean(auto));
check("the autosave carries the edited draft",
  auto && auto.workflow.agents.some((a) => a.name === "Beta 2"));

send({ kind: "saved", workflowId: "wf", at: 1700000600000, auto: true });
check("a save acknowledgement clears the unsaved marker", savedChip.dataset.state === "saved");
check("...and says when", /saved \d\d:\d\d/.test(savedChip.textContent));

// Leaving must not lose work either.
beta.value = "Beta 3";
beta.dispatchEvent(new Event("change"));
sent.length = 0;
document.getElementById("builder-back").click();
check("leaving the builder flushes an autosave first",
  sent.some((m) => m.kind === "saveWorkflow" && m.auto === true));
check("...before it navigates away",
  sent.findIndex((m) => m.kind === "saveWorkflow") < sent.findIndex((m) => m.kind === "goHome"));

// ---- the model picker follows what the CLI reported --------------------------
// Model ids are the CLI's, not the API's, and not every model takes an effort
// level — a hardcoded list gets both wrong.
nodes()[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 50 }));
window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 50, clientY: 50 }));
// Re-queried every time: changing a setting re-renders the inspector, so a
// handle held across a change points at a detached node.
const adv = () => inspector.querySelector("details.advanced");
adv().open = true;
adv().dispatchEvent(new Event("toggle"));

const selects = () => [...adv().querySelectorAll("select")];
const modelSel = () => selects()[0];
const optionValues = () => [...modelSel().options].map((o) => o.value);

check("every model the CLI reported is offered",
  optionValues().includes("opus[1m]") && optionValues().includes("haiku"));
check("Fable is in the list", optionValues().includes("claude-fable-5[1m]"));
check("the option shows the friendly name and the id it will send",
  [...modelSel().options].some((o) => o.textContent === "Fable — claude-fable-5[1m]"));
check("a model with effort levels gets an effort control", selects().length === 2);

modelSel().value = "haiku";
modelSel().dispatchEvent(new Event("change"));
check("choosing a model that takes no effort removes the effort control",
  selects().length === 1);
check("...and says why rather than silently dropping it",
  adv().textContent.includes("does not take an effort level"));

modelSel().value = "claude-fable-5[1m]";
modelSel().dispatchEvent(new Event("change"));
check("switching back to a model with effort brings the control back",
  selects().length === 2);

// A model saved before it vanished from the CLI's list must still be visible,
// or opening the panel would silently change what the agent runs on.
const orphaned = editing({ authoritative: true });
orphaned.workflow.agents[0].model = "claude-retired-9";
send(orphaned);
nodes()[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 50 }));
window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 50, clientY: 50 }));
adv().open = true;
check("a model the CLI no longer offers is still shown, not silently reset",
  adv().querySelector("select").value === "claude-retired-9");
check("...and is marked as unavailable",
  adv().querySelector("select").textContent.includes("not offered by this CLI"));

// ---- launching ------------------------------------------------------------------
// Launching a template used to re-refine its already-written prompts: three
// paid round trips during which the button looked dead.
const longPrompt = "word ".repeat(300).trim();
const written = editing({ authoritative: true });
written.workflow.agents.forEach((a) => { a.prompt = longPrompt; });
send({ kind: "screen", screen: "builder" });
send(written);

sent.length = 0;
document.getElementById("builder-launch").click();
check("a workflow whose prompts are already written launches straight away",
  sent.some((m) => m.kind === "saveWorkflow" && m.launch === true));
check("...without refining anything", !sent.some((m) => m.kind === "refinePrompt"));

// A one-line prompt is exactly what refinement is for.
const jotted = editing({ authoritative: true });
jotted.workflow.agents.forEach((a) => { a.prompt = "does the thing"; });
send(jotted);
sent.length = 0;
document.getElementById("builder-launch").click();
check("a jotted-down prompt is refined before launching",
  sent.some((m) => m.kind === "refinePrompt"));
check("...and the launch waits for it",
  !sent.some((m) => m.kind === "saveWorkflow"));
check("the button says it is working", document.getElementById("builder-launch").disabled === true);

// Clicking again mid-launch used to start a second one, racing to save.
const beforeSecond = sent.filter((m) => m.kind === "refinePrompt").length;
document.getElementById("builder-launch").click();
check("clicking Launch again while it is launching does nothing",
  sent.filter((m) => m.kind === "refinePrompt").length === beforeSecond);

// A refinement that fails must not be retried forever — each retry is a real
// model call, and the old code picked the same agent every pass.
const failing = sent.find((m) => m.kind === "refinePrompt");
sent.length = 0;
send({ kind: "refined", agent: failing.agent.id, prompt: "", note: "Could not refine." });
const retried = sent.filter((m) => m.kind === "refinePrompt" && m.agent.id === failing.agent.id);
check("a failed refinement is not retried on the same agent", retried.length === 0);
check("...and the launch carries on to the other agents rather than stalling",
  sent.some((m) => m.kind === "refinePrompt" || m.kind === "saveWorkflow"));

// ---- the live map must be findable ----------------------------------------------
send({ kind: "screen", screen: "run" });
send({ kind: "roster", workflowId: "a", workflowName: "AI News Daily", autonomy: "", billing: "",
  workspace: "demo", connectors: [], edges: [],
  members: [
    { id: "one", name: "One", role: "", preset: "readonly", model: "opus", effort: "high",
      status: "idle", entry: true, x: 0, y: 0 },
    { id: "two", name: "Two", role: "", preset: "build", model: "opus", effort: "high",
      status: "idle", entry: false, x: 300, y: 0 },
  ] });

const livemap = document.getElementById("livemap");
check("the map is open by default rather than a hairline nobody clicks",
  livemap.open === true);
check("its header says what it is", document.getElementById("livemap-title").textContent === "AI News Daily");
check("...and how many agents there are",
  document.getElementById("livemap-hint").textContent === "2 agents");
check("it carries a visible show/hide control",
  document.getElementById("livemap-toggle").textContent === "Hide");

livemap.open = false;
livemap.dispatchEvent(new Event("toggle"));
check("collapsing it flips the control to Show",
  document.getElementById("livemap-toggle").textContent === "Show");

// ---- who you are talking to -----------------------------------------------------
const channel = document.getElementById("channel");
check("the picker lists every agent", channel.options.length === 2);
check("it is usable as soon as the workflow is open", channel.disabled === false);

send({ kind: "busy", busy: true });
check("it stays usable during a run — that is when you look at it",
  channel.disabled === false);
check("...and warns that switching now stops the run",
  /stop the current run/.test(channel.title));

sent.length = 0;
channel.value = "two";
channel.dispatchEvent(new Event("change"));
check("choosing another agent asks the host to switch",
  sent.some((m) => m.kind === "setChannel" && m.to === "two"));

// The host refuses or the user declines: the dropdown must not lie about who
// it is talking to.
send({ kind: "channel", to: "one" });
check("a declined switch snaps the dropdown back", channel.value === "one");

send({ kind: "busy", busy: false });
send({ kind: "roster", workflowId: "solo", workflowName: "Solo", autonomy: "", billing: "",
  workspace: "demo", connectors: [], edges: [],
  members: [{ id: "only", name: "Only", role: "", preset: "full", model: "opus", effort: "high",
    status: "idle", entry: true, x: 0, y: 0 }] });
check("with one agent there is nothing to choose, so it is disabled",
  document.getElementById("channel").disabled === true);
check("...and says why", /one agent/.test(document.getElementById("channel").title));

// ---- skills come from the CLI, not from a setting -------------------------------
const skillRows = [...adv().querySelectorAll(".multi")]
  .find((m) => m.textContent.startsWith("Skills"));
check("the skills the CLI reported are offered",
  skillRows && /\/code-review/.test(skillRows.textContent));
check("...with what each one does", /Review the current diff/.test(skillRows.textContent));
check("the ones that cannot run here say so, before an agent discovers it mid-run",
  /cannot run here/.test(skillRows.textContent) && /\/loop/.test(skillRows.textContent));

// ---- build with Claude ---------------------------------------------------------
send({ kind: "screen", screen: "home" });
send({ kind: "workflows", project: "demo", items: [], templates: [] });

const buildCard = document.getElementById("build-card");
check("the build panel is hidden until asked for", buildCard.hidden === true);
document.getElementById("home-build").click();
check("the Build with Claude button opens it", buildCard.hidden === false);

sent.length = 0;
document.getElementById("build-go").click();
check("building with nothing typed asks for a description rather than calling out",
  !sent.some((m) => m.kind === "buildWorkflow") &&
  document.getElementById("build-note").textContent.length > 0);

document.getElementById("build-input").value = "Read tickets, reproduce the bugs, draft replies.";
sent.length = 0;
document.getElementById("build-go").click();
const asked = sent.find((m) => m.kind === "buildWorkflow");
check("a described pipeline is sent to be designed", Boolean(asked));
check("...with what was typed", asked && /reproduce the bugs/.test(asked.description));

send({ kind: "building", busy: true, note: "Designing the workflow…" });
check("the button reports that it is working",
  document.getElementById("build-go").disabled === true &&
  document.getElementById("build-go").textContent === "Designing…");
send({ kind: "building", busy: false, note: "Built 3 agents, 2 arrows." });
check("and comes back when it is done",
  document.getElementById("build-go").disabled === false);
check("...saying what it built",
  document.getElementById("build-note").textContent.includes("3 agents"));

// ---- home, split by where a workflow lives ---------------------------------
send({ kind: "screen", screen: "home" });
send({ kind: "workflows", project: "demo", items: [
  { id: "a", name: "Local one", scope: "local", agents: 2, edges: 1, updatedAt: 0, sessions: 0, agentNames: ["A", "B"], problems: 0 },
  { id: "b", name: "Shared one", scope: "global", agents: 3, edges: 2, updatedAt: 0, sessions: 4, agentNames: ["C", "D", "E"], problems: 0 },
], templates: [
  { id: "t1", name: "A template", description: "does things", agents: ["One"] },
] });

const home = document.getElementById("workflow-list");
const headings = [...home.querySelectorAll(".wf-section h2")].map((h) => h.textContent);
check("the home screen separates project workflows from global ones",
  headings.includes("This project") && headings.includes("Everywhere"));
check("a global workflow is badged as such",
  [...home.querySelectorAll(".workflow-card")].some((c) =>
    c.textContent.includes("Shared one") && c.textContent.includes("everywhere")));
check("templates are listed too",
  document.getElementById("template-list").textContent.includes("A template"));

sent.length = 0;
[...home.querySelectorAll(".wf-open")][0].click();
check("clicking a workflow opens its page rather than a chat",
  sent.some((m) => m.kind === "showWorkflow" && m.id === "a"));

sent.length = 0;
[...home.querySelectorAll(".wf-actions button")].find((b) => b.textContent === "Globalise").click();
check("a project workflow offers to be made global",
  sent.some((m) => m.kind === "moveWorkflow" && m.to === "global"));

// ---- the workflow's own page -------------------------------------------------
const detailWf = {
  id: "a", name: "Local one", scope: "local", description: "a description",
  entry: "one", createdAt: 0, updatedAt: 0, revision: 1,
  agents: [
    { id: "one", name: "One", role: "first", prompt: "p", preset: "readonly", x: 0, y: 0 },
    { id: "two", name: "Two", role: "second", prompt: "p", preset: "build", x: 300, y: 0 },
  ],
  edges: [{ from: "one", to: "two", kind: "delegate" }],
};
send({ kind: "screen", screen: "workflow" });
send({ kind: "detail", workflow: detailWf, problems: [], sessions: [
  { id: "s1", title: "Checkout 500s after the deploy", when: 1 },
  { id: "s2", title: "Queue backlog", when: 2 },
] });

check("the page names the workflow",
  document.getElementById("detail-name").textContent === "Local one");
check("it lists the conversations",
  document.getElementById("detail-sessions").querySelectorAll(".session").length === 2);
check("...with the names Claude gave them",
  document.getElementById("detail-sessions").textContent.includes("Checkout 500s after the deploy"));
check("it draws the graph", document.querySelectorAll("#detail-map .map-node").length === 2);
check("the scope control says where it lives",
  document.getElementById("detail-scope").textContent === "This project");

sent.length = 0;
document.getElementById("detail-start").click();
check("starting a conversation asks for a fresh session",
  sent.some((m) => m.kind === "startSession" && m.id === "a"));

send({ kind: "detail", workflow: { ...detailWf, entry: "" }, sessions: [],
       problems: [{ level: "error", message: "No entry agent is set" }] });
check("a broken workflow cannot be started from its page",
  document.getElementById("detail-start").disabled === true);
check("...and says why", document.getElementById("detail-problems").textContent.includes("entry agent"));
check("an empty history says so rather than showing nothing",
  document.getElementById("detail-sessions").textContent.includes("No conversations yet"));

// ---- the live map ------------------------------------------------------------
send({ kind: "screen", screen: "run" });
send({ kind: "roster", workflowId: "a", workflowName: "Local one", autonomy: "", billing: "",
  workspace: "demo", connectors: [],
  edges: [{ from: "one", to: "two", kind: "delegate" }],
  members: [
    { id: "one", name: "One", role: "first", preset: "readonly", model: "opus", effort: "high",
      status: "idle", entry: true, x: 0, y: 0 },
    { id: "two", name: "Two", role: "second", preset: "build", model: "opus", effort: "high",
      status: "idle", entry: false, x: 300, y: 0 },
  ] });

const map = () => document.getElementById("run-map");
check("the run view draws the workflow", map().querySelectorAll(".map-node").length === 2);
check("it uses the positions from the graph, not a made-up row",
  map().querySelector(".map-box").getAttribute("x") === "0");

send({ kind: "active", agents: ["two"], edge: { from: "one", to: "two" } });
check("the working agent is highlighted",
  map().querySelectorAll(".map-node.active").length === 1);
check("...and it is the right one",
  (map().querySelector(".map-node.active")?.textContent ?? "").includes("Two"));
check("the arrow carrying the work is marked live",
  map().querySelectorAll(".wire.live").length === 1);
check("the header says how many of how many are working",
  document.getElementById("livemap-hint").textContent === "1 of 2 working");

send({ kind: "status", who: "two", status: "working", activity: "pytest -x" });
check("the map shows what an agent is doing, not its job title",
  (map().textContent ?? "").includes("pytest -x"));

send({ kind: "active", agents: [], edge: undefined });
check("when nothing is running nothing is highlighted",
  map().querySelectorAll(".map-node.active").length === 0 &&
  map().querySelectorAll(".wire.live").length === 0);

// ---- resting versus working -------------------------------------------------
// A picture where everything is coloured says the same as one where nothing is.
send({ kind: "active", agents: [], edge: undefined });
check("with nothing running, nothing is dimmed",
  map().querySelectorAll(".map-node.resting").length === 0);
check("...and no arrow is in motion", map().querySelectorAll(".wire.live").length === 0);

send({ kind: "active", agents: ["two"], edge: undefined });
check("the working agent is highlighted", map().querySelectorAll(".map-node.active").length === 1);
check("the ones waiting recede", map().querySelectorAll(".map-node.resting").length === 1);
check("an arrow into a working agent moves, even without the runner naming it",
  map().querySelectorAll(".wire.live").length === 1);
check("arrows not carrying work stay grey",
  [...map().querySelectorAll(".wire")].every((w) =>
    w.classList.contains("live") || w.classList.contains("idle")));

// ---- the separator ----------------------------------------------------------
// An earlier check collapsed the map; reopen it, since the separator only
// applies when there is something to resize.
livemap.open = true;
livemap.dispatchEvent(new Event("toggle"));

const splitter = document.getElementById("splitter");
const runMap = document.getElementById("run-map");
check("there is a separator between the map and the board", Boolean(splitter));
check("it is visible while the map is open", splitter.hidden === false);
check("it announces itself to a screen reader",
  splitter.getAttribute("role") === "separator");

// Dragging it, and letting go where this document cannot see the release. The
// handle takes pointer capture, which usually keeps the events coming, but
// capture can be refused or taken away and there was nothing to end the drag if
// it was: the map would go on resizing under a pointer nobody was pressing.
{
  const heightNow = () => runMap.getBoundingClientRect().height;
  const initial = heightNow();
  splitter.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientY: 300, buttons: 1 }));
  check("dragging the separator marks it as being dragged", splitter.dataset.dragging === "true");
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 360, buttons: 1 }));
  check("...and the map follows the pointer", heightNow() !== initial);

  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 400, buttons: 0 }));
  check("letting go out of sight ends the drag", splitter.dataset.dragging === undefined);
  const settled = heightNow();
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 500, buttons: 0 }));
  check("...and the map stops resizing under an unpressed pointer", heightNow() === settled);

  // Losing capture has to end it too.
  splitter.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientY: 300, buttons: 1 }));
  splitter.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true }));
  check("losing pointer capture ends the drag", splitter.dataset.dragging === undefined);
  const afterLoss = heightNow();
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 560, buttons: 1 }));
  check("...and nothing keeps resizing afterwards", heightNow() === afterLoss);
}

const startHeight = runMap.style.height;
splitter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
check("it can be resized from the keyboard, not only by dragging",
  runMap.style.height !== startHeight);
const grown = parseInt(runMap.style.height, 10);
splitter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
check("...in both directions", parseInt(runMap.style.height, 10) < grown);

for (let i = 0; i < 40; i += 1) {
  splitter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true }));
}
check("it cannot be shrunk to nothing", parseInt(runMap.style.height, 10) >= 110);
for (let i = 0; i < 80; i += 1) {
  splitter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
}
check("...nor grown until the board disappears",
  parseInt(runMap.style.height, 10) <= Math.round(document.body.clientHeight * 0.6));

splitter.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
check("double-clicking resets it", runMap.style.height === "210px");

livemap.open = false;
livemap.dispatchEvent(new Event("toggle"));
check("collapsing the map hides the separator with it", splitter.hidden === true);
livemap.open = true;
livemap.dispatchEvent(new Event("toggle"));

// ---- markdown in a lane ----------------------------------------------------
// Agents write headed sections, bullets and tables. Only bold and inline code
// used to render; everything else arrived as literal punctuation.
send({ kind: "screen", screen: "run" });
send({ kind: "clear" });
send({ kind: "say", who: "one", turn: "md", delta: [
  "### Why it was not posted",
  "",
  "There is **no destination** configured. I checked \`.cadre/workflows/x.json\`.",
  "",
  "- verified every URL",
  "- no leaked *Markdown* syntax",
  "",
  "1. first",
  "2. second",
  "",
  "> a quoted caveat",
  "",
  "| item | state |",
  "|---|---|",
  "| pdf | built |",
  "",
  "See [the docs](https://example.com/docs) or https://example.com/raw",
].join("\n") });
send({ kind: "sayEnd", who: "one", turn: "md" });

const rendered = document.querySelector(".stream .body") || document.querySelector(".body");
const html = rendered ? rendered.innerHTML : "";
check("a heading renders as a heading, not as hashes", /<h5>Why it was not posted<\/h5>/.test(html));
check("bullets render as a list", /<ul><li>verified every URL<\/li>/.test(html));
check("a numbered list renders as one", /<ol><li>first<\/li>/.test(html));
check("bold still works", /<strong>no destination<\/strong>/.test(html));
check("italics work now too", /<em>Markdown<\/em>/.test(html));
check("inline code survives", /<code>\.cadre\/workflows\/x\.json<\/code>/.test(html));
check("a quote renders as one", /<blockquote>a quoted caveat<\/blockquote>/.test(html));
check("a table renders as a table", /<table>[\s\S]*<td>built<\/td>/.test(html));
check("a link is a link", /<a href="https:\/\/example\.com\/docs"/.test(html));
check("a pasted URL becomes one too", /<a href="https:\/\/example\.com\/raw"/.test(html));
check("no raw markdown punctuation is left behind", !/###|\*\*/.test(rendered ? rendered.textContent : "x**"));

// Escaping must survive all of it.
send({ kind: "clear" });
send({ kind: "say", who: "one", turn: "x", delta: "<img src=x onerror=alert(1)> and \`a**b**c\`" });
const danger = document.querySelector(".body");
check("html in a message is escaped, not executed",
  danger.querySelector("img") === null && danger.textContent.includes("<img"));
check("emphasis does not reach inside a code span",
  /<code>a\*\*b\*\*c<\/code>/.test(danger.innerHTML));

// A link's href and title are built as attributes out of agent text, and a URL
// containing a quote is one the link pattern happily matches. Unescaped, the
// quote closes the attribute and the rest of the URL becomes markup — an
// on-handler, an autofocus, a style covering the panel. The content security
// policy refuses to run an inline handler, so this is not a live script
// injection; it is one CSP change away from being one, and it is malformed
// markup either way. The assertion is about the markup, not about what the
// browser chose to execute.
const injections = [
  ["a link", '[click](https://x.com/"onmouseover="alert(1))', 'https://x.com/"onmouseover="alert(1'],
  ["a pasted URL", 'see https://x.com/"onfocus="alert(1)"autofocus="x', 'https://x.com/"onfocus="alert'],
  ["a table cell", '| a |\n|---|\n| [x](https://a/"onclick="1) |', 'https://a/"onclick="1'],
  ["a single-quoted break", "[a](https://x.com/'onmouseover='alert(1))", "https://x.com/'onmouseover='alert(1"],
];
for (const [label, payload, expectedHref] of injections) {
  send({ kind: "clear" });
  send({ kind: "say", who: "one", turn: "inj", delta: payload });
  send({ kind: "sayEnd", who: "one", turn: "inj" });
  const body = document.querySelector(".body");
  const anchors = [...body.querySelectorAll("a")];
  const attrs = anchors.flatMap((a) => [...a.attributes].map((at) => at.name.toLowerCase()));

  check(label + " cannot smuggle an attribute past the href",
    anchors.length > 0 && attrs.every((n) => n === "href" || n === "title" || n === "class"));
  check("...and " + label + " leaves no event handler anywhere in the lane",
    !/\son[a-z]+\s*=/i.test(body.innerHTML));
  // The quote must end up *inside* the href rather than terminating it, which
  // is the difference between an escaped URL and a broken tag.
  check("...and " + label + " keeps the quote inside the href",
    anchors.some((a) => a.getAttribute("href") === expectedHref));
}

// The escaping must not have broken ordinary punctuation, which is far more
// common than an attack.
send({ kind: "clear" });
send({ kind: "say", who: "one", turn: "q",
  delta: 'He said "hello" and it\'s the agent\'s job. See [docs](https://example.com/a?b=1&c=2)' });
send({ kind: "sayEnd", who: "one", turn: "q" });
{
  const body = document.querySelector(".body");
  check("straight quotes still render as quotes", body.textContent.includes('"hello"'));
  check("an apostrophe still renders as one", body.textContent.includes("it's the agent's job"));
  const link = body.querySelector("a");
  check("a query string with an ampersand survives escaping",
    link !== null && link.getAttribute("href") === "https://example.com/a?b=1&c=2");
}

// ---- the run footer and the compaction notice reach a lane at all ---------
// These were placed in a lane hardcoded as "lead" — a leftover from the fixed
// Lead/Researcher/Engineer roster this used to be. place() returns silently
// when the lane does not exist, and after the generalisation no template has an
// agent slugged "lead", so the per-run cost card and the "history was
// summarised" notice were both dropped on the floor for every real workflow.
send({ kind: "screen", screen: "run" });
send({ kind: "roster", workflowId: "z", workflowName: "No Lead Here", autonomy: "", billing: "",
  workspace: "demo", connectors: [], edges: [],
  members: [
    { id: "alpha", name: "Alpha", role: "", preset: "readonly", model: "opus", effort: "high",
      status: "idle", entry: true, x: 0, y: 0 },
    { id: "beta", name: "Beta", role: "", preset: "build", model: "opus", effort: "high",
      status: "idle", entry: false, x: 300, y: 0 },
  ] });
send({ kind: "clear" });
send({ kind: "spend", usd: 0.1234, totalUsd: 0.5, turns: 7, durationMs: 4500 });
send({ kind: "compacted", before: 190000, after: 40000 });
send({ kind: "notice", level: "info", text: "a notice with no agent named" });
{
  const board = document.getElementById("floor") || document.body;
  const text = board.textContent;
  check("the run's cost card is not dropped on the floor", /7 turns/.test(text));
  check("...and reports what the run cost", /0\.1234/.test(text));
  check("the compaction notice is not dropped either", /history was summarised/.test(text));
  check("a notice with no agent named still reaches a lane",
    /a notice with no agent named/.test(text));

  // Specifically the entry agent's lane, since that is who the user is talking
  // to and where they are looking.
  const entryLane = document.getElementById("stream-alpha") || document.getElementById("stream-all");
  check("...and they land in the entry agent's lane",
    entryLane !== null && /7 turns/.test(entryLane.textContent)
    && /history was summarised/.test(entryLane.textContent));
}

// A compaction sits in the replay log, so it is re-rendered every time the
// board is rebuilt. When it threw, the loop aborted and every event after it
// went unrendered — the lane went blank from the compaction onwards, and only
// for users whose context had filled.
send({ kind: "say", who: "alpha", turn: "post", delta: "work after the compaction" });
send({ kind: "sayEnd", who: "alpha", turn: "post" });
send({ kind: "roster", workflowId: "z", workflowName: "No Lead Here", autonomy: "", billing: "",
  workspace: "demo", connectors: [], edges: [],
  members: [
    { id: "alpha", name: "Alpha", role: "", preset: "readonly", model: "opus", effort: "high",
      status: "idle", entry: true, x: 0, y: 0 },
    { id: "beta", name: "Beta", role: "", preset: "build", model: "opus", effort: "high",
      status: "idle", entry: false, x: 300, y: 0 },
    { id: "gamma", name: "Gamma", role: "", preset: "build", model: "opus", effort: "high",
      status: "idle", entry: false, x: 600, y: 0 },
  ] });
{
  const board = (document.getElementById("floor") || document.body).textContent;
  check("a rebuild replays the compaction notice", /history was summarised/.test(board));
  check("...and everything that came after it", /work after the compaction/.test(board));
  check("...with the token counts formatted for reading", /190K/.test(board));
}

// The header total is a session figure, not the last run's — the spend cap it
// is measured against applies to the whole session, and a teammate's cost is
// part of it.
send({ kind: "spend", usd: 0.1, totalUsd: 0.6, turns: 1, durationMs: 100 });
check("the header shows the session total, not just the last run",
  document.getElementById("spend").textContent === "$0.6000");

// ---- the empty board explains itself ---------------------------------------
// The placeholder was pinned to a lane called "lead" and named the Researcher
// and the Engineer. Two of fourteen templates have an agent slugged "lead";
// everywhere else it was placed into a lane that does not exist and dropped,
// leaving a blank board with nothing to explain it.
send({ kind: "clear" });
{
  const board = (document.getElementById("floor") || document.body).textContent;
  check("an empty board says what to do", /Describe the work to Alpha/.test(board));
  check("...and names the teammates that actually exist", /Beta/.test(board));
  check("...and not agents from a roster this workflow does not have",
    !/Researcher|Engineer|the Lead/.test(board));
  const entryLane = document.getElementById("stream-alpha") || document.getElementById("stream-all");
  check("...in the entry agent's lane",
    entryLane !== null && /Describe the work to Alpha/.test(entryLane.textContent));
}

// A one-agent workflow has nobody to put to work, and saying otherwise is a
// small lie the user can see through immediately.
send({ kind: "roster", workflowId: "solo", workflowName: "Solo", autonomy: "", billing: "",
  workspace: "demo", connectors: [], edges: [],
  members: [{ id: "only", name: "Only", role: "", preset: "full", model: "opus", effort: "high",
    status: "idle", entry: true, x: 0, y: 0 }] });
send({ kind: "clear" });
{
  const board = (document.getElementById("floor") || document.body).textContent;
  check("a single agent is not told to put anyone to work", !/to work/.test(board));
  check("...but is still introduced", /Describe the work to Only/.test(board));
}

// ---- a large workflow stays usable ----------------------------------------
// The point of the generalisation is that a workflow can be any shape. A team
// of twelve is exactly the case that the old three-lane board never had to
// handle: the lanes must stay readable rather than being squeezed, the map
// must draw everyone, and nothing may collapse to zero.
{
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: "a" + i, name: "Agent " + i, role: "does thing " + i,
    preset: "build", model: "opus", effort: "high", status: "idle",
    entry: i === 0, x: 40 + (i % 4) * 260, y: 40 + Math.floor(i / 4) * 140,
  }));
  const edges = [];
  for (let i = 1; i < 12; i++) edges.push({ from: "a0", to: "a" + i, kind: i % 3 ? "delegate" : "then" });

  send({ kind: "screen", screen: "run" });
  send({ kind: "roster", workflowId: "big", workflowName: "Twelve", autonomy: "", billing: "",
    workspace: "demo", connectors: [], edges, members: many });

  const lanes = many.map((m) => document.getElementById("stream-" + m.id)).filter(Boolean);
  check("every agent gets a lane, however many there are", lanes.length === 12);

  const board = document.getElementById("floor");
  check("the board scrolls sideways rather than squeezing the lanes",
    board !== null && (board.scrollWidth > board.clientWidth
      || getComputedStyle(board).overflowX === "auto" || getComputedStyle(board).overflowX === "scroll"));

  // A lane squeezed below readability is worse than one you have to scroll to.
  const widths = lanes.map((l) => l.getBoundingClientRect().width).filter((w) => w > 0);
  check("no lane is squeezed to nothing", widths.length === 0 || Math.min(...widths) >= 180);

  const map = document.getElementById("livemap");
  check("the live map is there to draw into", map !== null);
  check("the live map draws every agent", map.querySelectorAll(".map-node").length === 12);
  check("...and every arrow between them", map.querySelectorAll(".wire").length === 11);

  // Talking to a specific agent must still be possible at this size.
  const channel = document.getElementById("channel");
  check("the picker is there", channel !== null);
  check("the picker offers all twelve", channel.options.length === 12);
  check("...and is usable rather than disabled", channel.disabled === false);
}

// Several agents working at once is the whole point, and until the layout was
// decided before first paint none of this was reachable from a test: the board
// was always the merged single-lane one.
{
  const three = ["a0", "a3", "a7"];
  send({ kind: "roster", workflowId: "big", workflowName: "Twelve", autonomy: "", billing: "",
    workspace: "demo", connectors: [], edges: [],
    members: Array.from({ length: 12 }, (_, i) => ({
      id: "a" + i, name: "Agent " + i, role: "", preset: "build", model: "opus", effort: "high",
      status: three.includes("a" + i) ? "working" : "idle", entry: i === 0,
      x: 40 + (i % 4) * 260, y: 40 + Math.floor(i / 4) * 140,
    })) });
  send({ kind: "clear" });
  for (const who of three) {
    send({ kind: "say", who, turn: "t", delta: "output from " + who });
    send({ kind: "sayEnd", who, turn: "t" });
  }

  for (const who of three) {
    const lane = document.getElementById("stream-" + who);
    check(who + " renders into its own lane", lane !== null && lane.textContent.includes("output from " + who));
  }
  check("...and nothing bleeds into a lane it does not belong to",
    three.every((who) => three.filter((o) => o !== who)
      .every((other) => !document.getElementById("stream-" + who).textContent.includes("output from " + other))));
  check("...and an idle agent's lane stays empty",
    (document.getElementById("stream-a1").textContent || "").trim() === "");

  // Each lane carries its own accent, or twelve lanes are a wall of one colour.
  const accents = new Set([...document.querySelectorAll(".lane")]
    .map((l) => l.style.getPropertyValue("--lane-accent")).filter(Boolean));
  check("lanes are told apart by more than position", accents.size >= 6);

  // A delegation card sits in the delegator's lane, because that is where the
  // decision was made; the receiving lane then carries the work itself.
  send({ kind: "assign", assignment: { id: "d1", from: "a0", to: "a5", brief: "look into it", startedAt: 0 } });
  const sender = document.getElementById("stream-a0");
  check("a delegation card lands in the lane that decided it",
    sender !== null && /look into it/.test(sender.textContent));
  check("...and names both ends, so it can be followed",
    /Agent 0\s*→\s*Agent 5/.test(sender.textContent));
  check("...and is not duplicated into the receiving lane",
    !/look into it/.test(document.getElementById("stream-a5").textContent));

  // The report comes back onto the same card rather than as a loose line.
  send({ kind: "deliver", id: "d1", outcome: "delivered", summary: "found the cause" });
  check("the report lands on the card it answers",
    /delivered: found the cause/.test(sender.textContent));
  // Scoped to the board: the driver's own source sits in a script element on
  // this page, so searching the whole document matches the test itself.
  check("...once, not once per lane",
    (document.getElementById("floor").textContent.match(/found the cause/g) || []).length === 1);
}

// One agent is the other end of the same range.
{
  send({ kind: "roster", workflowId: "one", workflowName: "One", autonomy: "", billing: "",
    workspace: "demo", connectors: [], edges: [],
    members: [{ id: "solo", name: "Solo", role: "", preset: "full", model: "opus", effort: "high",
      status: "idle", entry: true, x: 0, y: 0 }] });
  check("a single agent still gets a lane", document.getElementById("stream-solo") !== null);
  check("...and no lane is left over from the larger workflow",
    document.getElementById("stream-a7") === null);
}

// ---- attaching an image ----------------------------------------------------
// Reading, downscaling and encoding an attachment is asynchronous, so it runs
// after the synchronous driver and rewrites the results when it finishes. This
// placeholder fails on its own: if the block below never runs, the suite goes
// red rather than quietly dropping the checks.
results.push(["the attachment checks ran at all", false]);

(async () => {
  const finish = () => {
    document.body.setAttribute("data-results", JSON.stringify(results));
  };
  try {
    const asFile = (bytes, type, name) =>
      new File([new Uint8Array(bytes)], name, { type });

    /** Waits for a condition, up to a deadline, without assuming a duration. */
    const settled = async (ready) => {
      for (let i = 0; i < 60; i += 1) {
        if (ready()) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    };
    const chips = () => [...document.getElementById("attachments").querySelectorAll("img")];

    // A real 1x1 PNG, small enough to pass straight through.
    const png = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ), (c) => c.charCodeAt(0));

    const staged = [];
    const composer = document.querySelector(".composer");
    const drop = (files) => {
      const ev = new Event("drop", { bubbles: true });
      Object.defineProperty(ev, "dataTransfer", { value: { files } });
      composer.dispatchEvent(ev);
    };

    // A PNG is passed through untouched.
    drop([asFile(png, "image/png", "shot.png")]);
    await settled(() => chips().length > 0);
    staged.push(chips().length);

    // A format the API does not take must not be relabelled and sent raw. It
    // used to come through as mediaType image/png carrying BMP bytes.
    // A real 1x1 24-bit BMP, 58 bytes, so the browser can actually decode it.
    // An undecodable one would be rejected before the labelling ever mattered,
    // and the check would pass without testing anything.
    const bmp = Uint8Array.from([
      0x42, 0x4d, 0x3a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00,
      0x28, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
      0x13, 0x0b, 0x00, 0x00, 0x13, 0x0b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xff, 0x00, 0x00, 0x00,
    ]);
    drop([asFile(bmp, "image/bmp", "shot.bmp")]);
    // Polled rather than slept on: reading and re-encoding an image takes as
    // long as it takes, and a fixed wait that is a little too short turns the
    // whole check green for the wrong reason. It did, at 300ms.
    await settled(() => chips().length > staged[0]);

    // The signature of the bug: a chip labelled image/png whose payload is the
    // BMP that was dropped. Base64 of the bytes "BM" is "Qk0", so a src of
    // data:image/png;base64,Qk0... is a label that does not match its data.
    const srcs = chips().map((el) => el.getAttribute("src") || "");
    const mislabelled = srcs.filter((src) => /^data:image\/png;base64,Qk0/.test(src));
    const types = srcs.map((src) => (/^data:([^;,]+)/.exec(src) || [])[1]).filter(Boolean);

    results.push(["a dropped png is attached", staged[0] >= 1]);
    results.push([
      "an image the API does not accept is not relabelled as one it does",
      mislabelled.length === 0,
    ]);
    results.push([
      "...and every attachment carries a type the API takes",
      types.every((t) => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(t)),
    ]);
    results.push([
      "...because it is converted rather than passed through",
      chips().length === 2 && types.includes("image/jpeg"),
    ]);

    // Replace the placeholder now that the real checks are in.
    const at = results.findIndex(([label]) => label === "the attachment checks ran at all");
    if (at !== -1) results[at] = ["the attachment checks ran at all", true];
  } catch (err) {
    results.push(["the attachment checks threw: " + String(err && err.message ? err.message : err), false]);
  }
  finish();
})();

document.title = "done";
window.__results = results;
`;

const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style>
<style>html,body{width:1180px;height:800px;margin:0}</style></head><body>
${body.replace(/\$\{[^}]*\}/g, "")}
<script>
  window.__sent = [];
  window.acquireVsCodeApi = () => ({
    postMessage(m) { window.__sent.push(m); },
    getState() {}, setState() {},
  });
</script>
<script>${js}</script>
<script>
try { ${DRIVER} } catch (err) {
  var done = (window.__partial || []).length;
  var where = err && err.stack ? String(err.stack).split("\\n").slice(0, 2).join(" | ") : String(err);
  window.__results = [["the driver threw after " + done + " checks: " + where, false]];
}
document.body.setAttribute("data-results", JSON.stringify(window.__results || []));
</script>
</body></html>`;

if (process.env.CADRE_DUMP_PAGE) { fs.writeFileSync(process.env.CADRE_DUMP_PAGE, page); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadre-webview-"));
const file = path.join(dir, "page.html");
fs.writeFileSync(file, page);

const dom = execFileSync(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=4000", "--dump-dom", `file://${file}`],
  { encoding: "utf8", maxBuffer: 64_000_000 },
);

const match = /data-results="([^"]*)"/.exec(dom);
if (!match) {
  console.log("=== webview ===");
  console.log("FAIL  the page never reported results — it threw before assigning them");
  process.exit(1);
}
const decode = (s) =>
  s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const results = JSON.parse(decode(match[1]));

console.log("=== webview ===");
let failed = false;
for (const [label, ok] of results) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
if (!results.length) { console.log("FAIL  no assertions ran"); failed = true; }
process.exit(failed ? 1 : 0);

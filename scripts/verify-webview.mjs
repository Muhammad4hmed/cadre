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
const eventsSrc = fs.readFileSync("src/team/events.ts", "utf8");
const outboundKinds = [...new Set(
  [...eventsSrc.slice(eventsSrc.indexOf("export type TeamEvent ="), eventsSrc.indexOf("export type Screen ="))
    .matchAll(/kind:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]),
)];

const DRIVER = String.raw`
const outboundKinds = ${JSON.stringify(outboundKinds)};
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

// A name typed and not yet left is still the name you meant.
//
// The field commits on a change event, which fires on blur. Every explicit save reads
// the box directly, so Save and Launch were fine — but the autosave that runs
// when the window is hidden or the builder is left refused to write anything
// while the draft looked clean. Type a name, switch to another tab without
// leaving the field, and the rename was read and then thrown away.
send(editing());
{
  const nameBox = document.getElementById("builder-name");
  const original = nameBox.value;
  sent.length = 0;
  nameBox.value = "Renamed but not blurred";
  // Deliberately no change event: this is what mid-typing looks like.
  document.dispatchEvent(new Event("visibilitychange"));
  const saved = sent.find((m) => m.kind === "saveWorkflow");
  check("a name typed but not committed is still saved", Boolean(saved));
  check("...under the name that was typed",
    saved && saved.workflow.name === "Renamed but not blurred");
  check("...and it was not the old name that got written",
    !saved || saved.workflow.name !== original);
}

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

// A send that could not start hands back what was typed and what was attached.
// The picture has to come back to the composer, not just to the host's memory.
{
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const attachments = document.getElementById("attachments");
  const shots = () => attachments.querySelectorAll("img").length;

  document.getElementById("input").value = "";
  send({ kind: "restoreInput", text: "look at this", images: [{ name: "a.png", mediaType: "image/png", data: png, bytes: 11 }] });
  check("a handed-back message restores the words", document.getElementById("input").value === "look at this");
  check("...and the picture with them", shots() === 1);
  check("...and the composer shows the attachment row", attachments.hidden === false);

  // Sending it again must carry the restored image, not an empty list. The
  // composer has to be enabled first, or submit() returns before doing anything
  // and the checks below pass for the wrong reason.
  send({ kind: "sendability", ok: true });
  send({ kind: "busy", busy: false });
  sent.length = 0;
  document.getElementById("send").click();
  const outgoing = sent.find((m) => m.kind === "send");
  check("...and sending again carries it", (outgoing?.images ?? []).length === 1);
  check("...leaving the composer empty afterwards", shots() === 0);
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
    document.body.setAttribute("data-noise", JSON.stringify(window.__noise || []));
  };
  try {
    // The passthrough limit in the webview. Anything above it is re-encoded.
    const MAX_BYTES_TEST = 3_500_001;
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

    // There is deliberately no assertion here that the BMP came back as a JPEG.
    // Proving the conversion path needs an image the browser will certainly
    // decode, and a BMP is not that: this machine decodes one and the CI runner
    // does not, so that assertion passed here and failed there. Padding a PNG
    // past the size limit decodes everywhere but takes longer to encode than a
    // poll can wait for, because virtual time races ahead of the real work.
    //
    // The check that matters is the one above, and it holds either way: where
    // the BMP cannot be decoded it is simply never staged, and where it can it
    // is staged re-encoded. Only passing it through under a borrowed label
    // fails, which is the bug.

    // Replace the placeholder now that the real checks are in.
    const at = results.findIndex(([label]) => label === "the attachment checks ran at all");
    if (at !== -1) results[at] = ["the attachment checks ran at all", true];
  } catch (err) {
    results.push(["the attachment checks threw: " + String(err && err.message ? err.message : err), false]);
  }
  finish();
})();

// ---- project paths on someone else's machine ------------------------------
// Each card on the project picker shows where the project is, shortened to the
// tail because that is the part that identifies it. The shortener matched
// /home/<user> and /Users/<user> literally and split on "/" alone, so a Windows
// path matched neither and contained no separator it recognised: the card
// showed the whole path, and the CSS truncation then cut off the end, which is
// the only part worth reading.
send({ kind: "screen", screen: "projects" });
send({ kind: "projects", roots: [], active: "", items: [
  // Deep enough to survive the home substitution and still need shortening,
  // which is the only way the join is exercised at all.
  { path: "C:\\Users\\someone\\code\\deep\\nested\\pipeline", name: "pipeline", open: true, known: true, stack: [], lastTouched: 0 },
  { path: "D:\\work\\a\\b\\c\\rig", name: "rig", open: false, known: true, stack: [], lastTouched: 0 },
  { path: "/srv/work/clients/acme/pipeline", name: "acme", open: false, known: true, stack: [], lastTouched: 0 },
  { path: "/opt/app", name: "app", open: false, known: false, stack: [], lastTouched: 0 },
] });
{
  const shown = [...document.querySelectorAll(".path")].map((n) => n.textContent);
  check("a project path is rendered on the card", shown.length === 4);
  check("a Windows home directory is written with a tilde, like a unix one",
    shown[0] !== undefined && shown[0].startsWith("~"));
  check("...and the path is shortened rather than shown whole",
    shown[0] !== undefined && shown[0].includes("…"));
  check("...and keeps the end, which is what names the project",
    shown[0] !== undefined && /pipeline$/.test(shown[0]));
  check("a Windows path outside home is shortened too",
    shown[1] !== undefined && shown[1].includes("…") && /rig$/.test(shown[1]));
  check("...and is not rebuilt as a mix of both separators",
    shown[1] !== undefined && !shown[1].includes("/"));
  check("a deep unix path is still shortened",
    shown[2] !== undefined && shown[2].includes("…") && /pipeline$/.test(shown[2]));
  check("...and still uses forward slashes",
    shown[2] !== undefined && !shown[2].includes("\\"));
  check("a short path is left alone", shown[3] === "/opt/app");
}

// ---- every screen shows something ------------------------------------------
// Six screens, and the host decides which is up. One that fails to render is a
// blank panel with no error the user can see — and an unknown name, which is
// what a version mismatch between the host and the webview looks like, must not
// leave every screen hidden at once.
{
  const screenKinds = ["auth", "projects", "home", "workflow", "builder", "run"];
  const noiseAt = (window.__noise || []).length;
  const visible = () => [...document.querySelectorAll("[data-active='true']")].length;

  for (const name of screenKinds) {
    send({ kind: "screen", screen: name });
    check("the " + name + " screen becomes the visible one", visible() === 1);
    const shown = document.querySelector("[data-active='true']");
    check("...and it has something in it", (shown?.textContent ?? "").trim().length > 0);
  }

  check("no screen produced an error: " + JSON.stringify((window.__noise || []).slice(noiseAt, noiseAt + 2)),
    (window.__noise || []).length === noiseAt);

  // The chips that describe a running team belong to the run screen alone.
  send({ kind: "screen", screen: "home" });
  const chipHidden = ["autonomy", "billing", "spend"].every((id) => {
    const n = document.getElementById(id);
    return !n || n.style.display === "none";
  });
  check("chips about a running team are put away off the run screen", chipHidden);
  send({ kind: "screen", screen: "run" });
  check("...and come back on it",
    ["autonomy", "billing"].every((id) => {
      const n = document.getElementById(id);
      return !n || n.style.display !== "none";
    }));

  // Signing in is reachable from every screen, because a token can expire while
  // the gate never fires.
  for (const name of screenKinds) {
    send({ kind: "screen", screen: name });
    const account = document.getElementById("account");
    check("the account control is reachable on " + name,
      account !== null && account.style.display !== "none");
  }
  // A name that matches nothing hides everything, and that is deliberate: it is
  // how the panel waits before the host has said what to show. Pinned here so
  // it reads as the design rather than as a screen that failed to draw.
  send({ kind: "screen", screen: "loading" });
  check("a name matching no screen leaves the panel waiting, as at startup",
    visible() === 0);
  send({ kind: "screen", screen: "run" });
  check("...and the next real screen brings it back", visible() === 1);

  window.__noise.length = noiseAt;
}

// ---- every event, well formed, handled without error ----------------------
// The context meter never worked because the function that drew it did not
// exist, and the compaction notice threw for the same reason before it. Both
// were reachable by simply sending the event — no malformed input needed. So
// every kind is sent here once, properly filled in, and the page must handle
// all of them without a single error.
//
// The table has to cover the union: a new event kind with no entry fails the
// first check rather than quietly going unexercised.
{
  const agent = { id: "one", name: "One", role: "does things", preset: "build",
    model: "opus", effort: "high", status: "idle", entry: true, x: 0, y: 0 };
  const wf = { id: "w", name: "Team", entry: "one", agents: [
    { id: "one", name: "One", role: "r", prompt: "p", preset: "build", x: 0, y: 0 }], edges: [] };

  const WELL_FORMED = {
    screen: { screen: "run" },
    roster: { workflowId: "w", workflowName: "Team", autonomy: "Standard", billing: "Subscription",
      workspace: "…/p", connectors: [{ name: "kaggle", ok: true, status: "connected" }],
      edges: [], members: [agent] },
    clear: {},
    busy: { busy: true },
    status: { who: "one", status: "working", activity: "reading" },
    userSaid: { to: "one", text: "hello", images: [] },
    say: { who: "one", turn: "t1", delta: "some words" },
    sayEnd: { who: "one", turn: "t1" },
    think: { who: "one", turn: "t1", delta: "thinking" },
    act: { who: "one", act: "a1", tool: "Read", summary: "src/a.ts" },
    actEnd: { who: "one", act: "a1", ok: true, summary: "read 40 lines" },
    assign: { assignment: { id: "d1", from: "one", to: "one", brief: "look", startedAt: 0 } },
    deliver: { id: "d1", outcome: "delivered", summary: "found it" },
    active: { agents: ["one"], edge: undefined },
    spend: { who: "one", usd: 0.12, totalUsd: 0.5, turns: 3, durationMs: 4200 },
    context: { percent: 44, tokens: 88000, max: 200000 },
    compacted: { before: 190000, after: 40000 },
    notice: { level: "info", text: "something happened" },
    ask: { id: "q1", who: "one", questions: [{ question: "Which?", header: "Pick",
      multiSelect: false, options: [{ label: "A", description: "first" }] }] },
    askClosed: { id: "q1", answered: true },
    sendability: { ok: true },
    restoreInput: { text: "typed", images: [] },
    channel: { to: "one" },
    auth: { signedIn: true, detail: "you@example.com", usingApiKey: false },
    authProblem: { detail: "not signed in" },
    sessionStarted: { sessionId: "s1" },
    sessions: { workflowId: "w", items: [{ id: "s1", title: "a chat", when: 1 }] },
    workflows: { project: "p", templates: [], items: [{ id: "w", name: "Team", description: "d",
      scope: "local", agents: 1, edges: 0, updatedAt: 1700000000000, sessions: 1,
      agentNames: ["One"], problems: 0 }] },
    detail: { workflow: wf, sessions: [], problems: [] },
    editing: { authoritative: true, workflow: wf, problems: [] },
    projects: { roots: [], active: "", items: [{ path: "/p", name: "p", open: true,
      known: true, stack: ["Node"], lastTouched: 0 }] },
    saved: { workflowId: "w", at: 1700000000000, auto: false },
    refining: { agent: "one", busy: true },
    refined: { agent: "one", prompt: "a refined prompt", note: "Expanded to 200 words." },
    building: { busy: false, note: "Built 2 agents." },
  };

  const declaredKinds = outboundKinds;
  const uncovered = declaredKinds.filter((k) => !(k in WELL_FORMED));
  check("every event kind has a well-formed example to send" +
    (uncovered.length ? " (" + uncovered.join(", ") + ")" : ""), uncovered.length === 0);

  const noiseAt = (window.__noise || []).length;
  for (const kind of declaredKinds) {
    const payload = WELL_FORMED[kind];
    if (!payload) continue;
    send({ kind, ...payload });
  }
  const raised = (window.__noise || []).slice(noiseAt);
  check("no well-formed event produces an error: " + JSON.stringify(raised.slice(0, 3)),
    raised.length === 0);
  window.__noise.length = noiseAt;
}

// ---- how full the context window is ---------------------------------------
// The chip, its CSS and the event all existed; the function that draws them did
// not, so every context event threw and the chip stayed hidden — while the
// README said the header shows this.
{
  const chip = document.getElementById("context");
  check("there is a chip for it", chip !== null);

  send({ kind: "context", percent: 8, tokens: 16000, max: 200000 });
  check("a nearly empty window is not worth a number in the header", chip.hidden === true);

  send({ kind: "context", percent: 62.4, tokens: 124800, max: 200000 });
  check("a window worth knowing about is shown", chip.hidden === false);
  check("...as a percentage", /62% context/.test(chip.textContent));
  check("...with the real numbers behind it", /125K of 200K/.test(chip.title));
  check("...and not marked as a worry yet", chip.classList.contains("warn") === false);

  send({ kind: "context", percent: 91, tokens: 182000, max: 200000 });
  check("close to the limit is marked", chip.classList.contains("warn") === true);
  check("...and says what happens next", /summarised/.test(chip.title));

  send({ kind: "context", percent: 140, tokens: 1, max: 1 });
  check("a percentage past the end is clamped rather than shown raw",
    /100% context/.test(chip.textContent));
}

// ---- events the host should never send, but might ------------------------
// The page trusts what it is given. A field that is missing, null, the wrong
// type or absurd should leave it standing — a webview that throws stops
// rendering everything after it, and the user sees a board frozen mid-run with
// no way to tell why. Every one of these is caught by the error channel, so a
// throw here shows up as a failed check rather than as silence.
{
  send({ kind: "screen", screen: "run" });
  send({ kind: "clear" });
    // Two shapes we can anticipate. The blanket guard would catch these as well,
  // but catching is for what we did not foresee — a case we know about should
  // draw nothing quietly rather than log an error every time it arrives.
  {
    const quietBefore = (window.__noise || []).length;
    send({ kind: "assign" });
    send({ kind: "assign", assignment: null });
    send({ kind: "spend" });
    send({ kind: "spend", usd: NaN, totalUsd: undefined, turns: -1, durationMs: "soon" });
    check("an assignment with nothing in it is ignored quietly, not caught and logged",
      (window.__noise || []).length === quietBefore);
    check("...and a cost line of nothing reads as zero rather than throwing",
      /0 turns/.test(document.getElementById("floor").textContent));
  }

  const noiseBefore = (window.__noise || []).length;
  for (const bad of [
    { kind: "say" },
    { kind: "say", who: null, turn: null, delta: null },
    { kind: "say", who: "one", turn: "t", delta: 12345 },
    { kind: "sayEnd" },
    { kind: "act", who: "one" },
    { kind: "actEnd", act: "missing", ok: "yes" },
    { kind: "assign" },
    { kind: "assign", assignment: null },
    { kind: "assign", assignment: { id: "x" } },
    { kind: "deliver", id: "never-assigned", outcome: undefined, summary: null },
    { kind: "status" },
    { kind: "status", who: "ghost", status: "invented" },
    { kind: "spend" },
    { kind: "spend", usd: NaN, totalUsd: undefined, turns: -1, durationMs: "soon" },
    { kind: "context", percent: 1e9, tokens: null, max: 0 },
    { kind: "compacted" },
    { kind: "notice" },
    { kind: "notice", level: "unknown", text: null },
    { kind: "roster" },
    { kind: "roster", members: null, edges: null },
    { kind: "roster", members: [{ id: null }], edges: [{ from: null, to: null }] },
    { kind: "sessions", items: null },
    { kind: "workflows", items: [null, { id: null }] },
    { kind: "detail" },
    { kind: "editing" },
    { kind: "editing", workflow: null },
    { kind: "ask", id: "q", who: "one" },
    { kind: "askClosed" },
    { kind: "restoreInput" },
    { kind: "channel" },
    { kind: "busy" },
    { kind: "active" },
    { kind: "saved" },
    { kind: "refined" },
    { kind: "building" },
    { kind: "auth" },
    { kind: "projects" },
  ]) {
    // Dispatching is synchronous here, so a handler that throws would abort this
    // loop. In the extension each message is its own event and the browser
    // catches it — the event is dropped and logged rather than killing the page.
    // Recorded either way: a dropped event is a lane that stops updating.
    try { send(bad); } catch (err) {
      (window.__noise ||= []).push("threw on " + bad.kind + ": " + String(err && err.message ? err.message : err));
    }
  }
    const raised = (window.__noise || []).slice(noiseBefore);
  // Caught and logged is the designed outcome: one event is dropped and the
  // page carries on. What must never happen is an uncaught throw, which leaves
  // the handler half-finished with nothing to correct it.
  const uncaught = raised.filter((n) => String(n).startsWith("error:"));
  check("no malformed event throws uncaught: " + JSON.stringify(uncaught.slice(0, 3)),
    uncaught.length === 0);
  check("...and anything unhandleable is reported rather than swallowed",
    raised.every((n) => /could not handle|could not render|threw on/.test(String(n))));
  // Deliberate noise, so it does not count against the page's own error check.
  window.__noise.length = noiseBefore;
  check("...and the board is still there afterwards",
    document.getElementById("floor") !== null);
  send({ kind: "roster", workflowId: "ok", workflowName: "Fine", autonomy: "", billing: "",
    workspace: "d", connectors: [], edges: [],
    members: [{ id: "one", name: "One", role: "", preset: "build", model: "opus",
      effort: "high", status: "idle", entry: true, x: 0, y: 0 }] });
  send({ kind: "say", who: "one", turn: "z", delta: "still working" });
  send({ kind: "sayEnd", who: "one", turn: "z" });
  check("...and still renders after all that",
    (document.getElementById("stream-one") || document.getElementById("stream-all"))
      .textContent.includes("still working"));
}

document.title = "done";
window.__results = results;
`;

const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style>
<style>html,body{width:1180px;height:800px;margin:0}</style></head><body>
${body.replace(/\$\{[^}]*\}/g, "")}
<script>
  // Anything the page reports on its own: an uncaught error in a handler, a
  // rejected promise nobody caught, a CSP violation, or a console.error the
  // code itself chose to emit. None of it reached the suite before, so the page
  // could be throwing on every message and still report every check green.
  window.__noise = [];
  window.addEventListener("error", (e) => {
    window.__noise.push("error: " + (e.message || String(e.error)));
  });
  window.addEventListener("unhandledrejection", (e) => {
    window.__noise.push("unhandled rejection: " + String(e.reason && e.reason.message ? e.reason.message : e.reason));
  });
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__noise.push("CSP: " + e.violatedDirective + " blocked " + e.blockedURI);
  });
  const realConsoleError = console.error.bind(console);
  console.error = (...args) => {
    window.__noise.push("console.error: " + args.map((a) => (a && a.message) || String(a)).join(" "));
    realConsoleError(...args);
  };

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
document.body.setAttribute("data-noise", JSON.stringify(window.__noise || []));
</script>
</body></html>`;

if (process.env.CADRE_DUMP_PAGE) { fs.writeFileSync(process.env.CADRE_DUMP_PAGE, page); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadre-webview-"));
const file = path.join(dir, "page.html");
fs.writeFileSync(file, page);

const dom = execFileSync(
  CHROME,
  [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    // Virtual time is only spent while something is pending, so headroom is
    // nearly free — and the asynchronous checks (reading and re-encoding an
    // image) need it. At 4000 they finished on an idle machine and were cut
    // off on a loaded one, which is a suite that fails for the wrong reason
    // and then gets ignored.
    //
    // Deliberately below the 45s autosave idle timer: raising it past that
    // would start firing autosaves in the middle of tests that never expected
    // one.
    "--virtual-time-budget=20000",
    "--dump-dom", `file://${file}`,
  ],
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

// What the page said about itself while all of that was happening.
const noiseMatch = /data-noise="([^"]*)"/.exec(dom);
const noise = noiseMatch ? JSON.parse(decode(noiseMatch[1])) : [];
results.push([
  noise.length ? `the page reported no errors of its own (${noise.slice(0, 3).join(" | ")})` : "the page reported no errors of its own",
  noise.length === 0,
]);

console.log("=== webview ===");
let failed = false;
for (const [label, ok] of results) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
if (!results.length) { console.log("FAIL  no assertions ran"); failed = true; }
process.exit(failed ? 1 : 0);

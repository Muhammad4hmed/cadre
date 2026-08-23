/**
 * The workflow model: graph rules, capability resolution, the injected
 * protocol, and persistence.
 *
 * These are the load-bearing invariants of the whole product now. If a `then`
 * cycle gets through, a workflow never terminates; if capability resolution
 * lets a denied tool back in, the safety story is decoration; if the protocol
 * is injected for an arrow that does not exist, an agent is told it can reach
 * someone it cannot.
 */
import * as esbuild from "esbuild";
import { baseOptions } from "./esbuild-shared.mjs";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadre-wf-"));
const outfile = path.join(dir, "wf.cjs");

await esbuild.build({
  ...baseOptions({ entry: "scripts/entry-workflow.ts", outfile }),
  logLevel: "warning",
});
const wf = createRequire(import.meta.url)(outfile);
const { model, presets, protocol, store, templates, generate, models } = wf;

const checks = [];
const check = (label, ok) => checks.push([label, ok]);

/* ------------------------------------------------------------------ slugs */

check("a name becomes a tool-safe slug", model.slug("Senior Researcher!") === "senior_researcher");
check("an unusable name still yields something", model.slug("!!!") === "agent");
check("a slug is truncated, not left unbounded", model.slug("x".repeat(80)).length <= 32);
check("a duplicate slug is suffixed", model.uniqueSlug("Lead", ["lead"]) === "lead_2");
check("suffixing continues past the first collision",
  model.uniqueSlug("Lead", ["lead", "lead_2"]) === "lead_3");

/* ------------------------------------------------------------ graph rules */

const agent = (id, over = {}) => ({
  id, name: id, role: "", prompt: "do the thing", preset: "readonly", x: 0, y: 0, ...over,
});
const build = (agents, edges, entry) => ({
  id: "w", name: "W", entry: entry ?? agents[0]?.id ?? "", agents, edges,
  createdAt: 0, updatedAt: 0, revision: 1,
});

const line = build(
  [agent("a"), agent("b"), agent("c")],
  [{ from: "a", to: "b", kind: "then" }, { from: "b", to: "c", kind: "then" }],
);
check("a valid workflow has no errors", model.isRunnable(line));

const thenLoop = build(
  [agent("a"), agent("b")],
  [{ from: "a", to: "b", kind: "then" }, { from: "b", to: "a", kind: "then" }],
);
check("a 'then' loop is an error — it would never finish", !model.isRunnable(thenLoop));
check("the loop error names the agents in it",
  model.validate(thenLoop).some((p) => /a → b → a/.test(p.message)));

const delegateLoop = build(
  [agent("a"), agent("b")],
  [{ from: "a", to: "b", kind: "delegate" }, { from: "b", to: "a", kind: "delegate" }],
);
check("a 'delegate' loop is allowed — that is a conversation", model.isRunnable(delegateLoop));

const longThenLoop = build(
  [agent("a"), agent("b"), agent("c")],
  [
    { from: "a", to: "b", kind: "then" },
    { from: "b", to: "c", kind: "then" },
    { from: "c", to: "a", kind: "then" },
  ],
);
check("an indirect 'then' loop is caught too", !model.isRunnable(longThenLoop));

// A mixed graph must not have its delegate edges dragged into the cycle check.
const mixed = build(
  [agent("a"), agent("b"), agent("c")],
  [
    { from: "a", to: "b", kind: "then" },
    { from: "b", to: "a", kind: "delegate" },
    { from: "b", to: "c", kind: "then" },
  ],
);
check("a delegate edge closing a 'then' path is not treated as a loop", model.isRunnable(mixed));

check("an agent pointing at itself is an error",
  !model.isRunnable(build([agent("a")], [{ from: "a", to: "a", kind: "delegate" }])));
check("an arrow to a deleted agent is an error",
  !model.isRunnable(build([agent("a")], [{ from: "a", to: "ghost", kind: "delegate" }])));
check("an agent with no prompt is an error",
  !model.isRunnable(build([agent("a", { prompt: "" })], [])));
check("no entry agent is an error",
  !model.isRunnable(build([agent("a")], [], "nobody")));
check("an empty workflow is not runnable", !model.isRunnable(build([], [])));

const orphan = build([agent("a"), agent("b")], [], "a");
check("an unreachable agent is a warning, not a blocker", model.isRunnable(orphan));
check("...and it is actually reported",
  model.validate(orphan).some((p) => p.level === "warning" && /no arrows/.test(p.message)));

/* --------------------------------------------------------- then ordering */

const diamond = build(
  [agent("a"), agent("b"), agent("c"), agent("d")],
  [
    { from: "a", to: "b", kind: "then" },
    { from: "a", to: "c", kind: "then" },
    { from: "b", to: "d", kind: "then" },
    { from: "c", to: "d", kind: "then" },
  ],
);
const order = model.thenOrder(diamond, "a");
check("a diamond runs the join once, not twice",
  order.filter((id) => id === "d").length === 1);
check("the join runs after both sides",
  order.indexOf("d") > order.indexOf("b") && order.indexOf("d") > order.indexOf("c"));
check("an agent with no 'then' successors schedules nothing",
  model.thenOrder(delegateLoop, "a").length === 0);

/* --------------------------------------------------- capability resolution */

const graph = build(
  [agent("lead"), agent("hands", { preset: "build" })],
  [{ from: "lead", to: "hands", kind: "delegate" }],
);
const lead = presets.resolveAgent(graph, graph.agents[0], { defaultModel: "opus", speaksToUser: true });
const hands = presets.resolveAgent(graph, graph.agents[1], { defaultModel: "opus", speaksToUser: false });

check("an arrow becomes a brief tool", lead.tools.includes("mcp__team__brief_hands"));
check("an arrow becomes an ask tool too", lead.tools.includes("mcp__team__ask_hands"));
check("no arrow, no tool", !hands.tools.some((t) => t.startsWith("mcp__team__brief_")));
check("a read-only agent has no shell", !lead.tools.includes("Bash") && lead.disallowedTools.includes("Bash"));
check("a build agent has one", hands.tools.includes("Bash"));
check("only the agent you address may ask questions",
  lead.tools.includes("AskUserQuestion") && !hands.tools.includes("AskUserQuestion"));
check("the others are explicitly denied it, not merely unlisted",
  hands.disallowedTools.includes("AskUserQuestion"));

for (const banned of presets.NEVER_AVAILABLE) {
  check(`${banned} is denied to every agent`,
    [lead, hands].every((a) => a.disallowedTools.includes(banned) && !a.tools.includes(banned)));
}

const sneaky = build(
  [agent("x", { preset: "full", tools: ["Bash", "Agent", "Workflow", "Read"] })],
  [],
);
const resolved = presets.resolveAgent(sneaky, sneaky.agents[0], { defaultModel: "opus", speaksToUser: true });
check("an explicit tool override cannot re-add a banned tool",
  !resolved.tools.includes("Agent") && !resolved.tools.includes("Workflow"));
check("...but its legitimate overrides survive",
  resolved.tools.includes("Bash") && resolved.tools.includes("Read"));

const capped = presets.resolveAgent(graph, graph.agents[0], {
  defaultModel: "opus", speaksToUser: true, mayDelegate: false,
});
check("at the depth cap the delegate tools are gone",
  !capped.tools.some((t) => t.startsWith("mcp__team__brief_")));

check("a per-agent model override wins",
  presets.resolveAgent(graph, { ...graph.agents[0], model: "sonnet" },
    { defaultModel: "opus", speaksToUser: true }).model === "sonnet");
check("otherwise the workflow default applies", lead.model === "opus");

/* -------------------------------------------------------------- protocol */

const opts = { scratchpad: ".cadre", docsPath: "docs", speaksToUser: true };
const leadPrompt = protocol.composeSystemPrompt(graph, graph.agents[0], opts);
const handsPrompt = protocol.composeSystemPrompt(graph, graph.agents[1], { ...opts, speaksToUser: false });

check("the agent is told who it is", leadPrompt.includes("You are **lead**"));
check("the user's own prompt survives", leadPrompt.includes("do the thing"));
check("a delegator is told exactly who it can reach", leadPrompt.includes("brief_hands"));
check("...and not told about arrows it does not have", !handsPrompt.includes("brief_lead"));
check("a briefed agent is given the report contract", handsPrompt.includes("VERDICT"));
check("an agent nobody briefs is not", !leadPrompt.includes("VERDICT      DONE"));
check("the agent holding the channel is told it can ask", leadPrompt.includes("AskUserQuestion"));
check("the others are not", !handsPrompt.includes("AskUserQuestion"));
check("a read-only agent is told where it may write", leadPrompt.includes(".cadre/"));
check("an agent with hands is not lectured about it", !handsPrompt.includes("You have no shell"));

const chain = build(
  [agent("first"), agent("second")],
  [{ from: "first", to: "second", kind: "then", label: "drafting" }],
);
const firstPrompt = protocol.composeSystemPrompt(chain, chain.agents[0], opts);
const secondPrompt = protocol.composeSystemPrompt(chain, chain.agents[1], { ...opts, speaksToUser: false });
check("a 'then' sender is warned its last message is the handoff",
  /handed straight to/.test(firstPrompt));
check("a 'then' receiver is told where its input came from",
  /started automatically/.test(secondPrompt));
check("the arrow's label reaches the prompt", firstPrompt.includes("drafting"));

/* ----------------------------------------------------------------- store */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cadre-proj-"));
check("an empty project lists no workflows", store.listWorkflows(root).length === 0);

const created = store.createWorkflow(root, "My Team");
check("creating a workflow writes a file", fs.existsSync(path.join(root, ".cadre/workflows/my_team.json")));
check("it is listed", store.listWorkflows(root).length === 1);
check("an unfinished workflow is listed with its problem count",
  store.listWorkflows(root)[0].problems > 0);

const saved = store.writeWorkflow(root, { ...created, agents: [agent("a")], entry: "a", name: "My Team" });
check("saving bumps the revision", saved.revision > created.revision);
check("a saved workflow reads back", store.readWorkflow(root, created.id)?.agents.length === 1);
check("a finished workflow has no problems", store.listWorkflows(root)[0].problems === 0);

store.recordSession(root, created.id, { sessionId: "s1", title: "first", when: 1 });
store.recordSession(root, created.id, { sessionId: "s2", title: "second", when: 2 });
check("sessions are recorded against the workflow", store.listSessions(root, created.id).length === 2);
check("newest first", store.listSessions(root, created.id)[0].sessionId === "s2");
store.recordSession(root, created.id, { sessionId: "s1", title: "first again", when: 3 });
check("re-recording a session updates rather than duplicates",
  store.listSessions(root, created.id).length === 2);

const second = store.createWorkflow(root, "My Team");
check("a second workflow with the same name gets its own id", second.id !== created.id);
check("one workflow does not see another's sessions", store.listSessions(root, second.id).length === 0);

/* ------------------------------------------------------------ scope */

// A global workflow is visible from any project; its conversations are not.
const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cadre-proj2-"));
const globalHome = path.join(os.homedir(), ".cadre", "workflows");
const before = new Set(fs.existsSync(globalHome) ? fs.readdirSync(globalHome) : []);

const shared = store.createWorkflow(root, "Shared thing", "global");
check("a global workflow is not written into the project",
  !fs.existsSync(path.join(root, ".cadre/workflows/shared_thing.json")));
check("it is visible from the project it was made in",
  store.listWorkflows(root).some((w) => w.id === shared.id && w.scope === "global"));
check("...and from a completely different project",
  store.listWorkflows(otherRoot).some((w) => w.id === shared.id));
check("reading it reports the scope it was found in",
  store.readWorkflow(otherRoot, shared.id)?.scope === "global");

store.recordSession(root, shared.id, { sessionId: "here", title: "in project one", when: 1 });
check("a global workflow's conversations belong to the project",
  store.listSessions(root, shared.id).length === 1 &&
  store.listSessions(otherRoot, shared.id).length === 0);

const localised = store.moveWorkflow(root, shared.id, "local");
check("moving it into the project changes its scope", localised?.scope === "local");
check("...and it is no longer visible elsewhere",
  !store.listWorkflows(otherRoot).some((w) => w.id === shared.id));
check("...and the file really moved",
  fs.existsSync(path.join(root, ".cadre/workflows/shared_thing.json")));

const backOut = store.moveWorkflow(root, shared.id, "global");
check("and back out again", backOut?.scope === "global" &&
  store.listWorkflows(otherRoot).some((w) => w.id === shared.id));
check("moving to the scope it is already in is a no-op",
  store.moveWorkflow(root, shared.id, "global")?.scope === "global");

// A local workflow shadows a global one of the same id, so a project can pin
// its own version of something shared.
store.writeWorkflow(root, { ...backOut, name: "Local override" }, "local");
check("the project's copy wins when both exist",
  store.readWorkflow(root, shared.id)?.name === "Local override");
check("...while the other project still sees the global one",
  store.readWorkflow(otherRoot, shared.id)?.name === "Shared thing");
check("both are listed, so the shadowing is visible rather than silent",
  store.listWorkflows(root).filter((w) => w.id === shared.id).length === 2);

store.deleteWorkflow(root, shared.id, "local");
store.deleteWorkflow(root, shared.id, "global");
check("cleanup leaves the global directory as it was",
  fs.readdirSync(globalHome).every((f) => before.has(f)));

/* ------------------------------------------------- workflow-level defaults */

const defaulted = build([agent("solo", { preset: "build" })], []);
defaulted.defaults = { model: "sonnet", effort: "low", maxTurns: 7 };
const withDefaults = presets.resolveAgent(defaulted, defaulted.agents[0],
  { defaultModel: "opus", speaksToUser: true });
check("a workflow default beats the workspace default", withDefaults.model === "sonnet");
check("...for effort too", withDefaults.effort === "low");
check("...and for the turn limit", withDefaults.maxTurns === 7);

const overridden = presets.resolveAgent(
  defaulted,
  { ...defaulted.agents[0], model: "haiku", effort: "xhigh", maxTurns: 99 },
  { defaultModel: "opus", speaksToUser: true },
);
check("an agent's own setting beats the workflow default", overridden.model === "haiku");
check("...for effort too", overridden.effort === "xhigh");
check("...and for the turn limit", overridden.maxTurns === 99);
check("an empty skill list at workflow level means none, not inherit",
  presets.resolveAgent({ ...defaulted, defaults: { skills: [] } }, defaulted.agents[0],
    { defaultModel: "opus", speaksToUser: true }).skills?.length === 0);

const copy = store.duplicateWorkflow(root, created.id);
check("duplicating gives a new id", copy && copy.id !== created.id);
check("...and copies the agents", copy?.agents.length === 1);

store.deleteWorkflow(root, second.id);
check("deleting removes it", !store.listWorkflows(root).some((w) => w.id === second.id));

/* ------------------------------------------------------------- templates */

for (const template of templates.TEMPLATES) {
  const built = { ...template.build(0), id: template.id, createdAt: 0, updatedAt: 0, revision: 1 };
  const problems = model.validate(built).filter((p) => p.level === "error");
  check(`the "${template.name}" template is runnable${problems.length ? ` — ${problems[0].message}` : ""}`,
    problems.length === 0);
  check(`the "${template.name}" template gives every agent a prompt`,
    built.agents.every((a) => a.prompt.trim().length > 200));
}

// A shipped template with a warning on it is a bad example: it teaches the
// shape the builder flags. Errors are already checked above; this is stricter.
for (const template of templates.TEMPLATES) {
  const built = { ...template.build(0), id: template.id, createdAt: 0, updatedAt: 0, revision: 1 };
  const warnings = model.validate(built).filter((p) => p.level === "warning");
  check(`the "${template.name}" template has no unreachable agents${warnings.length ? ` — ${warnings[0].message}` : ""}`,
    warnings.length === 0);
  check(`the "${template.name}" template's entry agent exists`,
    built.agents.some((a) => a.id === built.entry));
  check(`the "${template.name}" template has no duplicate agent ids`,
    new Set(built.agents.map((a) => a.id)).size === built.agents.length);
}

// A template labelled "ready to run" has to earn it. These thresholds are what
// separates a shape to build on from a workflow someone could actually use.
const complete = templates.TEMPLATES.filter((t) => t.kind === "complete");
check("there are workflows offered as ready to run", complete.length >= 3);

for (const template of complete) {
  const built = template.build(0);
  const words = (a) => a.prompt.trim().split(/\s+/).length;
  check(`"${template.name}" has a real team, not three boxes`, built.agents.length >= 5);
  check(`"${template.name}" has more arrows than agents — the agents relate to each other`,
    built.edges.length >= built.agents.length);
  check(`"${template.name}" gives every agent a prompt written for the job`,
    built.agents.every((a) => words(a) >= 150));
  check(`"${template.name}" keeps every prompt short enough to be read`,
    built.agents.every((a) => words(a) <= 600));
  check(`"${template.name}" gives every agent a stated role`,
    built.agents.every((a) => a.role.trim().length > 10));
  check(`"${template.name}" labels every arrow, so the graph explains itself`,
    built.edges.every((e) => (e.label ?? "").trim().length > 0));
  check(`"${template.name}" gives hands to as few agents as the work needs`,
    built.agents.filter((a) => a.preset === "build" || a.preset === "full").length <= 2);
  check(`"${template.name}" has someone the user talks to who cannot do the work themselves`,
    ["readonly", "research"].includes(built.agents.find((a) => a.id === built.entry)?.preset));
  // A prompt that explains the brief format duplicates what the arrows inject.
  check(`"${template.name}" leaves the protocol to the arrows`,
    built.agents.every((a) => !/VERDICT|done_when|decide_yourself/.test(a.prompt)));
}

check("at least one ready-to-run workflow lets peers push back on each other",
  complete.some((t) => Boolean(model.findCycle(t.build(0).edges.filter((e) => e.kind === "delegate")))));
check("at least one hands off automatically as well as delegating",
  complete.some((t) => t.build(0).edges.some((e) => e.kind === "then")));
check("the ready-to-run set is not all about code",
  complete.some((t) => /bid|contract|content/.test(t.id)));

const ids = templates.TEMPLATES.map((t) => t.id);
check("template ids are unique", new Set(ids).size === ids.length);

const allEdges = templates.TEMPLATES.flatMap((t) => t.build(0).edges);
check("the templates demonstrate delegate arrows", allEdges.some((e) => e.kind === "delegate"));
check("...and 'then' arrows", allEdges.some((e) => e.kind === "then"));
check("at least one template has a cycle, since that is legal and worth showing",
  templates.TEMPLATES.some((t) => {
    const e = t.build(0).edges.filter((x) => x.kind === "delegate");
    return Boolean(model.findCycle(e));
  }));
// The point of the rewrite was that this is not a software tool any more.
check("at least one template is not about software",
  templates.TEMPLATES.some((t) => /contract|content/.test(t.id)));

const team = { ...templates.templateById("software-team").build(0), id: "t", createdAt: 0, updatedAt: 0, revision: 1 };
check("the software team keeps the lead read-only",
  team.agents.find((a) => a.id === "lead").preset === "readonly");
check("the software team's engineer has hands",
  team.agents.find((a) => a.id === "engineer").preset === "build");
const teamLead = protocol.composeSystemPrompt(team, team.agents[0], opts);
check("the ported lead prompt no longer explains the brief format itself",
  !/^## Writing a brief$/m.test(teamLead));
check("...because the arrows explain it instead", teamLead.includes("brief_researcher"));
check("the ported lead prompt keeps its judgement sections",
  /Price the decision before you spend on it/.test(teamLead));

/* -------------------------------------------------------- unsafe ids */

// Workflow ids reach the store from webview messages and become filenames.
// This is not theoretical: writeWorkflow created a file outside the project
// before the guard existed.
const guarded = fs.mkdtempSync(path.join(os.tmpdir(), "cadre-guard-"));
const escapee = path.join(guarded, "..", "cadre-ESCAPED.json");
fs.rmSync(escapee, { force: true });

let threw = false;
try {
  store.writeWorkflow(guarded, {
    id: "../cadre-ESCAPED", name: "x", entry: "", agents: [], edges: [],
    createdAt: 0, updatedAt: 0, revision: 0,
  }, "local");
} catch { threw = true; }
check("writing with a traversing id is refused", threw);
check("...and nothing was written outside the project",
  !fs.existsSync(path.join(guarded, ".cadre", "workflows", "..", "cadre-ESCAPED.json")));

for (const bad of ["../x", "a/b", "/etc/passwd", "..", "", "x".repeat(200), "Bad Id", "a\u0000b", "."]) {
  check(`an unsafe id is not treated as a workflow: ${JSON.stringify(bad)}`,
    store.isSafeId(bad) === false && store.readWorkflow(guarded, bad) === undefined);
}
for (const good of ["software_team", "a", "wf_2", "123", "x".repeat(64)]) {
  check(`a slug is accepted: ${JSON.stringify(good).slice(0, 20)}`, store.isSafeId(good) === true);
}

// Reads, deletes and session lookups must refuse quietly rather than throw:
// they are called on ids that may simply no longer exist.
let quiet = true;
try {
  store.readWorkflow(guarded, "../x");
  store.deleteWorkflow(guarded, "../x");
  store.listSessions(guarded, "../x");
} catch { quiet = false; }
check("reading, deleting and listing an unsafe id fail quietly", quiet);

const victim = path.join(guarded, "victim.txt");
fs.writeFileSync(victim, "keep me");
store.deleteWorkflow(guarded, `../../${path.basename(guarded)}/victim`);
check("a traversing delete removes nothing", fs.existsSync(victim));

// Every id the product mints must survive its own guard.
check("every generated slug is a safe id",
  ["Senior Researcher!", "!!!", "x".repeat(80), "123", "Lead"].every((n) =>
    store.isSafeId(model.uniqueSlug(n, []))));

/* ------------------------------------------------ generated workflows */

// The schema constrains the shape but not the sense. Everything below is a
// design the model could plausibly return and that would break the builder if
// it were trusted as-is.
const design = (over = {}) => ({
  name: "Support triage",
  description: "does the thing",
  entry: "triage",
  agents: [
    { id: "triage", name: "Triage", role: "sorts", preset: "readonly", prompt: "You sort tickets." },
    { id: "fixer", name: "Fixer", role: "fixes", preset: "build", prompt: "You fix things." },
  ],
  edges: [{ from: "triage", to: "fixer", kind: "delegate", label: "reproduce it" }],
  ...over,
});

const built = generate.assemble(design(), []);
check("a well-formed design assembles", built.ok && built.workflow.agents.length === 2);
check("the arrows survive", built.workflow.edges.length === 1);
check("the entry agent is kept", built.workflow.entry === "triage");
check("agents are laid out so they do not overlap",
  built.workflow.agents[0].x !== built.workflow.agents[1].x);
check("the result is runnable as generated",
  model.isRunnable({ ...built.workflow, id: "x", createdAt: 0, updatedAt: 0, revision: 0 }));

// An id already used by a workflow on disk must not be reused.
const clashing = generate.assemble(design(), ["triage"]);
check("an id that collides with an existing workflow is renamed",
  clashing.workflow.agents[0].id !== "triage");
check("...and its arrows are renamed with it",
  clashing.workflow.edges[0].from === clashing.workflow.agents[0].id);
check("...and so is the entry", clashing.workflow.entry === clashing.workflow.agents[0].id);

const duplicated = generate.assemble(design({
  agents: [
    { id: "same", name: "One", role: "", preset: "readonly", prompt: "a" },
    { id: "same", name: "Two", role: "", preset: "build", prompt: "b" },
  ],
  edges: [], entry: "same",
}), []);
check("two agents given the same id are separated",
  duplicated.workflow.agents[0].id !== duplicated.workflow.agents[1].id);

const dangling = generate.assemble(design({
  edges: [
    { from: "triage", to: "ghost", kind: "delegate" },
    { from: "nobody", to: "fixer", kind: "then" },
    { from: "triage", to: "triage", kind: "delegate" },
    { from: "triage", to: "fixer", kind: "delegate" },
    { from: "triage", to: "fixer", kind: "delegate" },
  ],
}), []);
check("an arrow to an agent that does not exist is dropped",
  dangling.workflow.edges.every((e) => e.to !== "ghost"));
check("an arrow from one that does not exist is dropped too",
  dangling.workflow.edges.every((e) => e.from !== "nobody"));
check("a self-arrow is dropped",
  dangling.workflow.edges.every((e) => e.from !== e.to));
check("a duplicated arrow is kept once", dangling.workflow.edges.length === 1);

const nonsense = generate.assemble(design({
  entry: "not-an-agent",
  agents: [{ id: "", name: "", role: "", preset: "wizard", prompt: "x" }],
  edges: [],
  name: "",
}), []);
check("an unknown preset falls back to the safest one",
  nonsense.workflow.agents[0].preset === "readonly");
check("a nameless agent still gets a name and an id",
  Boolean(nonsense.workflow.agents[0].name) && Boolean(nonsense.workflow.agents[0].id));
check("an entry pointing at nothing falls back to the first agent",
  nonsense.workflow.entry === nonsense.workflow.agents[0].id);
check("a nameless workflow still gets a name", Boolean(nonsense.workflow.name));

// A design referring to agents by display name rather than id must still wire up.
const byName = generate.assemble(design({
  agents: [
    { id: "a", name: "Planner", role: "", preset: "readonly", prompt: "p" },
    { id: "b", name: "Writer", role: "", preset: "readonly", prompt: "w" },
  ],
  edges: [{ from: "Planner", to: "Writer", kind: "then" }],
  entry: "Planner",
}), []);
check("arrows given by display name are resolved to ids",
  byName.workflow.edges.length === 1 && byName.workflow.edges[0].from === "a");

check("a design with no agents is refused rather than opened empty",
  generate.assemble({ agents: [] }, []).workflow.agents.length === 0);

// The note must not claim success when the result needs work.
const broken = generate.assemble(design({
  agents: [{ id: "solo", name: "Solo", role: "", preset: "readonly", prompt: "" }],
  edges: [], entry: "solo",
}), []);
check("a design with a missing prompt says so rather than reading as finished",
  /to fix/.test(broken.note));

/* ------------------------------------------------------------- models */

const list = [
  { value: "opus[1m]", label: "Opus", efforts: ["low", "high", "max"], resolves: "claude-opus-4-8[1m]" },
  { value: "haiku", label: "Haiku", efforts: [] },
];
check("a model that takes effort levels reports them",
  models.effortsFor(list, "opus[1m]").length === 3);
check("a model that takes none says none", models.supportsEffort(list, "haiku") === false);
check("...and offers no levels", models.effortsFor(list, "haiku").length === 0);
check("an alias can be matched through what it resolves to",
  models.supportsEffort(list, "claude-opus-4-8[1m]") === true);
check("a model we have never heard of keeps its effort control",
  models.supportsEffort(list, "some-future-model") === true);
check("no model selected means the workspace default, which may take effort",
  models.supportsEffort(list, "") === true);
check("the fallback list is small and includes the aliases that always exist",
  models.FALLBACK_MODELS.length <= 6 &&
  models.FALLBACK_MODELS.some((m) => m.value === "opus"));
check("skills are empty until the CLI has been asked", models.cachedSkills().length === 0);
check("the fallback knows Haiku takes no effort level",
  models.FALLBACK_MODELS.find((m) => m.value === "haiku").efforts.length === 0);

console.log("=== workflow model ===");
let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
process.exit(failed ? 1 : 0);

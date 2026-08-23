/**
 * Drives the real bundled extension against a stub `vscode`: composer readiness,
 * the no-folder first run, and the direct-line gate. No API calls.
 */
import * as esbuild from "esbuild";
import { baseOptions } from "./esbuild-shared.mjs";
import Module from "node:module";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A stand-in executable so resolution is deterministic. Without it the suite
// falls through to `which claude` and quietly depends on the host having Claude
// Code installed — green locally, red in CI.
const fakeCli = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cadre-cli-")), "claude");
fs.writeFileSync(fakeCli, "#!/bin/sh\nexit 0\n");
fs.chmodSync(fakeCli, 0o755);

const settings = {
  "cadre.directLine": false,
  "cadre.autonomy": "standard",
  "cadre.inheritGlobalConfig": false,
  "cadre.billing": "subscription",
  "cadre.claudeExecutablePath": fakeCli,
};
const state = { workspaceFolders: undefined };
/** Folder-scoped overrides, keyed by fsPath. */
const folderSettings = {};
const shownErrors = [];
const secrets = new Map();

/**
 * A webview panel that records what was done to it. Restoring a panel after a
 * window reload is the case that matters: VS Code hands the extension a panel
 * that still has a tab but no html, no listener, and default resource roots.
 */
const panels = [];
function makePanel(viewType = "cadre.floor") {
  const panel = {
    viewType,
    webview: {
      options: {}, html: "", cspSource: "x", asWebviewUri: (u) => u,
      onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async () => true,
    },
    disposed: false, revealed: 0,
    onDidDispose: (cb) => { panel.__onDispose = cb; return { dispose() {} }; },
    reveal: () => { panel.revealed += 1; },
    dispose: () => { panel.disposed = true; panel.__onDispose?.(); },
  };
  panels.push(panel);
  return panel;
}

const vscodeStub = {
  Uri: { joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join("/") }) },
  ViewColumn: { Active: -1 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Disposable: class { constructor(fn) { this.dispose = fn || (() => {}); } },
  window: {
    createOutputChannel: () => ({
      // Captured, because some behaviour is only observable in the log — the
      // executable resolver, for one, reports what it found and why.
      info: (m) => logged.push(String(m)), warn: (m) => logged.push(String(m)),
      error: (m) => logged.push(String(m)), debug: () => {},
      show: () => {}, dispose: () => {},
    }),
    registerWebviewViewProvider: (_id, provider) => { vscodeStub.__provider = provider; return { dispose() {} }; },
    registerWebviewPanelSerializer: (id, serializer) => {
      (vscodeStub.__serializers ??= {})[id] = serializer;
      return { dispose() {} };
    },
    createWebviewPanel: (...args) => makePanel(...args),
    showErrorMessage: async (m) => { shownErrors.push(m); return undefined; },
    showWarningMessage: async () => vscodeStub.__warn,
    showInformationMessage: async () => undefined,
    showQuickPick: async (items) => {
      const resolved = await items;
      return vscodeStub.__pick ? vscodeStub.__pick(resolved) : undefined;
    },
    showInputBox: async () => vscodeStub.__input,
  },
  commands: {
    registerCommand: (id, fn) => { (vscodeStub.__commands ??= {})[id] = fn; return { dispose() {} }; },
    executeCommand: async () => undefined,
  },
  workspace: {
    getConfiguration: (prefix, scope) => ({
      // Real VS Code exposes inspect(); the trust layer needs it to tell a
      // repo-supplied value from one the user chose.
      inspect: (key) => ({
        key: `${prefix}.${key}`,
        globalValue: settings[`${prefix}.${key}`],
        workspaceFolderValue: scope ? folderSettings[scope.fsPath]?.[`${prefix}.${key}`] : undefined,
      }),
      get: (key) => {
        const perFolder = scope && folderSettings[scope.fsPath];
        if (perFolder && `${prefix}.${key}` in perFolder) return perFolder[`${prefix}.${key}`];
        return settings[`${prefix}.${key}`];
      },
      update: async (key, value, target) => {
        if (target === 3 && scope) {
          (folderSettings[scope.fsPath] ??= {})[`${prefix}.${key}`] = value;
          return;
        }
        settings[`${prefix}.${key}`] = value;
      },
    }),
    get workspaceFolders() { return state.workspaceFolders; },
    onDidChangeWorkspaceFolders: (cb) => { vscodeStub.__onFolders = cb; return { dispose() {} }; },
    onDidChangeConfiguration: (cb) => { vscodeStub.__onConfig = cb; return { dispose() {} }; },
  },
};

const originalLoad = Module._load;
const spawns = { count: 0 };
const logged = [];
Module._load = (request, parent, isMain) => {
  if (request === "vscode") return vscodeStub;
  // Finding the executable on PATH means a *synchronous* subprocess on the
  // extension host thread. Counting them is the only way to notice one
  // creeping back into a hot path.
  if (request === "node:child_process" || request === "child_process") {
    const real = originalLoad.call(Module, request, parent, isMain);
    return new Proxy(real, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== "execFileSync") return value;
        return (...args) => { spawns.count += 1; (spawns.what ??= []).push(String(args[0])); return value(...args); };
      },
    });
  }
  return originalLoad.call(Module, request, parent, isMain);
};

const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-team-ui-")), "extension.cjs");
// Alias the SDK out: listSessions would otherwise read the real session store,
// which is green locally and empty in CI — the exact split that had CI red.
await esbuild.build({
  ...baseOptions({ entry: "src/extension.ts", outfile }),
  alias: { "@anthropic-ai/claude-agent-sdk": path.resolve("scripts/fake-sdk.mjs") },
  logLevel: "warning",
});
const fake = await import("./fake-sdk.mjs");

const require = createRequire(import.meta.url);
const ext = require(outfile);
const workspaceState = new Map();
ext.activate({
  subscriptions: [],
  extensionUri: { fsPath: process.cwd() },
  workspaceState: {
    get: (k, d) => (workspaceState.has(k) ? workspaceState.get(k) : d),
    update: async (k, v) => { workspaceState.set(k, v); },
  },
  secrets: {
    get: async (k) => secrets.get(k),
    store: async (k, v) => { secrets.set(k, v); },
    delete: async (k) => { secrets.delete(k); },
  },
});

const posted = [];
let receive;
const view = {
  webview: {
    options: {}, html: "", cspSource: "vscode-resource:", asWebviewUri: (u) => u,
    onDidReceiveMessage: (cb) => { receive = cb; return { dispose() {} }; },
    postMessage: async (m) => { posted.push(m); return true; },
  },
  onDidDispose: () => ({ dispose() {} }),
};
vscodeStub.__provider.resolveWebviewView(view);

/**
 * A second surface, to check what someone opening the view mid-session sees.
 * `private` in TypeScript is a compile-time fiction, so the controller the
 * provider is holding is reachable here.
 */
const controller = vscodeStub.__provider.controller;
function makeSurface() {
  const seen = [];
  let send;
  const webview = {
    options: {}, html: "", cspSource: "x", asWebviewUri: (u) => u,
    onDidReceiveMessage: (cb) => { send = cb; return { dispose() {} }; },
    postMessage: async (m) => { seen.push(m); return true; },
  };
  const handle = controller.attach(webview);
  return { seen, ready: () => send({ kind: "ready" }), dispose: () => handle.dispose() };
}
/** Feeds an event through the same path the runner uses. */
const emit = (event) => controller["broadcast"](event);

const last = (kind) => [...posted].reverse().find((m) => m.kind === kind);
const settle = () => new Promise((r) => setTimeout(r, 40));
/** Waits for a specific message rather than a fixed delay, so screen
 *  transitions (which resolve asynchronously) cannot race the assertion. */
async function waitFor(kind, predicate = () => true, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = [...posted].reverse().find((m) => m.kind === kind && predicate(m));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
}
const checks = [];
const check = (label, ok) => checks.push([label, ok]);

// ---- first run: no folder open ---------------------------------------------
receive({ kind: "ready" });
await settle();
const blocked = last("sendability");
check("no folder -> composer blocked", blocked?.ok === false);
check("no folder -> reason says to open one", /open a folder/i.test(blocked?.reason ?? ""));

posted.length = 0;
receive({ kind: "send", text: "build me a thing" });
await settle();
check("blocked send -> text handed back", last("restoreInput")?.text === "build me a thing");
check("blocked send -> nothing rendered as said", !posted.some((m) => m.kind === "userSaid"));
check("blocked send -> native prompt offered", shownErrors.length === 1);

// ---- folder opened ----------------------------------------------------------
state.workspaceFolders = [{ uri: { fsPath: process.cwd() } }];
posted.length = 0;
vscodeStub.__onFolders();
await settle();
// A folder alone is not enough any more: agents come from a workflow.
check("folder but no workflow -> still blocked", last("sendability")?.ok === false);
check("...and it says which of the two is missing",
  /open a workflow/i.test(last("sendability")?.reason ?? ""));

// ---- creating a workflow from a template -----------------------------------
const project = process.cwd();
const wfDir = path.join(project, ".cadre", "workflows");
fs.rmSync(wfDir, { recursive: true, force: true });

posted.length = 0;
// A template must not stop to ask for a name: the builder is a better place to
// change it than a modal shown before you have seen what you are naming.
vscodeStub.__input = undefined;
receive({ kind: "newWorkflow", template: "software-team" });
await settle();
check("picking a template goes straight to the builder, no questions",
  (await waitFor("screen", (m) => m.screen === "builder"))?.screen === "builder");
const editing = last("editing");
check("the template's agents come with it", editing?.workflow.agents.length === 3);
check("it takes the template's own name", editing?.workflow.name === "Software team");
check("the template is written to the project",
  fs.existsSync(path.join(wfDir, "software_team.json")));
check("a new workflow is local unless asked otherwise", editing?.workflow.scope === "local");
check("the builder is given the presets to offer", (editing?.presets ?? []).length >= 4);
check("...and the tool catalogue for the advanced panel", (editing?.catalogue ?? []).length > 0);
check("a runnable template reports no errors",
  (editing?.problems ?? []).every((p) => p.level !== "error"));

// ---- live validation while drawing -----------------------------------------
posted.length = 0;
const broken = JSON.parse(JSON.stringify(editing.workflow));
broken.edges.push({ from: "engineer", to: "lead", kind: "then" });
broken.edges.push({ from: "lead", to: "engineer", kind: "then" });
receive({ kind: "checkWorkflow", workflow: broken });
await settle();
const validated = last("editing");
check("a 'then' loop drawn in the builder is reported at once",
  (validated?.problems ?? []).some((p) => p.level === "error" && /loop/i.test(p.message)));
check("validating does not write the broken graph to disk",
  JSON.parse(fs.readFileSync(path.join(wfDir, "software_team.json"), "utf8")).edges.length === 4);

// ---- launching ---------------------------------------------------------------
posted.length = 0;
receive({ kind: "saveWorkflow", workflow: editing.workflow, launch: true });
await settle();
check("launching opens the run view",
  (await waitFor("screen", (m) => m.screen === "run"))?.screen === "run");
check("a launched workflow unblocks the composer", last("sendability")?.ok === true);

// ---- switching who you talk to ----------------------------------------------
posted.length = 0;
receive({ kind: "setChannel", to: "engineer" });
await settle();
check("you can address any agent without a settings gate", last("channel")?.to === "engineer");
posted.length = 0;
receive({ kind: "setChannel", to: "nobody" });
await settle();
check("an agent that is not in the workflow is refused",
  !posted.some((m) => m.kind === "channel"));
receive({ kind: "setChannel", to: "lead" });
await settle();

// ---- a workflow that cannot run goes to the builder, not the run view -------
const halfBuilt = {
  id: "half", name: "Half built", entry: "", agents: [], edges: [],
  createdAt: 1, updatedAt: 1, revision: 1,
};
fs.writeFileSync(path.join(wfDir, "half.json"), JSON.stringify(halfBuilt));
posted.length = 0;
receive({ kind: "openWorkflow", id: "half" });
await settle();
check("an unfinished workflow opens in the builder instead of running",
  (await waitFor("screen", (m) => m.screen === "builder"))?.screen === "builder");
check("...and says why", posted.some((m) => m.kind === "notice" && /not finished/i.test(m.text)));

// ---- the home screen lists what is in the project ---------------------------
posted.length = 0;
receive({ kind: "goHome" });
await settle();
check("Home is the workflow list",
  (await waitFor("screen", (m) => m.screen === "home"))?.screen === "home");
const listing = last("workflows");
check("every workflow in the project is listed", (listing?.items ?? []).length === 2);
check("a broken one is flagged with a count, not hidden",
  (listing?.items ?? []).some((w) => w.id === "half" && w.problems > 0));
check("templates are offered alongside", (listing?.templates ?? []).length >= 3);

fs.rmSync(path.join(wfDir, "half.json"), { force: true });

// ---- API-key billing without a key blocks, with a remedy --------------------
settings["cadre.billing"] = "apiKey";
posted.length = 0;
vscodeStub.__onConfig({ affectsConfiguration: () => true });
await settle();
const noKey = last("sendability");
check("api-key billing with no key blocks", noKey?.ok === false);
check("api-key billing names the remedy", /Set API Key/i.test(noKey?.reason ?? ""));

// ---- multi-root: every folder must be reachable ----------------------------
// Real directories: project discovery stats the filesystem, so fake paths would
// silently produce an empty list and prove nothing.
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-team-ws-"));
const mkProject = (name, marker) => {
  const dir = path.join(workRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  if (marker) fs.writeFileSync(path.join(dir, marker), "{}");
  return { name, uri: { fsPath: dir } };
};
const A = mkProject("alpha", "package.json");
const B = mkProject("beta", "pyproject.toml");
mkProject("gamma", "Cargo.toml");          // discoverable but not open
mkProject("notes", null);                  // no marker -> must not be listed
state.workspaceFolders = [A, B];
posted.length = 0;
vscodeStub.__onFolders();
await settle();

// Drive the real command rather than asserting on the stub.
vscodeStub.__pick = (items) => items.find((i) => i.label === "beta");
posted.length = 0;
await vscodeStub.__commands["cadre.selectProject"]();
await settle();

check("multi-root: selecting a project switches to it",
  posted.some((m) => m.kind === "notice" && /working in beta/i.test(m.text)));
check("multi-root: switching starts a clean session",
  posted.some((m) => m.kind === "clear"));
check("multi-root: the choice is remembered",
  workspaceState.get("cadre.activeFolder") === B.uri.fsPath);

// A folder leaving the workspace must not strand the team on a dead path.
state.workspaceFolders = [A];
posted.length = 0;
vscodeStub.__onFolders();
await settle();
check("multi-root: a removed active folder is released",
  workspaceState.get("cadre.activeFolder") === undefined);
vscodeStub.__pick = undefined;
state.workspaceFolders = [A, B];

// Folder-scoped settings must actually resolve per folder.
folderSettings[B.uri.fsPath] = { "cadre.autonomy": "supervised" };
settings["cadre.autonomy"] = "standard";
const readFor = (uri) => vscodeStub.workspace.getConfiguration("cadre", uri).get("autonomy");
check("per-project profile: alpha uses the window value", readFor(A.uri) === "standard");
check("per-project profile: beta overrides it", readFor(B.uri) === "supervised");

// Applying a profile writes at WorkspaceFolder scope, so it travels with the project.
await vscodeStub.workspace
  .getConfiguration("cadre", A.uri)
  .update("documentation", "always", vscodeStub.ConfigurationTarget.WorkspaceFolder);
check("profiles are written per folder, not per window",
  folderSettings[A.uri.fsPath]?.["cadre.documentation"] === "always" &&
  settings["cadre.documentation"] === undefined);

// ---- screens: signed out must be a screen, not a red box in the transcript --
// API-key mode is used here so the check stays hermetic (it never shells out).
settings["cadre.billing"] = "apiKey";
secrets.delete("cadre.anthropicApiKey");
posted.length = 0;
receive({ kind: "ready" });
await settle();
const gate = await waitFor("screen", (m) => m.screen === "auth");
check("signed out -> the auth screen, not the chat", gate?.screen === "auth");
const gateAuth = await waitFor("auth", (m) => m.signedIn === false);
check("signed out -> says why", /no key/i.test(gateAuth?.detail ?? ""));
check("signed out -> not reported as signed in", gateAuth?.signedIn === false);

// ---- with a credential, the home screen is the project list ----------------
secrets.set("cadre.anthropicApiKey", "sk-ant-test-0123456789abcdef");
// A send earlier in this file already took the user off the home screen, which
// is correct behaviour — ask for it explicitly.
receive({ kind: "goHome" });
posted.length = 0;
receive({ kind: "refreshAuth" });
await settle();
check("credential present -> home is the workflow list",
  (await waitFor("screen", (m) => m.screen === "home"))?.screen === "home");

// The project list is still reachable, it is just no longer the landing page.
receive({ kind: "selectProject" });
await settle();
check("the project switcher is still reachable",
  (await waitFor("screen", (m) => m.screen === "projects"))?.screen === "projects");
const listed = await waitFor("projects");
check("the project list is populated", (listed?.items?.length ?? 0) > 0);
check("open folders are marked as open", listed?.items?.some((i) => i.open));
check("the roots being scanned are stated", (listed?.roots?.length ?? 0) > 0);
check("a sibling project is discovered, not just open ones",
  listed?.items?.some((i) => i.name === "gamma" && !i.open));
check("a folder with no project markers is not listed",
  !listed?.items?.some((i) => i.name === "notes"));

// ---- signing in must update the state, not sit on a cached answer ----------
// Signing in happens in a terminal, outside the extension, so the cached
// "not signed in" has to be invalidated rather than waited out.
secrets.delete("cadre.anthropicApiKey");
receive({ kind: "refreshAuth" });
check("cache invalidated -> back to the gate",
  (await waitFor("screen", (m) => m.screen === "auth"))?.screen === "auth");

posted.length = 0;
secrets.set("cadre.anthropicApiKey", "sk-ant-test-0123456789abcdef");
receive({ kind: "refreshAuth" });
const recovered = await waitFor("auth", (m) => m.signedIn === true);
check("a credential appearing is picked up without a reload", recovered?.signedIn === true);
check("and the gate is left behind",
  (await waitFor("screen", (m) => m.screen !== "auth"))?.screen !== "auth");

// ---- choosing a project lands on that project's workflows -------------------
posted.length = 0;
receive({ kind: "openProject", path: A.uri.fsPath, alreadyOpen: true });
await settle();
check("choosing a project shows its workflows",
  (await waitFor("screen", (m) => m.screen === "home"))?.screen === "home");
check("...which are that project's, not the last one's",
  last("workflows")?.project === "alpha");

// ---- the sign-in affordance must survive every screen ----------------------
// `claude auth status` reports loggedIn:true for an expired token, so the gate
// can fail to fire while the user is effectively signed out. The account
// control is the escape hatch and must never be conditional.
const html = view.webview.html;
check("the header carries an account control", /id="account"/.test(html));
// "Floor" was internal jargon nobody outside the source could decode.
check("the full-view control says what it does",
  /id="openFloor"[^>]*>[^<]*Full view/.test(html));
check("...and its tooltip explains why you would want it",
  /Open this workflow in a full editor tab/.test(html));
check("it is a button, not a static chip", /<button[^>]*id="account"/.test(html));

for (const screen of ["auth", "projects", "home", "builder", "run"]) {
  const hidesAccount = new RegExp(`"${screen}"[\\s\\S]{0,400}?el\\.account[\\s\\S]{0,80}?display`, "m");
  check(`the account control is not hidden on the ${screen} screen`,
    !hidesAccount.test(fs.readFileSync("media/team.js", "utf8")));
}

const teamJs = fs.readFileSync("media/team.js", "utf8");
check("clicking it asks the host for account options",
  /el\.account\.addEventListener\("click"/.test(teamJs));
check("it renders a sign-in label when signed out",
  /e\.signedIn \? e\.detail : "sign in"/.test(teamJs));

// ---- past sessions belong to a workflow, not to the project -----------------
// Two workflows in one folder share the CLI's session store, so the index is
// what keeps one from showing the other's history.
state.workspaceFolders = [{ uri: { fsPath: project } }];
vscodeStub.__onFolders();
await settle();

fake.__registry.sessions = [
  { sessionId: "s-1", customTitle: "Urdu TTS feasibility", lastModified: Date.now() - 3 * 3600_000 },
  { sessionId: "s-2", summary: "fix the decoder truncation", lastModified: Date.now() - 26 * 3600_000 },
  { sessionId: "s-3", firstPrompt: "set up CI", lastModified: Date.now() - 9 * 60_000 },
  { sessionId: "other-1", summary: "belongs to a different workflow", lastModified: Date.now() },
];
fs.writeFileSync(path.join(wfDir, "software_team.sessions.json"), JSON.stringify([
  { sessionId: "s-1", title: "Urdu TTS feasibility", when: 3 },
  { sessionId: "s-2", title: "fix the decoder truncation", when: 2 },
  { sessionId: "s-3", title: "set up CI", when: 1 },
]));

posted.length = 0;
receive({ kind: "openWorkflow", id: "software_team" });
const stored = await waitFor("sessions", (m) => (m.items?.length ?? 0) > 0);
check("opening a workflow lists its past sessions", stored?.items?.length === 3);
check("a custom title is preferred",
  stored?.items?.some((i) => i.title === "Urdu TTS feasibility"));
check("a session with only a first prompt still gets a label",
  stored?.items?.some((i) => i.title === "set up CI"));
check("another workflow's session is not shown",
  !stored?.items?.some((i) => i.id === "other-1"));
check("the sessions are attributed to the workflow they belong to",
  stored?.workflowId === "software_team");

// Resuming must bring the conversation back, not just the model's memory.
fake.__registry.messages = [
  { type: "user", uuid: "u1", parent_tool_use_id: null,
    message: { role: "user", content: "the decoder drops the last word" } },
  { type: "assistant", uuid: "a1", parent_tool_use_id: null, message: { role: "assistant", content: [
    { type: "text", text: "Reproduced. Briefing the Engineer." },
    { type: "tool_use", id: "t1", name: "mcp__team__brief_engineer",
      input: { objective: "Write a failing test for the dropped word" } },
  ] } },
  { type: "user", uuid: "u2", parent_tool_use_id: null, message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "t1",
      content: "VERDICT: DONE\nHEADLINE: the tokenizer drops a trailing space, not the decoder" },
  ] } },
  { type: "assistant", uuid: "a2", parent_tool_use_id: "t1", message: { role: "assistant", content: [
    { type: "text", text: "internal to the teammate run" },
  ] } },
  // The CLI writes this into the user role itself; replaying it as a chat
  // bubble would show the user saying something they never typed.
  { type: "user", uuid: "u2b", parent_tool_use_id: null, message: { role: "user", content: [
    { type: "text", text: "[Request interrupted by user for tool use]" },
  ] } },
  { type: "assistant", uuid: "a3", parent_tool_use_id: null, message: { role: "assistant", content: [
    { type: "thinking", thinking: "the diff will show whether the fix landed" },
    { type: "tool_use", id: "t2", name: "git_view", input: { subcommand: "diff" } },
  ] } },
  { type: "user", uuid: "u3", parent_tool_use_id: null, message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "t2", is_error: true, content: "not a git repository" },
  ] } },
];

posted.length = 0;
receive({ kind: "resumeSession", id: "s-2", title: "fix the decoder truncation" });
await settle();
check("resuming a session leaves the home screen",
  (await waitFor("screen", (m) => m.screen === "run"))?.screen === "run");
check("resuming says which conversation it reopened",
  posted.some((m) => m.kind === "notice" && /decoder truncation/.test(m.text)));

const said = posted.filter((m) => m.kind === "userSaid");
check("what you said is replayed",
  said.some((m) => /drops the last word/.test(m.text)));
check("a tool result is not replayed as something you said",
  !said.some((m) => /VERDICT/.test(m.text)));
check("the Lead's replies are replayed",
  posted.some((m) => m.kind === "say" && /Reproduced/.test(m.delta)));
check("delegations come back as assignment cards",
  posted.some((m) => m.kind === "assign" && m.assignment.to === "engineer"));
check("ordinary tool calls come back as chips",
  posted.some((m) => m.kind === "act" && m.tool === "git_view"));
check("a teammate's internal messages are not replayed into the Lead's lane",
  !posted.some((m) => m.kind === "say" && /internal to the teammate/.test(m.delta)));
check("a delegation replays with the report that came back",
  posted.some((m) => m.kind === "deliver" && m.outcome === "delivered" && /trailing space/.test(m.summary)));
check("a tool call that failed replays as failed",
  posted.some((m) => m.kind === "actEnd" && m.ok === false && /not a git repository/.test(m.summary)));
check("an interruption is shown as what it is, not as something you typed",
  posted.some((m) => m.kind === "notice" && /Request interrupted/.test(m.text)) &&
  !posted.some((m) => m.kind === "userSaid" && /Request interrupted/.test(m.text)));
check("reasoning is replayed when the store kept it",
  posted.some((m) => m.kind === "think" && /whether the fix landed/.test(m.delta)));
check("the end of the replayed history is marked",
  posted.some((m) => m.kind === "notice" && /end of the earlier conversation/.test(m.text)));
check("empty teammate lanes above the line are explained, not left to imply idleness",
  posted.some((m) => m.kind === "notice" && /own session/.test(m.text)));
// The composer must lock while history streams in, or a reply lands above the
// conversation it answers.
const gates = posted.filter((m) => m.kind === "sendability");
check("sending is blocked while the transcript loads",
  gates.some((m) => m.ok === false && /earlier conversation/i.test(m.reason ?? "")));
check("sending is unblocked once the transcript is in",
  gates.length > 0 && gates[gates.length - 1].ok === true);

posted.length = 0;
receive({ kind: "goHome" });
check("Home returns from a resumed session",
  (await waitFor("screen", (m) => m.screen === "home"))?.screen === "home");

check("the header carries a Home control", /id="home"/.test(view.webview.html));

// ---- opening a workflow must show it, before anything runs -------------------
// The board used to be built only from a live session's init message, so it sat
// empty — no lanes, no "talking to" options, no workflow id for the Edit button
// — until you spent a turn.
posted.length = 0;
receive({ kind: "openWorkflow", id: "software_team" });
await settle();
const board = last("roster");
check("opening a workflow publishes its agents immediately",
  (board?.members?.length ?? 0) === 3);
check("...without starting a session", !posted.some((m) => m.kind === "spend"));
check("the roster names the workflow, so Edit has something to open",
  board?.workflowId === "software_team");
check("the arrows come with it, so the map can be drawn",
  (board?.edges?.length ?? 0) === 4);
check("the entry agent is marked",
  board?.members?.filter((m) => m.entry).length === 1);
check("each agent carries its canvas position",
  board?.members?.every((m) => typeof m.x === "number"));
check("each agent carries the model it will actually use",
  board?.members?.every((m) => Boolean(m.model)));

// ---- a workflow's own page ---------------------------------------------------
// Opening a workflow lands on its page, not in a chat: most of the time you are
// coming back to a conversation rather than starting one.
posted.length = 0;
receive({ kind: "showWorkflow", id: "software_team" });
await settle();
check("opening a workflow shows its page",
  (await waitFor("screen", (m) => m.screen === "workflow"))?.screen === "workflow");
const detail = last("detail");
check("the page carries the graph", detail?.workflow.agents.length === 3);
check("...and the conversations under it", (detail?.sessions?.length ?? 0) === 3);
check("...and anything that would stop it running",
  Array.isArray(detail?.problems));

posted.length = 0;
receive({ kind: "startSession", id: "software_team" });
await settle();
check("starting a conversation opens the run view",
  (await waitFor("screen", (m) => m.screen === "run"))?.screen === "run");
check("...on a clean board", posted.some((m) => m.kind === "clear"));

// ---- global workflows --------------------------------------------------------
// A global workflow lives in the home directory and shows up in every project.
const globalDir = path.join(os.homedir(), ".cadre", "workflows");
const globalId = "verify_ui_global";
fs.rmSync(path.join(globalDir, `${globalId}.json`), { force: true });

posted.length = 0;
receive({ kind: "moveWorkflow", id: "software_team", to: "global" });
await settle();
check("a workflow can be moved out of the project",
  fs.existsSync(path.join(globalDir, "software_team.json")));
check("...and is gone from the project",
  !fs.existsSync(path.join(wfDir, "software_team.json")));
check("moving it says what changed",
  posted.some((m) => m.kind === "notice" && /every project/i.test(m.text)));

posted.length = 0;
receive({ kind: "goHome" });
await settle();
const scoped = last("workflows");
check("a global workflow is listed",
  (scoped?.items ?? []).some((w) => w.id === "software_team" && w.scope === "global"));

// Its conversations stay with the project, not with the workflow: the same
// global workflow used in two repositories has two separate histories.
check("its session index stayed in the project",
  fs.existsSync(path.join(wfDir, "software_team.sessions.json")));

posted.length = 0;
receive({ kind: "moveWorkflow", id: "software_team", to: "local" });
await settle();
check("and it can be moved back",
  fs.existsSync(path.join(wfDir, "software_team.json")) &&
  !fs.existsSync(path.join(globalDir, "software_team.json")));

// ---- workflow-level defaults ---------------------------------------------------
const withDefaults = JSON.parse(fs.readFileSync(path.join(wfDir, "software_team.json"), "utf8"));
withDefaults.defaults = { model: "sonnet", effort: "low" };
receive({ kind: "saveWorkflow", workflow: withDefaults });
await settle();
check("workflow defaults are persisted",
  JSON.parse(fs.readFileSync(path.join(wfDir, "software_team.json"), "utf8")).defaults.model === "sonnet");

// ---- resolving the executable must not spawn a process every time -----------
// It is a synchronous subprocess on the extension host thread, and it used to
// run on every readiness check — so every settings change and folder change
// blocked the UI on it.
delete settings["cadre.claudeExecutablePath"];
posted.length = 0;
spawns.count = 0;
// A change to some *other* Cadre setting. Real VS Code answers
// affectsConfiguration per section, so a blanket `true` would be claiming the
// executable path changed — which legitimately invalidates the cache.
for (let i = 0; i < 12; i += 1) {
  vscodeStub.__onConfig({ affectsConfiguration: (k) => k === "cadre" });
  await settle();
}
const repeated = spawns.count;
if (repeated > 2) console.log("SPAWNED:", JSON.stringify((spawns.what || []).slice(0, 4)));
check(`twelve unrelated setting changes resolve the executable once, not twelve times (${repeated})`,
  repeated <= 2);

settings["cadre.claudeExecutablePath"] = fakeCli;
vscodeStub.__onConfig({ affectsConfiguration: (k) => k.includes("claudeExecutablePath") });
await settle();
const settled = spawns.count;
for (let i = 0; i < 5; i += 1) {
  vscodeStub.__onConfig({ affectsConfiguration: (k) => k === "cadre" });
  await settle();
}
check("a configured path needs no PATH search at all", spawns.count === settled);

// Changing the path must invalidate the cache, or the setting appears inert.
// Asserted on the wiring: the effect is not observable from here, because the
// resolver finds the SDK's bundled binary before it ever reaches PATH.
const wiring = fs.readFileSync("src/extension.ts", "utf8");
check("changing cadre.claudeExecutablePath clears the cached resolution",
  /affectsConfiguration\("cadre\.claudeExecutablePath"\)\)\s*clearExecutableCache\(\)/.test(wiring));

// ---- a long session must not grow without bound ------------------------------
// Streamed prose arrives one delta at a time. Every delta used to be kept, so a
// single turn pushed thousands of objects into the replay log and the same
// thousands into every webview.
emit({ kind: "clear" });
for (let i = 0; i < 5000; i += 1) emit({ kind: "say", who: "lead", turn: "t1", delta: "x" });
emit({ kind: "sayEnd", who: "lead", turn: "t1" });
emit({ kind: "say", who: "lead", turn: "t2", delta: "second" });

const joining = makeSurface();
joining.ready();
await settle();
const replayed = joining.seen.filter((m) => m.kind === "say");
check("5000 streamed deltas replay as one message, not five thousand",
  replayed.length === 2);
check("...with none of the text lost",
  replayed.find((m) => m.turn === "t1")?.delta.length === 5000);
check("a different turn stays a different message",
  Boolean(replayed.find((m) => m.turn === "t2")));
joining.dispose();

// And the log is capped whatever else happens.
for (let i = 0; i < 6000; i += 1) emit({ kind: "notice", level: "info", text: `n${i}` });
const late = makeSurface();
late.ready();
await settle();
const notices = late.seen.filter((m) => m.kind === "notice");
check("the replay log is capped rather than growing forever", notices.length < 5200);
check("...and says history was dropped instead of starting mid-sentence",
  notices.some((m) => /not shown here/.test(m.text)));
late.dispose();
emit({ kind: "clear" });

// ---- autosave --------------------------------------------------------------
// The whole point is that it never interrupts. It must reach disk without
// moving the user, and without resetting the session they are talking to.
receive({ kind: "openWorkflow", id: "software_team" });
await settle();
const live = last("screen")?.screen;

posted.length = 0;
const edited = JSON.parse(fs.readFileSync(path.join(wfDir, "software_team.json"), "utf8"));
edited.agents[0].role = "changed by an autosave";
receive({ kind: "saveWorkflow", workflow: edited, auto: true });
await settle();

check("an autosave reaches disk",
  JSON.parse(fs.readFileSync(path.join(wfDir, "software_team.json"), "utf8"))
    .agents[0].role === "changed by an autosave");
check("an autosave is acknowledged so the UI can stop saying 'unsaved'",
  last("saved")?.auto === true);
check("an autosave does not move the user off the screen they are on",
  (last("screen")?.screen ?? live) === live);
check("an autosave does not reset the running session",
  !posted.some((m) => m.kind === "notice" && /session was reset/i.test(m.text)));

posted.length = 0;
edited.agents[0].role = "changed deliberately";
receive({ kind: "saveWorkflow", workflow: edited });
await settle();
check("an explicit save is acknowledged as deliberate", last("saved")?.auto === false);
check("an explicit save does reset the running session, and says so",
  posted.some((m) => m.kind === "notice" && /session was reset/i.test(m.text)));

// ---- the builder must be told when it may replace its own draft -------------
posted.length = 0;
receive({ kind: "editWorkflow", id: "software_team" });
await settle();
check("opening a workflow to edit is authoritative",
  posted.some((m) => m.kind === "editing" && m.authoritative === true));
posted.length = 0;
receive({ kind: "checkWorkflow", workflow: edited });
await settle();
check("a re-validate is not — it must not overwrite unsaved edits",
  posted.some((m) => m.kind === "editing") &&
  posted.filter((m) => m.kind === "editing").every((m) => m.authoritative === false));

// ---- deleting a workflow ----------------------------------------------------
// The confirmation is modal, so this exercises the declined path too: a
// workflow must survive a dialog the user dismissed.
vscodeStub.__warn = undefined;
posted.length = 0;
receive({ kind: "deleteWorkflow", id: "software_team" });
await settle();
check("a declined delete leaves the workflow alone",
  fs.existsSync(path.join(wfDir, "software_team.json")));

vscodeStub.__warn = "Delete";
posted.length = 0;
receive({ kind: "deleteWorkflow", id: "software_team" });
await settle();
check("a confirmed delete removes it", !fs.existsSync(path.join(wfDir, "software_team.json")));
check("...and its session index with it",
  !fs.existsSync(path.join(wfDir, "software_team.sessions.json")));
check("deleting returns you to the list",
  (await waitFor("screen", (m) => m.screen === "home"))?.screen === "home");
vscodeStub.__warn = undefined;


// ---- the full-view tab survives a window reload ---------------------------
// VS Code persists the tab itself, then hands it back on the next launch. A
// restored panel keeps its tab but none of its wiring — no html, no message
// listener, and resource roots reset to the workspace, so its script will not
// load. Unregistered, it comes back as a blank tab that never fills in, which
// reads as a hang rather than as a tab to close.
const serializer = vscodeStub.__serializers?.["cadre.floor"];
check("the full-view panel registers a serializer", Boolean(serializer));

if (serializer) {
  panels.length = 0;
  const restored = makePanel("cadre.floor");
  restored.webview.html = "";
  restored.webview.options = {};
  await serializer.deserializeWebviewPanel(restored, undefined);

  check("a restored panel gets its html back", restored.webview.html.includes("<script"));
  check("...and its scripts re-enabled", restored.webview.options.enableScripts === true);
  check("...and its resource root back to the extension's media folder",
    (restored.webview.options.localResourceRoots ?? []).some((u) => String(u.fsPath).endsWith("/media")));
  check("...and is attached to the controller",
    typeof restored.webview.postMessage === "function" && restored.webview.html.length > 0);

  // Revealing after a restore must not build a second panel: two panels both
  // attached to one controller would fight over the same state.
  const before = panels.length;
  await vscodeStub.__commands["cadre.openTeamFloor"]();
  check("revealing an already-restored panel reuses it", panels.length === before);
  check("...by revealing rather than recreating", restored.revealed === 1);

  // And a panel disposed after being superseded must not tear down the live one.
  const second = makePanel("cadre.floor");
  await serializer.deserializeWebviewPanel(second, undefined);
  check("adopting a second panel disposes the stale one", restored.disposed === true);
  check("...and leaves the new one live", second.disposed === false);
  await vscodeStub.__commands["cadre.openTeamFloor"]();
  check("...and the new one is what reveal now finds", second.revealed === 1);
}


console.log("=== ui ===");
let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
// The credential watcher keeps the loop alive, so exit explicitly.
process.exit(failed ? 1 : 0);

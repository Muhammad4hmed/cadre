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
        // Real VS Code throws on a key that is not a registered configuration
        // property. The stub can be told to do the same, so the code that has
        // to survive it is actually exercised.
        if (vscodeStub.__rejectKey && `${prefix}.${key}` === vscodeStub.__rejectKey) {
          throw new Error(`Unable to write to Workspace Folder Settings because ${prefix}.${key} is not a registered configuration`);
        }
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
        return (...args) => {
          spawns.count += 1;
          (spawns.what ??= []).push(String(args[0]));
          // Recorded so the suite can assert this call is bounded. It is
          // synchronous and runs on the extension host thread: a lookup that
          // never returns freezes the editor and every extension in it.
          (spawns.options ??= []).push(args[2] ?? {});
          return value(...args);
        };
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

const modelsOut = path.join(path.dirname(outfile), "models.cjs");
await esbuild.build({
  ...baseOptions({ entry: "src/models.ts", outfile: modelsOut }),
  alias: { "@anthropic-ai/claude-agent-sdk": path.resolve("scripts/fake-sdk.mjs") },
  logLevel: "warning",
});

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
/**
 * Anything that rejects with nobody listening. Node exits on an unhandled
 * rejection, so without this a fire-and-forget handler that fails takes the
 * whole suite down and prints no results at all — the failure is detected and
 * unreadable. Collected here, it becomes a check with a name.
 */
const escaped = [];
process.on("unhandledRejection", (reason) => {
  escaped.push(reason instanceof Error ? reason.message : String(reason));
});

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
// A scratch directory, not the repository. The suite drives the real controller,
// which writes workflows and session indexes into the open folder — pointed at
// the working tree it left files behind, and .vscodeignore does not exclude
// .cadre, so a stray one was packaged into the extension users download.
const project = fs.mkdtempSync(path.join(os.tmpdir(), "cadre-project-"));
state.workspaceFolders = [{ uri: { fsPath: project } }];
posted.length = 0;
vscodeStub.__onFolders();
await settle();
// A folder alone is not enough any more: agents come from a workflow.
check("folder but no workflow -> still blocked", last("sendability")?.ok === false);
check("...and it says which of the two is missing",
  /open a workflow/i.test(last("sendability")?.reason ?? ""));

// ---- creating a workflow from a template -----------------------------------
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

// The same, in a workflow whose entry agent is not called "lead". This is the
// case that was broken: replay addressed a lane the workflow does not have, and
// placing into a missing lane fails silently, so the board came back empty.
// The suite only ever exercised the one template where the old hardcoding
// happened to be right.
receive({ kind: "newWorkflow", template: "marketing-department" });
await settle();
fs.writeFileSync(path.join(wfDir, "marketing_team.sessions.json"), JSON.stringify([
  { sessionId: "s-2", title: "positioning pass", when: 2 },
]));
receive({ kind: "openWorkflow", id: "marketing_team" });
await settle();
posted.length = 0;
receive({ kind: "resumeSession", id: "s-2", title: "positioning pass" });
await settle();
{
  const lanes = new Set(posted.filter((m) => m.who).map((m) => m.who));
  const addressed = posted.filter((m) => m.kind === "userSaid").map((m) => m.to);
  check("resuming addresses this workflow's entry agent, not one called lead",
    addressed.length > 0 && addressed.every((to) => to === "head"));
  check("...and no event is addressed to a lane this workflow does not have",
    [...lanes].every((who) => ["head", "audience", "positioning", "writer", "distribution", "analyst"].includes(who)));
  check("...and there is something to show at all", posted.some((m) => m.kind === "say"));
}
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

// ---- another writer got there first -----------------------------------------
// Workflows are files the product tells you to commit and hand-edit, so a
// second writer is routine: another window, a pull, an editor. An autosave that
// clobbers it loses work with no trace.
receive({ kind: "editWorkflow", id: "software_team" });
await settle();
const opened = last("editing").workflow;

// Someone else writes a newer revision while the builder holds an older one.
const theirs = JSON.parse(fs.readFileSync(path.join(wfDir, "software_team.json"), "utf8"));
theirs.name = "Renamed in another window";
theirs.revision = (theirs.revision ?? 0) + 5;
fs.writeFileSync(path.join(wfDir, "software_team.json"), JSON.stringify(theirs, null, 2));

posted.length = 0;
const mine = JSON.parse(JSON.stringify(opened));
mine.agents[0].role = "changed here";
receive({ kind: "saveWorkflow", workflow: mine, auto: true });
await settle();

check("an autosave does not overwrite a workflow that moved on disk",
  JSON.parse(fs.readFileSync(path.join(wfDir, "software_team.json"), "utf8"))
    .name === "Renamed in another window");
check("...and says so rather than failing silently",
  posted.some((m) => m.kind === "notice" && /changed on disk/i.test(m.text)));
check("...and does not claim to have saved",
  last("saved")?.conflict === true);
check("...and never asks during an autosave — the user is mid-sentence",
  !posted.some((m) => m.kind === "notice" && /overwrite/i.test(m.text)));

// A deliberate save asks, because now the user is present to answer.
vscodeStub.__warn = "Keep mine, overwrite theirs";
posted.length = 0;
receive({ kind: "saveWorkflow", workflow: mine });
await settle();
check("a deliberate save can overwrite once the user has chosen to",
  JSON.parse(fs.readFileSync(path.join(wfDir, "software_team.json"), "utf8"))
    .agents[0].role === "changed here");

// Or discard local edits and take what is on disk.
const newer = JSON.parse(fs.readFileSync(path.join(wfDir, "software_team.json"), "utf8"));
newer.name = "Renamed again elsewhere";
newer.revision = (newer.revision ?? 0) + 9;
fs.writeFileSync(path.join(wfDir, "software_team.json"), JSON.stringify(newer, null, 2));

vscodeStub.__warn = "Discard mine, reload theirs";
posted.length = 0;
receive({ kind: "saveWorkflow", workflow: mine });
await settle();
check("the other choice reloads what is on disk instead",
  last("editing")?.workflow.name === "Renamed again elsewhere");
check("...and the file is left as the other writer left it",
  JSON.parse(fs.readFileSync(path.join(wfDir, "software_team.json"), "utf8"))
    .name === "Renamed again elsewhere");

// Dismissing the dialog must lose nothing and write nothing.
const untouched = JSON.parse(fs.readFileSync(path.join(wfDir, "software_team.json"), "utf8"));
untouched.revision += 3;
fs.writeFileSync(path.join(wfDir, "software_team.json"), JSON.stringify(untouched, null, 2));
vscodeStub.__warn = undefined;
posted.length = 0;
receive({ kind: "saveWorkflow", workflow: mine });
await settle();
check("dismissing the conflict writes nothing",
  JSON.parse(fs.readFileSync(path.join(wfDir, "software_team.json"), "utf8")).revision === untouched.revision);
check("...and says the edits are still there",
  posted.some((m) => m.kind === "notice" && /still here/i.test(m.text)));
vscodeStub.__warn = undefined;

// A conflict check is only as good as the expectation behind it. Every path
// that writes a workflow has to refresh what we believe is on disk — moving one
// between scopes did not, so the next ordinary save looked like someone else's
// edit and was silently refused. A false conflict loses work just as surely as
// no conflict check at all.
receive({ kind: "editWorkflow", id: "software_team" });
await settle();
for (const [label, to] of [["global", "global"], ["back into the project", "local"]]) {
  posted.length = 0;
  receive({ kind: "moveWorkflow", id: "software_team", to });
  await settle();

  const after = last("editing")?.workflow
    ?? JSON.parse(fs.readFileSync(path.join(
      to === "global" ? path.join(os.homedir(), ".cadre", "workflows") : wfDir,
      "software_team.json"), "utf8"));
  const touched = JSON.parse(JSON.stringify(after));
  touched.agents[0].role = `saved after moving ${label}`;
  posted.length = 0;
  receive({ kind: "saveWorkflow", workflow: touched, auto: true });
  await settle();

  check(`saving after moving a workflow ${label} is not mistaken for a conflict`,
    last("saved")?.conflict !== true);

  // The invariant behind that, asserted directly: what the host believes is on
  // disk must equal what is on disk. Every write path has to maintain it, and a
  // path that forgets turns the next ordinary save into a false conflict.
  const where = to === "global"
    ? path.join(os.homedir(), ".cadre", "workflows") : wfDir;
  const real = JSON.parse(fs.readFileSync(path.join(where, "software_team.json"), "utf8"));
  check(`after moving ${label}, the tracked revision matches the file`,
    controller["onDisk"].get("software_team") === real.revision);
}

// Leave the file in a state the autosave tests below can work from.
receive({ kind: "moveWorkflow", id: "software_team", to: "local" });
await settle();
receive({ kind: "editWorkflow", id: "software_team" });
await settle();

// ---- autosave --------------------------------------------------------------
// The whole point is that it never interrupts. It must reach disk without
// moving the user, and without resetting the session they are talking to.
receive({ kind: "openWorkflow", id: "software_team" });
await settle();
const live = last("screen")?.screen;

// A run actually in flight, for both halves of this: an autosave must not kill
// a live conversation — it fires every 45 seconds while the user is still
// editing — and a deliberate save must, because the agents it started no longer
// match what was saved.
fake.__instances.length = 0;
receive({ kind: "send", text: "start working" });
await settle();
const liveRun = fake.__instances.find((i) => i.options?.mcpServers?.team);
check("there is a run in flight for a save to act on", liveRun !== undefined);

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
check("...and the conversation is genuinely still running, not merely unannounced",
  liveRun?.options.abortController?.signal.aborted === false && liveRun?.closed !== true);

posted.length = 0;
edited.agents[0].role = "changed deliberately";
// The run that is about to be reset, so it can be checked that it really stops.
// Resetting by dropping the reference would leave the agents running: still
// editing files, still spending, with nothing listening to them and no way for
// the user to reach them again.
const beforeSave = liveRun;
receive({ kind: "saveWorkflow", workflow: edited });
await settle();
check("an explicit save is acknowledged as deliberate", last("saved")?.auto === false);
check("an explicit save does reset the running session, and says so",
  posted.some((m) => m.kind === "notice" && /session was reset/i.test(m.text)));
check("...and the agents are actually stopped, not just let go of",
  beforeSave?.options.abortController?.signal.aborted === true);
check("...and the query itself is closed, so nothing keeps streaming",
  beforeSave?.closed === true);

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


// ---- project profiles write settings that exist ---------------------------
// These wrote per-agent keys from the fixed roster — engineer.model,
// lead.effort — which were removed when workflows became arbitrary. VS Code
// throws on an unregistered key, and the loop awaited each in turn, so the
// first dead key took the rest of the profile with it: Production promised a
// spend cap and never wrote one.
{
  const declared = new Set(
    Object.keys(JSON.parse(fs.readFileSync("package.json", "utf8"))
      .contributes.configuration.properties),
  );
  const folderPath = state.workspaceFolders?.[0]?.uri.fsPath;

  for (const wanted of ["Sandbox", "Balanced", "Production"]) {
    vscodeStub.__pick = (items) => items.find((i) => i.label === wanted);
    for (const key of Object.keys(folderSettings[folderPath] ?? {})) {
      delete folderSettings[folderPath][key];
    }
    await vscodeStub.__commands["cadre.saveProfile"]();

    const written = Object.keys(folderSettings[folderPath] ?? {});
    check(`the ${wanted} profile only writes settings that exist`,
      written.length > 0 && written.every((key) => declared.has(key)));
    check(`...and it names the ones it does not, rather than half-applying`,
      !written.some((key) => /^cadre\.(engineer|researcher|lead)\./.test(key)));
  }

  // The cap is the one that matters: it is written last, so it was the one
  // lost when an earlier key threw.
  vscodeStub.__pick = (items) => items.find((i) => i.label === "Production");
  await vscodeStub.__commands["cadre.saveProfile"]();
  check("the Production profile actually writes the spend cap it promises",
    folderSettings[folderPath]?.["cadre.maxSpendUsd"] === 5);
  check("...and the autonomy it promises", folderSettings[folderPath]?.["cadre.autonomy"] === "supervised");

  // And if one setting will not take, the user must not silently lose the rest
  // of the profile — least of all the cap.
  for (const key of Object.keys(folderSettings[folderPath] ?? {})) {
    delete folderSettings[folderPath][key];
  }
  vscodeStub.__rejectKey = "cadre.model";
  let threw = false;
  try { await vscodeStub.__commands["cadre.saveProfile"](); } catch { threw = true; }
  vscodeStub.__rejectKey = undefined;
  check("a setting that will not take does not abort the profile", !threw);
  check("...and the spend cap is still written", folderSettings[folderPath]?.["cadre.maxSpendUsd"] === 5);
  check("...and the autonomy is still written",
    folderSettings[folderPath]?.["cadre.autonomy"] === "supervised");

  vscodeStub.__pick = undefined;
}

// ---- the synchronous PATH lookup is bounded -------------------------------
// Finding the claude binary can fall through to execFileSync("which"), which
// blocks the extension host thread. Unbounded it could not merely be slow, it
// could be permanent, and it would freeze every extension in the window, not
// just this one. On Windows `where` walks every PATH entry, network drives
// included.
//
// Asserted against the source rather than by running it: on any machine with
// the SDK's bundled binary present, resolution finds that first and never
// reaches PATH, so a behavioural test here would pass without executing the
// line it claims to cover.
{
  const cli = fs.readFileSync("src/cli.ts", "utf8");
  const call = /execFileSync\(\s*finder\s*,\s*\["claude"\]\s*,\s*\{([\s\S]*?)\}\s*\)/.exec(cli);
  check("the PATH lookup is still a single execFileSync call", call !== null);
  const opts = call?.[1] ?? "";
  const timeout = /timeout:\s*([\d_]+)/.exec(opts);
  check("...and it is given a timeout", timeout !== null);
  check("...that is short enough to not read as a freeze",
    timeout !== null && Number(timeout[1].replace(/_/g, "")) <= 10_000);
  check("...and it does not inherit stderr into the host's output",
    /stdio:/.test(opts));
}

// ---- the vetted limits actually reach the run ------------------------------
// The trust layer clamps what a repository may loosen, but clamping is only
// half of it: the controller has to use the vetted value rather than reading
// the setting again. Reading it again silently undoes the whole guard, and
// nothing about the trust suite would notice.
{
  const folderPath = state.workspaceFolders?.[0]?.uri.fsPath;
  settings["cadre.maxSpendUsd"] = 5;                       // the user's ceiling
  (folderSettings[folderPath] ??= {})["cadre.maxSpendUsd"] = 0;   // the repo removes it
  (folderSettings[folderPath])["cadre.maxDelegationDepth"] = 25;
  settings["cadre.maxDelegationDepth"] = 3;
  settings["cadre.exclusiveConnectors"] = true;                 // the user's choice
  (folderSettings[folderPath])["cadre.exclusiveConnectors"] = false;  // the repo's

  // Whichever workflow still exists at this point in the suite: earlier checks
  // delete some, and opening one that is gone starts no run at all, which would
  // make every assertion below pass for the wrong reason.
  const available = fs.readdirSync(wfDir).find((f) => f.endsWith(".json") && !f.endsWith(".sessions.json"));
  check("there is a workflow to run", available !== undefined);
  receive({ kind: "openWorkflow", id: available.replace(/\.json$/, "") });
  await settle();
  fake.__instances.length = 0;
  receive({ kind: "send", text: "go" });
  await settle();

  const run = fake.__instances[0];
  check("a run starts so the limits can be observed", run !== undefined);
  check("the repo cannot spend past the ceiling the user set",
    run?.options.maxBudgetUsd === 5);

  const tools = run?.options.mcpServers?.team?.tools ?? [];
  check("...and the run is otherwise wired up", tools.length > 0);
  check("...and connector exclusivity the user turned on survives the repo turning it off",
    run?.options.strictMcpConfig === true);

  delete folderSettings[folderPath]["cadre.maxSpendUsd"];
  delete folderSettings[folderPath]["cadre.maxDelegationDepth"];
  delete folderSettings[folderPath]["cadre.exclusiveConnectors"];
  settings["cadre.exclusiveConnectors"] = false;
  settings["cadre.maxSpendUsd"] = 0;
  controller.stop();
  await settle();
}

// ---- the builder's own model runs can be stopped ---------------------------
// Refining a prompt and designing a workflow are model runs, and neither was
// given a signal — nothing could stop one. A wedged CLI left the button saying
// "Refining…" until the window was reloaded, and walking away from the builder
// abandoned the run rather than ending it: still spending, with nowhere to
// deliver. Neither path had any test at all.
{
  const workflow = {
    id: "software_team", name: "Software team", entry: "lead",
    agents: [
      { id: "lead", name: "Lead", role: "decides", prompt: "You decide and delegate.", preset: "readonly" },
      { id: "engineer", name: "Engineer", role: "builds", prompt: "You build.", preset: "build" },
    ],
    edges: [{ from: "lead", to: "engineer", kind: "delegate" }],
  };
  const agent = { ...workflow.agents[0], rawPrompt: "you decide what matters and hand the rest on" };

  fake.__instances.length = 0;
  posted.length = 0;
  receive({ kind: "refinePrompt", workflow, agent });
  await settle();

  const run = fake.__instances[0];
  check("refining actually starts a model run", run !== undefined);
  check("...told to use no tools, so it cannot wander off reading the repo",
    (run?.options.tools ?? ["x"]).length === 0);
  check("...and bounded to a single turn", run?.options.maxTurns === 1);
  check("...with something that can stop it", run?.options.abortController !== undefined);
  check("...and the button says it is working",
    posted.some((m) => m.kind === "refining" && m.busy === true));

  // Walking away has to end it, not orphan it.
  posted.length = 0;
  receive({ kind: "goHome" });
  await settle();
  check("leaving the builder stops the run rather than abandoning it",
    run?.options.abortController?.signal.aborted === true);

  // And asking again supersedes a request you have already given up on.
  fake.__instances.length = 0;
  receive({ kind: "refinePrompt", workflow, agent });
  await settle();
  const first = fake.__instances[0];
  receive({ kind: "refinePrompt", workflow, agent });
  await settle();
  const second = fake.__instances[1];
  check("asking again stops the request already in flight",
    first?.options.abortController?.signal.aborted === true);
  check("...and the new one is left running",
    second !== undefined && second.options.abortController?.signal.aborted === false);

  // Shutdown must not leave one running either.
  controller.dispose();
  check("shutting down stops the builder's work too",
    second?.options.abortController?.signal.aborted === true);
}

// ---- discovering what the CLI supports cannot hang ------------------------
// The model list comes from the installed CLI, because the identifiers are its
// and they change per release. It is a handshake with no tools and no session,
// so it is fast or it is broken — but nothing bounded it, and the caller behind
// `Cadre: Settings -> Default model` awaits it before showing anything. A
// wedged CLI meant clicking that did nothing at all: no picker, no error, no
// sign the click had registered. There has always been a fallback list for when
// discovery fails; a hang never reached it.
{
  const models = require(modelsOut);
  const opts = { executablePath: fakeCli, cwd: process.cwd(), timeoutMs: 150 };

  fake.__registry.hangDiscovery = false;
  models.clearModelCache?.();
  const found = await models.discoverModels(opts);
  check("discovery returns what the CLI reports", found.some((m) => m.value === "claude-opus-5"));
  check("...including which effort levels it takes",
    found.find((m) => m.value === "claude-opus-5")?.efforts.includes("high") === true);
  check("...and that a model taking none is reported as taking none",
    found.find((m) => m.value === "claude-haiku-4-5")?.efforts.length === 0);

  // The case that used to hang.
  fake.__registry.hangDiscovery = true;
  models.clearModelCache?.();
  const started = Date.now();
  const settled = await Promise.race([
    models.discoverModels(opts),
    new Promise((resolve) => setTimeout(() => resolve("HUNG"), 4000)),
  ]);
  check("a CLI that never answers does not hang the caller", settled !== "HUNG");
  check("...it falls back to a usable list instead",
    Array.isArray(settled) && settled.length > 0 && settled.every((m) => m.value));
  check("...and gives up quickly rather than after a minute",
    Date.now() - started < 3000);

  fake.__registry.hangDiscovery = false;
}

// ---- every event has somewhere to land ------------------------------------
// The host and the webview talk in two typed unions. Adding a case to either
// and forgetting the other end fails silently: an event nobody handles falls
// through a switch and is dropped, which is how the run's cost card and the
// "history was summarised" notice went missing for months.
{
  const events = fs.readFileSync("src/team/events.ts", "utf8");
  const cut = (name, nextName) => {
    const from = events.indexOf(`export type ${name} =`);
    const to = nextName ? events.indexOf(`export type ${nextName} =`, from) : events.length;
    return events.slice(from, to === -1 ? events.length : to);
  };
  const kindsIn = (text) => [...new Set([...text.matchAll(/kind:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]))];

  const outbound = kindsIn(cut("TeamEvent", "Screen"));
  const inbound = kindsIn(cut("UiCommand", null));
  globalThis.__inboundKinds = inbound;
  check("the event union is not empty, or this checks nothing", outbound.length > 10);
  check("the command union is not empty either", inbound.length > 10);

  const webview = fs.readFileSync("media/team.js", "utf8");
  // A handler is either a case in the render switch or a key on the handlers
  // map, and the map's entries may or may not take a parameter.
  const handled = new Set([
    ...[...webview.matchAll(/case\s+"([a-zA-Z]+)":/g)].map((m) => m[1]),
    ...[...webview.matchAll(/^\s{4}([a-zA-Z]+)\((?:e)?\)\s*\{/gm)].map((m) => m[1]),
  ]);
  // Some events are for the host alone and are deliberately not forwarded.
  const host = fs.readFileSync("src/team/controller.ts", "utf8");
  const interceptedByHost = new Set(
    [...host.matchAll(/if \(event\.kind === "([a-zA-Z]+)"\)[\s\S]{0,200}?return;/g)].map((m) => m[1]),
  );

  const unhandled = outbound.filter((k) => !handled.has(k) && !interceptedByHost.has(k));
  check(`every event reaches a handler or is answered by the host${unhandled.length ? " (" + unhandled.join(", ") + ")" : ""}`,
    unhandled.length === 0);

  const commands = new Set([...host.matchAll(/case\s+"([a-zA-Z]+)":/g)].map((m) => m[1]));
  const ignored = inbound.filter((k) => !commands.has(k));
  check(`every command the webview can send is answered${ignored.length ? " (" + ignored.join(", ") + ")" : ""}`,
    ignored.length === 0);
}

// ---- every command is wired at both ends -----------------------------------
// A command declared in package.json but never registered shows in the palette
// and does nothing. One registered but not declared cannot be found. And one
// invoked by another command has to exist, or the caller silently no-ops.
{
  const ext = fs.readFileSync("src/extension.ts", "utf8");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const registered = new Set([...ext.matchAll(/registerCommand\("([\w.]+)"/g)].map((m) => m[1]));
  const declared = new Set((pkg.contributes.commands ?? []).map((c) => c.command));
  const viewIds = new Set(
    Object.values(pkg.contributes.views ?? {}).flat().map((v) => v.id),
  );

  check("there are commands to check", declared.size > 10);
  const ghosts = [...declared].filter((c) => !registered.has(c));
  check(`every command in the palette is registered${ghosts.length ? " (" + ghosts.join(", ") + ")" : ""}`,
    ghosts.length === 0);
  const hidden = [...registered].filter((c) => !declared.has(c));
  check(`every registered command can be found${hidden.length ? " (" + hidden.join(", ") + ")" : ""}`,
    hidden.length === 0);

  // Commands one command asks for. VS Code generates "<viewId>.focus" itself.
  const invoked = [...new Set([...ext.matchAll(/executeCommand\("(cadre[\w.]*)"/g)].map((m) => m[1]))];
  const dangling = invoked.filter((c) =>
    !registered.has(c) && !(c.endsWith(".focus") && viewIds.has(c.slice(0, -".focus".length))));
  check(`every command invoked from another exists${dangling.length ? " (" + dangling.join(", ") + ")" : ""}`,
    dangling.length === 0);
}

// Compacting with nothing to compact must say so rather than doing nothing.
{
  posted.length = 0;
  controller.newSession();
  await settle();
  posted.length = 0;
  // Caught, so that a command which throws is a failed check rather than a
  // crashed suite that takes every result after it down as well.
  let threw = false;
  try { await vscodeStub.__commands["cadre.compact"](); } catch { threw = true; }
  await settle();
  check("compacting with no conversation does not throw", !threw);
  check("compacting with no conversation says so rather than nothing at all",
    posted.some((m) => m.kind === "notice" && /nothing to compact/i.test(m.text)));
}

// ---- choosing how much rope the team gets ----------------------------------
// The setting that removes every permission prompt. Three things about it are
// load-bearing and none had a test: autonomous asks for confirmation first,
// declining changes nothing, and the choice is written globally rather than
// into the folder — because the folder is where a cloned repo's settings live,
// and writing there would make the user's own choice indistinguishable from one
// a repository shipped. The trust layer would then clamp it back and the
// setting would appear not to work.
{
  const folderPath = state.workspaceFolders?.[0]?.uri.fsPath;
  const writes = [];
  const realUpdate = vscodeStub.workspace.getConfiguration;
  vscodeStub.workspace.getConfiguration = (prefix, scope) => {
    const cfg = realUpdate(prefix, scope);
    return { ...cfg, update: async (k, v, target) => { writes.push({ k, v, target }); return cfg.update(k, v, target); } };
  };
  const realWarn = vscodeStub.window.showWarningMessage;
  let askedToConfirm = 0;
  vscodeStub.window.showWarningMessage = async (msg, opts, ...choices) => {
    if (opts && opts.modal && /autonomous/i.test(String(msg))) {
      askedToConfirm += 1;
      return vscodeStub.__autonomyConfirm;
    }
    return undefined;
  };

  // A safe level needs no confirmation.
  writes.length = 0;
  vscodeStub.__pick = (items) => items.find((i) => i.value === "supervised");
  await vscodeStub.__commands["cadre.setAutonomy"]();
  check("choosing a safer level does not stop to confirm", askedToConfirm === 0);
  check("...and is written", writes.some((w) => w.k === "autonomy" && w.v === "supervised"));
  check("...globally, not into the folder a repository can also write to",
    writes.filter((w) => w.k === "autonomy").every((w) => w.target === 1));

  // Autonomous must ask, and taking it back must change nothing.
  writes.length = 0;
  askedToConfirm = 0;
  vscodeStub.__pick = (items) => items.find((i) => i.value === "autonomous");
  vscodeStub.__autonomyConfirm = undefined;      // dismissed
  await vscodeStub.__commands["cadre.setAutonomy"]();
  check("autonomous asks before it is set", askedToConfirm === 1);
  check("...and dismissing the question writes nothing at all", writes.length === 0);

  // Agreeing sets it.
  writes.length = 0;
  vscodeStub.__autonomyConfirm = "I understand";
  await vscodeStub.__commands["cadre.setAutonomy"]();
  check("agreeing sets it", writes.some((w) => w.k === "autonomy" && w.v === "autonomous"));
  check("...still globally", writes.filter((w) => w.k === "autonomy").every((w) => w.target === 1));

  // Choosing nothing at all is not a choice.
  writes.length = 0;
  vscodeStub.__pick = () => undefined;
  await vscodeStub.__commands["cadre.setAutonomy"]();
  check("dismissing the picker writes nothing", writes.length === 0);

  vscodeStub.workspace.getConfiguration = realUpdate;
  vscodeStub.window.showWarningMessage = realWarn;
  vscodeStub.__pick = undefined;
  settings["cadre.autonomy"] = "standard";
}

// ---- reviewing what a repository asked for ---------------------------------
// Every warning about a repo's settings points at this command. It lists what
// the folder is asking for and lets you allow it. Approving is recorded per
// folder — so the listing has to look it up the same way, or it offers the same
// thing again and your approval reads as having failed.
{
  const folderPath = state.workspaceFolders?.[0]?.uri.fsPath;
  const connectors = { risky: { type: "stdio", command: "/bin/sh", args: ["-c", "echo hi"] } };
  (folderSettings[folderPath] ??= {})["cadre.connectors"] = connectors;

  const shown = [];
  const realWarn = vscodeStub.window.showWarningMessage;
  const realInfo = vscodeStub.window.showInformationMessage;
  const infos = [];
  vscodeStub.window.showWarningMessage = async (msg, opts, ...choices) => {
    if (opts && opts.modal && /cadre\.connectors/.test(String(msg))) {
      shown.push(msg);
      return "Allow for this workspace";
    }
    return undefined;
  };
  vscodeStub.window.showInformationMessage = async (msg) => { infos.push(String(msg)); return undefined; };

  await vscodeStub.__commands["cadre.reviewWorkspaceSettings"]();
  check("a repo's connector is offered for review", shown.length === 1);

  // Asked and answered. Asking again is the bug.
  shown.length = 0;
  infos.length = 0;
  await vscodeStub.__commands["cadre.reviewWorkspaceSettings"]();
  check("once allowed, the review does not ask about it again", shown.length === 0);
  check("...and says there is nothing left to review",
    infos.some((m) => /nothing to review/i.test(m)));

  vscodeStub.window.showWarningMessage = realWarn;
  vscodeStub.window.showInformationMessage = realInfo;
  delete folderSettings[folderPath]["cadre.connectors"];
}

// ---- changing how the work is paid for, mid-conversation -------------------
// A session works out its environment once, when it starts. So switching
// billing reaches the next conversation and not the one already running: the
// chip says "Claude subscription" while the run in front of you goes on being
// billed per token, and nothing says so. Logging out already resets the session
// for exactly this reason — the credential is gone — but these are subtler,
// because the old credential still works and nothing breaks.
{
  const asked = [];
  const realWarn = vscodeStub.window.showWarningMessage;
  vscodeStub.window.showWarningMessage = async (msg, opts, ...choices) => {
    asked.push({ msg, modal: Boolean(opts && opts.modal), choices });
    return vscodeStub.__billingChoice;
  };

  // With a conversation running, the switch has to say it misses this one.
  fake.__instances.length = 0;
  receive({ kind: "openWorkflow", id: "software_team" });
  await settle();
  receive({ kind: "send", text: "start working" });
  await settle();
  const running = fake.__instances.find((i) => i.options?.mcpServers?.team);
  check("a conversation is running for the switch to miss", running !== undefined);

  asked.length = 0;
  vscodeStub.__billingChoice = undefined;      // the user declines the offer
  await vscodeStub.__commands["cadre.clearApiKey"]();
  check("switching billing mid-conversation says the running one is unaffected",
    asked.some((a) => a.modal && /already running/i.test(a.msg)));
  check("...and offers to start a new one", 
    asked.some((a) => a.choices.some((c) => /new conversation/i.test(String(c)))));
  check("...and declining leaves the conversation alone",
    running?.options.abortController?.signal.aborted === false);

  // Accepting has to actually apply it.
  asked.length = 0;
  vscodeStub.__billingChoice = "Start a new conversation";
  await vscodeStub.__commands["cadre.clearApiKey"]();
  check("accepting ends the conversation so the change takes effect",
    running?.options.abortController?.signal.aborted === true);

  // With nothing running there is nothing to warn about.
  asked.length = 0;
  vscodeStub.__billingChoice = undefined;
  await vscodeStub.__commands["cadre.clearApiKey"]();
  check("with no conversation running, the switch is silent",
    !asked.some((a) => /already running/i.test(a.msg)));

  vscodeStub.window.showWarningMessage = realWarn;
  vscodeStub.__billingChoice = undefined;
}

// ---- every command, well formed, handled without throwing ------------------
// The mirror of the event check in the webview suite. That one found two
// features whose drawing function did not exist — reachable by simply sending
// the event, and nothing sent it. The same is true in this direction: a command
// handler that throws on a valid payload would take out whatever called it, and
// half of these have never been sent by a test.
{
  const wf = JSON.parse(fs.readFileSync(path.join(wfDir,
    fs.readdirSync(wfDir).find((f) => f.endsWith(".json") && !f.endsWith(".sessions.json"))), "utf8"));
  const anyAgent = wf.agents[0];

  const WELL_FORMED = {
    ready: {},
    send: { text: "hello", images: [] },
    stop: {},
    newSession: {},
    setChannel: { to: wf.agents[1]?.id ?? anyAgent.id },
    openTeamFloor: {},
    selectProject: {},
    openProject: { path: state.workspaceFolders?.[0]?.uri.fsPath ?? ".", alreadyOpen: true },
    goHome: {},
    resumeSession: { id: "s-1", title: "an earlier chat" },
    answer: { id: "no-such-question", answers: { q: "a" } },
    answerCancelled: { id: "no-such-question" },
    signIn: {},
    useApiKey: {},
    refreshAuth: {},
    account: {},
    configure: { setting: "cadre.autonomy" },
    newWorkflow: { template: "solo", scope: "local" },
    showWorkflow: { id: wf.id },
    startSession: { id: wf.id },
    moveWorkflow: { id: wf.id, to: "local" },
    buildWorkflow: { description: "a team that reads tickets and drafts replies", scope: "local" },
    openWorkflow: { id: wf.id },
    editWorkflow: { id: wf.id },
    duplicateWorkflow: { id: wf.id },
    saveWorkflow: { workflow: wf, auto: true },
    checkWorkflow: { workflow: wf },
    refinePrompt: { agent: anyAgent, workflow: wf },
    // Deliberately last: it removes the workflow the others act on.
    deleteWorkflow: { id: wf.id },
  };

  const inboundKinds = globalThis.__inboundKinds ?? [];
  check("the command union was read", inboundKinds.length > 20);
  const uncovered = inboundKinds.filter((k) => !(k in WELL_FORMED));
  check("every command kind has a well-formed example to send" +
    (uncovered.length ? " (" + uncovered.join(", ") + ")" : ""), uncovered.length === 0);

  const failures = [];
  const order = [...inboundKinds.filter((k) => k !== "deleteWorkflow"), "deleteWorkflow"];
  vscodeStub.__warn = "Delete";
  for (const kind of order) {
    const payload = WELL_FORMED[kind];
    if (!payload) continue;
    try {
      receive({ kind, ...payload });
      await settle();
    } catch (err) {
      failures.push(`${kind}: ${err && err.message ? err.message : err}`);
    }
  }
  vscodeStub.__warn = undefined;
  check("no well-formed command throws: " + JSON.stringify(failures.slice(0, 3)),
    failures.length === 0);
}

// ---- a message that could not be sent keeps its attachments ----------------
// When a send cannot start a session, the text comes back to the composer
// rather than vanishing — the comment where that happens says "never swallow
// what the user typed". Attachments were swallowed: an image-only message, or a
// screenshot with a sentence, came back as the sentence alone with the image
// gone and nothing to say so.
{
  // No workflow open, so nothing can start.
  const open = fs.readdirSync(wfDir).filter((f) => f.endsWith(".json") && !f.endsWith(".sessions.json"));
  vscodeStub.__warn = "Delete";
  for (const f of open) { receive({ kind: "deleteWorkflow", id: f.replace(/\.json$/, "") }); await settle(); }
  vscodeStub.__warn = undefined;

  posted.length = 0;
  const shot = { name: "screen.png", mediaType: "image/png", data: "iVBORw0KGgo=", bytes: 11 };
  receive({ kind: "send", text: "look at this", images: [shot] });
  await settle();

  const back = posted.find((m) => m.kind === "restoreInput");
  check("a send that cannot start hands the text back", back?.text === "look at this");
  check("...and hands the attachments back too", (back?.images ?? []).length === 1);
  check("...the same one that was attached", back?.images?.[0]?.name === "screen.png");

  // An image on its own is a complete message, so it must survive on its own.
  posted.length = 0;
  receive({ kind: "send", text: "", images: [shot] });
  await settle();
  const imageOnly = posted.find((m) => m.kind === "restoreInput");
  check("an image sent with no words is handed back rather than dropped",
    (imageOnly?.images ?? []).length === 1);
}

// ---- onboarding with nothing to onboard with -------------------------------
// "Onboard this project" surveys the repo and writes PROJECT.md, which is a
// message to a team. Someone running it for the first time has most likely just
// installed the extension and opened a folder — the exact state where no
// workflow is open. The modal promised a survey and the prompt then landed in
// the composer, unsent, with nothing to say why.
{
  // The state a new install is in: a folder open, no workflow yet. Disposing a
  // session does not produce it — the controller still remembers which workflow
  // is open — so the open one is deleted, which does.
  const open = fs.readdirSync(wfDir).filter((f) => f.endsWith(".json") && !f.endsWith(".sessions.json"));
  vscodeStub.__warn = "Delete";
  for (const f of open) {
    receive({ kind: "deleteWorkflow", id: f.replace(/\.json$/, "") });
    await settle();
  }
  check("no workflow is open, which is where a new install starts",
    fs.readdirSync(wfDir).filter((f) => f.endsWith(".json") && !f.endsWith(".sessions.json")).length === 0);
  vscodeStub.__warn = undefined;
  const asked = [];
  const realWarn = vscodeStub.window.showWarningMessage;
  vscodeStub.window.showWarningMessage = async (msg, opts, ...choices) => {
    asked.push({ msg, modal: Boolean(opts && opts.modal), choices });
    return undefined;
  };
  const realInfo = vscodeStub.window.showInformationMessage;
  let promised = false;
  vscodeStub.window.showInformationMessage = async (msg) => { promised = true; return undefined; };

  posted.length = 0;
  await vscodeStub.__commands["cadre.onboard"]();

  check("onboarding with no workflow open does not promise a survey", promised === false);
  check("...it says a team is what is missing",
    asked.some((a) => /team/i.test(a.msg) && a.modal));
  check("...and offers a way to get one",
    asked.some((a) => a.choices.some((c) => /workflow/i.test(String(c)))));
  check("...and nothing is dumped into the composer",
    !posted.some((m) => m.kind === "restoreInput"));

  vscodeStub.window.showWarningMessage = realWarn;
  vscodeStub.window.showInformationMessage = realInfo;
}

console.log("=== ui ===");
// ---- a command that fails has to say so ------------------------------------
// Every branch of the dispatcher was fire-and-forget, so a handler that
// rejected became an unhandled promise: the click did nothing, the panel looked
// fine, and the only trace was in a console the user does not have open. Most
// of these handlers touch the disk — a read-only checkout, a full disk, a file
// another window is holding.
{
  controller.showWorkflow = async () => { throw new Error("the checkout is read-only"); };
  receive({ kind: "showWorkflow", id: "anything" });
  const rejected = await waitFor("notice", (n) => /read-only/.test(n.text ?? ""));
  check("a command whose handler rejects is reported, not swallowed", Boolean(rejected));
  check("...as an error rather than a passing remark", rejected?.level === "error");
  check("...naming which command it was", /showWorkflow/.test(rejected?.text ?? ""));

  // A handler can also throw before it ever awaits, which is not a rejected
  // promise at all and would sail past a .catch on its own.
  controller.showWorkflow = () => { throw new Error("threw before awaiting"); };
  receive({ kind: "showWorkflow", id: "anything" });
  const threw = await waitFor("notice", (n) => /before awaiting/.test(n.text ?? ""));
  check("...and one that throws before awaiting anything is reported too", Boolean(threw));

  // A handler that simply succeeds must stay quiet.
  controller.showWorkflow = async () => {};
  const before = posted.filter((m) => m.kind === "notice" && m.level === "error").length;
  receive({ kind: "showWorkflow", id: "anything" });
  await settle();
  check("...while a command that works says nothing",
    posted.filter((m) => m.kind === "notice" && m.level === "error").length === before);

  delete controller.showWorkflow;
}

// Last, so it covers everything above it: no promise anywhere in this suite
// may reject with nobody listening.
await settle();
check(escaped.length
  ? `nothing rejected unhandled (${escaped.slice(0, 3).join(" | ")})`
  : "nothing rejected unhandled", escaped.length === 0);

let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
// The credential watcher keeps the loop alive, so exit explicitly.
process.exit(failed ? 1 : 0);

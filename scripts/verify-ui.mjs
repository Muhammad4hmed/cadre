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

const settings = {
  "cadre.directLine": false,
  "cadre.autonomy": "standard",
  "cadre.inheritGlobalConfig": false,
  "cadre.billing": "subscription",
  "cadre.claudeExecutablePath": "",
};
const state = { workspaceFolders: undefined };
/** Folder-scoped overrides, keyed by fsPath. */
const folderSettings = {};
const shownErrors = [];
const secrets = new Map();

const vscodeStub = {
  Uri: { joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join("/") }) },
  ViewColumn: { Active: -1 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Disposable: class { constructor(fn) { this.dispose = fn || (() => {}); } },
  window: {
    createOutputChannel: () => ({
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, show: () => {}, dispose: () => {},
    }),
    registerWebviewViewProvider: (_id, provider) => { vscodeStub.__provider = provider; return { dispose() {} }; },
    createWebviewPanel: () => ({
      webview: { options: {}, html: "", cspSource: "x", asWebviewUri: (u) => u,
        onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async () => true },
      onDidDispose: () => ({ dispose() {} }), reveal: () => {}, dispose: () => {},
    }),
    showErrorMessage: async (m) => { shownErrors.push(m); return undefined; },
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showQuickPick: async (items) => {
      const resolved = await items;
      return vscodeStub.__pick ? vscodeStub.__pick(resolved) : undefined;
    },
    showInputBox: async () => undefined,
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
Module._load = (r, p, m) => (r === "vscode" ? vscodeStub : originalLoad.call(Module, r, p, m));

const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-team-ui-")), "extension.cjs");
await esbuild.build({ ...baseOptions({ entry: "src/extension.ts", outfile }), logLevel: "warning" });

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
check("folder opened -> composer unblocked", last("sendability")?.ok === true);

// ---- direct line is off by default -----------------------------------------
posted.length = 0;
receive({ kind: "setChannel", to: "researcher" });
await settle();
check("direct line off -> switch refused", !posted.some((m) => m.kind === "channel" && m.to === "researcher"));
check("direct line off -> explains why",
  posted.some((m) => m.kind === "notice" && /direct line is off/i.test(m.text)));
check("webview told the gate state", last("directLine")?.enabled === false);

// ---- direct line enabled ----------------------------------------------------
settings["cadre.directLine"] = true;
posted.length = 0;
vscodeStub.__onConfig({ affectsConfiguration: () => true });
await settle();
check("enabling direct line reaches the webview", last("directLine")?.enabled === true);

posted.length = 0;
receive({ kind: "setChannel", to: "engineer" });
await settle();
check("direct line on -> switch allowed", last("channel")?.to === "engineer");

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
check("credential present -> home is the project list",
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

// ---- choosing a project moves to the team -----------------------------------
posted.length = 0;
receive({ kind: "openProject", path: A.uri.fsPath, alreadyOpen: true });
await settle();
check("choosing a project shows the team",
  (await waitFor("screen", (m) => m.screen === "team"))?.screen === "team");

// ---- and Home goes back ------------------------------------------------------
posted.length = 0;
receive({ kind: "goHome" });
await settle();
check("Home returns to the project list",
  (await waitFor("screen", (m) => m.screen === "projects"))?.screen === "projects");

// ---- the sign-in affordance must survive every screen ----------------------
// `claude auth status` reports loggedIn:true for an expired token, so the gate
// can fail to fire while the user is effectively signed out. The account
// control is the escape hatch and must never be conditional.
const html = view.webview.html;
check("the header carries an account control", /id="account"/.test(html));
check("it is a button, not a static chip", /<button[^>]*id="account"/.test(html));

for (const screen of ["auth", "projects", "team"]) {
  const hidesAccount = new RegExp(`"${screen}"[\\s\\S]{0,400}?el\\.account[\\s\\S]{0,80}?display`, "m");
  check(`the account control is not hidden on the ${screen} screen`,
    !hidesAccount.test(fs.readFileSync("media/team.js", "utf8")));
}

const teamJs = fs.readFileSync("media/team.js", "utf8");
check("clicking it asks the host for account options",
  /el\.account\.addEventListener\("click"/.test(teamJs));
check("it renders a sign-in label when signed out",
  /e\.signedIn \? e\.detail : "sign in"/.test(teamJs));

fs.rmSync(workRoot, { recursive: true, force: true });

console.log("=== controller + composer ===");
let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
process.exit(failed ? 1 : 0);

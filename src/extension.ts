import * as vscode from "vscode";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { TeamController } from "./team/controller";
import { describeAuth, logout, readAuthStatus } from "./auth";
import { buildPaper, detectToolchain, installToolchain, toolchainHome } from "./paper";
import { resolveClaudeExecutable } from "./cli";
import { cachedModels, discoverModels } from "./models";
import type { Autonomy } from "./policy";
import type { BillingMode } from "./billing";

let log: vscode.LogOutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel("Cadre", { log: true });
  context.subscriptions.push(log);

  const controller = new TeamController(context, log);
  const sidebar = new ChatViewProvider(context, controller);
  const floor = new TeamFloor(context, controller);

  context.subscriptions.push(
    controller,
    floor,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("cadre.newSession", () => controller.newSession()),
    vscode.commands.registerCommand("cadre.stop", () => controller.stop()),
    vscode.commands.registerCommand("cadre.showLogs", () => log.show()),
    vscode.commands.registerCommand("cadre.openTeamFloor", () => floor.reveal()),
    vscode.commands.registerCommand("cadre.focus", () =>
      vscode.commands.executeCommand("cadre.chat.focus"),
    ),
    vscode.commands.registerCommand("cadre.setApiKey", async () => {
      if (await controller.billing.promptForApiKey()) {
        void vscode.window.showInformationMessage("API key stored. Cadre will bill the API from now on.");
        await controller.refreshSendability();
      }
    }),
    vscode.commands.registerCommand("cadre.clearApiKey", async () => {
      await controller.billing.clearApiKey();
      await controller.billing.setMode("subscription");
      void vscode.window.showInformationMessage("API key cleared. Back to your Claude subscription.");
      await controller.refreshSendability();
    }),
    vscode.commands.registerCommand("cadre.chooseBilling", () => chooseBilling(controller)),
    vscode.commands.registerCommand("cadre.setAutonomy", () => chooseAutonomy(controller)),
    vscode.commands.registerCommand("cadre.settings", () => settingsHub(controller)),
    vscode.commands.registerCommand("cadre.setThinking", () => chooseThinking()),
    vscode.commands.registerCommand("cadre.setModel", () => chooseDefault("model", controller)),
    vscode.commands.registerCommand("cadre.setEffort", () => chooseDefault("effort")),
    vscode.commands.registerCommand("cadre.newWorkflow", () => controller.receive({ kind: "newWorkflow" })),
    vscode.commands.registerCommand("cadre.goHome", () => controller.receive({ kind: "goHome" })),
    vscode.commands.registerCommand("cadre.resumeSession", () => resumeSession(controller)),
    vscode.commands.registerCommand("cadre.rewindFiles", () => rewindFiles(controller)),
    vscode.commands.registerCommand("cadre.compact", () => controller.compactNow()),
    vscode.commands.registerCommand("cadre.installToolchain", () => setupToolchain()),
    vscode.commands.registerCommand("cadre.buildPaper", () => buildThePaper(controller)),
    vscode.commands.registerCommand("cadre.selectProject", () => selectProject(controller)),
    vscode.commands.registerCommand("cadre.onboard", () => onboard(controller)),
    vscode.commands.registerCommand("cadre.saveProfile", () => applyProfile(controller)),
    vscode.commands.registerCommand("cadre.reviewWorkspaceSettings", () => reviewWorkspaceSettings(controller)),
    vscode.commands.registerCommand("cadre.account", () => showAccount(controller)),
    vscode.commands.registerCommand("cadre.login", () => runAuth("login", controller)),
    vscode.commands.registerCommand("cadre.logout", () => confirmLogout(controller)),

    // Opening a folder in an empty window, or changing configuration, must
    // reach the surfaces without a reload.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      controller.reconcileFolders();
      void controller.refreshSendability();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cadre")) void controller.refreshSendability();
    }),
  );

  log.info("Cadre activated");
}

export function deactivate(): void {
  // Disposables on the context handle teardown.
}

// ------------------------------------------------------------------ surfaces

class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "cadre.chat";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: TeamController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = webviewOptions(this.context);
    view.webview.html = teamHtml(view.webview, this.context);
    const attachment = this.controller.attach(view.webview);
    view.onDidDispose(() => attachment.dispose());
  }
}

/** The same view in a full editor tab, with room for every lane. */
class TeamFloor implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private attachment: vscode.Disposable | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: TeamController,
  ) {}

  reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "cadre.floor",
      "Cadre — Full view",
      vscode.ViewColumn.Active,
      { ...webviewOptions(this.context), retainContextWhenHidden: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg");
    this.panel.webview.html = teamHtml(this.panel.webview, this.context);
    this.attachment = this.controller.attach(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.attachment?.dispose();
      this.attachment = undefined;
      this.panel = undefined;
    });
  }

  dispose(): void {
    this.attachment?.dispose();
    this.panel?.dispose();
  }
}

function webviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
  };
}

// ---------------------------------------------------------------- settings UX

async function chooseBilling(controller: TeamController): Promise<void> {
  const current = controller.billing.mode;
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "Claude subscription",
        description: current === "subscription" ? "current" : undefined,
        detail: "Uses the login your Claude Code CLI already has. Any ANTHROPIC_API_KEY in your shell is ignored.",
        mode: "subscription" as BillingMode,
      },
      {
        label: "Anthropic API key",
        description: current === "apiKey" ? "current" : undefined,
        detail: "Billed per token. The key is held in VS Code's encrypted secret storage.",
        mode: "apiKey" as BillingMode,
      },
    ],
    { title: "How should Cadre be billed?", ignoreFocusOut: true },
  );
  if (!picked) return;

  if (picked.mode === "apiKey" && !(await controller.billing.getApiKey())) {
    if (!(await controller.billing.promptForApiKey())) return;
  } else {
    await controller.billing.setMode(picked.mode);
  }
  await controller.refreshSendability();
}

async function chooseAutonomy(controller: TeamController): Promise<void> {
  const options: { label: string; detail: string; value: Autonomy }[] = [
    { label: "Standard", detail: "Edits flow; risky commands ask. Recommended.", value: "standard" },
    { label: "Supervised", detail: "Every edit and command needs your approval.", value: "supervised" },
    { label: "Plan only", detail: "The team designs and reports but changes nothing.", value: "plan" },
    { label: "Autonomous", detail: "No prompts at all. Secret files are still blocked.", value: "autonomous" },
  ];
  const picked = await vscode.window.showQuickPick(options, {
    title: "How much rope does the team get?",
    placeHolder: "Applies everywhere. Use “Apply a project profile” for one project only.",
    ignoreFocusOut: true,
  });
  if (!picked) return;

  if (picked.value === "autonomous") {
    const confirmed = await vscode.window.showWarningMessage(
      "Autonomous means the Engineer runs shell commands with no prompt, ever.",
      { modal: true, detail: "Reads of .env, ssh keys and credentials stay blocked. Nothing else does." },
      "I understand",
    );
    if (confirmed !== "I understand") return;
  }

  // Global, not workspace. How much you trust the agent is a judgement about
  // you, not about the folder — and workspace scope is precisely where a cloned
  // repo's settings live, so writing there makes your own choice
  // indistinguishable from one a repo shipped, and the trust layer refuses it.
  // Per-project overrides still exist via "Apply a project profile".
  await vscode.workspace
    .getConfiguration("cadre")
    .update("autonomy", picked.value, vscode.ConfigurationTarget.Global);

  // Belt and braces for a folder that already carries this value.
  await controller.trust.approve("autonomy", picked.value);
  controller.forgetShownWarnings();
  await controller.refreshSendability();
}

/**
 * Lets the user inspect and allow settings a repository shipped. Deliberately
 * shows the literal value — a connector is a command line, and the only useful
 * review is reading it.
 */
async function reviewWorkspaceSettings(controller: TeamController): Promise<void> {
  const cfg = controller.configForActiveFolder();
  const pending = controller.trust.pending(cfg);
  if (!pending.length) {
    void vscode.window.showInformationMessage(
      "Nothing to review — this folder's settings ask for no extra permissions.",
    );
    return;
  }

  for (const { setting, value } of pending) {
    const rendered = JSON.stringify(value, null, 2);
    const what =
      setting === "autonomy"
        ? "This would widen what the team may do without asking you."
        : setting === "connectors"
          ? "These start processes before the team runs. Read the commands."
          : "Local plugins can ship hooks that run shell commands.";

    const choice = await vscode.window.showWarningMessage(
      `This folder's settings set "cadre.${setting}"`,
      { modal: true, detail: `${what}\n\n${rendered.slice(0, 1200)}` },
      "Allow for this workspace",
      "Skip",
    );
    if (choice === "Allow for this workspace") {
      await controller.trust.approve(setting, value);
    }
  }
  controller.forgetShownWarnings();
  await controller.refreshSendability();
}

async function selectProject(controller: TeamController): Promise<void> {
  const folders = controller.folders();
  if (!folders.length) {
    void vscode.window.showWarningMessage("No folders are open.");
    return;
  }
  if (folders.length === 1) {
    void vscode.window.showInformationMessage(
      `Only one folder is open: ${folders[0].name}. Add another to the workspace to switch between projects.`,
    );
    return;
  }
  const active = controller.activeFolder();
  const picked = await vscode.window.showQuickPick(
    folders.map((f) => ({
      label: f.name,
      description: f.uri.fsPath === active?.uri.fsPath ? "current" : undefined,
      detail: f.uri.fsPath,
      folder: f,
    })),
    { title: "Which project should the team work in?", ignoreFocusOut: true },
  );
  if (picked) await controller.setActiveFolder(picked.folder);
}

/**
 * A one-off survey so later sessions start informed. Written as a user turn
 * rather than a special code path: the Lead decides how to delegate it, which
 * is the whole point of having a Lead.
 */
async function onboard(controller: TeamController): Promise<void> {
  const folder = controller.activeFolder();
  if (!folder) {
    void vscode.window.showWarningMessage("Open a folder first.");
    return;
  }
  const docs = vscode.workspace.getConfiguration("cadre", folder.uri).get<string>("docsPath") || "docs";
  const confirmed = await vscode.window.showInformationMessage(
    `Onboard ${folder.name}?`,
    {
      modal: true,
      detail:
        `The team will survey this project once — stack, how it is built and tested, entry points, conventions, and what looks risky — and write ${docs}/PROJECT.md. Later sessions then start informed instead of re-deriving it.\n\nThis costs a few minutes and a few delegations.`,
    },
    "Onboard",
  );
  if (confirmed !== "Onboard") return;

  await vscode.commands.executeCommand("cadre.focus");
  controller.submit(
    [
      `Onboard this project. I want ${docs}/PROJECT.md written so future sessions start informed.`,
      "",
      "Find out and record: what this project is and who it is for; the stack and how it is built, run and tested (the actual commands, verified); the entry points and the shape of the code; the conventions a newcomer would get wrong; and what is risky or surprising here.",
      "",
      "Verify the commands rather than inferring them from config files — a build command that does not run is worse than none. Where something is genuinely unclear, record it under OPEN rather than guessing.",
    ].join("\n"),
  );
}

const PROFILES: { label: string; detail: string; settings: Record<string, unknown> }[] = [
  {
    label: "Sandbox",
    detail: "Throwaway work. Autonomous, cheap models, no documentation duty.",
    settings: {
      autonomy: "autonomous", documentation: "off", "engineer.model": "haiku",
      "researcher.model": "haiku", "lead.effort": "medium", "engineer.effort": "medium",
      maxSpendUsd: 0,
    },
  },
  {
    label: "Balanced",
    detail: "The default. Edits flow, risky commands ask, substantial work gets documented.",
    settings: {
      autonomy: "standard", documentation: "substantial", "engineer.model": "",
      "researcher.model": "", "lead.effort": "", "engineer.effort": "", maxSpendUsd: 0,
    },
  },
  {
    label: "Production",
    detail: "Code that matters. Supervised, highest effort, everything documented, spend capped.",
    settings: {
      autonomy: "supervised", documentation: "always", "engineer.model": "opus",
      "researcher.model": "opus", "lead.effort": "xhigh", "engineer.effort": "max",
      maxSpendUsd: 5,
    },
  },
];

async function applyProfile(controller: TeamController): Promise<void> {
  const folder = controller.activeFolder();
  if (!folder) {
    void vscode.window.showWarningMessage("Open a folder first — profiles are stored per project.");
    return;
  }
  const picked = await vscode.window.showQuickPick(PROFILES, {
    title: `Profile for ${folder.name}`,
    ignoreFocusOut: true,
  });
  if (!picked) return;

  const cfg = vscode.workspace.getConfiguration("cadre", folder.uri);
  for (const [key, value] of Object.entries(picked.settings)) {
    // WorkspaceFolder scope writes into that folder's .vscode/settings.json, so
    // the profile travels with the project rather than the machine.
    await cfg.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    // Chosen here, so approved here — otherwise the trust layer clamps it back.
    if (key === "autonomy") await controller.trust.approve("autonomy", value);
  }
  controller.forgetShownWarnings();
  await controller.refreshSendability();
  void vscode.window.showInformationMessage(
    `${picked.label} profile applied to ${folder.name}. It is written to that folder's settings, so it travels with the project.`,
  );
}

/**
 * The CLI owns the subscription login, so anything to do with accounts is a
 * thin wrapper over `claude auth` rather than something this extension stores.
 */
async function showAccount(controller: TeamController): Promise<void> {
  const executablePath = resolveClaudeExecutable(log);
  if (!executablePath) {
    void vscode.window.showErrorMessage("Can't find the claude executable.");
    return;
  }
  const [auth, billing] = await Promise.all([
    readAuthStatus(executablePath),
    controller.billing.status(),
  ]);

  const lines = [
    `Signed in:    ${auth ? (auth.loggedIn ? "yes" : "no") : "unknown"}`,
    auth?.email ? `Account:      ${auth.email}` : "",
    auth?.subscriptionType ? `Plan:         ${auth.subscriptionType}` : "",
    auth?.authMethod ? `Method:       ${auth.authMethod}` : "",
    `Cadre uses: ${billing.ok ? billing.describe : billing.reason}`,
    `CLI:          ${executablePath}`,
  ].filter(Boolean);

  const actions = auth?.loggedIn ? ["Log out", "Switch billing"] : ["Log in", "Switch billing"];
  const choice = await vscode.window.showInformationMessage(
    "Cadre account",
    { modal: true, detail: lines.join("\n") },
    ...actions,
  );
  if (choice === "Log out") await confirmLogout(controller);
  else if (choice === "Log in") runAuth("login", controller);
  else if (choice === "Switch billing") await chooseBilling(controller);
}

/** Login is an interactive browser flow, so it belongs in a terminal. */
function runAuth(subcommand: "login" | "logout", controller?: TeamController): void {
  const executablePath = resolveClaudeExecutable(log);
  if (!executablePath) {
    void vscode.window.showErrorMessage("Can't find the claude executable.");
    return;
  }
  const name = `Claude ${subcommand}`;
  const terminal = vscode.window.createTerminal({ name });
  terminal.show();
  terminal.sendText(`"${executablePath}" auth ${subcommand}`);

  // The credential watcher usually catches this first; closing the terminal is
  // the backstop for a login that wrote nothing (cancelled, or already signed in).
  const sub = vscode.window.onDidCloseTerminal((closed) => {
    if (closed !== terminal) return;
    sub.dispose();
    controller?.recheckAuth();
  });
}

async function confirmLogout(controller: TeamController): Promise<void> {
  const executablePath = resolveClaudeExecutable(log);
  if (!executablePath) {
    void vscode.window.showErrorMessage("Can't find the claude executable.");
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    "Log out of Claude?",
    {
      modal: true,
      detail:
        "This signs out the Claude Code CLI itself, so anything else using it on this machine is signed out too. Cadre cannot run until you sign back in or switch to an API key.",
    },
    "Log out",
  );
  if (confirmed !== "Log out") return;

  const result = await logout(executablePath);
  if (!result.ok) {
    void vscode.window.showErrorMessage(`Logout failed: ${result.detail}`);
    return;
  }
  // The live session is running on the credential that just went away.
  controller.newSession();
  await controller.refreshSendability();
  const next = await vscode.window.showInformationMessage(
    "Logged out of Claude.",
    "Log back in",
    "Use an API key",
  );
  if (next === "Log back in") runAuth("login", controller);
  else if (next === "Use an API key") await vscode.commands.executeCommand("cadre.setApiKey");
}

/**
 * Fetches a LaTeX toolchain on request. Never automatic: it is a 60 MB download,
 * and it is the user's machine.
 */
async function setupToolchain(): Promise<void> {
  const existing = await detectToolchain();
  if (existing.builder) {
    void vscode.window.showInformationMessage(
      `LaTeX is already available (${existing.managed ?? existing.builder}).`,
    );
    return;
  }
  const go = await vscode.window.showInformationMessage(
    "Install a LaTeX toolchain for Cadre?",
    {
      modal: true,
      detail:
        `Downloads Tectonic (~60 MB) into ${toolchainHome()}. No sudo, nothing outside that folder, ` +
        `and removing it is deleting the folder. Without it the team still writes the paper — you just ` +
        `cannot build the PDF here.`,
    },
    "Install",
  );
  if (go !== "Install") return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Installing Tectonic" },
    async (progress) => {
      const result = await installToolchain((line) => progress.report({ message: line }));
      if (result.ok) void vscode.window.showInformationMessage(result.detail);
      else void vscode.window.showErrorMessage(`Could not install: ${result.detail}`);
    },
  );
}

async function buildThePaper(controller: TeamController): Promise<void> {
  const folder = controller.activeFolder();
  if (!folder) {
    void vscode.window.showWarningMessage("Open a folder first.");
    return;
  }
  const docs = vscode.workspace.getConfiguration("cadre", folder.uri).get<string>("docsPath") || "docs";
  const dir = vscode.Uri.joinPath(folder.uri, docs, "paper").fsPath;

  const built = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Building the paper" },
    () => buildPaper(dir),
  );
  if (built.ok && built.pdf) {
    const open = await vscode.window.showInformationMessage(built.detail, "Open PDF");
    if (open === "Open PDF") {
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(built.pdf));
    }
    return;
  }
  const fix = /toolchain/i.test(built.detail) ? "Install a toolchain" : undefined;
  const choice = await vscode.window.showErrorMessage(built.detail, ...(fix ? [fix] : []));
  if (choice === fix) await setupToolchain();
}

/** One place to reach everything, mirroring the shape of Claude Code's own menu. */
async function settingsHub(controller: TeamController): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("cadre");
  const executablePath = resolveClaudeExecutable(log);
  const [billing, auth] = await Promise.all([
    controller.billing.status(),
    executablePath ? readAuthStatus(executablePath) : Promise.resolve(undefined),
  ]);
  const model = cfg.get<string>("model") || "default";
  const spend = cfg.get<number>("maxSpendUsd") ?? 0;

  const items: (vscode.QuickPickItem & { run: () => unknown })[] = [
    { label: "$(hubot) Default model", description: `${model} — each agent can override this`, run: () => chooseDefault("model", controller) },
    { label: "$(lightbulb) Thinking", description: cfg.get<string>("thinking") ?? "adaptive", run: chooseThinking },
    { label: "$(shield) Autonomy", description: controller.effectiveAutonomy(), run: () => chooseAutonomy(controller) },
    { label: "$(credit-card) Billing", description: billing.ok ? billing.describe : billing.reason, run: () => chooseBilling(controller) },
    { label: "$(account) Account", description: describeAuth(auth), run: () => showAccount(controller) },
    { label: "$(law) Spend cap", description: spend > 0 ? `$${spend.toFixed(2)} per run` : "none", run: chooseSpendCap },
    { label: "$(git-merge) Delegation depth", description: `${cfg.get<number>("maxDelegationDepth") ?? 3} — how far a chain of briefs may go`, run: chooseDepth },
    { label: "$(discard) Checkpoints", description: cfg.get<boolean>("checkpoints") === false ? "off" : "on", run: () => toggle("checkpoints") },
    { label: "", kind: vscode.QuickPickItemKind.Separator, run: () => undefined },
    { label: "$(folder-opened) Project", description: controller.activeFolder()?.name ?? "none", run: () => selectProject(controller) },
    { label: "$(compass) Survey this project", description: "writes PROJECT.md so later sessions start informed", run: () => onboard(controller) },
    { label: "$(json) Apply a project profile…", run: () => applyProfile(controller) },
    { label: "$(history) Resume a session…", run: () => resumeSession(controller) },
    { label: "$(plug) Connectors…", run: () => openSetting("cadre.connectors") },
    { label: "$(book) Playbooks…", run: () => openSetting("cadre.playbooks") },
    { label: "$(file-text) Documentation…", run: () => openSetting("cadre.documentation") },
    { label: "$(extensions) Plugins…", run: () => openSetting("cadre.plugins") },
    { label: "$(file-pdf) Build the paper", run: () => buildThePaper(controller) },
    { label: "$(gear) All settings…", run: () => openSetting("cadre") },
  ];

  const picked = await vscode.window.showQuickPick(items, { title: "Cadre", ignoreFocusOut: true });
  await picked?.run();
}

const openSetting = (key: string) =>
  vscode.commands.executeCommand("workbench.action.openSettings", key);

async function toggle(key: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("cadre");
  const next = !(cfg.get<boolean>(key) ?? key === "checkpoints");
  await cfg.update(key, next, vscode.ConfigurationTarget.Workspace);
  void vscode.window.showInformationMessage(`${key} is now ${next ? "on" : "off"}.`);
}

async function chooseThinking(): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "Adaptive", detail: "Each teammate decides when and how much to reason. Recommended.", value: "adaptive" },
      { label: "Off", detail: "No extended thinking. Faster and cheaper; noticeably worse on hard problems.", value: "off" },
    ],
    { title: "Thinking", ignoreFocusOut: true },
  );
  if (!picked) return;
  await vscode.workspace.getConfiguration("cadre").update("thinking", picked.value, vscode.ConfigurationTarget.Workspace);
}

const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];

/**
 * The workspace default. Per-agent model and effort now live on the agent, in
 * the builder, where you can see which agent you are changing.
 */
async function chooseDefault(key: "model" | "effort", controller?: TeamController): Promise<void> {
  const current = vscode.workspace.getConfiguration("cadre").get<string>(key) ?? "";

  let options: { label: string; description?: string; detail?: string; value: string }[];
  if (key === "model") {
    // The installed CLI is the authority on which models exist and what their
    // identifiers are — they are not the API's, and they change per release.
    const executablePath = resolveClaudeExecutable(log);
    const models = executablePath
      ? await discoverModels({
          executablePath,
          cwd: controller?.activeFolder()?.uri.fsPath ?? process.cwd(),
          log: (m) => log.info(m),
        })
      : cachedModels();
    options = [
      { label: "Default", value: "", detail: "Let the CLI choose" },
      ...models.map((m) => ({
        label: m.label,
        value: m.value,
        detail: [m.value, m.efforts.length ? `effort: ${m.efforts.join(", ")}` : "no effort levels"]
          .filter(Boolean)
          .join("  ·  "),
      })),
    ];
  } else {
    options = EFFORTS.map((v) => ({ label: v || "Default", value: v }));
  }

  const picked = await vscode.window.showQuickPick(
    options.map((o) => ({ ...o, description: o.value === current ? "current" : o.description })),
    { title: `Default ${key} for agents that do not set their own`, ignoreFocusOut: true },
  );
  if (!picked) return;
  await vscode.workspace
    .getConfiguration("cadre")
    .update(key, picked.value, vscode.ConfigurationTarget.Workspace);
}

async function chooseDepth(): Promise<void> {
  const entered = await vscode.window.showInputBox({
    title: "Maximum delegation depth",
    prompt: "How many delegate arrows a single chain may follow. Cycles are allowed, so this is what makes them stop.",
    value: String(vscode.workspace.getConfiguration("cadre").get<number>("maxDelegationDepth") ?? 3),
    validateInput: (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 8 ? undefined : "A whole number from 1 to 8."),
  });
  if (entered === undefined) return;
  await vscode.workspace
    .getConfiguration("cadre")
    .update("maxDelegationDepth", Number(entered), vscode.ConfigurationTarget.Workspace);
}

async function chooseSpendCap(): Promise<void> {
  const entered = await vscode.window.showInputBox({
    title: "Spend cap per run (USD)",
    prompt: "The run stops when it exceeds this. 0 means no cap.",
    value: String(vscode.workspace.getConfiguration("cadre").get<number>("maxSpendUsd") ?? 0),
    validateInput: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? undefined : "Enter a number, 0 or more."),
  });
  if (entered === undefined) return;
  await vscode.workspace
    .getConfiguration("cadre")
    .update("maxSpendUsd", Number(entered), vscode.ConfigurationTarget.Workspace);
}

async function resumeSession(controller: TeamController): Promise<void> {
  const cwd = controller.activeFolder()?.uri.fsPath;
  if (!cwd) {
    void vscode.window.showWarningMessage("Open a folder first — sessions are stored per project.");
    return;
  }
  let sessions;
  try {
    sessions = await listSessions({ dir: cwd, limit: 40 });
  } catch (err) {
    void vscode.window.showErrorMessage(`Couldn't read session history: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!sessions.length) {
    void vscode.window.showInformationMessage("No stored sessions for this folder yet.");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    sessions.map((s) => ({
      label: s.customTitle || s.summary || s.firstPrompt || "(untitled)",
      description: new Date(s.lastModified).toLocaleString(),
      sessionId: s.sessionId,
    })),
    { title: "Resume a session", ignoreFocusOut: true, matchOnDescription: true },
  );
  if (!picked) return;
  controller.resumeSession(picked.sessionId, picked.label);
}

async function rewindFiles(controller: TeamController): Promise<void> {
  const turns = controller.history();
  if (!turns.length) {
    void vscode.window.showInformationMessage("Nothing to rewind to — no turns in this session yet.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    [...turns].reverse().map((t) => ({
      label: t.text.length > 70 ? `${t.text.slice(0, 70)}…` : t.text,
      description: new Date(t.at).toLocaleTimeString(),
      id: t.id,
    })),
    { title: "Rewind the workspace to just before…", ignoreFocusOut: true },
  );
  if (!picked) return;

  // Show what it would do before doing it.
  const preview = await controller.rewind(picked.id, true);
  if (!preview.ok) {
    void vscode.window.showWarningMessage(`Cannot rewind: ${preview.detail}`);
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    "Restore files to that point?",
    { modal: true, detail: `${preview.detail} Changes made after it are lost.` },
    "Rewind",
  );
  if (confirmed !== "Rewind") return;

  const result = await controller.rewind(picked.id, false);
  if (result.ok) void vscode.window.showInformationMessage(result.detail);
  else void vscode.window.showErrorMessage(`Rewind failed: ${result.detail}`);
}

// --------------------------------------------------------------------- html

function teamHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  const asset = (...parts: string[]): vscode.Uri =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, ...parts));

  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join("; ");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset("media", "team.css")}">
<title>Cadre</title>
</head>
<body>
  <header class="bar">
    <button class="brand" id="home" title="Home — projects and past sessions">CADRE</button>
    <button class="chip pick" id="workspace" title="Back to projects">—</button>
    <span class="chip" id="autonomy">—</span>
    <span class="chip" id="billing">—</span>
    <span class="chip" id="connectors" hidden>—</span>
    <span class="chip" id="context" hidden>—</span>
    <span class="spacer"></span>
    <button class="chip pick account" id="account" title="Account">account</button>
    <span class="chip" id="spend">$0.0000</span>
    <button class="ghost wide" id="openFloor" title="Open this workflow in a full editor tab, with room for every lane">⛶ Full view</button>
  </header>

  <section class="screen gate" id="screen-auth" hidden>
    <div class="gate-card">
      <span class="glyph">◈</span>
      <h1>Sign in to Claude</h1>
      <p id="auth-detail">The team runs on your Claude Code login. Nothing can run until it is signed in.</p>
      <div class="gate-actions">
        <button class="primary" id="auth-signin">Sign in to Claude</button>
        <button class="ghost" id="auth-apikey">Use an API key instead</button>
      </div>
      <button class="ghost quiet" id="auth-recheck">Check again</button>
    </div>
  </section>

  <section class="screen" id="screen-projects" hidden>
    <div class="projects-head">
      <h1>Projects</h1>
      <span class="muted" id="projects-roots"></span>
    </div>
    <div class="project-list" id="project-list"></div>
    <div class="projects-foot">
      <button class="ghost" id="projects-configure">Change where to look…</button>
    </div>
  </section>

  <section class="screen" id="screen-home" hidden>
    <div class="home-head">
      <div>
        <h1>Workflows</h1>
        <span class="muted" id="home-project"></span>
      </div>
      <div class="home-actions">
        <button class="ghost" id="home-new">Blank workflow</button>
        <button class="primary" id="home-build">Build with Claude</button>
      </div>
    </div>
    <div class="composer-card" id="build-card" hidden>
      <label for="build-input">Describe the pipeline</label>
      <p class="muted">What are the stages, who does what, and what should happen automatically. Claude designs the agents, their prompts and the arrows; you edit anything before it runs.</p>
      <textarea id="build-input" rows="4" placeholder="e.g. Read incoming support tickets, work out which are bugs, reproduce the bugs against our repo, and draft a reply for each one."></textarea>
      <div class="build-row">
        <span class="muted" id="build-note"></span>
        <span class="spacer"></span>
        <button class="ghost" id="build-cancel">Cancel</button>
        <button class="primary" id="build-go">Build it</button>
      </div>
    </div>
    <div class="workflow-list" id="workflow-list"></div>
    <div class="templates" id="templates">
      <h2>Start from a template</h2>
      <div class="template-list" id="template-list"></div>
    </div>
  </section>

  <section class="screen" id="screen-workflow" hidden>
    <div class="detail-head">
      <button class="ghost" id="detail-back" title="Back to workflows">‹ Workflows</button>
      <span class="spacer"></span>
      <button class="ghost" id="detail-scope" title="Where this workflow is stored">—</button>
      <button class="ghost" id="detail-edit">Edit</button>
      <button class="primary" id="detail-start">New conversation</button>
    </div>
    <div class="detail-body">
      <div class="detail-main">
        <h1 id="detail-name">—</h1>
        <p class="muted" id="detail-desc"></p>
        <div class="detail-problems" id="detail-problems" hidden></div>
        <h2>Conversations</h2>
        <div class="session-list" id="detail-sessions"></div>
      </div>
      <aside class="detail-map">
        <div class="map-wrap" id="detail-map"></div>
        <div class="map-legend" id="detail-legend"></div>
      </aside>
    </div>
  </section>

  <section class="screen builder" id="screen-builder" hidden>
    <div class="builder-bar">
      <button class="ghost" id="builder-back" title="Back to workflows">‹ Workflows</button>
      <input id="builder-name" class="name-field" aria-label="Workflow name" placeholder="Name this workflow">
      <span class="spacer"></span>
      <span class="note" id="builder-note"></span>
      <span class="saved" id="builder-saved" data-state="saved"></span>
      <label class="toggle" title="Turn a one-line description into a full system prompt before launching. You always see the result.">
        <input type="checkbox" id="builder-refine" checked>
        <span>Refine prompts</span>
      </label>
      <button class="ghost" id="builder-add">Add agent</button>
      <button class="ghost" id="builder-save">Save</button>
      <button class="primary" id="builder-launch">Launch</button>
    </div>
    <div class="builder-body">
      <div class="canvas-wrap" id="canvas-wrap">
        <div class="canvas" id="canvas">
          <svg class="wires" id="wires" aria-hidden="true"></svg>
        </div>
      </div>
      <aside class="inspector" id="inspector" hidden></aside>
    </div>
    <div class="problems" id="problems" hidden></div>
  </section>

  <div class="screen" id="screen-run" hidden>
    <details class="livemap" id="livemap" open>
      <summary>
        <span class="chev" aria-hidden="true">›</span>
        <span id="livemap-title">Workflow</span>
        <span class="livemap-hint" id="livemap-hint"></span>
        <span class="livemap-toggle" id="livemap-toggle">Hide</span>
      </summary>
      <div class="map-wrap" id="run-map"></div>
    </details>
    <div class="splitter" id="splitter" role="separator" aria-orientation="horizontal"
         aria-label="Resize the workflow map" tabindex="0" title="Drag to resize · double-click to reset"></div>
    <div class="roster" id="roster"></div>
    <main class="floor" id="floor"></main>
    <footer class="composer">
      <div class="to">
        <span>Talking to</span>
        <select id="channel" aria-label="Who to talk to"></select>
        <span class="spacer"></span>
        <button class="ghost quiet" id="run-sessions" title="Earlier conversations in this workflow">Sessions</button>
        <button class="ghost quiet" id="run-edit" title="Edit this workflow">Edit</button>
      </div>
      <div class="sessions" id="sessions" hidden>
        <div class="session-list" id="session-list"></div>
      </div>
      <div class="attachments" id="attachments" hidden></div>
      <div class="row">
        <input type="file" id="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
        <button class="ghost attach" id="attach" title="Attach an image (or paste, or drop one here)">＋</button>
        <textarea id="input" rows="1" placeholder="Describe your project…" aria-label="Message"></textarea>
        <button class="primary" id="send" title="Send (Enter)">Send</button>
        <button class="danger" id="stop" title="Interrupt" hidden>Stop</button>
      </div>
    </footer>
  </div>

  <script nonce="${nonce}" src="${asset("media", "team.js")}"></script>
</body>
</html>`;
}

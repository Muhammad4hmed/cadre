import * as vscode from "vscode";
import { resolveClaudeExecutable } from "../cli";
import { Billing } from "../billing";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DISPLAY_NAME, TEAMMATES, type Attachment, type TeamEvent, type TeammateId, type UiCommand } from "./events";
import { TeamSession, type TeamConfig } from "./orchestrator";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { discoverProjects } from "./project";
import { SettingsTrust } from "./trust";
import { describeAuth, readAuthStatus } from "../auth";

type Readiness = { ok: true; config: TeamConfig } | { ok: false; reason: string };

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Owns the session and fans events out to every attached surface — the sidebar
 * view and the Team Floor tab both render the same stream. A replay log lets a
 * surface opened mid-run catch up instead of showing an empty board.
 */
export class TeamController implements vscode.Disposable {
  private session: TeamSession | undefined;
  private readonly surfaces = new Set<vscode.Webview>();
  private readonly replay: TeamEvent[] = [];
  /**
   * Latest value of each state-shaped event. A surface opened mid-run needs the
   * current roster and status lights, not the history of how they got there.
   */
  private latestRoster: TeamEvent | undefined;
  private readonly latestStatus = new Map<TeammateId, TeamEvent>();
  private busy = false;
  private channel: TeammateId = "lead";
  /** Set by "Resume Session"; consumed by the next session that starts. */
  private pendingResume: string | undefined;
  /**
   * Which workspace folder the team works in. Only folder[0] used to be
   * reachable, so in a multi-root workspace every other folder was silently
   * invisible. Persisted per window.
   */
  private activeFolderPath: string | undefined;
  /**
   * The webview opens on the project list rather than an empty chat. Cleared
   * once the user commits to a project, restored by the Home button.
   */
  private atHome = true;
  /** Set when a run fails for an auth reason, so the UI can say so properly. */
  private authProblem: string | undefined;
  /**
   * `claude auth status` spawns the CLI, so it is cached. Config and folder
   * changes are frequent; shelling out on each one would be both slow and
   * enough to make the composer feel laggy.
   */
  private authCache: { at: number; value: Awaited<ReturnType<typeof readAuthStatus>> } | undefined;

  readonly billing: Billing;

  private readonly memento: vscode.Memento;
  readonly trust: SettingsTrust;
  /** Warnings already shown, so a settings change does not repeat them. */
  private shownWarnings = new Set<string>();

  constructor(
    context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.billing = new Billing(context.secrets);
    this.memento = context.workspaceState;
    this.trust = new SettingsTrust(context.workspaceState);
    this.activeFolderPath = this.memento.get<string>("cadre.activeFolder");
    this.watchCredentials();
  }

  /**
   * Signing in happens in a terminal, outside anything we control, so the only
   * reliable signal that it worked is the credential file changing. Polling
   * rather than fs.watch: the CLI writes atomically (write + rename), which
   * fs.watch on the path itself can miss entirely.
   */
  private watchCredentials(): void {
    const file = path.join(os.homedir(), ".claude", ".credentials.json");
    const listener = () => {
      this.log.info("claude credentials changed — rechecking auth");
      this.authProblem = undefined;
      this.authCache = undefined;
      void this.publishScreen();
    };
    try {
      fs.watchFile(file, { interval: 2000 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) listener();
      });
      this.stopWatching = () => fs.unwatchFile(file);
    } catch (err) {
      this.log.warn(`could not watch credentials: ${describeError(err)}`);
    }
  }

  private stopWatching: (() => void) | undefined;

  /** Called after an interactive `claude auth` run finishes. */
  recheckAuth(): void {
    this.authProblem = undefined;
    this.authCache = undefined;
    void this.publishScreen();
  }

  // ---------------------------------------------------------------- projects

  folders(): readonly vscode.WorkspaceFolder[] {
    return vscode.workspace.workspaceFolders ?? [];
  }

  /** The folder the team works in, falling back to the first available. */
  activeFolder(): vscode.WorkspaceFolder | undefined {
    const all = this.folders();
    if (!all.length) return undefined;
    const remembered = all.find((f) => f.uri.fsPath === this.activeFolderPath);
    return remembered ?? all[0];
  }

  /** Drops a remembered folder that is no longer part of the workspace. */
  reconcileFolders(): void {
    if (!this.activeFolderPath) return;
    const stillOpen = this.folders().some((f) => f.uri.fsPath === this.activeFolderPath);
    if (stillOpen) return;
    this.log.info(`active project ${this.activeFolderPath} left the workspace`);
    this.activeFolderPath = undefined;
    void this.memento.update("cadre.activeFolder", undefined);
    this.session?.dispose();
    this.session = undefined;
    this.broadcast({ kind: "clear" });
  }

  async setActiveFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    if (folder.uri.fsPath === this.activeFolder()?.uri.fsPath) return;
    this.activeFolderPath = folder.uri.fsPath;
    await this.memento.update("cadre.activeFolder", folder.uri.fsPath);
    // Settings are per-folder, and the CLI runs with a fixed cwd, so switching
    // project means a new session rather than a re-pointed one.
    this.session?.dispose();
    this.session = undefined;
    this.broadcast({ kind: "clear" });
    this.broadcast({ kind: "notice", level: "info", text: `Working in ${folder.name}.` });
    await this.refreshSendability();
    this.log.info(`active project: ${folder.uri.fsPath}`);
  }

  // -------------------------------------------------------------- surfaces

  attach(webview: vscode.Webview): vscode.Disposable {
    this.surfaces.add(webview);
    const sub = webview.onDidReceiveMessage((command: UiCommand) => this.handle(command));
    return new vscode.Disposable(() => {
      sub.dispose();
      this.surfaces.delete(webview);
    });
  }

  /**
   * Decides what the user should be looking at. Auth wins over everything —
   * a signed-out team cannot do anything, and saying so up front beats a
   * cryptic model error after they have typed a message.
   */
  private async publishScreen(webview?: vscode.Webview): Promise<void> {
    const targets = webview ? [webview] : [...this.surfaces];
    const executablePath = resolveClaudeExecutable(this.log);
    const billing = await this.billing.status();
    const usingApiKey = this.billing.mode === "apiKey";

    const auth = executablePath && !usingApiKey ? await this.cachedAuth(executablePath) : undefined;
    // An unreadable status is NOT evidence of being signed in. Treat it as
    // unknown: do not gate the user out, but never claim they are signed in.
    const known = auth !== undefined;
    const signedIn = usingApiKey
      ? billing.ok
      : known
        ? auth.loggedIn && !this.authProblem
        : !this.authProblem;

    const detail = this.authProblem
      ? this.authProblem
      : usingApiKey
        ? billing.ok
          ? billing.describe
          : billing.reason
        : known
          ? describeAuth(auth)
          : "Signed-in state unknown — the CLI could not report it.";

    const screen: "auth" | "projects" | "team" = !signedIn ? "auth" : this.atHome ? "projects" : "team";

    for (const surface of targets) {
      void surface.postMessage({
        kind: "auth",
        signedIn,
        detail,
        billing: billing.ok ? billing.describe : billing.reason,
        usingApiKey,
      });
      if (screen === "projects") {
        void surface.postMessage(this.projectList());
        void this.publishSessions(surface);
      }
      void surface.postMessage({ kind: "screen", screen });
    }
  }

  private async cachedAuth(
    executablePath: string,
  ): Promise<Awaited<ReturnType<typeof readAuthStatus>>> {
    // A confident "signed in" is worth caching. Unknown or signed-out is a
    // state the user is probably in the middle of fixing, so retry it sooner.
    const value = this.authCache?.value;
    const age = value?.loggedIn ? 60_000 : 3_000;
    if (this.authCache && Date.now() - this.authCache.at < age) return value;
    const fresh = await readAuthStatus(executablePath);
    this.authCache = { at: Date.now(), value: fresh };
    return fresh;
  }

  /**
   * Past conversations for the active project. Read lazily: listSessions walks
   * the session store on disk, and the project list should not wait on it.
   */
  private async publishSessions(webview: vscode.Webview): Promise<void> {
    const folder = this.activeFolder();
    if (!folder) {
      void webview.postMessage({ kind: "sessions", items: [] });
      return;
    }
    try {
      const found = await listSessions({ dir: folder.uri.fsPath, limit: 25 });
      void webview.postMessage({
        kind: "sessions",
        project: folder.name,
        items: found.map((s) => ({
          id: s.sessionId,
          title: s.customTitle || s.summary || s.firstPrompt || "(untitled)",
          when: s.lastModified,
        })),
      });
    } catch (err) {
      this.log.warn(`could not list sessions: ${describeError(err)}`);
      void webview.postMessage({ kind: "sessions", items: [] });
    }
  }

  private projectList(): TeamEvent {
    const folders = this.folders().map((f) => f.uri.fsPath);
    const configured = vscode.workspace
      .getConfiguration("cadre", this.activeFolder()?.uri)
      .get<string[]>("projectRoots") ?? [];
    // Default: look beside the folders that are already open.
    const roots = configured.length ? configured : [...new Set(folders.map((f) => path.dirname(f)))];
    const docsPath = vscode.workspace
      .getConfiguration("cadre", this.activeFolder()?.uri)
      .get<string>("docsPath") || "docs";

    return {
      kind: "projects",
      roots,
      items: discoverProjects(roots, folders, docsPath),
      active: this.activeFolder()?.uri.fsPath,
    };
  }

  /** Brings a freshly-opened surface up to date. */
  private hydrate(webview: vscode.Webview): void {
    void webview.postMessage({ kind: "directLine", enabled: this.directLineEnabled() });
    if (this.latestRoster) void webview.postMessage(this.latestRoster);
    for (const event of this.replay) void webview.postMessage(event);
    for (const event of this.latestStatus.values()) void webview.postMessage(event);
    void webview.postMessage({ kind: "busy", busy: this.busy });
    void webview.postMessage({ kind: "channel", to: this.channel });
    void this.publishSendability(webview);
    void this.publishScreen(webview);
  }

  private broadcast(event: TeamEvent): void {
    // An auth failure is a screen, not a transcript entry.
    if (event.kind === "authProblem") {
      this.reportAuthProblem(event.detail);
      return;
    }
    // State-shaped events are remembered as a latest value; content accumulates.
    if (event.kind === "roster") this.latestRoster = event;
    else if (event.kind === "status") this.latestStatus.set(event.who, event);
    else if (event.kind === "busy") this.busy = event.busy;
    else if (!TRANSIENT.has(event.kind)) this.replay.push(event);

    if (event.kind === "clear") {
      this.replay.length = 0;
      this.latestStatus.clear();
      this.busy = false;
    }
    for (const surface of this.surfaces) void surface.postMessage(event);
  }

  // --------------------------------------------------------------- commands

  private handle(command: UiCommand): void {
    switch (command.kind) {
      case "ready":
        for (const surface of this.surfaces) this.hydrate(surface);
        return;
      case "send":
        return this.send(command.text, command.images);
      case "stop":
        void this.session?.interrupt();
        return;
      case "newSession":
        return this.newSession();
      case "setChannel":
        return this.setChannel(command.to);
      case "openTeamFloor":
        void vscode.commands.executeCommand("cadre.openTeamFloor");
        return;
      case "selectProject":
      case "goHome":
        this.atHome = true;
        void this.publishScreen();
        return;
      case "openProject":
        void this.openProject(command.path, command.alreadyOpen);
        return;
      case "requestDirectLine":
        void this.offerDirectLine(command.to);
        return;
      case "resumeSession":
        this.resumeSession(command.id, command.title);
        this.atHome = false;
        void this.publishScreen();
        return;
      case "signIn":
        void vscode.commands.executeCommand("cadre.login");
        return;
      case "useApiKey":
        void vscode.commands.executeCommand("cadre.setApiKey");
        return;
      case "account":
        void vscode.commands.executeCommand("cadre.account");
        return;
      case "refreshAuth":
        this.authProblem = undefined;
        this.authCache = undefined;
        void this.publishScreen();
        return;
      case "configure":
        void vscode.commands.executeCommand("workbench.action.openSettings", command.setting);
        return;
    }
  }

  /** Sends a message on the user's behalf, e.g. from the Onboard command. */
  submit(text: string): void {
    this.send(text);
  }

  /** Opens a project from the home screen. */
  private async openProject(target: string, alreadyOpen: boolean): Promise<void> {
    if (alreadyOpen) {
      const folder = this.folders().find((f) => f.uri.fsPath === target);
      if (folder) await this.setActiveFolder(folder);
      this.atHome = false;
      await this.publishScreen();
      return;
    }
    // Not in the workspace. Opening it keeps the explorer and the team pointed
    // at the same place, which is worth the window reload.
    const confirmed = await vscode.window.showInformationMessage(
      `Open ${path.basename(target)}?`,
      { modal: true, detail: `${target}\n\nVS Code reloads to open this folder. The current session ends.` },
      "Open",
      "Add to Workspace",
    );
    if (confirmed === "Open") {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target));
    } else if (confirmed === "Add to Workspace") {
      vscode.workspace.updateWorkspaceFolders(this.folders().length, 0, { uri: vscode.Uri.file(target) });
    }
  }

  private send(text: string, images: Attachment[] = []): void {
    const trimmed = text.trim();
    // An image on its own is a complete message; do not require a caption.
    if (!trimmed && !images.length) return;

    this.atHome = false;
    const session = this.ensureSession();
    if (!session) {
      // Never swallow what the user typed.
      for (const surface of this.surfaces) void surface.postMessage({ kind: "restoreInput", text: trimmed });
      return;
    }
    session.send(trimmed, images);
  }

  /**
   * Offers to open the direct line at the moment the user reaches for it,
   * rather than sending them to a settings file to find a boolean.
   */
  private async offerDirectLine(to: TeammateId): Promise<void> {
    const name = DISPLAY_NAME[to];
    const choice = await vscode.window.showInformationMessage(
      `Talk to the ${name} directly?`,
      {
        modal: true,
        detail:
          `Normally you talk to the Lead and it delegates. A direct line skips it — useful for a quick question, but the Lead does not see the exchange, so its picture of the work goes stale until you tell it.\n\nYou can switch back to the Lead at any time.`,
      },
      "Open a direct line",
    );
    if (choice !== "Open a direct line") return;

    await vscode.workspace
      .getConfiguration("cadre")
      .update("directLine", true, vscode.ConfigurationTarget.Global);
    await this.refreshSendability();
    this.setChannel(to);
  }

  private setChannel(to: TeammateId): void {
    if (!TEAMMATES.includes(to)) return;
    if (to !== "lead" && !this.directLineEnabled()) {
      this.broadcast({
        kind: "notice",
        level: "warn",
        text: "Direct line is off. Turn on cadre.directLine to talk to a teammate without the Lead.",
      });
      // Re-assert the gate: a surface that asked for this had a stale lock state.
      for (const surface of this.surfaces) {
        void surface.postMessage({ kind: "directLine", enabled: false });
      }
      return;
    }
    this.channel = to;
    this.session?.setChannel(to);
    for (const surface of this.surfaces) void surface.postMessage({ kind: "channel", to });
  }

  newSession(): void {
    this.session?.dispose();
    this.session = undefined;
    this.channel = "lead";
    this.broadcast({ kind: "clear" });
    this.broadcast({ kind: "notice", level: "info", text: "New session." });
    void this.refreshSendability();
    this.log.info("session reset");
  }

  stop(): void {
    void this.session?.interrupt();
  }

  compactNow(): void {
    this.session?.compactNow();
  }

  /** Reopens a stored conversation. The next send starts against its history. */
  resumeSession(sessionId: string, summary: string): void {
    this.session?.dispose();
    this.session = undefined;
    this.channel = "lead";
    this.pendingResume = sessionId;
    this.broadcast({ kind: "clear" });
    this.broadcast({
      kind: "notice",
      level: "info",
      text: `Resuming: ${summary}. The transcript above is not replayed, but the team remembers it.`,
    });
    void this.refreshSendability();
  }

  history(): { id: string; text: string; at: number }[] {
    return this.session?.history() ?? [];
  }

  async rewind(turnId: string, dryRun = false): Promise<{ ok: boolean; detail: string }> {
    if (!this.session) return { ok: false, detail: "No live session." };
    const result = await this.session.rewind(turnId, dryRun);
    if (result.ok && !dryRun) {
      this.broadcast({ kind: "notice", level: "info", text: `Rewound: ${result.detail}` });
    }
    return result;
  }

  dispose(): void {
    this.stopWatching?.();
    this.stopWatching = undefined;
    this.session?.dispose();
    this.session = undefined;
  }

  // -------------------------------------------------------------- readiness

  /** Called when a run fails for an auth reason, so the UI can explain properly. */
  reportAuthProblem(detail: string): void {
    this.authProblem = detail;
    this.authCache = undefined;   // the cached "signed in" is now known to be wrong
    void this.publishScreen();
  }

  async refreshSendability(): Promise<void> {
    for (const surface of this.surfaces) await this.publishSendability(surface);
    void this.publishScreen();
    for (const surface of this.surfaces) {
      void surface.postMessage({ kind: "directLine", enabled: this.directLineEnabled() });
    }
  }

  private async publishSendability(webview: vscode.Webview): Promise<void> {
    const readiness = this.check();
    if (!readiness.ok) {
      void webview.postMessage({ kind: "sendability", ok: false, reason: readiness.reason });
      return;
    }
    const billing = await this.billing.status();
    void webview.postMessage(
      billing.ok
        ? { kind: "sendability", ok: true }
        : { kind: "sendability", ok: false, reason: `${billing.reason} ${billing.remedy}` },
    );
  }

  private check(): Readiness {
    const folder = this.activeFolder();
    if (!folder) {
      return { ok: false, reason: "Open a folder to start — the team needs a working directory." };
    }
    const cwd = folder.uri.fsPath;
    const executablePath = resolveClaudeExecutable(this.log);
    if (!executablePath) {
      return {
        ok: false,
        reason: "Can't find the claude executable. Install Claude Code, or set cadre.claudeExecutablePath.",
      };
    }

    // Scoped to the folder, so a project can carry its own profile in
    // .vscode/settings.json — cheap-and-autonomous in a sandbox, supervised in
    // a production repo.
    const cfg = vscode.workspace.getConfiguration("cadre", folder.uri);
    const per = <T>(key: string): Partial<Record<TeammateId, T>> =>
      Object.fromEntries(TEAMMATES.map((id) => [id, cfg.get<T>(`${id}.${key}`)]).filter(([, v]) => v));

    // A repository can ship .vscode/settings.json. Anything in it that would
    // widen permissions or start a process is clamped until explicitly allowed.
    const vetted = this.trust.vet(cfg);
    for (const warning of vetted.warnings) {
      if (this.shownWarnings.has(warning)) continue;
      this.shownWarnings.add(warning);
      this.broadcast({ kind: "notice", level: "warn", text: warning });
      this.log.warn(warning);
      // A transcript notice is easy to miss, and the remedy is a command the
      // user has to go find. Offer it directly.
      void vscode.window.showWarningMessage(warning, "Review…").then((choice) => {
        if (choice === "Review…") void vscode.commands.executeCommand("cadre.reviewWorkspaceSettings");
      });
    }

    return {
      ok: true,
      config: {
        cwd,
        executablePath,
        autonomy: vetted.autonomy,
        inheritGlobalConfig: cfg.get<boolean>("inheritGlobalConfig") ?? false,
        directLine: cfg.get<boolean>("directLine") ?? false,
        models: per<string>("model"),
        efforts: per<string>("effort"),
        skills: cfg.get<string[]>("playbooks")?.length ? cfg.get<string[]>("playbooks") : undefined,
        connectors: vetted.connectors,
        thinking: cfg.get<"adaptive" | "off">("thinking") ?? "adaptive",
        fallbackModel: cfg.get<string>("fallbackModel") ?? "",
        maxSpendUsd: cfg.get<number>("maxSpendUsd") ?? 0,
        checkpoints: cfg.get<boolean>("checkpoints") ?? true,
        additionalDirectories: cfg.get<string[]>("additionalDirectories") ?? [],
        plugins: vetted.plugins,
        exclusiveConnectors: cfg.get<boolean>("exclusiveConnectors") ?? false,
        persistSessions: cfg.get<boolean>("persistSessions") ?? true,
        documentation: cfg.get<"off" | "substantial" | "always">("documentation") ?? "substantial",
        docsPath: cfg.get<string>("docsPath") || "docs",
        resumeSessionId: this.pendingResume,
      },
    };
  }

  /** The folder-scoped configuration the trust review acts on. */
  configForActiveFolder(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("cadre", this.activeFolder()?.uri);
  }

  /** What is actually in force, which may differ from the raw setting. */
  effectiveAutonomy(): string {
    const vetted = this.trust.vet(this.configForActiveFolder());
    const raw = this.configForActiveFolder().get<string>("autonomy") ?? "standard";
    return vetted.autonomy === raw ? raw : `${vetted.autonomy}  (${raw} not allowed from this folder)`;
  }

  forgetShownWarnings(): void {
    this.shownWarnings.clear();
  }

  private directLineEnabled(): boolean {
    return (
      vscode.workspace
        .getConfiguration("cadre", this.activeFolder()?.uri)
        .get<boolean>("directLine") ?? false
    );
  }

  private ensureSession(): TeamSession | undefined {
    if (this.session) return this.session;

    const readiness = this.check();
    if (!readiness.ok) {
      this.broadcast({ kind: "notice", level: "error", text: readiness.reason });
      for (const surface of this.surfaces) {
        void surface.postMessage({ kind: "sendability", ok: false, reason: readiness.reason });
      }
      this.offerRemedy(readiness.reason);
      return undefined;
    }

    const session = new TeamSession(readiness.config, this.billing, (e) => this.broadcast(e), this.log);
    // The environment (and therefore the API key) is resolved once, before any
    // nested teammate run can race the secret store.
    void session.prepare().then(() => {
      if (this.channel !== "lead") session.setChannel(this.channel);
    });
    this.session = session;
    return session;
  }

  private offerRemedy(reason: string): void {
    const wantsFolder = reason.startsWith("Open a folder");
    const wantsKey = reason.includes("API-key");
    const action = wantsFolder ? "Open Folder" : wantsKey ? "Set API Key" : "Open Settings";

    void vscode.window.showErrorMessage(reason, action).then((choice) => {
      if (choice !== action) return;
      if (wantsFolder) return void vscode.commands.executeCommand("vscode.openFolder");
      if (wantsKey) return void vscode.commands.executeCommand("cadre.setApiKey");
      void vscode.commands.executeCommand("workbench.action.openSettings", "cadre");
    });
  }
}

/** Events describing momentary state, not transcript content. */
const TRANSIENT = new Set(["sendability", "restoreInput", "channel"]);

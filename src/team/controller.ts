import * as vscode from "vscode";
import { resolveClaudeExecutable } from "../cli";
import { Billing } from "../billing";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentId, Attachment, Screen, TeamEvent, UiCommand } from "./events";
import { WorkflowSession, type RunConfig } from "../workflow/runner";
import { isRunnable, validate, type Scope, type Workflow } from "../workflow/model";
import { PRESET_LIST, TOOL_CATALOGUE } from "../workflow/presets";
import { refinePrompt } from "../workflow/refine";
import { generateWorkflow } from "../workflow/generate";
import * as workflows from "../workflow/store";
import { templateCards, templateById } from "../workflow/templates";
import { getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import { REPLAY_LIMIT, transcriptToEvents, type SessionMessage } from "./replay";
import { discoverProjects } from "./project";
import { SettingsTrust } from "./trust";
import { describeAuth, readAuthStatus } from "../auth";
import { ALL_EFFORTS, cachedModels, cachedSkills, discoverModels, supportsEffort } from "../models";

type Readiness = { ok: true; config: RunConfig } | { ok: false; reason: string };

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A MessageParam's content is a string or a block array; normalise to blocks. */

/**
 * Owns the session and fans events out to every attached surface — the sidebar
 * view and the Team Floor tab both render the same stream. A replay log lets a
 * surface opened mid-run catch up instead of showing an empty board.
 */
export class TeamController implements vscode.Disposable {
  private session: WorkflowSession | undefined;
  private readonly surfaces = new Set<vscode.Webview>();
  private readonly replay: TeamEvent[] = [];
  /**
   * Latest value of each state-shaped event. A surface opened mid-run needs the
   * current roster and status lights, not the history of how they got there.
   */
  private latestRoster: TeamEvent | undefined;
  private readonly latestStatus = new Map<AgentId, TeamEvent>();
  private busy = false;
  private channel: AgentId = "";
  /**
   * The workflow being run, loaded from disk when it is opened. Held for the
   * life of the session: editing it mid-run would change an agent's tools out
   * from under a query that is already using them.
   */
  private running: Workflow | undefined;
  /** The workflow the builder is editing, which need not be the one running. */
  private editing: Workflow | undefined;
  /** The workflow whose page is open, which need not be either of the above. */
  private viewing: Workflow | undefined;
  /** Set by "Resume Session"; consumed by the next session that starts. */
  private pendingResume: string | undefined;
  /** True while a stored transcript is being written into the lanes. */
  private replaying = false;
  /** The CLI's id for the live conversation, once it has told us. */
  private liveSession: string | undefined;
  /** What the first message was, until Claude's own summary replaces it. */
  private provisionalTitle = "";
  /**
   * Which workspace folder the team works in. Only folder[0] used to be
   * reachable, so in a multi-root workspace every other folder was silently
   * invisible. Persisted per window.
   */
  private activeFolderPath: string | undefined;
  /**
   * Where the user is. Home is the workflow list for the active folder; the
   * builder and the run view both need one to be open, so leaving either
   * returns here.
   */
  private screen: Exclude<Screen, "auth"> = "home";
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

    const screen: Screen = signedIn ? this.screen : "auth";

    for (const surface of targets) {
      void surface.postMessage({
        kind: "auth",
        signedIn,
        detail,
        billing: billing.ok ? billing.describe : billing.reason,
        usingApiKey,
      });
      if (screen === "home") {
        void surface.postMessage(this.workflowList());
      } else if (screen === "projects") {
        void surface.postMessage(this.projectList());
      } else if (screen === "workflow" && this.viewing) {
        void this.publishDetail(surface, this.viewing);
      } else if (screen === "builder" && this.editing) {
        // Not authoritative: a screen refresh must not overwrite unsaved edits.
        void surface.postMessage(this.editorState(this.editing, false));
      } else if (screen === "run" && this.running) {
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
    const workflow = this.running ?? this.editing;
    if (!folder || !workflow) {
      void webview.postMessage({ kind: "sessions", items: [], workflowId: "" });
      return;
    }

    // The index says which of this project's sessions belong to this workflow;
    // the CLI's own store says what they are actually called now. Two workflows
    // in one folder would otherwise show each other's history.
    const mine = new Map(workflows.listSessions(folder.uri.fsPath, workflow.id).map((s) => [s.sessionId, s]));
    let items = [...mine.values()].map((s) => ({ id: s.sessionId, title: s.title, when: s.when }));
    try {
      const found = await listSessions({ dir: folder.uri.fsPath, limit: 200 });
      items = found
        .filter((s) => mine.has(s.sessionId))
        .map((s) => ({
          id: s.sessionId,
          title: s.customTitle || s.summary || s.firstPrompt || mine.get(s.sessionId)?.title || "(untitled)",
          when: s.lastModified,
        }));
    } catch (err) {
      this.log.warn(`could not list sessions: ${describeError(err)}`);
    }
    void webview.postMessage({ kind: "sessions", workflowId: workflow.id, items });
  }

  /** One workflow's page: the graph, and its conversations in this project. */
  private async publishDetail(webview: vscode.Webview, workflow: Workflow): Promise<void> {
    const root = this.root();
    const index = root ? workflows.listSessions(root, workflow.id) : [];
    let sessions = index.map((s) => ({ id: s.sessionId, title: s.title, when: s.when }));

    // The index remembers which conversations are ours; the CLI's own store has
    // the current titles, which it rewrites as a conversation develops.
    if (root && index.length) {
      try {
        const known = new Map(index.map((s) => [s.sessionId, s]));
        const found = await listSessions({ dir: root, limit: 200 });
        sessions = found
          .filter((s) => known.has(s.sessionId))
          .map((s) => ({
            id: s.sessionId,
            title: s.customTitle || s.summary || known.get(s.sessionId)?.title || "(untitled)",
            when: s.lastModified,
          }));
      } catch (err) {
        this.log.warn(`could not list sessions: ${describeError(err)}`);
      }
    }

    void webview.postMessage({
      kind: "detail",
      workflow,
      sessions,
      problems: validate(workflow),
    });
  }

  /** The home screen. */
  private workflowList(): TeamEvent {
    const folder = this.activeFolder();
    return {
      kind: "workflows",
      project: folder?.name ?? "",
      items: folder ? workflows.listWorkflows(folder.uri.fsPath) : [],
      templates: templateCards(),
    };
  }

  /** Everything the builder needs to render its panels for one workflow. */
  private editorState(workflow: Workflow, authoritative = true): TeamEvent {
    const cfg = this.configForActiveFolder();
    return {
      kind: "editing",
      workflow,
      authoritative,
      problems: validate(workflow),
      presets: PRESET_LIST.map((p) => ({ id: p.id, name: p.name, blurb: p.blurb })),
      catalogue: TOOL_CATALOGUE,
      // What the CLI has, not a list the user had to type into a setting.
      // `cadre.playbooks` still narrows it when set.
      skills: (() => {
        const configured = cfg.get<string[]>("playbooks") ?? [];
        const available = cachedSkills();
        if (!configured.length) return available;
        const allowed = new Set(configured);
        return available.filter((s) => allowed.has(s.name));
      })(),
      connectors: Object.keys(cfg.get<Record<string, unknown>>("connectors") ?? {}),
      models: cachedModels(),
      efforts: ALL_EFFORTS,
    };
  }

  /**
   * Asks the CLI which models it has, then re-publishes the builder so the
   * picker fills in. Fire-and-forget: the panel opens immediately with the
   * cached or fallback list rather than waiting on a subprocess.
   */
  private refreshModels(): void {
    const root = this.root();
    const executablePath = resolveClaudeExecutable(this.log);
    if (!root || !executablePath) return;
    void discoverModels({
      executablePath,
      cwd: root,
      log: (message) => this.log.info(message),
    }).then((models) => {
      if (!this.editing || this.screen !== "builder") return;
      // Only re-publish when the list actually arrived with something new,
      // so an open inspector is not rebuilt for nothing.
      if (models.length) this.broadcastTo(this.editorState(this.editing, false));
    });
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
    if (this.latestRoster) void webview.postMessage(this.latestRoster);
    if (this.dropped) {
      void webview.postMessage({
        kind: "notice",
        level: "info",
        text: `${this.dropped} earlier messages are not shown here — this session is long enough that the oldest were dropped. The conversation itself is intact.`,
      });
    }
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
    if (event.kind === "sessionStarted") {
      this.noteSession(event.sessionId);
      return;
    }
    // A turn ending is the moment the CLI has had a chance to name the
    // conversation, so that is when the provisional title gets replaced.
    if (event.kind === "spend") void this.refreshSessionTitle();
    // State-shaped events are remembered as a latest value; content accumulates.
    if (event.kind === "roster") this.latestRoster = event;
    else if (event.kind === "status") this.latestStatus.set(event.who, event);
    else if (event.kind === "busy") this.busy = event.busy;
    else if (!TRANSIENT.has(event.kind)) this.remember(event);

    if (event.kind === "clear") {
      this.replay.length = 0;
      this.dropped = 0;
      this.latestStatus.clear();
      this.busy = false;
    }
    for (const surface of this.surfaces) void surface.postMessage(event);
  }

  // --------------------------------------------------------------- commands

  /** Lets an extension command take the same path a webview click does. */
  receive(command: UiCommand): void {
    this.handle(command);
  }

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
        this.screen = "projects";
        void this.publishScreen();
        return;
      case "goHome":
        this.stopBuilderWork();
        this.screen = "home";
        void this.publishScreen();
        return;
      case "openProject":
        void this.openProject(command.path, command.alreadyOpen);
        return;

      case "answer":
        this.session?.answer(command.id, command.answers);
        return;
      case "answerCancelled":
        this.session?.answer(command.id, null);
        return;
      case "resumeSession":
        this.resumeSession(command.id, command.title);
        this.screen = "run";
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

      // ----------------------------------------------------------- workflows
      case "newWorkflow":
        void this.newWorkflow(command.template, command.scope);
        return;
      case "showWorkflow":
        void this.showWorkflow(command.id);
        return;
      case "startSession":
        void this.openWorkflow(command.id, true);
        return;
      case "moveWorkflow":
        void this.moveWorkflow(command.id, command.to);
        return;
      case "openWorkflow":
        void this.openWorkflow(command.id);
        return;
      case "editWorkflow":
        void this.editWorkflow(command.id);
        return;
      case "saveWorkflow":
        void this.saveWorkflow(command.workflow, command.launch === true, command.auto === true);
        return;
      case "checkWorkflow":
        this.broadcastTo(this.editorState(command.workflow, false));
        return;
      case "deleteWorkflow":
        void this.deleteWorkflow(command.id);
        return;
      case "duplicateWorkflow":
        void this.duplicateWorkflow(command.id);
        return;
      case "refinePrompt":
        void this.refine(command.workflow, command.agent);
        return;
      case "buildWorkflow":
        void this.buildWorkflow(command.description, command.scope ?? "local");
        return;
    }
  }

  // -------------------------------------------------------------- workflows

  private root(): string | undefined {
    return this.activeFolder()?.uri.fsPath;
  }

  private async newWorkflow(template?: string, scope: Scope = "local"): Promise<void> {
    const root = this.root();
    if (!root) {
      void vscode.window.showWarningMessage("Open a folder first — Cadre needs a working directory.");
      return;
    }

    const chosen = template ? templateById(template) : undefined;

    // Starting from a template asks nothing: the name is the template's, and
    // the builder — where the name field is the second thing on screen — is a
    // better place to change it than a modal that appears before you have seen
    // what you are naming.
    let name = chosen?.name ?? "";
    if (!chosen) {
      const entered = await vscode.window.showInputBox({
        title: "Name this workflow",
        value: "New workflow",
        prompt: "You can rename it later.",
        validateInput: (v) => (v.trim() ? undefined : "It needs a name."),
      });
      if (entered === undefined) return;
      name = entered.trim();
    }

    let created = workflows.createWorkflow(root, name, scope);
    if (chosen) {
      const built = chosen.build(Date.now());
      created = workflows.writeWorkflow(
        root,
        { ...created, ...built, id: created.id, name, scope },
        scope,
      );
    }
    this.log.info(`created ${scope} workflow ${created.id}${chosen ? ` from ${chosen.id}` : ""}`);
    await this.intoBuilder(created);
  }

  /**
   * A workflow's own page: what it is, and every conversation under it.
   *
   * Opening a workflow lands here rather than straight in a chat, because most
   * of the time you are coming back to something rather than starting fresh,
   * and the thing you want is the conversation you had yesterday.
   */
  private async showWorkflow(id: string): Promise<void> {
    const root = this.root();
    if (!root) return;
    const workflow = workflows.readWorkflow(root, id);
    if (!workflow) {
      void vscode.window.showWarningMessage("That workflow could not be read.");
      await this.publishScreen();
      return;
    }
    this.viewing = workflow;
    this.screen = "workflow";
    await this.publishScreen();
  }

  /**
   * The roster, from the workflow definition alone.
   *
   * The run view used to get its agents only from a live session's `init`
   * message, so opening a workflow showed an empty board with an empty "talking
   * to" dropdown until you spent a turn — and the Edit button did nothing,
   * because the view had no workflow id yet. The lanes, the map and the
   * controls are all properties of the graph; none of them should wait on a
   * subprocess. The runner's roster replaces this one as soon as it arrives,
   * carrying what only the CLI knows (the resolved model, live connectors).
   */
  private async publishRoster(workflow: Workflow): Promise<void> {
    const folder = this.activeFolder();
    const cfg = vscode.workspace.getConfiguration("cadre", folder?.uri);
    const fallbackModel = cfg.get<string>("model") || "default";
    const billing = await this.billing.status();

    this.broadcast({
      kind: "roster",
      workflowId: workflow.id,
      workflowName: workflow.name,
      edges: workflow.edges,
      autonomy: this.effectiveAutonomy(),
      billing: billing.ok ? billing.describe : billing.reason,
      workspace: folder?.name ?? "",
      // Not known until the CLI starts and reports them.
      connectors: [],
      members: workflow.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        model: agent.model || workflow.defaults?.model || fallbackModel,
        effort: agent.effort || workflow.defaults?.effort || "",
        preset: agent.preset,
        status: "idle" as const,
        entry: agent.id === (this.channel || workflow.entry),
        x: agent.x,
        y: agent.y,
      })),
    });
  }

  private async moveWorkflow(id: string, to: Scope): Promise<void> {
    const root = this.root();
    if (!root) return;
    const moved = workflows.moveWorkflow(root, id, to);
    if (!moved) return;
    this.log.info(`moved workflow ${id} to ${to}`);
    if (this.viewing?.id === id) this.viewing = moved;
    if (this.editing?.id === id) this.editing = moved;
    if (this.running?.id === id) this.running = moved;
    this.broadcast({
      kind: "notice",
      level: "info",
      text: to === "global"
        ? `"${moved.name}" is now available in every project.`
        : `"${moved.name}" now lives in this project only.`,
    });
    await this.publishScreen();
  }

  /** Opens a workflow for running. A broken one goes to the builder instead. */
  private async openWorkflow(id: string, fresh = false): Promise<void> {
    const root = this.root();
    if (!root) return;
    const workflow = workflows.readWorkflow(root, id);
    if (!workflow) {
      void vscode.window.showWarningMessage("That workflow could not be read.");
      await this.publishScreen();
      return;
    }

    if (!isRunnable(workflow)) {
      await this.intoBuilder(workflow);
      this.broadcast({
        kind: "notice",
        level: "warn",
        text: "This workflow is not finished yet — fix what is flagged and launch it from here.",
      });
      return;
    }

    // A different workflow means a different set of agents and prompts, so the
    // live session cannot carry over. `fresh` is an explicit "new conversation".
    if (fresh || this.running?.id !== workflow.id) {
      this.endSession();
      this.broadcast({ kind: "clear" });
    }
    this.running = workflow;
    this.channel = workflow.entry;
    this.screen = "run";
    await this.publishScreen();
    // Before anything runs, so the board is the workflow rather than a blank.
    await this.publishRoster(workflow);
    await this.refreshSendability();
  }

  /**
   * Hands the builder a workflow to edit, authoritatively — this is the one
   * path that is allowed to replace whatever draft it is holding.
   */
  private async intoBuilder(workflow: Workflow): Promise<void> {
    this.editing = workflow;
    this.screen = "builder";
    this.broadcastTo(this.editorState(workflow, true));
    await this.publishScreen();
    this.refreshModels();
  }

  private async editWorkflow(id: string): Promise<void> {
    const root = this.root();
    if (!root) return;
    const workflow = workflows.readWorkflow(root, id);
    if (!workflow) return;
    await this.intoBuilder(workflow);
  }

  private async saveWorkflow(workflow: Workflow, launch: boolean, auto = false): Promise<void> {
    const root = this.root();
    if (!root) return;

    // The whole workflow arrives from the webview, id included, and the store
    // refuses an id it could not have minted. Report it rather than letting the
    // rejection surface as an unhandled promise nobody sees.
    let saved: Workflow;
    try {
      saved = workflows.writeWorkflow(root, workflow, workflow.scope);
    } catch (err) {
      this.log.error(`refused to save workflow: ${describeError(err)}`);
      this.broadcastTo({ kind: "saved", workflowId: workflow.id, at: Date.now(), auto });
      this.broadcast({
        kind: "notice",
        level: "error",
        text: `That workflow could not be saved: ${describeError(err)}`,
      });
      return;
    }
    this.editing = saved;
    if (this.viewing?.id === saved.id) this.viewing = saved;
    this.log.info(`${auto ? "autosaved" : "saved"} workflow ${saved.id} (${saved.agents.length} agents, ${saved.edges.length} arrows)`);
    this.broadcastTo({ kind: "saved", workflowId: saved.id, at: saved.updatedAt, auto });

    // A running session was built from the old shape, so a deliberate save
    // resets it. An autosave deliberately does NOT: it fires while the user is
    // still editing, and killing their conversation every 45 seconds because
    // they nudged a box would be worse than the session being briefly stale.
    if (!auto && this.running?.id === saved.id) {
      this.endSession();
      this.running = saved;
      this.broadcast({
        kind: "notice",
        level: "info",
        text: "The workflow changed, so the session was reset. The agents now match what you just saved.",
      });
    }

    if (launch) {
      await this.openWorkflow(saved.id);
      return;
    }
    // An autosave must not move the user, redraw the canvas, or steal focus.
    if (!auto) await this.publishScreen();
  }

  private async deleteWorkflow(id: string): Promise<void> {
    const root = this.root();
    if (!root) return;
    const workflow = workflows.readWorkflow(root, id);
    const sessions = workflows.listSessions(root, id).length;
    const confirmed = await vscode.window.showWarningMessage(
      `Delete "${workflow?.name ?? id}"?`,
      {
        modal: true,
        detail: sessions
          ? `This removes the workflow and its record of ${sessions} conversation${sessions === 1 ? "" : "s"}. The conversations themselves stay in Claude Code's own history.`
          : "This removes the workflow definition from the project.",
      },
      "Delete",
    );
    if (confirmed !== "Delete") return;

    workflows.deleteWorkflow(root, id, workflow?.scope);
    if (this.running?.id === id) { this.endSession(); this.running = undefined; }
    if (this.editing?.id === id) this.editing = undefined;
    if (this.viewing?.id === id) this.viewing = undefined;
    this.screen = "home";
    await this.publishScreen();
  }

  private async duplicateWorkflow(id: string): Promise<void> {
    const root = this.root();
    if (!root) return;
    const copy = workflows.duplicateWorkflow(root, id);
    if (!copy) return;
    await this.intoBuilder(copy);
  }

  /**
   * Designs a whole workflow from a description and opens it in the builder.
   *
   * It is never launched and never runs: the result lands on the canvas, with
   * its problems flagged, for the user to read and change. The blank canvas is
   * the hardest part of this product, and this is the shortcut past it — not a
   * way to skip understanding what you are about to run.
   */
  private async buildWorkflow(description: string, scope: Scope): Promise<void> {
    const root = this.root();
    const executablePath = resolveClaudeExecutable(this.log);
    if (!root || !executablePath) {
      this.broadcastTo({ kind: "building", busy: false, note: "Open a folder first." });
      return;
    }

    const signal = this.startBuilderWork();
    this.broadcastTo({ kind: "building", busy: true, note: "Designing the workflow…" });
    try {
      const cfg = vscode.workspace.getConfiguration("cadre", this.activeFolder()?.uri);
      const result = await generateWorkflow({
        description,
        cwd: root,
        executablePath,
        model: cfg.get<string>("model") || "default",
        env: await this.billing.environment(),
        taken: workflows.listWorkflows(root).map((w) => w.id),
        signal,
      });

      if (!result.ok || !result.workflow) {
        this.broadcastTo({ kind: "building", busy: false, note: result.note });
        return;
      }

      const created = workflows.createWorkflow(root, result.workflow.name, scope);
      const saved = workflows.writeWorkflow(
        root,
        { ...created, ...result.workflow, id: created.id, scope },
        scope,
      );
      this.log.info(`built workflow ${saved.id}: ${saved.agents.length} agents, ${saved.edges.length} edges`);
      this.broadcastTo({ kind: "building", busy: false });
      await this.intoBuilder(saved);
      this.broadcast({ kind: "notice", level: "info", text: result.note });
    } catch (err) {
      this.broadcastTo({ kind: "building", busy: false, note: describeError(err) });
    }
  }

  /**
   * Rewrites one agent's prompt into something a practitioner would recognise.
   * Runs as its own tool-less query, so it cannot touch the project.
   */
  /**
   * Refining a prompt and designing a workflow are model runs started from the
   * builder, and both used to run unsupervised: no signal was passed, so
   * nothing could stop one. A wedged CLI left the button saying "Refining…"
   * until the window was reloaded, and leaving the builder abandoned the run
   * rather than ending it — still spending, with nowhere to deliver.
   *
   * One at a time, and the newest wins: asking again supersedes the request you
   * have already given up on.
   */
  private builderWork: AbortController | undefined;

  private startBuilderWork(): AbortSignal {
    this.builderWork?.abort();
    this.builderWork = new AbortController();
    return this.builderWork.signal;
  }

  /** Ends anything the builder started — leaving it, or shutting down. */
  stopBuilderWork(): void {
    this.builderWork?.abort();
    this.builderWork = undefined;
  }

  private async refine(workflow: Workflow, agent: Parameters<typeof refinePrompt>[0]["agent"]): Promise<void> {
    const root = this.root();
    const executablePath = resolveClaudeExecutable(this.log);
    if (!root || !executablePath) {
      this.broadcastTo({ kind: "refined", agent: agent.id, prompt: "", note: "No project or no claude executable." });
      return;
    }

    const signal = this.startBuilderWork();
    this.broadcastTo({ kind: "refining", agent: agent.id, busy: true });
    try {
      const cfg = vscode.workspace.getConfiguration("cadre", this.activeFolder()?.uri);
      const result = await refinePrompt({
        workflow,
        agent,
        cwd: root,
        executablePath,
        model: agent.model || cfg.get<string>("model") || "opus",
        env: await this.billing.environment(),
        signal,
      });
      this.broadcastTo({ kind: "refined", agent: agent.id, prompt: result.prompt, note: result.note });
    } catch (err) {
      this.broadcastTo({ kind: "refined", agent: agent.id, prompt: "", note: describeError(err) });
    } finally {
      this.broadcastTo({ kind: "refining", agent: agent.id, busy: false });
    }
  }

  /**
   * Records that this conversation belongs to the open workflow.
   *
   * The title starts as the first thing the user said, because a list of
   * "(untitled)" is useless the moment there are three of them. Claude's own
   * summary replaces it as soon as the CLI has written one.
   */
  private noteSession(sessionId: string): void {
    const root = this.root();
    if (!root || !this.running || this.liveSession === sessionId) return;
    this.liveSession = sessionId;
    workflows.recordSession(root, this.running.id, {
      sessionId,
      title: this.provisionalTitle || "New conversation",
      when: Date.now(),
    });
  }

  /**
   * Replaces the provisional title with the one Claude wrote.
   *
   * The CLI summarises a conversation itself and stores it, so there is a
   * model-written name available for free — spending a separate model call on
   * naming would be paying twice for the same sentence.
   */
  private async refreshSessionTitle(): Promise<void> {
    const root = this.root();
    if (!root || !this.running || !this.liveSession) return;
    try {
      const found = await listSessions({ dir: root, limit: 60 });
      const mine = found.find((s) => s.sessionId === this.liveSession);
      const title = mine?.customTitle || mine?.summary;
      if (!title) return;
      workflows.recordSession(root, this.running.id, {
        sessionId: this.liveSession,
        title,
        when: mine?.lastModified ?? Date.now(),
      });
    } catch (err) {
      this.log.warn(`could not refresh the session title: ${describeError(err)}`);
    }
  }

  /**
   * Keeps the replay log usable over a long session.
   *
   * Streamed prose arrives one delta at a time, so a single agent turn used to
   * push thousands of objects here and the same thousands into the webview —
   * which then re-rendered all of them on every layout flip. Consecutive deltas
   * of the same turn are merged instead, losslessly: what a surface joining
   * late replays is identical, at a fraction of the size.
   *
   * The cap is the backstop for everything else. Dropping the oldest is the
   * least bad option, and it is counted so a surface can say history was lost
   * rather than quietly showing a conversation that begins mid-sentence.
   */
  private remember(event: TeamEvent): void {
    if (event.kind === "say" || event.kind === "think") {
      const last = this.replay[this.replay.length - 1];
      if (
        last &&
        last.kind === event.kind &&
        last.who === event.who &&
        last.turn === event.turn
      ) {
        last.delta += event.delta;
        return;
      }
      // A copy: the original was already posted, and growing it afterwards
      // would mutate an object the surfaces were handed.
      this.replay.push({ ...event });
      return;
    }

    this.replay.push(event);
    if (this.replay.length > REPLAY_CAP) {
      const shed = this.replay.splice(0, Math.floor(REPLAY_CAP / 4));
      this.dropped += shed.length;
      this.log.info(`replay log trimmed: ${this.dropped} events dropped this session`);
    }
  }

  /** How much of the transcript the replay log no longer holds. */
  private dropped = 0;

  /** Posts to every surface without recording in the replay log. */
  private broadcastTo(event: TeamEvent): void {
    for (const surface of this.surfaces) void surface.postMessage(event);
  }

  private endSession(): void {
    this.session?.dispose();
    this.session = undefined;
    this.liveSession = undefined;
    this.provisionalTitle = "";
  }

  /**
   * Is there a conversation already running?
   *
   * It matters for anything that changes a credential: the environment a
   * session runs in is resolved once, when it starts, so a change made now
   * reaches the next conversation and not this one.
   */
  hasLiveSession(): boolean {
    return this.session !== undefined;
  }

  /** The workflow a conversation is open on, if any. */
  openWorkflowName(): string | undefined {
    return this.running?.name;
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
      // A different folder has different workflows, so land on its list.
      this.running = undefined;
      this.editing = undefined;
      this.screen = "home";
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
    if (!this.provisionalTitle && trimmed) {
      this.provisionalTitle = trimmed.length > 70 ? `${trimmed.slice(0, 69)}…` : trimmed;
    }
    // An image on its own is a complete message; do not require a caption.
    if (!trimmed && !images.length) return;

    const session = this.ensureSession();
    if (!session) {
      // Never swallow what the user typed — or attached. An image on its own is
      // a complete message, so handing back the words and dropping the picture
      // can hand back nothing at all.
      for (const surface of this.surfaces) {
        void surface.postMessage({ kind: "restoreInput", text: trimmed, images });
      }
      return;
    }
    session.send(trimmed, images);
  }

  /**
   * Points the conversation at a different agent.
   *
   * No gate on this any more: the entry agent is a default, not a wall, and the
   * runner explains what switching costs. Hiding it behind a setting only meant
   * people never found it.
   */
  private setChannel(to: AgentId): void {
    if (to === this.channel) return;
    const target = this.running?.agents.find((a) => a.id === to);
    if (!target) return;

    // Each agent has its own prompt and its own tools, so switching restarts
    // the main thread — which means abandoning whatever is running. Worth
    // asking about, and worth doing rather than greying the control out for the
    // whole of a run.
    if (this.busy) {
      void this.confirmSwitch(target.name, to);
      return;
    }
    this.applyChannel(to);
  }

  private async confirmSwitch(name: string, to: AgentId): Promise<void> {
    const SWITCH = `Stop and talk to ${name}`;
    const choice = await vscode.window.showWarningMessage(
      `Switch to ${name} while the workflow is running?`,
      {
        modal: true,
        detail:
          "The current run stops. Anything already written to disk stays; anything in flight is abandoned.\n\n" +
          `${name} has not seen this conversation, so tell them what they need to know.`,
      },
      SWITCH,
    );
    if (choice !== SWITCH) {
      // Snap the dropdown back: it moved the moment it was clicked.
      for (const surface of this.surfaces) {
        void surface.postMessage({ kind: "channel", to: this.channel });
      }
      return;
    }
    await this.session?.interrupt();
    this.applyChannel(to);
  }

  private applyChannel(to: AgentId): void {
    this.channel = to;
    this.session?.setChannel(to);
    for (const surface of this.surfaces) void surface.postMessage({ kind: "channel", to });
  }

  newSession(): void {
    this.endSession();
    this.channel = this.running?.entry ?? "";
    this.broadcast({ kind: "clear" });
    this.broadcast({ kind: "notice", level: "info", text: "New session." });
    void this.refreshSendability();
    this.log.info("session reset");
  }

  stop(): void {
    void this.session?.interrupt();
  }

  compactNow(): void {
    if (!this.session) {
      // The runner says so itself when there is a session but nothing running.
      // With no session at all there is nobody to say it, and a command that
      // does nothing visible is indistinguishable from one that is broken.
      this.broadcast({
        kind: "notice",
        level: "info",
        text: "Nothing to compact — no conversation has started yet.",
      });
      return;
    }
    this.session.compactNow();
  }

  /** Reopens a stored conversation, transcript and all. */
  resumeSession(sessionId: string, summary: string): void {
    this.endSession();
    this.channel = this.running?.entry ?? "";
    this.pendingResume = sessionId;
    this.replaying = true;
    this.broadcast({ kind: "clear" });
    void this.refreshSendability();
    void this.replayTranscript(sessionId, summary).finally(() => {
      this.replaying = false;
      void this.refreshSendability();
    });
  }

  /**
   * Renders a stored conversation back into the lanes.
   *
   * The CLI resumes the model's memory either way; this is so the user can see
   * what was said. Only the main thread is stored here — a teammate's run was
   * its own session — so history lands in the entry agent's lane, which is
   * where it was addressed. Which agent that is comes from the workflow: the
   * transcript does not record it, because the CLI has never heard of
   * workflows.
   */
  private async replayTranscript(sessionId: string, summary: string): Promise<void> {
    const dir = this.activeFolder()?.uri.fsPath;
    let messages: SessionMessage[] = [];
    try {
      messages = (await getSessionMessages(sessionId, { dir, limit: REPLAY_LIMIT })) as SessionMessage[];
    } catch (err) {
      this.log.warn(`could not replay transcript: ${describeError(err)}`);
    }
    // Which workflow this conversation belongs to. Without it replay addresses
    // a lane called "lead", which most workflows do not have — and placing into
    // a lane that does not exist fails silently, so the board comes back empty.
    const workflow = this.running;
    const roster = {
      entry: workflow?.entry ?? "",
      agents: (workflow?.agents ?? []).map((a) => a.id),
    };
    for (const event of transcriptToEvents(messages, summary, roster)) this.broadcast(event);
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
    // A refine or a design started from the builder outlives the session it
    // was started from, so it has to be ended here too or it keeps running
    // with nowhere to deliver.
    this.stopBuilderWork();
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
    // Replay writes the whole history into the lanes; a message accepted
    // mid-replay would be rendered above the conversation it replies to.
    if (this.replaying) return { ok: false, reason: "Loading the earlier conversation…" };
    // Folder first: with nothing open, "open a workflow" is advice the user
    // cannot act on, because workflows live inside a project.
    const folder = this.activeFolder();
    if (!folder) {
      return { ok: false, reason: "Open a folder to start — workflows live in the project." };
    }
    const workflow = this.running;
    if (!workflow) return { ok: false, reason: "Open a workflow to start." };
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

    // A repository can ship .vscode/settings.json. Anything in it that would
    // widen permissions or start a process is clamped until explicitly allowed.
    const vetted = this.trust.vet(cfg, cwd);
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
        workflow,
        cwd,
        executablePath,
        autonomy: vetted.autonomy,
        inheritGlobalConfig: vetted.inheritGlobalConfig,
        model: cfg.get<string>("model") || "default",
        maxDepth: vetted.maxDelegationDepth,
        maxContinues: vetted.maxContinuations,
        // Haiku takes no effort level, and the set differs by model, so the
        // runner asks rather than assuming every model accepts one.
        effortAllowed: (model: string) => supportsEffort(cachedModels(), model),
        skills: cfg.get<string[]>("playbooks")?.length ? cfg.get<string[]>("playbooks") : undefined,
        connectors: vetted.connectors,
        thinking: cfg.get<"adaptive" | "off">("thinking") ?? "adaptive",
        fallbackModel: cfg.get<string>("fallbackModel") ?? "",
        maxSpendUsd: vetted.maxSpendUsd,
        checkpoints: vetted.checkpoints,
        additionalDirectories: vetted.additionalDirectories,
        plugins: vetted.plugins,
        exclusiveConnectors: vetted.exclusiveConnectors,
        persistSessions: cfg.get<boolean>("persistSessions") ?? true,
        documentation: cfg.get<"off" | "substantial" | "always">("documentation") ?? "substantial",
        docsPath: vetted.docsPath,
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
    const vetted = this.trust.vet(this.configForActiveFolder(), this.activeFolder()?.uri.fsPath);
    const raw = this.configForActiveFolder().get<string>("autonomy") ?? "standard";
    return vetted.autonomy === raw ? raw : `${vetted.autonomy}  (${raw} not allowed from this folder)`;
  }

  forgetShownWarnings(): void {
    this.shownWarnings.clear();
  }



  private ensureSession(): WorkflowSession | undefined {
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

    const session = new WorkflowSession(
      readiness.config,
      this.billing,
      (e: TeamEvent) => this.broadcast(e),
      this.log,
    );
    // The environment (and therefore the API key) is resolved once, before any
    // nested agent run can race the secret store.
    void session.prepare().then(() => {
      if (this.channel && this.channel !== readiness.config.workflow.entry) {
        session.setChannel(this.channel);
      }
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

/**
 * How many events a surface joining late replays. Generous — with deltas
 * merged, a long working session sits well under it — but bounded, because
 * "runs all day" is the case this product is for.
 */
const REPLAY_CAP = 4000;

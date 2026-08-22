import * as path from "node:path";
import * as vscode from "vscode";
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { DISPLAY_NAME, ROLE_BLURB, TEAMMATES, type Assignment, type Attachment, type TeamEvent, type TeammateId, type TeammateStatus } from "./events";
import { ROSTER, composePrompt, consultVariant, toolAliases, type TeammateSpec } from "./roster";
import { createTeamServer } from "./tools";
import { contextPreamble, surveyProject } from "./project";
import { policyFor, settingSourcesFor, type Autonomy } from "../policy";
import type { Billing } from "../billing";

export interface TeamConfig {
  cwd: string;
  executablePath: string;
  autonomy: Autonomy;
  inheritGlobalConfig: boolean;
  directLine: boolean;
  /** Per-teammate overrides from settings; falls back to the roster default. */
  models: Partial<Record<TeammateId, string>>;
  efforts: Partial<Record<TeammateId, string>>;
  skills: string[] | "all" | undefined;
  connectors: Record<string, unknown>;
  thinking: "adaptive" | "off";
  fallbackModel: string;
  maxSpendUsd: number;
  checkpoints: boolean;
  additionalDirectories: string[];
  plugins: string[];
  exclusiveConnectors: boolean;
  persistSessions: boolean;
  /** off | substantial | always — when the team maintains documentation. */
  documentation: "off" | "substantial" | "always";
  /** Workspace-relative root for deliverable docs. */
  docsPath: string;
  /** Set when reopening a stored conversation. */
  resumeSessionId?: string;
}

/**
 * Push-driven prompt source. Handing this to query() puts it in streaming-input
 * mode: one long-lived CLI process across many turns, with interrupt() and live
 * permission changes available.
 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(
    content: SDKUserMessage["message"]["content"],
    uuid: `${string}-${string}-${string}-${string}-${string}`,
  ): void {
    if (this.closed) return;
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
      uuid,
    };
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.pending.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiting.splice(0)) w({ value: undefined, done: true });
  }

  /** Ends the current consumer without discarding buffered input. */
  detach(): void {
    for (const w of this.waiting.splice(0)) w({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const buffered = this.pending.shift();
      if (buffered) { yield buffered; continue; }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>((r) => this.waiting.push(r));
      if (next.done) return;
      yield next.value;
    }
  }
}

export class TeamSession implements vscode.Disposable {
  private input = new InputQueue();
  private stream: Query | undefined;
  private pump: Promise<void> | undefined;
  private disposed = false;
  private busy = false;
  private runId = 0;
  private readonly abort = new AbortController();
  private readonly pendingPermissions = new Set<(r: PermissionResult) => void>();
  /** Live teammate runs, so Stop can actually stop them. */
  private readonly nested = new Set<{ query: Query; abort: AbortController }>();
  private readonly status = new Map<TeammateId, TeammateStatus>();
  /** Which teammate the user is currently addressing. */
  private channel: TeammateId = "lead";
  private initSeen = false;
  /** User turns, newest last. Checkpointing rewinds to one of these. */
  private readonly turns: { id: string; text: string; at: number }[] = [];

  constructor(
    private readonly config: TeamConfig,
    private readonly billing: Billing,
    private readonly emit: (event: TeamEvent) => void,
    private readonly log: vscode.LogOutputChannel,
  ) {
    for (const who of TEAMMATES) this.status.set(who, "idle");
  }

  // --------------------------------------------------------------- lifecycle

  send(text: string, images: Attachment[] = []): void {
    if (this.disposed) return;
    this.runId += 1;
    const id = crypto.randomUUID();
    this.turns.push({ id, text, at: Date.now() });
    this.emit({
      kind: "userSaid",
      to: this.channel,
      text,
      images: images.map((i) => ({ name: i.name, dataUrl: `data:${i.mediaType};base64,${i.data}` })),
    });
    this.setBusy(true);
    this.setStatus(this.channel, "thinking");

    // The environment must be resolved before options are built, or the CLI is
    // spawned without the credential billing just worked out.
    void this.prepare().then(() => {
      if (this.disposed) return;
      if (!this.stream) this.start();
      // Images go before the text: the model reads them as context for the
      // sentence that follows, which is how people write when they paste one.
      const content = images.length
        ? [
            ...images.map((i) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: i.mediaType, data: i.data },
            })),
            ...(text ? [{ type: "text" as const, text }] : []),
          ]
        : text;
      this.input.push(content, id);
    });
  }

  /** Switching who the user talks to needs a fresh main thread. */
  setChannel(to: TeammateId): void {
    if (to === this.channel) return;
    if (to !== "lead" && !this.config.directLine) return;
    this.channel = to;
    this.teardown();
    this.emit({ kind: "channel", to });
    this.emit({
      kind: "notice",
      level: "info",
      text:
        to === "lead"
          ? "Back on the Lead. They have not seen anything said on a direct line."
          : `Direct line to the ${DISPLAY_NAME[to]}. The Lead is not in the loop — their picture will be stale.`,
    });
  }

  async interrupt(): Promise<void> {
    if (!this.stream && !this.nested.size) return;
    // Teammates first: the Lead is blocked on their tool call, so leaving them
    // running would keep editing files under a UI that says idle.
    await this.stopNested();
    try {
      await this.stream?.interrupt();
      this.emit({ kind: "notice", level: "info", text: "Interrupted." });
    } catch (err) {
      this.log.warn(`interrupt failed: ${describe(err)}`);
    } finally {
      this.setBusy(false);
      for (const who of TEAMMATES) this.setStatus(who, "idle");
    }
  }

  dispose(): void {
    if (this.disposed) return;
    // Before `disposed` latches, so the webview still hears it and the busy
    // context key resets — otherwise New Session mid-run wedges the composer.
    this.setBusy(false);
    this.disposed = true;
    this.settlePermissions("The session ended before this was approved.");
    void this.stopNested();
    this.abort.abort();
    this.input.close();
    try { this.stream?.close(); } catch (err) { this.log.warn(`close failed: ${describe(err)}`); }
    this.stream = undefined;
    this.pump = undefined;
  }

  /** Drops the live query but keeps the session usable. */
  private teardown(): void {
    void this.stopNested();
    this.settlePermissions("The conversation moved to another teammate.");
    try { this.stream?.close(); } catch { /* already gone */ }
    this.stream = undefined;
    this.pump = undefined;
    this.input.detach();
    this.input = new InputQueue();
    this.setBusy(false);
  }

  private settlePermissions(reason: string): void {
    for (const settle of this.pendingPermissions) settle({ behavior: "deny", message: reason });
    this.pendingPermissions.clear();
  }

  /** Points the user could rewind the workspace back to. */
  history(): { id: string; text: string; at: number }[] {
    return [...this.turns];
  }

  /**
   * Restores every file the team touched to its state at the given user turn.
   * Requires checkpointing, which is on by default.
   */
  async rewind(turnId: string, dryRun = false): Promise<{ ok: boolean; detail: string }> {
    if (!this.stream) return { ok: false, detail: "No live session to rewind." };
    try {
      const result = await this.stream.rewindFiles(turnId, { dryRun });
      if (!result.canRewind) {
        return { ok: false, detail: result.error ?? "Nothing to rewind to." };
      }
      const changed = (result as { filesChanged?: number }).filesChanged;
      return {
        ok: true,
        detail: dryRun
          ? `Would restore ${changed ?? "the"} file(s).`
          : `Restored ${changed ?? "the"} file(s) to that point.`,
      };
    } catch (err) {
      return { ok: false, detail: describe(err) };
    }
  }

  // ------------------------------------------------------------- main thread

  private start(): void {
    const spec = this.specFor(this.channel);
    this.log.info(`main thread: ${spec.id} in ${this.config.cwd}`);
    const options = this.optionsFor(spec);
    if (this.config.resumeSessionId) {
      options.resume = this.config.resumeSessionId;
      // One-shot: a later restart in this session must not resume again.
      this.config.resumeSessionId = undefined;
    }
    this.stream = query({ prompt: this.input, options });

    this.pump = this.consume(this.stream, spec.id, true)
      .then(() => undefined)
      .catch((err) => {
        if (this.disposed) return;
        this.log.error(`stream failed: ${describe(err)}`);
        this.emit({ kind: "notice", level: "error", text: describe(err) });
      })
      .finally(() => this.endStream());
    void this.pump;
  }

  /**
   * The dead-stream guard. Without it the finished Query stays assigned, the
   * next send() skips start(), and the message is pushed into a queue nobody
   * reads — vanishing with no output and no error.
   */
  private endStream(): void {
    if (this.disposed) return;
    const wasBusy = this.busy;
    this.stream = undefined;
    this.pump = undefined;
    this.input.detach();
    this.setBusy(false);
    for (const who of TEAMMATES) this.setStatus(who, "idle");
    if (wasBusy) {
      this.emit({ kind: "notice", level: "warn", text: "The session ended. Your next message will start a new one." });
    }
  }

  // ---------------------------------------------------------- nested runs

  /**
   * Runs one teammate to completion in its own query, streaming everything into
   * that teammate's lane. Because we spawn it ourselves, attribution is known
   * rather than inferred.
   */
  private async runTeammate(args: {
    who: TeammateId;
    kind: "brief" | "consult";
    id: string;
    prompt: string;
    from: TeammateId;
    headline: string;
  }): Promise<string> {
    if (this.disposed) return "The session ended before this could run.";

    const base = this.specFor(args.who);
    const spec = args.kind === "consult" ? consultVariant(base) : base;

    const assignment: Assignment = {
      id: args.id,
      from: args.from,
      to: args.who,
      brief: args.headline,
      startedAt: Date.now(),
    };
    if (args.kind === "brief") this.emit({ kind: "assign", assignment });
    this.setStatus(args.who, "thinking", args.kind === "consult" ? "answering a consult" : args.headline);

    // Its own controller, chained to the session's, so a single teammate can be
    // cancelled without tearing down the whole session.
    const abort = new AbortController();
    const onSessionAbort = () => abort.abort();
    this.abort.signal.addEventListener("abort", onSessionAbort, { once: true });

    let handle: { query: Query; abort: AbortController } | undefined;
    try {
      const nestedQuery = query({ prompt: args.prompt, options: this.optionsFor(spec, abort) });
      handle = { query: nestedQuery, abort };
      this.nested.add(handle);
      const report = await this.consume(nestedQuery, args.who, false);
      const outcome = /^\s*VERDICT\s*:?\s*(BLOCKED|REJECTED)/im.test(report) ? "blocked" : "delivered";
      if (args.kind === "brief") {
        this.emit({ kind: "deliver", id: args.id, outcome, summary: headlineOf(report) });
      }
      this.setStatus(args.who, "idle");
      return report || "(the teammate returned nothing)";
    } catch (err) {
      this.log.error(`${args.who} run failed: ${describe(err)}`);
      if (args.kind === "brief") {
        this.emit({ kind: "deliver", id: args.id, outcome: "failed", summary: describe(err) });
      }
      this.setStatus(args.who, "idle");
      return `VERDICT: BLOCKED\nThe run failed before producing a report: ${describe(err)}`;
    } finally {
      if (handle) this.nested.delete(handle);
      this.abort.signal.removeEventListener("abort", onSessionAbort);
    }
  }

  /** Summarises the conversation now rather than waiting for the window to fill. */
  compactNow(): void {
    if (!this.stream) {
      this.emit({ kind: "notice", level: "info", text: "Nothing to compact — no session running." });
      return;
    }
    this.runId += 1;
    this.setBusy(true);
    this.input.push("/compact", crypto.randomUUID());
  }

  /** Ends every teammate currently running. */
  private async stopNested(): Promise<void> {
    const running = [...this.nested];
    this.nested.clear();
    for (const { query: q, abort } of running) {
      abort.abort();
      try { q.close(); } catch { /* already gone */ }
    }
    if (running.length) this.log.info(`stopped ${running.length} teammate run(s)`);
  }

  // ----------------------------------------------------------- translation

  /** Consumes one query, emitting lane-attributed events. Returns the final text. */
  private async consume(stream: Query, who: TeammateId, isMain: boolean): Promise<string> {
    let turn = "";
    let finalText = "";
    /** Set when the run ended for any reason other than success. */
    let failure = "";

    for await (const message of stream) {
      if (this.disposed) break;

      switch (message.type) {
        case "system": {
          if (message.subtype === "compact_boundary") {
            // Only the main thread's compaction concerns the user; a teammate
            // compacting is internal to a run that ends anyway.
            if (isMain) {
              const meta = message.compact_metadata;
              this.emit({
                kind: "compacted",
                trigger: meta.trigger,
                before: meta.pre_tokens,
                after: meta.post_tokens,
              });
            }
            break;
          }
          if (message.subtype !== "init") break;
          if (isMain && !this.initSeen) {
            this.initSeen = true;
            // Our own in-process server is plumbing, not a user connector.
            const connectors = (message.mcp_servers ?? [])
              .filter((s) => s.name !== "team")
              .map((s) => ({ name: s.name, ok: s.status === "connected", status: s.status }));
            const failed = connectors.filter((c) => !c.ok);
            if (failed.length) {
              this.emit({
                kind: "notice",
                level: "warn",
                text: `Connector${failed.length > 1 ? "s" : ""} unavailable: ${failed.map((c) => `${c.name} (${c.status})`).join(", ")}. The team will work without ${failed.length > 1 ? "them" : "it"}.`,
              });
            }
            void this.publishRoster(message.model, message.tools.length, connectors);
          }
          break;
        }

        case "stream_event": {
          // Nested teammates run in their own query, so anything with a parent
          // belongs to a tool inside that run, not to another teammate.
          if (message.parent_tool_use_id !== null) break;
          const event = message.event as BetaRawMessageStreamEvent;
          if (event.type === "message_start") {
            turn = event.message.id || cryptoId();
          } else if (event.type === "content_block_delta" && turn) {
            const delta = event.delta;
            if (delta.type === "text_delta" && delta.text) {
              this.setStatus(who, "thinking");
              this.emit({ kind: "say", who, turn, delta: delta.text });
            } else if (delta.type === "thinking_delta" && delta.thinking) {
              this.emit({ kind: "think", who, turn, delta: delta.thinking });
            }
          } else if (event.type === "message_stop" && turn) {
            this.emit({ kind: "sayEnd", who, turn });
            turn = "";
          }
          break;
        }

        case "assistant": {
          if (message.parent_tool_use_id !== null) break;
          if (isMain && message.context_usage) {
            const u = message.context_usage;
            this.emit({
              kind: "context",
              percent: u.percentage,
              tokens: u.total_tokens,
              max: u.raw_max_tokens,
            });
          }
          for (const block of message.message.content) {
            if (block.type !== "tool_use") continue;
            const input = (block.input ?? {}) as Record<string, unknown>;
            // A brief tool call renders as an assignment card, not a tool chip.
            if (isTeamDelegation(block.name)) continue;
            this.setStatus(who, "working", describeTool(block.name, input));
            this.emit({
              kind: "act",
              who,
              act: block.id,
              tool: shortToolName(block.name),
              summary: describeTool(block.name, input),
            });
          }
          if (message.error) {
            const auth = AUTH_ERRORS[message.error];
            if (auth) {
              // Not a "model error" — the credential is the problem, and the UI
              // has a whole screen for saying so properly.
              this.emit({ kind: "authProblem", detail: auth });
            } else {
              this.emit({ kind: "notice", level: "error", who, text: `Model error: ${message.error}` });
            }
          }
          break;
        }

        case "user": {
          const content = message.message.content;
          if (typeof content === "string") break;
          for (const block of content) {
            if (block.type !== "tool_result") continue;
            this.emit({
              kind: "actEnd",
              who,
              act: block.tool_use_id,
              ok: block.is_error !== true,
              summary: summarizeResult(block.content),
            });
          }
          break;
        }

        case "result": {
          if (turn) { this.emit({ kind: "sayEnd", who, turn }); turn = ""; }
          if (message.subtype === "success") finalText = message.result ?? "";
          else failure = message.subtype;

          // Spend accrues across every run in the session, main and nested.
          this.spentUsd += message.total_cost_usd ?? 0;

          if (!isMain && message.subtype !== "success") {
            this.emit({
              kind: "notice",
              level: "error",
              who,
              text: `${DISPLAY_NAME[who]} stopped: ${describeStop(message.subtype)}`,
            });
          }
          if (isMain) {
            const resultRun = this.runId;
            this.emit({
              kind: "spend",
              usd: message.total_cost_usd ?? 0,
              turns: message.num_turns ?? 0,
              durationMs: message.duration_ms ?? 0,
            });
            if (message.subtype !== "success") {
              this.emit({ kind: "notice", level: "error", text: `Run ended: ${message.subtype}` });
            }
            if (resultRun === this.runId) this.setBusy(false);
            this.setStatus(who, "idle");
          }
          break;
        }

        default:
          break;
      }
    }

    // A truncated run must not read like a completed one.
    if (failure && !finalText) {
      return `VERDICT: BLOCKED\nHEADLINE: The run stopped before producing a report — ${describeStop(failure)}.\nNOT COVERED: everything in the brief. Nothing here was verified.\nNEXT: decide whether a narrower brief is worth another run.`;
    }
    return finalText;
  }

  // -------------------------------------------------------------- options

  private specFor(who: TeammateId): TeammateSpec {
    const base = ROSTER[who];
    return {
      ...base,
      model: this.config.models[who] || base.model,
      effort: (this.config.efforts[who] as TeammateSpec["effort"]) || base.effort,
      prompt:
        composePrompt(base.prompt, {
          documentation: this.config.documentation ?? "substantial",
          docsPath: this.config.docsPath || "docs",
        }) + this.projectPreamble(),
    };
  }

  private optionsFor(spec: TeammateSpec, abort?: AbortController): Options {
    const policy = policyFor(this.config.autonomy);
    const server = createTeamServer({
      cwd: this.config.cwd,
      signal: this.abort.signal,
      runTeammate: (args) => this.runTeammate(args),
    });

    return {
      cwd: this.config.cwd,
      pathToClaudeCodeExecutable: this.config.executablePath,
      model: spec.model,
      effort: spec.effort,
      maxTurns: spec.maxTurns,
      permissionMode: policy.permissionMode,
      allowDangerouslySkipPermissions: policy.allowDangerouslySkipPermissions,
      // Authoritative over the user's own settings: restrictive-only, so it can
      // force a prompt through an inherited blanket allow but never widen one.
      managedSettings: policy.managedSettings,
      settingSources: settingSourcesFor(this.config.inheritGlobalConfig),
      // A raw string REPLACES Claude Code's preset rather than appending to it.
      // That is deliberate: the preset is written for a single agent answering a
      // user in a terminal and pushes terse, few-line replies, which fights the
      // structured report every teammate owes back. The craft guidance worth
      // keeping from it (match the surrounding idiom, smallest diff, read before
      // you write) is stated directly in these prompts instead.
      systemPrompt: spec.prompt,
      // `tools` restricts what EXISTS; `allowedTools` only means "runs without a
      // prompt". Conflating them silently auto-approves instead of restricting.
      tools: spec.tools.filter((t) => !t.startsWith("mcp__")),
      // The team's own tools are safe by construction — git_view is read-only and
      // the brief tools gate their teammate's work separately — so they skip the
      // prompt. Everything else is decided by the autonomy policy.
      //
      // The SDK warns (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED) that bare allowedTools
      // entries bypass canUseTool. That is the intent here, and only here: a
      // brief is inert until the teammate it spawns hits its own gate.
      allowedTools: spec.tools.filter((t) => t.startsWith("mcp__")),
      disallowedTools: spec.disallowedTools,
      toolAliases: toolAliases(),
      mcpServers: { team: server, ...(this.config.connectors as Record<string, never>) },
      strictMcpConfig: this.config.exclusiveConnectors,
      skills: this.config.skills,
      plugins: (this.config.plugins ?? []).map((path) => ({ type: "local" as const, path })),
      additionalDirectories: this.config.additionalDirectories ?? [],
      thinking: this.config.thinking === "off" ? { type: "disabled" } : { type: "adaptive" },
      ...(this.config.fallbackModel ? { fallbackModel: this.config.fallbackModel } : {}),
      // The SDK's budget is per-query, so each teammate would otherwise get a
      // fresh ceiling. Hand every run only what is left of the session's.
      ...(this.remainingBudget() !== undefined ? { maxBudgetUsd: this.remainingBudget() } : {}),
      // Snapshots so rewindFiles() can put the workspace back.
      enableFileCheckpointing: this.config.checkpoints !== false,
      persistSession: this.config.persistSessions !== false,
      // When the window fills, summarise and keep going rather than failing the
      // turn. The boundary is surfaced so the user knows detail was dropped.
      settings: { autoCompactEnabled: true },
      // Disposal and interrupt must actually reach the subprocess.
      abortController: abort ?? this.abort,
      includePartialMessages: true,
      env: this.envSnapshot,
      canUseTool: (name, input, context) => this.requestPermission(spec.id, name, input, context),
      stderr: (data) => this.log.debug(`[${spec.id}] ${data.trimEnd()}`),
    };
  }

  /**
   * Seeded from the host environment so that a missed `prepare()` degrades to
   * "inherits our env" rather than "no env at all" — `env` REPLACES the
   * subprocess environment, so `{}` means no PATH, no HOME, no credential.
   */
  private envSnapshot: Record<string, string | undefined> = { ...process.env };
  private preparing: Promise<void> | undefined;
  /** Cumulative across the main thread and every teammate. */
  private spentUsd = 0;
  private preamble: string | undefined;

  /**
   * Computed once per session. Every teammate gets it, including nested runs —
   * a subagent starts with an empty context, so orientation it would otherwise
   * spend tool calls rediscovering is the cheapest thing we can hand it.
   */
  /** What is left of the user's ceiling, or undefined when uncapped. */
  private remainingBudget(): number | undefined {
    const cap = this.config.maxSpendUsd ?? 0;
    if (cap <= 0) return undefined;
    return Math.max(0.01, cap - this.spentUsd);
  }

  private projectPreamble(): string {
    if (this.preamble === undefined) {
      this.preamble = contextPreamble(
        surveyProject(this.config.cwd, this.config.docsPath || "docs"),
      );
    }
    return this.preamble;
  }

  /** Resolved once per session so a nested run can't race the secret store. */
  prepare(): Promise<void> {
    this.preparing ??= this.billing
      .environment()
      .then((env) => { this.envSnapshot = env; })
      .catch((err) => { this.log.error(`billing environment failed: ${describe(err)}`); });
    return this.preparing;
  }

  private async publishRoster(
    model: string,
    toolCount: number,
    connectors: { name: string; ok: boolean; status: string }[],
  ): Promise<void> {
    const status = await this.billing.status();
    this.emit({
      kind: "roster",
      autonomy: policyFor(this.config.autonomy).describe,
      billing: status.ok ? status.describe : status.reason,
      workspace: shortPath(this.config.cwd),
      connectors,
      members: TEAMMATES.map((id) => {
        const spec = this.specFor(id);
        return {
          id,
          name: DISPLAY_NAME[id],
          role: ROLE_BLURB[id],
          model: id === "lead" ? model : spec.model,
          effort: String(spec.effort),
          status: this.status.get(id) ?? "idle",
        };
      }),
    });
    this.log.info(`roster published (${toolCount} tools available to the Lead)`);
  }

  // ---------------------------------------------------------- permissions

  private async requestPermission(
    who: TeammateId,
    name: string,
    input: Record<string, unknown>,
    context: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const deny = (message: string): PermissionResult => ({ behavior: "deny", message });
    if (this.disposed) return deny("The session has ended.");

    // AskUserQuestion is not a permission decision — it is the question itself.
    // The CLI has no renderer here, so the host collects the answers and hands
    // them back on the tool input.
    if (shortToolName(name) === "AskUserQuestion") return this.askUser(who, input);

    // The Lead's scratchpad confinement. Its prompt says it has no editor outside
    // .cadre/, but a prompt is not an enforcement mechanism — without this the
    // Lead can quietly do the Engineer's job and the team becomes theatre.
    const confined = this.checkScratchpadOnly(who, name, input);
    if (confined) return deny(confined);

    this.setStatus(who, "waiting", `waiting on you: ${shortToolName(name)}`);
    const prompt = `${DISPLAY_NAME[who]} wants to run ${shortToolName(name)}`;
    const detail = context.description || describeTool(name, input);

    // Prefer the SDK's own scoped suggestions. When it offers none, derive one
    // ourselves rather than falling back to a single "Allow once" — otherwise
    // the only way to stop being asked is to keep answering.
    const scoped = context.suggestions?.length
      ? { label: "Always allow this", updates: context.suggestions }
      : deriveScope(name, input, this.config.cwd);

    const ONCE = "Allow once";
    const ALWAYS = scoped?.label;
    const NEVER_ASK = `Don't ask again for ${shortToolName(name)}`;
    const choices = [ONCE, ...(ALWAYS ? [ALWAYS] : []), NEVER_ASK];

    let settle: ((r: PermissionResult) => void) | undefined;
    const abandoned = new Promise<PermissionResult>((resolve) => {
      settle = resolve;
      this.pendingPermissions.add(resolve);
      if (context.signal.aborted) { resolve(deny("The run was cancelled.")); return; }
      context.signal.addEventListener("abort", () => resolve(deny("The run was cancelled.")), { once: true });
    });

    try {
      const answered = Promise.resolve(
        vscode.window.showWarningMessage(prompt, { modal: true, detail }, ...choices),
      ).then((choice): PermissionResult => {
        if (choice === ONCE) return { behavior: "allow", updatedInput: input };
        if (ALWAYS && choice === ALWAYS) {
          return { behavior: "allow", updatedInput: input, updatedPermissions: scoped.updates };
        }
        if (choice === NEVER_ASK) {
          // Explicit and clearly labelled: the whole tool, for this session only.
          return {
            behavior: "allow",
            updatedInput: input,
            updatedPermissions: [{
              type: "addRules",
              rules: [{ toolName: shortToolName(name) }],
              behavior: "allow",
              destination: "session",
            }],
          };
        }
        return deny(`The user declined ${shortToolName(name)}.`);
      });
      return await Promise.race([answered, abandoned]);
    } finally {
      if (settle) this.pendingPermissions.delete(settle);
      if (!this.disposed) this.setStatus(who, "working");
    }
  }

  /**
   * Renders the teammate's question and returns the answers on the tool input.
   *
   * The output schema carries `answers` as a question-text → answer map, so
   * that is the shape the CLI expects back. Without this the tool completes
   * with nothing and the teammate proceeds as if it had never asked.
   */
  private async askUser(
    who: TeammateId,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    const questions = Array.isArray(input.questions) ? (input.questions as RawQuestion[]) : [];
    if (!questions.length) return { behavior: "allow", updatedInput: input };

    this.setStatus(who, "waiting", "waiting on your answer");
    const answers: Record<string, string> = {};
    const OTHER = "$(edit) Something else…";

    try {
      for (const q of questions) {
        const options = Array.isArray(q?.options) ? q.options : [];
        const items: vscode.QuickPickItem[] = options.map((o) => ({
          label: String(o?.label ?? ""),
          detail: o?.description ? String(o.description) : undefined,
        }));
        items.push({ label: OTHER, detail: "Type your own answer" });

        const multi = q?.multiSelect === true;
        const picked = await vscode.window.showQuickPick(items, {
          title: `${DISPLAY_NAME[who]} asks — ${String(q?.header ?? "")}`,
          placeHolder: String(q?.question ?? ""),
          canPickMany: multi,
          ignoreFocusOut: true,
        });

        // Dismissing is a real answer: it means "stop and reconsider".
        if (!picked || (Array.isArray(picked) && !picked.length)) {
          return { behavior: "deny", message: "The user dismissed the question without answering." };
        }

        const chosen = Array.isArray(picked) ? picked : [picked];
        const labels: string[] = [];
        for (const item of chosen) {
          if (item.label !== OTHER) { labels.push(item.label); continue; }
          const typed = await vscode.window.showInputBox({
            title: String(q?.question ?? "Your answer"),
            prompt: "In your own words.",
            ignoreFocusOut: true,
          });
          if (typed === undefined) {
            return { behavior: "deny", message: "The user dismissed the question without answering." };
          }
          labels.push(typed);
        }
        answers[String(q?.question ?? "")] = labels.join(", ");
      }
    } finally {
      if (!this.disposed) this.setStatus(who, "thinking");
    }

    for (const [question, answer] of Object.entries(answers)) {
      this.emit({ kind: "userSaid", to: who, text: `${question}\n→ ${answer}` });
    }
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  /**
   * Returns a denial reason when a teammate whose remit excludes production code
   * tries to write outside the two places it owns.
   *
   * `.cadre/` is gitignored scratch. The docs root is a deliverable — it gets
   * committed and read by someone who was not here — so the Lead and Researcher
   * write there directly rather than round-tripping documentation through the
   * Engineer. Everything else still goes through a brief.
   */
  private checkScratchpadOnly(
    who: TeammateId,
    name: string,
    input: Record<string, unknown>,
  ): string | undefined {
    const editing = ["Write", "Edit", "NotebookEdit"].includes(shortToolName(name));
    if (!editing) return undefined;
    if (who === "engineer") return undefined;

    const target = typeof input.file_path === "string" ? input.file_path : "";
    if (!target) return undefined;

    const resolved = path.resolve(this.config.cwd, target);
    const roots = [SCRATCHPAD];
    if (this.config.documentation !== "off" && this.config.docsPath) {
      roots.push(this.config.docsPath);
    }
    const allowed = roots.some((root) => {
      const base = path.resolve(this.config.cwd, root);
      return resolved === base || resolved.startsWith(base + path.sep);
    });
    if (allowed) return undefined;

    const writable = roots.map((r) => `${r}/`).join(" and ");
    return who === "lead"
      ? `You have no editor outside ${writable}. Brief the Engineer to change ${target}.`
      : `You write findings and reports, not production code. Only ${writable} is writable.`;
  }

  // -------------------------------------------------------------- plumbing

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.emit({ kind: "busy", busy });
    void vscode.commands.executeCommand("setContext", "cadre.busy", busy);
  }

  private setStatus(who: TeammateId, status: TeammateStatus, activity?: string): void {
    if (this.status.get(who) === status && !activity) return;
    this.status.set(who, status);
    this.emit({ kind: "status", who, status, activity });
  }
}

// ------------------------------------------------------------------ helpers

/** Assistant errors that mean "fix your credentials", not "the model failed". */
const AUTH_ERRORS: Record<string, string> = {
  authentication_failed: "Not signed in to Claude, or the saved credential is no longer valid.",
  oauth_org_not_allowed: "Your organisation does not permit this login for Claude Code.",
  account_on_hold: "This Claude account is on hold.",
  billing_error: "Billing could not be authorised for this account.",
};

/** The shape AskUserQuestion sends; validated defensively since it is model output. */
interface RawQuestion {
  question?: unknown;
  header?: unknown;
  multiSelect?: unknown;
  options?: { label?: unknown; description?: unknown }[];
}

const TEAM_PREFIX = "mcp__team__";

/** The only place the Lead and Researcher may write. */
export const SCRATCHPAD = ".cadre";

function isTeamDelegation(name: string): boolean {
  return name === `${TEAM_PREFIX}brief_researcher` || name === `${TEAM_PREFIX}brief_engineer`;
}

/**
 * Builds a narrowly-scoped allow rule for a tool call, so "always allow" can
 * mean "this program" or "this directory" instead of "anything at all".
 */
function deriveScope(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): { label: string; updates: PermissionUpdate[] } | undefined {
  const tool = shortToolName(name);
  const rule = (toolName: string, ruleContent: string, label: string) => ({
    label,
    updates: [{
      type: "addRules" as const,
      rules: [{ toolName, ruleContent }],
      behavior: "allow" as const,
      destination: "session" as const,
    }],
  });

  if (tool === "Bash") {
    const program = programOf(typeof input.command === "string" ? input.command : "");
    return program ? rule("Bash", `${program}:*`, `Always allow ${program}`) : undefined;
  }

  if (tool === "WebFetch") {
    const url = typeof input.url === "string" ? input.url : "";
    try {
      const host = new URL(url).hostname;
      return rule("WebFetch", `domain:${host}`, `Always allow ${host}`);
    } catch {
      return undefined;
    }
  }

  if (["Read", "Write", "Edit", "NotebookEdit"].includes(tool)) {
    const target = typeof input.file_path === "string" ? input.file_path : "";
    if (!target) return undefined;
    const relative = path.relative(cwd, path.resolve(cwd, target));
    if (relative.startsWith("..")) return undefined;
    const dir = path.dirname(relative);
    const scope = dir === "." ? "*" : `${dir}/**`;
    return rule(tool, scope, `Always allow ${tool} in ${dir === "." ? "the workspace root" : dir}/`);
  }

  return undefined;
}

/** The program a shell command actually runs, for scoping an allow rule. */
function programOf(command: string): string | undefined {
  let rest = command.trim();
  // Step past a leading `cd somewhere &&`, which is a preamble, not the command.
  const chained = /^cd\s+\S+\s*&&\s*(.+)$/s.exec(rest);
  if (chained) rest = chained[1].trim();

  const tokens = rest.split(/\s+/);
  // Skip VAR=value prefixes.
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  const first = tokens[index];
  if (!first) return undefined;

  const program = path.basename(first);
  // A bare interpreter tells us nothing useful; two words is a better scope.
  if (["sudo", "env", "npx", "uvx", "git", "npm", "pnpm", "yarn", "pip", "pip3", "cargo", "docker"].includes(program)) {
    const second = tokens[index + 1];
    if (second && !second.startsWith("-")) return `${program} ${second}`;
  }
  return /^[\w.@+-]+$/.test(program) ? program : undefined;
}

function shortToolName(name: string): string {
  return name.startsWith(TEAM_PREFIX) ? name.slice(TEAM_PREFIX.length) : name;
}

export function describeTool(name: string, input: Record<string, unknown>): string {
  const str = (key: string): string | undefined =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;

  switch (shortToolName(name)) {
    case "Bash": return str("command") ?? "";
    case "Read": case "Write": case "Edit": case "NotebookEdit": return str("file_path") ?? "";
    case "Glob": case "Grep": return [str("pattern"), str("path")].filter(Boolean).join("  in  ");
    case "WebSearch": return str("query") ?? "";
    case "WebFetch": return str("url") ?? "";
    case "git_view": return [str("subcommand"), ...(Array.isArray(input.paths) ? input.paths : [])].join(" ");
    case "ask_researcher": case "ask_engineer": return str("question") ?? "";
    default: {
      const json = JSON.stringify(input);
      return json.length > 240 ? `${json.slice(0, 240)}…` : json;
    }
  }
}

function summarizeResult(content: unknown): string {
  const text = extractText(content).replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
    .join("");
}

/** Pulls HEADLINE out of a report block for the assignment card. */
function headlineOf(report: string): string {
  const match = /^\s*HEADLINE\s*:?\s*(.+)$/im.exec(report);
  const line = match?.[1]?.trim() || report.split("\n").find((l) => l.trim())?.trim() || "";
  return line.length > 220 ? `${line.slice(0, 220)}…` : line;
}

function shortPath(p: string): string {
  const home = process.env.HOME;
  const shown = home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  const parts = shown.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : shown;
}

function cryptoId(): string {
  return crypto.randomUUID();
}

/** Turns an SDK result subtype into something a person can act on. */
function describeStop(subtype: string): string {
  switch (subtype) {
    case "error_max_turns": return "it hit its turn limit";
    case "error_max_budget_usd": return "the spend cap was reached";
    case "error_during_execution": return "it failed during execution";
    default: return subtype.replace(/^error_/, "").replace(/_/g, " ");
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import * as os from "node:os";
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
  type SDKRateLimitInfo,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { AgentId, AgentStatus, Assignment, AskQuestion, Attachment, TeamEvent } from "../team/events";
import { agentById, thenOrder, type Workflow } from "./model";
import { PRESETS, resolveAgent, type ResolvedAgent } from "./presets";
import { composeSystemPrompt } from "./protocol";
import * as templates from "./templates";
import { createWorkflowServer, toolAliases } from "./tools";
import { contextPreamble, surveyProject } from "../team/project";
import { policyFor, settingSourcesFor, type Autonomy } from "../policy";
import type { Billing } from "../billing";
import { TEAM_PREFIX, describeTool, shortToolName } from "../team/describe";

/** Re-exported so the lifecycle suite can run a shipped template end to end. */
export const __templates = templates;

export interface RunConfig {
  /** The graph being run. Fixed for the life of the session. */
  workflow: Workflow;
  cwd: string;
  executablePath: string;
  autonomy: Autonomy;
  inheritGlobalConfig: boolean;
  /** Default model when an agent does not override it. */
  model: string;
  /** Whether a given model accepts an effort level. Not every one does. */
  effortAllowed?: (model: string) => boolean;
  /**
   * How many delegate arrows deep a run may go before the delegate tools are
   * withheld. Cycles are legal, so this is what makes them terminate.
   */
  maxDepth: number;
  /** How many times an agent may be continued after hitting its turn limit. */
  maxContinues?: number;
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

/**
 * Below this there is no point starting a run: it would spend its first call
 * and stop, having produced nothing and told the user nothing useful.
 */
const MIN_VIABLE_BUDGET = 0.05;


export class WorkflowSession implements vscode.Disposable {
  private input = new InputQueue();
  private stream: Query | undefined;
  private pump: Promise<void> | undefined;
  private disposed = false;
  private busy = false;
  private runId = 0;
  private readonly abort = new AbortController();
  private readonly pendingPermissions = new Set<(r: PermissionResult) => void>();
  /** Questions on screen, so an interrupt or teardown can settle them. */
  private readonly pendingAsks = new Map<string, (a: Record<string, string> | null) => void>();
  /** Live teammate runs, so Stop can actually stop them. */
  private readonly nested = new Set<{ query: Query; abort: AbortController }>();
  /**
   * Set by Stop, cleared by the next message.
   *
   * A handoff chain and a turn-limit continuation both start a NEW run once the
   * previous one ends, and neither is inside the query an interrupt aborts. So
   * they have to be told. Without this the chain only stopped because aborting
   * happened to make the run throw — true today, and not something correctness
   * should rest on: a node that completes cleanly a moment before Stop lands
   * would start the next one anyway.
   */
  private stopping = false;
  private readonly status = new Map<AgentId, AgentStatus>();
  /** Which agent the user is currently addressing. */
  private channel: AgentId;
  private initSeen = false;
  /** Connector name to the failure already announced for it, so a broken one is
   * reported when it breaks and not once per run for the rest of the session. */
  private readonly connectorTrouble = new Map<string, string>();
  /** The connector health last shown on the roster, so the chips are republished
   * when it changes and left alone when it has not. */
  private connectorHealth = "";
  /** Usage limits already reported, keyed by window and reset time, so one is
   * named when it is reached and not again on every turn until it clears. */
  private readonly limitsAnnounced = new Set<string>();
  /** User turns, newest last. Checkpointing rewinds to one of these. */
  private readonly turns: { id: string; text: string; at: number }[] = [];

  constructor(
    private readonly config: RunConfig,
    private readonly billing: Billing,
    private readonly emit: (event: TeamEvent) => void,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.channel = config.workflow.entry;
    for (const agent of config.workflow.agents) this.status.set(agent.id, "idle");
  }

  private agentIds(): AgentId[] {
    return this.config.workflow.agents.map((a) => a.id);
  }

  private nameOf(who: AgentId): string {
    return agentById(this.config.workflow, who)?.name ?? who;
  }

  // --------------------------------------------------------------- lifecycle

  send(text: string, images: Attachment[] = []): void {
    if (this.disposed) return;
    this.stopping = false;
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

  /**
   * Switching who the user talks to needs a fresh main thread.
   *
   * Each agent has its own system prompt and its own tools, so the running
   * query cannot simply be re-pointed — and the new agent has not seen the
   * conversation with the old one, which is worth saying out loud rather than
   * letting the user discover it from a confused reply.
   */
  setChannel(to: AgentId): void {
    if (to === this.channel || !agentById(this.config.workflow, to)) return;
    const entry = this.config.workflow.entry;
    this.channel = to;
    this.teardown();
    this.emit({ kind: "channel", to });
    this.emit({
      kind: "notice",
      level: "info",
      text:
        to === entry
          ? `Back on ${this.nameOf(entry)}. They have not seen anything said on a direct line.`
          : `Talking to ${this.nameOf(to)} directly. ${this.nameOf(entry)} is not in the loop, so their picture of the work goes stale until you tell them.`,
    });
  }

  async interrupt(): Promise<void> {
    // Set before anything is awaited: a chain deciding whether to continue must
    // see this even if it checks while the interrupt is still in flight.
    this.stopping = true;
    if (!this.stream && !this.nested.size) return;
    // Teammates first: the Lead is blocked on their tool call, so leaving them
    // running would keep editing files under a UI that says idle.
    this.settleAsks();
    // The modal stays on screen either way, but the tool call it was gating
    // should not go on waiting for a click that can no longer matter.
    this.settlePermissions("The run was stopped before this was approved.");
    await this.stopNested();
    try {
      await this.stream?.interrupt();
      this.emit({ kind: "notice", level: "info", text: "Interrupted." });
    } catch (err) {
      this.log.warn(`interrupt failed: ${describe(err)}`);
    } finally {
      this.setBusy(false);
      for (const who of this.agentIds()) this.setStatus(who, "idle");
    }
  }

  dispose(): void {
    if (this.disposed) return;
    // Before `disposed` latches, so the webview still hears it and the busy
    // context key resets — otherwise New Session mid-run wedges the composer.
    this.setBusy(false);
    this.stopping = true;
    this.disposed = true;
    this.settlePermissions("The session ended before this was approved.");
    this.settleAsks();
    void this.stopNested();
    this.abort.abort();
    this.input.close();
    try { this.stream?.close(); } catch (err) { this.log.warn(`close failed: ${describe(err)}`); }
    this.stream = undefined;
    this.pump = undefined;
  }

  /** Drops the live query but keeps the session usable. */
  private teardown(): void {
    this.settleAsks();
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
    // Said first, because it is the reason nothing can ever be rewound rather
    // than the reason this attempt failed.
    if (this.config.checkpoints === false) {
      return {
        ok: false,
        detail: "Checkpoints are turned off, so there is nothing to restore from. Turn cadre.checkpoints back on and the next run will be rewindable.",
      };
    }
    // The checkpoints belong to the query, so they go when it does. The command
    // is in the palette either way, and someone reaches for it exactly when
    // something has gone wrong — "no live session" reads as a fault in Cadre.
    if (!this.stream) {
      return {
        ok: false,
        detail: "This run has ended, and its checkpoints ended with it. Rewinding is only possible while a run is still going.",
      };
    }
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
    const spec = this.specFor(this.channel, { speaksToUser: true });
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
    // Anything still waiting on the run that has just ended. Interrupt,
    // teardown and dispose all did this; the path where the stream itself
    // fails did not, so a question the user had not answered sat in the lane
    // waiting for an answer that could no longer go anywhere.
    this.settleAsks();
    this.settlePermissions("The run ended before this was approved.");
    this.stream = undefined;
    this.pump = undefined;
    this.input.detach();
    this.setBusy(false);
    for (const who of this.agentIds()) this.setStatus(who, "idle");
    if (wasBusy) {
      this.emit({ kind: "notice", level: "warn", text: "The session ended. Your next message will start a new one." });
    }
  }

  // ---------------------------------------------------------- nested runs

  /**
   * Runs one agent to completion in its own query, streaming everything into
   * that agent's lane. Because we spawn it ourselves, attribution is known
   * rather than inferred.
   *
   * `depth` is how many delegate arrows we have followed to get here. Cycles
   * are legal in this model — A→B→A is how a peer asks back — so nothing about
   * the graph's shape bounds recursion, and this counter is what does: at the
   * cap the agent keeps every other tool but loses its delegate tools, so the
   * run cannot go deeper. Bounding by capability rather than by refusing the
   * call means the agent is never left retrying something that will never work.
   */
  private async runAgent(args: {
    who: AgentId;
    kind: "brief" | "consult";
    id: string;
    prompt: string;
    from: AgentId;
    headline: string;
    depth?: number;
    /**
     * Set when this run IS a link in a `then` chain. The chain loop already
     * holds every downstream node in order, so a link must not start the rest
     * of the chain itself — that would run each one twice.
     */
    inChain?: boolean;
    /** Renders as a handoff card rather than a brief. */
    handoff?: boolean;
  }): Promise<string> {
    if (this.disposed) return "The session ended before this could run.";

    const depth = args.depth ?? 1;
    const agent = agentById(this.config.workflow, args.who);
    if (!agent) return `There is no agent called "${args.who}" in this workflow.`;

    const spec = this.specFor(args.who, {
      speaksToUser: false,
      mayDelegate: depth < Math.max(1, this.config.maxDepth),
      // A consult is a question, not a handoff: keep it short.
      maxTurns: args.kind === "consult" ? 12 : undefined,
    });

    const assignment: Assignment = {
      id: args.id,
      from: args.from,
      to: args.who,
      brief: args.headline,
      startedAt: Date.now(),
      ...(args.handoff ? { handoff: true } : {}),
    };
    if (args.kind === "brief") this.emit({ kind: "assign", assignment });
    this.liveEdge = { from: args.from, to: args.who };
    this.setStatus(args.who, "thinking", args.kind === "consult" ? "answering a question" : args.headline);

    // Its own controller, chained to the session's, so a single agent can be
    // cancelled without tearing down the whole session.
    const abort = new AbortController();
    const onSessionAbort = () => abort.abort();
    this.abort.signal.addEventListener("abort", onSessionAbort, { once: true });

    // Held for as long as this run is going, so a sibling started in the same
    // turn cannot be handed the same money.
    const grant = this.claimBudget();
    if (grant !== undefined && grant < MIN_VIABLE_BUDGET) {
      this.releaseBudget(grant);
      const text =
        `The spend cap of $${(this.config.maxSpendUsd ?? 0).toFixed(2)} is committed to work already running, `
        + `so ${this.nameOf(args.who)} was not started. Raise cadre.maxSpendUsd to let the rest of the team run.`;
      this.emit({ kind: "notice", level: "error", who: args.who, text });
      if (args.kind === "brief") {
        this.emit({ kind: "deliver", id: args.id, outcome: "failed", summary: "the spend cap was reached" });
      }
      this.setStatus(args.who, "idle");
      this.abort.signal.removeEventListener("abort", onSessionAbort);
      return text;
    }

    let handle: { query: Query; abort: AbortController } | undefined;
    try {
      /**
       * Run, and carry on if the turn limit cuts it off.
       *
       * The context window is handled by the CLI: it summarises the history and
       * keeps going in the same conversation. The turn limit is not — the run
       * simply stops. So we do the same thing ourselves: hand the agent its own
       * account of what it did and what it wrote, and let it continue. It
       * streams into the same lane, so from the outside it is one run.
       *
       * Bounded, because "keep going" without a limit is how a stuck agent
       * spends a whole budget doing nothing.
       */
      let prompt = args.prompt;
      let attempt = 0;
      let outcomeOf: Awaited<ReturnType<typeof this.consume>>;
      const carried: string[] = [];
      const limit = Math.max(0, this.config.maxContinues ?? 2);

      for (;;) {
        const nestedQuery = query({ prompt, options: this.optionsFor(spec, abort, depth, grant) });
        handle = { query: nestedQuery, abort };
        this.nested.add(handle);
        outcomeOf = await this.consume(nestedQuery, args.who, false);
        this.nested.delete(handle);
        handle = undefined;

        for (const action of outcomeOf.touched) if (!carried.includes(action)) carried.push(action);

        const canContinue =
          outcomeOf.failure === "error_max_turns" &&
          !outcomeOf.text &&
          attempt < limit &&
          !this.disposed &&
          !this.stopping;
        if (!canContinue) break;

        attempt += 1;
        this.emit({
          kind: "notice",
          level: "info",
          who: args.who,
          text: `${this.nameOf(args.who)} hit its turn limit. Summarising what it has done and carrying on (${attempt} of ${limit}).`,
        });
        prompt = this.continuationPrompt(args.prompt, outcomeOf.said, carried, attempt, limit);
      }

      let report = outcomeOf.text
        || this.truncatedReport(outcomeOf.failure || "error_during_execution", outcomeOf.said, carried);
      const outcome = /^\s*VERDICT\s*:?\s*(BLOCKED|REJECTED)/im.test(report) ? "blocked" : "delivered";
      if (args.kind === "brief") {
        this.emit({ kind: "deliver", id: args.id, outcome, summary: headlineOf(report) });
      }
      this.setStatus(args.who, "idle");

      // Any `then` arrows leaving this agent fire now, with its output as their
      // input. Their results are appended to what goes back to the delegator:
      // otherwise work the user can watch happening would vanish from the only
      // record the delegator ever sees.
      if (!args.inChain) {
        const handoffs = await this.runHandoffs(args.who, report, depth);
        if (handoffs) report += handoffs;
      }

      return report || "(the agent returned nothing)";
    } catch (err) {
      this.log.error(`${args.who} run failed: ${describe(err)}`);
      if (args.kind === "brief") {
        this.emit({ kind: "deliver", id: args.id, outcome: "failed", summary: describe(err) });
      }
      this.setStatus(args.who, "idle");
      return `VERDICT: BLOCKED\nThe run failed before producing a report: ${describe(err)}`;
    } finally {
      if (handle) this.nested.delete(handle);
      this.releaseBudget(grant);
      this.abort.signal.removeEventListener("abort", onSessionAbort);
    }
  }

  /**
   * Runs the `then` chain leaving one agent, in order, feeding each result to
   * the next. Returns a summary to append to the triggering agent's output, or
   * an empty string when there is no chain.
   *
   * `then` arrows are validated acyclic in the builder, so this terminates
   * without a depth counter — but it is still capped, because a saved workflow
   * from an older version could carry a cycle the current validator rejects.
   */
  private async runHandoffs(from: AgentId, output: string, depth: number): Promise<string> {
    const chain = thenOrder(this.config.workflow, from).slice(0, 24);
    if (!chain.length || this.disposed) return "";

    const parts: string[] = [];
    // What each agent in the chain will be handed. A→B→C means C reads B's
    // output, not A's, and `done` is how the immediate predecessor is found —
    // the chain is a breadth-first order, so the trigger is not the sender for
    // anything past the first hop. Attributing every card to the trigger read
    // as "News Researcher → Publisher" for work Blog Writer actually handed on.
    const handed = new Map<AgentId, string>([[from, output]]);
    const done = new Set<AgentId>([from]);

    for (const next of chain) {
      if (this.disposed || this.stopping) break;
      const target = agentById(this.config.workflow, next);
      if (!target) continue;

      const edge = this.config.workflow.edges.find(
        (e) => e.kind === "then" && e.to === next && done.has(e.from),
      );
      const sender = edge?.from ?? from;
      const carried = handed.get(sender) ?? output;
      const headline = edge?.label || `Handoff from ${this.nameOf(sender)}`;
      const id = `handoff-${sender}-${next}-${cryptoId()}`;

      const prompt = [
        `HANDOFF from ${this.nameOf(sender)}.`,
        "",
        "This is their output, and it is your input. Nobody is available to clarify it.",
        "",
        carried,
      ].join("\n");

      // runAgent renders the card. Emitting one here too was drawing every
      // handoff twice.
      const result = await this.runAgent({
        who: next,
        kind: "brief",
        id,
        prompt,
        from: sender,
        headline,
        depth: depth + 1,
        inChain: true,
        handoff: true,
      });

      handed.set(next, result);
      done.add(next);
      parts.push(`\n\n--- HANDOFF → ${this.nameOf(next)} ---\n${clip(result, 2000)}`);
    }

    return parts.join("");
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

  /**
   * Consumes one query, emitting lane-attributed events.
   *
   * Returns how the run ended as well as what it said: a run cut off by the
   * turn limit can be continued, and the caller needs the progress record to
   * seed that continuation.
   */
  private async consume(
    stream: Query,
    who: AgentId,
    isMain: boolean,
  ): Promise<{ text: string; failure: string; said: string; touched: string[] }> {
    let turn = "";
    let finalText = "";
    /** Set when the run ended for any reason other than success. */
    let failure = "";
    /**
     * What the agent said and did, kept so a run that is cut off can still
     * report it. A truncated run used to hand back boilerplate saying nothing
     * was verified — true, but it also threw away the fact that files had been
     * written and things learned, so the delegator re-briefed the identical
     * work and paid for all of it twice.
     */
    let said = "";
    const touched: string[] = [];

    for await (const message of stream) {
      if (this.disposed) break;

      switch (message.type) {
        case "system": {
          if (message.subtype === "compact_boundary") {
            // Surfaced for every agent, not just the main thread. The window
            // filling and the history being summarised is the single most
            // important thing to know about a long run — including one nested
            // inside a brief, where detail dropping silently is how a report
            // ends up quietly missing what happened at the start.
            const meta = message.compact_metadata;
            this.emit({
              kind: "compacted",
              trigger: meta.trigger,
              before: meta.pre_tokens,
              after: meta.post_tokens,
            });
            if (!isMain) {
              this.emit({
                kind: "notice",
                level: "info",
                who,
                text: `${this.nameOf(who)} filled its context window. The history was summarised and it carried on in the same run — earlier detail is condensed, not lost.`,
              });
            }
            break;
          }
          /**
           * The model declined, and nothing retried it.
           *
           * `refusal` is not one of the assistant frame's error codes, so this
           * system message is the only thing the CLI sends about it. Dropped,
           * the agent stopped mid-run and said nothing — indistinguishable
           * from a hang, and the one failure a user cannot even report well.
           */
          if (message.subtype === "model_refusal_no_fallback") {
            const reason = message.api_refusal_explanation || message.content;
            // Only worth suggesting to someone who has not already set one:
            // with a fallback configured, the retry was declined for some
            // other reason and the advice would be nonsense.
            const retry = this.config.fallbackModel
              ? ""
              : " Set a fallback model to have a refused turn retried automatically.";
            this.emit({
              kind: "notice",
              level: "error",
              who,
              text: `${message.original_model} declined this turn${reason ? `: ${reason}` : ""}.${retry}`,
            });
            break;
          }

          if (message.subtype !== "init") break;
          // The id the CLI assigned, so the workflow can record which
          // conversations belong to it.
          if (isMain && message.session_id) {
            this.emit({ kind: "sessionStarted", sessionId: message.session_id });
          }
          // Our own in-process server is plumbing, not a user connector.
          const connectors = (message.mcp_servers ?? [])
            .filter((s) => s.name !== "team")
            .map((s) => ({ name: s.name, ok: s.status === "connected", status: s.status }));

          // Checked on every run and every teammate's run, not only the first
          // init of the session. A token expires, a server is restarted, a
          // teammate carries a connector the entry agent does not. This hung
          // off `initSeen`, which is set once and never again — so after the
          // first run the team went on working without a connector and said
          // nothing about it.
          const fresh: typeof connectors = [];
          for (const connector of connectors) {
            // Recovered: forget it, so breaking again is news a second time.
            if (connector.ok) { this.connectorTrouble.delete(connector.name); continue; }
            // Once is a warning. Every run is noise, and noise is how a real
            // warning stops being read.
            if (this.connectorTrouble.get(connector.name) === connector.status) continue;
            this.connectorTrouble.set(connector.name, connector.status);
            fresh.push(connector);
          }
          if (fresh.length) {
            this.emit({
              kind: "notice",
              level: "warn",
              text: `Connector${fresh.length > 1 ? "s" : ""} unavailable: ${fresh.map((c) => `${c.name} (${c.status})`).join(", ")}. The team will work without ${fresh.length > 1 ? "them" : "it"}.`,
            });
          }

          if (isMain) {
            // Republished when connector health changes, so the chips do not go
            // on showing a connector as healthy after it has dropped. Not on
            // every run: publishing asks the billing layer for its status, and
            // the answer has not changed just because a turn started.
            const health = connectors.map((c) => `${c.name}:${c.ok}`).join(",");
            if (!this.initSeen || health !== this.connectorHealth) {
              this.initSeen = true;
              this.connectorHealth = health;
              void this.publishRoster(message.model, message.tools.length, connectors);
            }
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
              said += delta.text;
              // Only the tail matters: it is the most recent account of where
              // the run had got to.
              if (said.length > 6000) said = said.slice(-6000);
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
            const trace = summariseAction(block.name, input);
            if (trace && touched.length < 60 && !touched.includes(trace)) touched.push(trace);
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
              // The code is kept: it is what support asks for and what a
              // search finds. The sentence after it is for the person reading.
              const plain = MODEL_ERRORS[message.error];
              this.emit({
                kind: "notice",
                level: "error",
                who,
                text: `Model error: ${message.error}${plain ? ` — ${plain}` : ""}`,
              });
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

          // Every run, not just the main one. A workflow's cost is mostly its
          // teammates — a lead that delegates six times spends almost nothing
          // itself — so reporting only the main run told the user they had
          // spent a fraction of what they had. `totalUsd` is the session
          // figure the spend cap is actually measured against.
          this.emit({
            kind: "spend",
            who,
            usd: message.total_cost_usd ?? 0,
            totalUsd: this.spentUsd,
            turns: message.num_turns ?? 0,
            durationMs: message.duration_ms ?? 0,
          });

          if (!isMain && message.subtype !== "success") {
            this.emit({
              kind: "notice",
              level: "error",
              who,
              text:
                message.subtype === "error_max_turns"
                  ? `${this.nameOf(who)} hit its turn limit. Whatever it wrote is still on disk, and it reported how far it got — raise "Max turns" in its Advanced settings if this keeps happening.`
                  : `${this.nameOf(who)} stopped: ${describeStop(message.subtype)}`,
            });
          }
          if (isMain) {
            const resultRun = this.runId;
            if (message.subtype !== "success") {
              this.emit({ kind: "notice", level: "error", text: `Run ended: ${message.subtype}` });
            }
            this.setStatus(who, "idle");

            // `then` arrows leaving the agent you are talking to fire once its
            // turn is done. Busy stays true across the chain: the composer must
            // not reopen while agents are still running below it.
            const chain = thenOrder(this.config.workflow, who);
            if (chain.length && message.subtype === "success" && !this.disposed && !this.stopping) {
              void this.runHandoffs(who, finalText, 0).finally(() => {
                if (resultRun === this.runId) this.setBusy(false);
              });
            } else if (resultRun === this.runId) {
              this.setBusy(false);
            }
          }
          break;
        }

        /**
         * The limit a subscription actually hits.
         *
         * Cadre's premise is that you sign in and go: no API key, one Claude
         * subscription, a whole team on it. A team is the heaviest thing a
         * five-hour window ever sees. This is the CLI saying so, on a message
         * type nothing handled — so a run slowed, stalled or died with nothing
         * said about why, which is the most confusing way this product can
         * fail. Not gated to the main thread: the limit is account-wide, and a
         * teammate's run hits it just as hard.
         */
        case "rate_limit_event":
          this.reportRateLimit(message.rate_limit_info);
          break;

        /** A token expiring, or signing out in another window, mid-run. */
        case "auth_status":
          if (message.error) {
            this.emit({
              kind: "notice",
              level: "error",
              text: `Claude sign-in failed: ${message.error}. Cadre cannot run until you sign back in.`,
            });
          }
          break;

        default:
          break;
      }
    }

    return { text: finalText, failure, said, touched };
  }

  /**
   * What a continuing agent is handed: its brief again, plus everything it did
   * and said before it ran out of turns.
   *
   * Its own words, verbatim, rather than a summary we write: it knows what it
   * was in the middle of, and paraphrasing that is how the continuation ends up
   * redoing the first half.
   */
  private continuationPrompt(
    brief: string,
    said: string,
    touched: string[],
    attempt: number,
    limit: number,
  ): string {
    return [
      "You ran out of turns partway through this work and are being continued.",
      "This is a fresh context: everything below is all you have. The work already",
      "done is real and on disk — check it rather than repeating it.",
      "",
      "=== THE ORIGINAL BRIEF ===",
      brief,
      "",
      "=== WHAT YOU ALREADY DID ===",
      touched.length ? touched.map((t) => `- ${t}`).join("\n") : "- nothing was written or run",
      "",
      "=== YOUR OWN LAST WORDS BEFORE YOU STOPPED ===",
      clip(said, 3000) || "(you had not said anything yet)",
      "",
      `This is continuation ${attempt} of ${limit}. Finish the work and produce your report.`,
      "If you cannot finish within these turns, spend the last of them writing the report",
      "with what you have — a report that arrives is worth more than work that does not.",
    ].join("\n");
  }

  /** The report a run that was cut off leaves behind. */
  private truncatedReport(failure: string, said: string, touched: string[]): string {
    {
      const lines = [
        "VERDICT: BLOCKED",
        `HEADLINE: The run stopped before it could report — ${describeStop(failure)}.`,
      ];
      if (touched.length) {
        lines.push(
          "ALREADY DONE: these ran or were written before it stopped. The changes are on disk; do not redo them blindly, check them.",
          ...touched.map((t) => `  - ${t}`),
        );
      }
      if (said.trim()) {
        lines.push("", "WHERE IT HAD GOT TO (its own last words, not a report):", clip(said, 1500));
      }
      lines.push(
        "",
        "NOT COVERED: everything else in the brief. Nothing above was verified by a report.",
        touched.length
          ? "NEXT: re-brief only what is left, telling them what is already done — a fresh run starts with an empty context and will otherwise repeat all of it."
          : "NEXT: nothing was accomplished. Decide whether a narrower brief is worth another run.",
      );
      return lines.join("\n");
    }
  }

  // -------------------------------------------------------------- options

  /**
   * One agent, resolved: its capabilities from the preset and the arrows, and
   * its system prompt from what the user wrote plus the protocol those arrows
   * imply.
   *
   * Recomputed per run rather than cached, because `speaksToUser` and
   * `mayDelegate` differ between the main thread and a nested run of the very
   * same agent.
   */
  private specFor(
    who: AgentId,
    opts: { speaksToUser: boolean; mayDelegate?: boolean; maxTurns?: number },
  ): ResolvedAgent {
    const agent = agentById(this.config.workflow, who);
    if (!agent) throw new Error(`No agent "${who}" in this workflow.`);

    const resolved = resolveAgent(this.config.workflow, agent, {
      defaultModel: this.config.model,
      speaksToUser: opts.speaksToUser,
      mayDelegate: opts.mayDelegate,
    });

    return {
      ...resolved,
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      prompt: composeSystemPrompt(this.config.workflow, agent, {
        scratchpad: SCRATCHPAD,
        docsPath: this.config.docsPath || "docs",
        documentation: this.config.documentation ?? "substantial",
        speaksToUser: opts.speaksToUser,
        preamble: this.projectPreamble(),
      }),
    };
  }

  /**
   * `depth` only affects the tools an agent is given, which specFor has already
   * applied; it is threaded through so a nested delegate call knows how deep it
   * is when it in turn delegates.
   */
  private optionsFor(
    spec: ResolvedAgent,
    abort?: AbortController,
    depth = 0,
    granted?: number,
  ): Options {
    const policy = policyFor(this.config.autonomy);
    // Each agent gets its own server: the delegate tools it carries are exactly
    // the arrows leaving it, so one shared server would hand everyone
    // everyone's tools.
    const server = createWorkflowServer(
      {
        cwd: this.config.cwd,
        signal: this.abort.signal,
        workflow: this.config.workflow,
        runAgent: (args) => this.runAgent({ ...args, depth: depth + 1 }),
      },
      spec.id,
    );

    return {
      cwd: this.config.cwd,
      pathToClaudeCodeExecutable: this.config.executablePath,
      model: spec.model,
      // Sending an effort level to a model that does not take one is at best
      // ignored and at worst an error, so it is omitted rather than guessed.
      ...(this.config.effortAllowed?.(spec.model) === false
        ? {}
        : { effort: spec.effort as Options["effort"] }),
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
      toolAliases: toolAliases(this.config.workflow, spec.id),
      mcpServers: { team: server, ...this.connectorsFor(spec) },
      strictMcpConfig: this.config.exclusiveConnectors,
      // An agent's own skill list wins when it has one. `undefined` inherits
      // the workspace setting; an empty array is a deliberate "none", so the
      // two cannot be collapsed with `||`.
      skills: spec.skills ?? this.config.skills,
      plugins: (this.config.plugins ?? []).map((path) => ({ type: "local" as const, path })),
      additionalDirectories: this.config.additionalDirectories ?? [],
      thinking: this.config.thinking === "off" ? { type: "disabled" } : { type: "adaptive" },
      ...(this.config.fallbackModel ? { fallbackModel: this.config.fallbackModel } : {}),
      // The SDK's budget is per-query, so each teammate would otherwise get a
      // fresh ceiling. Hand every run only what is left of the session's.
      ...(granted !== undefined
        ? { maxBudgetUsd: granted }
        : this.remainingBudget() !== undefined
          ? { maxBudgetUsd: this.remainingBudget() }
          : {}),
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
      /**
       * The read-only confinement, where a bypassed permission mode cannot
       * reach past it.
       *
       * A read-only agent has Write and Edit — it needs them for `.cadre/` and
       * the docs folder — and what kept it out of everything else was a check
       * inside `canUseTool`. On `autonomous` the CLI is asked for
       * `bypassPermissions`, and the SDK says plainly what that means:
       *
       *   "canUseTool will not be invoked: permissionMode 'bypassPermissions'
       *    auto-approves every tool call (except explicit deny rules) before
       *    the callback is consulted. To gate every tool call, use a PreToolUse
       *    hook instead."
       *
       * So the confinement held on the three levels that prompt and not on the
       * one built to run unwatched — where a coordinator quietly doing the
       * work itself is exactly the failure the roles exist to prevent. This is
       * that hook, and it runs whatever the mode.
       *
       * It carries the team's questions for the same reason: `askUser` hung off
       * the same callback, so on `autonomous` a question reached nobody.
       */
      hooks: {
        PreToolUse: [{
          hooks: [async (event) => {
            if (event.hook_event_name !== "PreToolUse") return {};
            const input = (event.tool_input ?? {}) as Record<string, unknown>;

            // A question is not a permission prompt. It is the agent needing
            // something only you know, and it has to reach you at every level:
            // `autonomous` means "stop asking me to approve tools", not "never
            // speak to me". It hung off `canUseTool`, which that mode does not
            // call, so on the one level built to run unwatched the question
            // reached nobody and the run carried on without an answer.
            if (shortToolName(event.tool_name) === "AskUserQuestion") {
              const answered = await this.askUser(spec.id, input);
              return answered.behavior === "allow"
                ? { hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "allow" as const,
                    updatedInput: answered.updatedInput as Record<string, unknown>,
                  } }
                : { hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason: answered.message,
                  } };
            }

            const refusal = this.checkScratchpadOnly(spec.id, event.tool_name, input);
            if (!refusal) return {};
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason: refusal,
              },
            };
          }],
        }],
      },
      stderr: (data) => this.log.debug(`[${spec.id}] ${data.trimEnd()}`),
    };
  }

  /**
   * The connectors one agent may reach.
   *
   * An agent with no list gets every configured connector, which is the old
   * behaviour and the sane default. An agent with a list gets exactly that
   * subset — so a researcher can hold a web connector that the agent editing
   * your files cannot.
   */
  private connectorsFor(spec: ResolvedAgent): Record<string, never> {
    const all = this.config.connectors as Record<string, never>;
    if (!spec.connectors) return all;
    const allowed = new Set(spec.connectors);
    return Object.fromEntries(
      Object.entries(all).filter(([name]) => allowed.has(name)),
    ) as Record<string, never>;
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
  /**
   * What has been handed to runs that are still going.
   *
   * A run's cost is only known when it ends, so two teammates started in the
   * same turn both used to see the whole remaining ceiling and the pair could
   * spend twice what the user allowed. Handing out a slice and holding it
   * until that run reports keeps the total bounded.
   */
  private reservedUsd = 0;

  /** What is left of the user's ceiling, or undefined when uncapped. */
  private remainingBudget(): number | undefined {
    const cap = this.config.maxSpendUsd ?? 0;
    if (cap <= 0) return undefined;
    return Math.max(0.01, cap - this.spentUsd);
  }

  /**
   * Take a slice of the ceiling for a teammate about to start, and hold it
   * until that run reports what it actually cost. `undefined` means uncapped;
   * a number below {@link MIN_VIABLE_BUDGET} means there is nothing left to
   * give and the run should not start at all.
   */
  private claimBudget(): number | undefined {
    const cap = this.config.maxSpendUsd ?? 0;
    if (cap <= 0) return undefined;
    const grant = Math.max(0, cap - this.spentUsd - this.reservedUsd);
    this.reservedUsd += grant;
    return grant;
  }

  private releaseBudget(grant: number | undefined): void {
    if (grant === undefined) return;
    this.reservedUsd = Math.max(0, this.reservedUsd - grant);
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
      workflowId: this.config.workflow.id,
      workflowName: this.config.workflow.name,
      edges: this.config.workflow.edges,
      members: this.config.workflow.agents.map((agent) => {
        const spec = this.specFor(agent.id, { speaksToUser: agent.id === this.channel });
        return {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          // The CLI reports what the main thread actually resolved to, which
          // can differ from what was asked for (a fallback, an alias).
          model: agent.id === this.channel ? model : spec.model,
          effort: String(spec.effort),
          preset: agent.preset,
          status: this.status.get(agent.id) ?? "idle",
          entry: agent.id === this.channel,
          x: agent.x,
          y: agent.y,
        };
      }),
    });
    this.log.info(`roster published: ${this.config.workflow.agents.length} agents, ${toolCount} tools on the main thread`);
  }

  // ---------------------------------------------------------- permissions

  private async requestPermission(
    who: AgentId,
    name: string,
    input: Record<string, unknown>,
    context: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const deny = (message: string): PermissionResult => ({ behavior: "deny", message });
    if (this.disposed) return deny("The session has ended.");

    // AskUserQuestion is not a permission decision — it is the question itself.
    // The CLI has no renderer here, so the host collects the answers and hands
    // them back on the tool input. That is done by the PreToolUse hook, which
    // runs whatever the permission mode; this callback does not run at all on
    // `autonomous`. Asking again here would put the same question up twice on
    // the levels where both do run.
    if (shortToolName(name) === "AskUserQuestion") return { behavior: "allow", updatedInput: input };

    // The Lead's scratchpad confinement. Its prompt says it has no editor outside
    // .cadre/, but a prompt is not an enforcement mechanism — without this the
    // Lead can quietly do the Engineer's job and the team becomes theatre.
    const confined = this.checkScratchpadOnly(who, name, input);
    if (confined) return deny(confined);

    this.setStatus(who, "waiting", `waiting on you: ${shortToolName(name)}`);
    const prompt = `${this.nameOf(who)} wants to run ${shortToolName(name)}`;
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
    who: AgentId,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    const raw = Array.isArray(input.questions) ? (input.questions as RawQuestion[]) : [];
    const questions: AskQuestion[] = raw.map((q) => ({
      question: String(q?.question ?? ""),
      header: String(q?.header ?? ""),
      multiSelect: q?.multiSelect === true,
      options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({
        label: String(o?.label ?? ""),
        description: String(o?.description ?? ""),
      })),
    })).filter((q) => q.question && q.options.length);

    if (!questions.length) return { behavior: "allow", updatedInput: input };

    const id = crypto.randomUUID();
    this.setStatus(who, "waiting", "waiting on your answer");
    this.emit({ kind: "ask", id, who, questions });

    const answers = await new Promise<Record<string, string> | null>((resolve) => {
      this.pendingAsks.set(id, resolve);
    });
    this.pendingAsks.delete(id);
    this.emit({ kind: "askClosed", id, answered: answers !== null });
    if (!this.disposed) this.setStatus(who, "thinking");

    if (!answers) {
      return { behavior: "deny", message: "The user dismissed the question without answering." };
    }
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  /**
   * Names the window that is filling and when it comes back.
   *
   * `utilization` is deliberately not shown: the SDK does not say whether it
   * is a fraction or a percentage, and a confidently wrong number is worse
   * than no number. Which window and when it clears is the actionable part.
   */
  private reportRateLimit(info: SDKRateLimitInfo | undefined): void {
    if (!info || info.status === "allowed") return;

    // Keyed on the window too, so the next one is news again.
    const key = `${info.status}:${info.rateLimitType ?? ""}:${info.resetsAt ?? ""}`;
    if (this.limitsAnnounced.has(key)) return;
    this.limitsAnnounced.add(key);

    const WINDOWS: Record<string, string> = {
      five_hour: "five-hour limit",
      seven_day: "weekly limit",
      seven_day_opus: "weekly Opus limit",
      seven_day_sonnet: "weekly Sonnet limit",
      seven_day_overage_included: "weekly limit",
      overage: "overage limit",
    };
    const window = WINDOWS[info.rateLimitType ?? ""] ?? "usage limit";

    // The SDK does not write down whether `resetsAt` is seconds or
    // milliseconds. A Unix time in seconds is about 1.7e9 and in milliseconds
    // about 1.7e12, so the two cannot be confused for any plausible date.
    // Accepting both beats picking one and being wrong half the time.
    const at = info.resetsAt === undefined
      ? undefined
      : new Date(info.resetsAt < 1e11 ? info.resetsAt * 1000 : info.resetsAt);
    const resets = at && !Number.isNaN(at.getTime())
      ? ` It resets ${info.rateLimitType === "five_hour" ? `at ${at.toLocaleTimeString()}` : `on ${at.toLocaleString()}`}.`
      : "";

    this.emit(info.status === "rejected"
      ? { kind: "notice", level: "error",
          text: `Claude's ${window} has been reached.${resets} The team cannot run until then.` }
      : { kind: "notice", level: "warn",
          text: `Close to Claude's ${window}.${resets} A long run may not finish.` });
  }

  /** Called when the webview sends the user's answer back. */
  answer(id: string, answers: Record<string, string> | null): void {
    this.pendingAsks.get(id)?.(answers);
  }

  private settleAsks(): void {
    for (const resolve of this.pendingAsks.values()) resolve(null);
    this.pendingAsks.clear();
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
    who: AgentId,
    name: string,
    input: Record<string, unknown>,
  ): string | undefined {
    const editing = ["Write", "Edit", "NotebookEdit"].includes(shortToolName(name));
    if (!editing) return undefined;

    const agent = agentById(this.config.workflow, who);
    // Whether an agent has real hands is a property of its preset, not of its
    // name. A workflow with five read-only agents confines all five.
    if (!agent || PRESETS[agent.preset]?.writesFreely) return undefined;

    const target = typeof input.file_path === "string" ? input.file_path : "";
    if (!target) return undefined;

    const resolved = path.resolve(this.config.cwd, target);
    const roots = [SCRATCHPAD];
    if (this.config.documentation !== "off" && this.config.docsPath) {
      roots.push(this.config.docsPath);
    }

    const workspace = path.resolve(this.config.cwd);
    const inside = (candidate: string): boolean =>
      candidate === workspace || candidate.startsWith(workspace + path.sep);

    const allowed = roots.some((root) => {
      const base = path.resolve(this.config.cwd, root);
      // A docs root outside the workspace is not a root. `cadre.docsPath` is a
      // resource-scoped setting, so a cloned repository can ship one — and
      // `../../.ssh` or `/etc` would otherwise hand an agent that is supposed
      // to have no editor a write anywhere on the machine, with no prompt at
      // all on `autonomous`.
      if (!inside(base)) return false;
      return resolved === base || resolved.startsWith(base + path.sep);
    });
    if (allowed) return undefined;

    const writable = roots
      .filter((root) => inside(path.resolve(this.config.cwd, root)))
      .map((r) => `${r}/`)
      .join(" and ");
    // Name who can actually do it: a refusal that leaves the agent guessing
    // costs another turn and usually ends in it trying a different path.
    const hands = this.config.workflow.edges
      .filter((e) => e.from === who && e.kind === "delegate")
      .map((e) => agentById(this.config.workflow, e.to))
      .filter((a) => a && PRESETS[a.preset]?.writesFreely)
      .map((a) => a!.name);

    return hands.length
      ? `You may only write inside ${writable}. To change ${target}, brief ${hands.join(" or ")}.`
      : `You may only write inside ${writable}, and no agent you can reach has an editor either. Say so rather than working around it.`;
  }

  // -------------------------------------------------------------- plumbing

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.emit({ kind: "busy", busy });
    void vscode.commands.executeCommand("setContext", "cadre.busy", busy);
  }

  private setStatus(who: AgentId, status: AgentStatus, activity?: string): void {
    if (this.status.get(who) === status && !activity) return;
    this.status.set(who, status);
    this.emit({ kind: "status", who, status, activity });
    this.publishActive();
  }

  /**
   * Who is live right now, and which arrow work most recently travelled along.
   *
   * Derived from status rather than tracked separately: a second source of
   * truth for "is this agent busy" is a second thing that can be wrong, and the
   * lane lights and the graph would eventually disagree.
   */
  private publishActive(): void {
    const busy = new Set(["thinking", "working", "waiting", "reporting"]);
    const agents = [...this.status.entries()]
      .filter(([, s]) => busy.has(s))
      .map(([id]) => id);
    this.emit({ kind: "active", agents, edge: this.liveEdge });
  }

  /** The arrow currently carrying work, for the graph to highlight. */
  private liveEdge: { from: AgentId; to: AgentId } | undefined;
}

// ------------------------------------------------------------------ helpers

/** Assistant errors that mean "fix your credentials", not "the model failed". */
const AUTH_ERRORS: Record<string, string> = {
  authentication_failed: "Not signed in to Claude, or the saved credential is no longer valid.",
  oauth_org_not_allowed: "Your organisation does not permit this login for Claude Code.",
  account_on_hold: "This Claude account is on hold.",
  billing_error: "Billing could not be authorised for this account.",
};

/**
 * Plain language for the error codes that are not a credential problem.
 *
 * Nothing is invented for a code that is not listed — an unexplained code beats
 * a confidently wrong explanation.
 */
const MODEL_ERRORS: Record<string, string> = {
  model_not_found: "that model is not available on this account. Choose another one for this agent.",
  overloaded: "Claude is busy right now. Nothing is wrong with the workflow; try again in a moment.",
  server_error: "Claude's API failed on its own side. The turn did not finish.",
  rate_limit: "the account's usage limit was reached.",
  invalid_request: "the request was rejected as malformed, which is a bug in Cadre rather than in your workflow.",
  max_output_tokens: "the reply hit the model's output limit and was cut off.",
};

/** The shape AskUserQuestion sends; validated defensively since it is model output. */
interface RawQuestion {
  question?: unknown;
  header?: unknown;
  multiSelect?: unknown;
  options?: { label?: unknown; description?: unknown }[];
}


/** The only place the Lead and Researcher may write. */
export const SCRATCHPAD = ".cadre";

/**
 * A brief renders as an assignment card travelling between lanes, not as a tool
 * chip. Matched by prefix because the agent ids are the user's to choose.
 *
 * `ask_` is deliberately NOT included: a consult is cheap and frequent, and
 * showing it as a chip in the asker's lane keeps it distinguishable from real
 * delegation at a glance.
 */
/**
 * One line describing an action, for the record a truncated run leaves behind.
 * Only the actions that change something or cost something are worth keeping —
 * a list of every file read is noise.
 */
function summariseAction(name: string, input: Record<string, unknown>): string | undefined {
  const short = shortToolName(name);
  const str = (key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (short) {
    case "Write": return `wrote ${str("file_path")}`;
    case "Edit": return `edited ${str("file_path")}`;
    case "NotebookEdit": return `edited notebook ${str("file_path")}`;
    case "Bash": {
      const command = str("command").replace(/\s+/g, " ").trim();
      return command ? `ran: ${command.length > 120 ? `${command.slice(0, 119)}…` : command}` : undefined;
    }
    default: return undefined;
  }
}

function isTeamDelegation(name: string): boolean {
  return name.startsWith(`${TEAM_PREFIX}brief_`);
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

/**
 * The workspace path, shortened for a chip that has room for about thirty
 * characters.
 *
 * Exported for the suite, and worth testing: this read `process.env.HOME`,
 * which is not set on Windows, and split on `/` alone, which a Windows path
 * does not contain. Both failures were silent and both pointed the same way —
 * the chip showed the entire path, and the part CSS then cut off was the end,
 * which is the only part that identifies the project.
 */
export function shortPath(p: string): string {
  const home = os.homedir();
  const shown = home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  const parts = shown.split(/[\\/]/).filter(Boolean);
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

/** Keeps an appended handoff from swamping the report it is attached to. */
function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n… (${trimmed.length - limit} more characters in their lane)`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What a workflow is.
 *
 * A workflow is a named set of agents and the arrows between them. It is the
 * whole product: there is no built-in roster any more, and nothing here knows
 * or cares whether the agents write software, review contracts or plan a trip.
 *
 * Two kinds of arrow, because they answer different questions:
 *
 *   delegate   A gets a tool for B. A writes a brief, B runs with an empty
 *              context, returns one report, A carries on. A→B→A is legal — it
 *              is how a peer asks back — so depth is bounded by a counter
 *              rather than by the shape of the graph.
 *
 *   then       B starts when A finishes, with A's output as its input. No
 *              waiting, no tool call, no decision: it just happens. This has
 *              to terminate, so `then` edges must form a DAG.
 */

export type AgentId = string;

/** How much of the machine an agent is trusted with, before any overrides. */
export type Preset = "readonly" | "research" | "build" | "full";

export type EdgeKind = "delegate" | "then";

export interface AgentSpec {
  /** Stable slug. Fixed at creation so renaming an agent never breaks an edge. */
  id: AgentId;
  name: string;
  /** One line under the name in the lane header. */
  role: string;
  /** The system prompt, after refinement if the user accepted it. */
  prompt: string;
  /** What the user typed, kept so refinement can be re-run or undone. */
  rawPrompt?: string;
  preset: Preset;

  // Advanced overrides. Every one is optional; the preset supplies the default.
  model?: string;
  effort?: string;
  /** Replaces the preset's tool list outright when set. */
  tools?: string[];
  /** Added to whatever the preset already denies. */
  disallowedTools?: string[];
  /** Skill names this agent may use. Empty array means none; undefined means inherit. */
  skills?: string[];
  /** Connector (MCP server) names this agent may reach. */
  connectors?: string[];
  maxTurns?: number;

  /** Canvas position, in the builder's coordinate space. */
  x: number;
  y: number;
}

export interface Edge {
  from: AgentId;
  to: AgentId;
  kind: EdgeKind;
  /** Shown on the arrow, and given to the agent as the reason the edge exists. */
  label?: string;
}

/**
 * Where a workflow lives, and therefore who can see it.
 *
 * `local` is stored in the project and travels with it — reviewable in a diff,
 * shareable by committing. `global` lives in your home directory and is
 * available in every project you open. The same graph can be either; moving it
 * is a copy and a delete.
 */
export type Scope = "local" | "global";

/**
 * Values every agent inherits unless it says otherwise.
 *
 * Three tiers, narrowest wins: the agent's own advanced settings, then these,
 * then the workspace setting. Having a per-workflow tier matters because a
 * workflow is the unit people share — "this one runs on sonnet" belongs with
 * the graph, not in someone's editor config.
 */
export interface Defaults {
  model?: string;
  effort?: string;
  maxTurns?: number;
  /** Undefined inherits the workspace; an empty array is a deliberate "none". */
  skills?: string[];
  connectors?: string[];
}

export interface Workflow {
  id: string;
  name: string;
  /** Set when the workflow is read, from the directory it was found in. */
  scope?: Scope;
  defaults?: Defaults;
  /** One line on the home card. */
  description?: string;
  /** Who you talk to when you open it. Must be an agent id. */
  entry: AgentId;
  agents: AgentSpec[];
  edges: Edge[];
  createdAt: number;
  updatedAt: number;
  /** Bumped when the shape changes, so a running session can notice. */
  revision: number;
  /** Set on a workflow created from a template, for the home screen's benefit. */
  template?: string;
}

/* ------------------------------------------------------------------- slugs */

/**
 * Agent ids become tool names (`brief_<id>`), so they have to survive being
 * pasted into an MCP tool name: lowercase, no spaces, no punctuation.
 */
export function slug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return base || "agent";
}

/** A slug not already taken in `existing`. */
export function uniqueSlug(name: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = slug(name);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

/* -------------------------------------------------------------- validation */

export interface Problem {
  /** `error` blocks launching; `warning` is worth saying but not fatal. */
  level: "error" | "warning";
  message: string;
  /** The agent or edge the problem is about, for highlighting on the canvas. */
  where?: string;
}

/**
 * Everything that makes a workflow unrunnable, in one pass.
 *
 * Returned rather than thrown: the builder shows these live while the user is
 * still drawing, and a half-built workflow is a normal state, not an error.
 */
export function validate(workflow: Workflow): Problem[] {
  const problems: Problem[] = [];
  const ids = new Set<string>();

  if (!workflow.name.trim()) problems.push({ level: "error", message: "The workflow needs a name." });
  if (!workflow.agents.length) problems.push({ level: "error", message: "Add at least one agent." });

  for (const agent of workflow.agents) {
    if (ids.has(agent.id)) {
      problems.push({ level: "error", message: `Two agents share the id "${agent.id}".`, where: agent.id });
    }
    ids.add(agent.id);
    if (!agent.name.trim()) {
      problems.push({ level: "error", message: "An agent has no name.", where: agent.id });
    }
    if (!agent.prompt.trim()) {
      problems.push({
        level: "error",
        message: `${agent.name || agent.id} has no prompt — it would start with no idea what it is for.`,
        where: agent.id,
      });
    }
  }

  if (workflow.agents.length && !ids.has(workflow.entry)) {
    problems.push({ level: "error", message: "No entry agent is set — mark the one you want to talk to." });
  }

  for (const edge of workflow.edges) {
    const key = edgeKey(edge);
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      problems.push({ level: "error", message: "An arrow points at an agent that no longer exists.", where: key });
      continue;
    }
    if (edge.from === edge.to) {
      problems.push({ level: "error", message: "An agent cannot point at itself.", where: key });
    }
  }

  const seen = new Set<string>();
  for (const edge of workflow.edges) {
    const key = `${edge.kind}:${edge.from}->${edge.to}`;
    if (seen.has(key)) {
      problems.push({ level: "warning", message: "The same arrow is drawn twice.", where: edgeKey(edge) });
    }
    seen.add(key);
  }

  // `then` must terminate. `delegate` may cycle: that is a conversation.
  const cycle = findCycle(workflow.edges.filter((e) => e.kind === "then"));
  if (cycle) {
    problems.push({
      level: "error",
      message: `"then" arrows form a loop (${cycle.join(" → ")}) and would never finish. Use a delegate arrow if they need to go back and forth.`,
    });
  }

  for (const agent of workflow.agents) {
    const connected =
      agent.id === workflow.entry ||
      workflow.edges.some((e) => e.to === agent.id || e.from === agent.id);
    if (!connected) {
      problems.push({
        level: "warning",
        message: `${agent.name} has no arrows, so nothing can ever reach it.`,
        where: agent.id,
      });
    }
  }

  return problems;
}

export const edgeKey = (edge: Edge): string => `${edge.from}->${edge.to}:${edge.kind}`;

export const isRunnable = (workflow: Workflow): boolean =>
  !validate(workflow).some((p) => p.level === "error");

/** The first cycle found, as a readable path, or undefined. */
export function findCycle(edges: Edge[]): string[] | undefined {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  }

  const state = new Map<string, "open" | "closed">();
  const path: string[] = [];

  const walk = (node: string): string[] | undefined => {
    const mark = state.get(node);
    if (mark === "closed") return undefined;
    if (mark === "open") return [...path.slice(path.indexOf(node)), node];

    state.set(node, "open");
    path.push(node);
    for (const child of next.get(node) ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    path.pop();
    state.set(node, "closed");
    return undefined;
  };

  for (const node of next.keys()) {
    const found = walk(node);
    if (found) return found;
  }
  return undefined;
}

/* ------------------------------------------------------------- graph reads */

/** Agents this one may delegate to. */
export const delegatesTo = (workflow: Workflow, from: AgentId): Edge[] =>
  workflow.edges.filter((e) => e.kind === "delegate" && e.from === from);

/** Agents that start automatically when this one finishes. */
export const thenAfter = (workflow: Workflow, from: AgentId): Edge[] =>
  workflow.edges.filter((e) => e.kind === "then" && e.from === from);

export const agentById = (workflow: Workflow, id: AgentId): AgentSpec | undefined =>
  workflow.agents.find((a) => a.id === id);

/**
 * A `then` chain, in the order it must run.
 *
 * Breadth-first from the trigger, and an agent already scheduled is not
 * scheduled again — a diamond (A→B, A→C, B→D, C→D) runs D once, after both
 * sides, rather than twice.
 */
export function thenOrder(workflow: Workflow, from: AgentId): AgentId[] {
  const order: AgentId[] = [];
  const queued = new Set<string>([from]);
  let frontier = [from];

  while (frontier.length) {
    const next: AgentId[] = [];
    for (const node of frontier) {
      for (const edge of thenAfter(workflow, node)) {
        if (queued.has(edge.to)) continue;
        // Wait for every `then` predecessor to have been scheduled first.
        const pending = workflow.edges.some(
          (e) => e.kind === "then" && e.to === edge.to && !queued.has(e.from),
        );
        if (pending) continue;
        queued.add(edge.to);
        order.push(edge.to);
        next.push(edge.to);
      }
    }
    frontier = next;
  }
  return order;
}

/* --------------------------------------------------------------- creation */

export function emptyWorkflow(name: string, id: string, now: number): Workflow {
  return {
    id,
    name,
    entry: "",
    agents: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}

export function newAgent(
  name: string,
  existing: Iterable<string>,
  position: { x: number; y: number },
): AgentSpec {
  return {
    id: uniqueSlug(name, existing),
    name,
    role: "",
    prompt: "",
    preset: "readonly",
    x: position.x,
    y: position.y,
  };
}

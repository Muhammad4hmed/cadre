import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSpec, Edge, Preset, Workflow } from "./model";
import { uniqueSlug, validate } from "./model";
import { PRESETS } from "./presets";

/**
 * Turns a description of a pipeline into a whole workflow.
 *
 * The blank canvas is the hardest part of this product: knowing you want
 * "research, then a draft, then someone who checks the numbers" is easy, and
 * turning it into four agents with real prompts, the right capabilities and the
 * right arrows is an hour of work. This does that hour, badly enough that you
 * will want to edit it and well enough that editing is all you have to do.
 *
 * It always lands in the builder. Nothing is launched, nothing runs, and every
 * decision it made is visible and changeable before anything costs anything.
 */

/**
 * The shape the model must return.
 *
 * A JSON schema rather than "reply with JSON" — the CLI enforces it, so a
 * malformed answer is retried by the SDK instead of arriving here as a parse
 * error we would have to explain to the user.
 */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "entry", "agents", "edges"],
  properties: {
    name: { type: "string", description: "Short name for the workflow. Two or three words." },
    description: { type: "string", description: "One sentence describing what it does." },
    entry: { type: "string", description: "The id of the agent the user talks to." },
    agents: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "role", "preset", "prompt"],
        properties: {
          id: {
            type: "string",
            description: "lowercase_with_underscores, unique, derived from the name",
          },
          name: { type: "string", description: "Display name. One or two words." },
          role: { type: "string", description: "One short line: what this agent is for." },
          preset: {
            type: "string",
            enum: ["readonly", "research", "build", "full"],
            description:
              "readonly: reads and delegates, no shell, no editing outside notes. " +
              "research: web search and fetch plus read-only project access. " +
              "build: files and a shell — the only one that can change things. " +
              "full: everything at once.",
          },
          prompt: {
            type: "string",
            description:
              "The agent's system prompt, addressed to it in the second person. 200-500 words. " +
              "Say what good work looks like in this role, the failure modes of doing it badly, " +
              "what to do when the task is underspecified, and what not to do. " +
              "Do NOT explain delegation, briefs, reports or which teammates exist — that is supplied separately.",
          },
        },
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to", "kind"],
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          kind: {
            type: "string",
            enum: ["delegate", "then"],
            description:
              "delegate: `from` can hand work to `to` and wait for a report. Cycles are allowed. " +
              "then: `to` starts automatically when `from` finishes, with its output as input. Must be acyclic.",
          },
          label: { type: "string", description: "Optional: what this arrow is for." },
        },
      },
    },
  },
} as const;

const SYSTEM = `You design agent workflows. Given a description of a pipeline, you return the workflow that implements it: the agents, what each one is for, how much of the machine each is trusted with, and the arrows between them.

## The model you are designing for

A workflow is a set of agents and two kinds of arrow.

**delegate** — A gets a tool for B. A writes a brief, B runs with a completely empty context, returns exactly one report, and ceases to exist. A waits. Cycles are legal: A→B and B→A together means they can consult each other. Use this when the caller needs to decide *whether* and *what* to hand over, or needs the answer before continuing.

**then** — B starts automatically when A finishes, with A's final message as its input. No decision, no waiting, no tool call. These must be acyclic. Use this for a fixed pipeline where the next stage always runs.

The user talks to exactly one agent, the entry. Everything else is reached through arrows.

## What makes a good workflow

**Few agents, sharply divided.** Three or four is usually right. Every agent must be justified by a tool the others lack, context hygiene (keeping a large amount of reading out of someone else's head), or genuine parallelism. An agent that exists to "coordinate" a two-agent workflow is overhead.

**Capabilities carry the design.** Only a \`build\` agent can change files or run commands. Give exactly one agent hands unless the work genuinely needs two — an agent that can quietly do the work itself will, and then its teammates are decoration. A coordinator should be \`readonly\`: it can see everything and change nothing, which is what forces the delegation to be real.

**Choose the arrow that matches the work.** A stage that always runs next is a \`then\`. A question that may or may not need asking is a \`delegate\`. Pipelines of four \`then\` arrows are common and fine; so is one coordinator with three \`delegate\` arrows and no \`then\` at all.

**The entry agent is whoever the user should be talking to.** Usually the one that decides scope, not the one that does the most work.

## The prompts

This is most of the value. A weak prompt produces an agent that is agreeable and useless.

Write each one in the second person, 200–500 words, in a few short markdown sections. Include what good work looks like *in that specific role*, the failure modes of doing that job badly, what to do when the task is underspecified, and what the agent should refuse or escalate. Be concrete and domain-specific — if the workflow is about contracts, the prompt should read like it was written by someone who reviews contracts.

Do not write anything about brief formats, report formats, delegation mechanics, or which teammates exist. All of that is generated from the arrows and appended automatically; saying it twice makes the two copies drift.

No emoji. No cheerleading. Write like documentation you would want to read.

## Honesty

If the description is too vague to design from, still return a workflow — the user is looking at a builder, not a chat — but make the agents general and say so in the description field. Do not invent domain specifics you were not given.`;

export interface GenerateRequest {
  /** Overridable so a test does not have to wait three minutes. */
  timeoutMs?: number;
  description: string;
  cwd: string;
  executablePath: string;
  model: string;
  env: Record<string, string | undefined>;
  /** Existing ids, so a generated workflow cannot collide with one on disk. */
  taken: string[];
  signal?: AbortSignal;
}

export interface GenerateResult {
  ok: boolean;
  workflow?: Omit<Workflow, "id" | "createdAt" | "updatedAt" | "revision">;
  /** One line for the UI: what was built, or what went wrong. */
  note: string;
}

export interface RawAgent {
  id?: string;
  name?: string;
  role?: string;
  preset?: string;
  prompt?: string;
}

export interface RawWorkflow {
  name?: string;
  description?: string;
  entry?: string;
  agents?: RawAgent[];
  edges?: { from?: string; to?: string; kind?: string; label?: string }[];
}

/**
 * Designing a workflow is one call with no tools; three minutes is generous.
 * Without a ceiling a wedged subprocess leaves "Designing…" on the button
 * forever, with no way back except reloading the window.
 */
const GENERATE_TIMEOUT_MS = 180_000;

export async function generateWorkflow(request: GenerateRequest): Promise<GenerateResult> {
  const description = request.description.trim();
  if (description.length < 12) {
    return { ok: false, note: "Describe the pipeline in a sentence or two first." };
  }

  const abort = controllerFor(request.signal);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, request.timeoutMs ?? GENERATE_TIMEOUT_MS);

  let raw: RawWorkflow | undefined;
  try {
    const run = query({
      prompt: [
        "Design a workflow for this:",
        "",
        description,
        "",
        "Return the workflow.",
      ].join("\n"),
      options: {
        cwd: request.cwd,
        pathToClaudeCodeExecutable: request.executablePath,
        model: request.model,
        systemPrompt: SYSTEM,
        outputFormat: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
        // Designing a workflow needs no tools. Giving it any would let it wander
        // off reading the repository at the user's expense.
        tools: [],
        allowedTools: [],
        maxTurns: 1,
        permissionMode: "default",
        settingSources: [],
        persistSession: false,
        env: request.env,
        abortController: abort,
      },
    });

    for await (const message of run) {
      if (message.type === "result" && message.subtype === "success") {
        raw = (message.structured_output ?? undefined) as RawWorkflow | undefined;
        // Older CLIs return the JSON as text rather than a structured field.
        if (!raw && message.result) raw = parseDesign(message.result);
      }
    }
  } catch (err) {
    if (timedOut) {
      return { ok: false, note: "Gave up waiting for Claude Code. Nothing was built — try again, or start from a template." };
    }
    if (request.signal?.aborted) {
      return { ok: false, note: "Cancelled. Nothing was built." };
    }
    return { ok: false, note: `Could not build it: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    return { ok: false, note: "Gave up waiting for Claude Code. Nothing was built — try again, or start from a template." };
  }

  if (!raw?.agents?.length) {
    return { ok: false, note: "The design came back empty. Try describing the pipeline in more detail." };
  }

  return assemble(raw, request.taken);
}

/**
 * Turns the model's answer into a workflow that is guaranteed well-formed.
 *
 * Everything here is defensive on purpose. The schema constrains the shape but
 * not the sense: ids can collide, an edge can name an agent that was renamed
 * away, `entry` can point at nothing. A generated workflow that fails to open
 * is far worse than one that opens with a warning on it.
 */
/**
 * How many agents a generated design may carry into the builder. Every agent is
 * a real model run, so a design that asks for thirty is a bill, not a team.
 */
const MAX_GENERATED_AGENTS = 8;

export function assemble(raw: RawWorkflow, taken: string[]): GenerateResult {
  const used = new Set(taken);
  const remap = new Map<string, string>();

  // The model's output is the one input here nobody controls. The schema
  // usually shapes it, but a CLI without structured output falls back to
  // parsing free text, and this is the only thing between that and the UI —
  // so nothing here may assume a type it has not checked.
  const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const text = (value: unknown): string => (typeof value === "string" ? value : "");

  const proposed = list<unknown>(raw?.agents);
  const agents: AgentSpec[] = [];
  proposed.slice(0, MAX_GENERATED_AGENTS).forEach((entry, index) => {
    const agent = object(entry) as RawAgent;
    const name = text(agent.name).trim() || `Agent ${index + 1}`;
    const wanted = text(agent.id).trim() || name;
    const id = uniqueSlug(wanted, [...used, ...agents.map((a) => a.id)]);
    remap.set(wanted, id);
    remap.set(name, id);

    const presetName = text(agent.preset);
    const preset: Preset = (presetName && presetName in PRESETS ? presetName : "readonly") as Preset;
    agents.push({
      id,
      name,
      role: text(agent.role).trim(),
      prompt: text(agent.prompt).trim(),
      preset,
      // Laid out left to right in the order they were designed, which usually
      // matches the direction the work flows. The user drags from there.
      x: 60 + index * 290,
      y: 70 + (index % 2) * 170,
    });
  });

  const ids = new Set(agents.map((a) => a.id));
  const resolve = (ref?: string): string | undefined => {
    if (!ref) return undefined;
    if (ids.has(ref)) return ref;
    const mapped = remap.get(ref) ?? remap.get(ref.trim());
    return mapped && ids.has(mapped) ? mapped : undefined;
  };

  const rawEdges = raw?.edges;
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const raw of list<unknown>(rawEdges)) {
    const edge = object(raw) as { from?: string; to?: string; kind?: string; label?: string };
    const from = resolve(text(edge.from));
    const to = resolve(text(edge.to));
    if (!from || !to || from === to) continue;
    const kind = edge.kind === "then" ? "then" : "delegate";
    const key = `${kind}:${from}->${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, kind, ...(text(edge.label).trim() ? { label: text(edge.label).trim() } : {}) });
  }

  const entry = resolve(text(raw?.entry)) ?? agents[0]?.id ?? "";

  const workflow = {
    name: text(raw?.name).trim() || "New workflow",
    description: text(raw?.description).trim() || undefined,
    entry,
    agents,
    edges,
  };

  // Report what it produced honestly, including the parts that need attention.
  const problems = validate({
    ...workflow,
    id: "draft",
    createdAt: 0,
    updatedAt: 0,
    revision: 0,
  }).filter((p) => p.level === "error");

  const shape = `${agents.length} agent${agents.length === 1 ? "" : "s"}, ${edges.length} arrow${edges.length === 1 ? "" : "s"}`;
  // A design quietly shrunk from twelve to eight is a lie the user cannot see.
  const dropped = proposed.length - agents.length;
  const trimmed = dropped > 0
    ? ` It designed ${proposed.length}; the last ${dropped} ${dropped === 1 ? "was" : "were"} left out, because every agent is a paid model run — add them back if you want them.`
    : "";
  return {
    ok: true,
    workflow,
    note: problems.length
      ? `Built ${shape}, with ${problems.length} thing${problems.length === 1 ? "" : "s"} to fix — they are flagged below.${trimmed}`
      : `Built ${shape}. Read the prompts before you launch it.${trimmed}`,
  };
}

/**
 * A CLI that does not fill `structured_output` returns the JSON as text.
 *
 * Models explain themselves. There is a preamble, sometimes an illustrative
 * snippet before the real answer, often notes after it — so the first fenced
 * block is the wrong one about as often as it is the right one. Every
 * candidate is read and the one that looks like a design wins.
 */
export function parseDesign(text: string): RawWorkflow | undefined {
  const objects: Record<string, unknown>[] = [];
  for (const candidate of candidates(text)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not JSON. The next candidate might be.
    }
  }
  // A design has agents. An example the model wrote to explain itself is an
  // object too, which is exactly how the first-block rule picked the wrong one.
  // Falling back to the first object keeps a malformed design reaching the
  // assembler, which reports what is wrong with it far better than this can.
  return (objects.find((o) => Array.isArray(o.agents)) ?? objects[0]) as RawWorkflow | undefined;
}

/** Every substring of a reply that might be the design, best-first. */
function* candidates(text: string): Generator<string> {
  // Fenced blocks, in order, whatever the tag and whatever its case.
  const fence = /```[a-zA-Z0-9]*[^\S\n]*\n?([\s\S]*?)```/g;
  let block: RegExpExecArray | null;
  while ((block = fence.exec(text))) yield block[1].trim();

  // An opening fence whose closing one never arrived, because the reply was
  // cut off. The JSON before the cut is often complete even when the fence is
  // not.
  const unclosed = /```[a-zA-Z0-9]*[^\S\n]*\n?([\s\S]*)$/.exec(text);
  if (unclosed) yield unclosed[1].trim();

  // The whole reply, for a model that answered with nothing else.
  yield text.trim();

  // And the outermost braces, for one that talked around it. Last, so it is
  // only reached when nothing better parsed.
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open !== -1 && close > open) yield text.slice(open, close + 1);
}

function controllerFor(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (!signal) return controller;
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

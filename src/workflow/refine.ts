import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSpec, Workflow } from "./model";
import { agentById, delegatesTo, thenAfter } from "./model";
import { PRESETS } from "./presets";

/**
 * Turns a sentence into a system prompt.
 *
 * Most people write "you review contracts" and stop. That produces an agent
 * with no judgement about what matters, no idea what to refuse, and no sense of
 * what a good answer looks like — so it defaults to being agreeable, which is
 * the failure mode nobody notices until the work is wrong.
 *
 * This is on by default because the gap between a one-line prompt and a decent
 * one is most of the quality of the whole workflow, and because the user can
 * always read the result and disagree with it. It never invents the role: what
 * the user wrote is the specification, and refinement only makes explicit what
 * a good practitioner of that role would already know.
 */

const META_PROMPT = `You write system prompts for AI agents. You are given a rough description of one agent in a workflow, and you return the prompt that agent should run with.

What you are optimising for: the agent should behave like an experienced practitioner of that role who has been doing it for fifteen years — someone with taste about what matters, who pushes back when pushing back is right, and who knows what a bad job looks like from the inside.

Write the prompt in the second person, addressed to the agent. Structure it with a few short markdown sections. Somewhere between 200 and 600 words — long enough to carry real judgement, short enough that every line earns its place.

What a strong prompt contains, and a weak one does not:

- **What good work looks like in this role specifically.** Not "be helpful" — the concrete standard a practitioner would hold. What separates competent from excellent here.
- **The failure modes of this role.** What does someone doing this job badly actually do? Name it, so the agent can avoid it. This is usually the highest-value part.
- **What to do when the work is underspecified.** Every real task is. Say whether to decide and note the assumption, or stop and ask.
- **What NOT to do.** The boundary of the role, and the tempting-but-wrong move.
- **How to be honest about uncertainty.** What to say when it does not know, and what never to claim.

Hard rules:

- Do not invent a different role than the one described. You are sharpening what the user asked for, not replacing it.
- Do not write anything about the mechanics of delegation, brief formats, report formats, or which teammates exist. That is supplied separately and would be duplicated.
- Do not write preamble, meta-commentary, or "Here is the prompt". Return the prompt itself and nothing else.
- Do not use the agent's name as a heading or restate its title back at it.
- No emoji. No cheerleading. Write like the best documentation you have ever read: direct, specific, and assuming an intelligent reader.`;

export interface RefineRequest {
  /** Overridable so a test does not have to wait two minutes. */
  timeoutMs?: number;
  workflow: Workflow;
  agent: AgentSpec;
  cwd: string;
  executablePath: string;
  model: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export interface RefineResult {
  ok: boolean;
  prompt: string;
  /** One line for the UI about what was done, or what went wrong. */
  note: string;
}

/** Everything about the agent's place in the graph that should shape its prompt. */
function situate(workflow: Workflow, agent: AgentSpec): string {
  const lines: string[] = [
    `Workflow: ${workflow.name}`,
    `Agent name: ${agent.name}`,
  ];
  if (agent.role) lines.push(`One-line role: ${agent.role}`);

  const preset = PRESETS[agent.preset];
  if (preset) {
    lines.push(`Capabilities: ${preset.name} — ${preset.blurb}`);
  }
  if (workflow.entry === agent.id) {
    lines.push("This agent is the one the user talks to directly.");
  }

  const out = delegatesTo(workflow, agent.id)
    .map((e) => agentById(workflow, e.to)?.name ?? e.to);
  if (out.length) lines.push(`Can hand work to: ${out.join(", ")} (do not explain how — that is supplied separately)`);

  const incoming = workflow.edges
    .filter((e) => e.kind === "delegate" && e.to === agent.id)
    .map((e) => agentById(workflow, e.from)?.name ?? e.from);
  if (incoming.length) lines.push(`Receives work from: ${incoming.join(", ")}`);

  const after = thenAfter(workflow, agent.id).map((e) => agentById(workflow, e.to)?.name ?? e.to);
  if (after.length) lines.push(`Its output is passed automatically to: ${after.join(", ")}`);

  const others = workflow.agents.filter((a) => a.id !== agent.id).map((a) => `${a.name}${a.role ? ` (${a.role})` : ""}`);
  if (others.length) lines.push(`Other agents in the workflow, for context: ${others.join("; ")}`);

  return lines.join("\n");
}

/**
 * How long to wait before giving up on the CLI.
 *
 * One model call with no tools should take seconds. Without a ceiling a wedged
 * subprocess never returns, the promise never settles, and the button that said
 * "Refining…" says it until the window is reloaded.
 */
const REFINE_TIMEOUT_MS = 120_000;

export async function refinePrompt(request: RefineRequest): Promise<RefineResult> {
  const draft = (request.agent.rawPrompt || request.agent.prompt || "").trim();
  if (!draft) {
    return { ok: false, prompt: "", note: "Write a line or two about what this agent does first." };
  }

  const prompt = [
    "Here is the agent to write a prompt for.",
    "",
    situate(request.workflow, request.agent),
    "",
    "What the user wrote about it:",
    "---",
    draft,
    "---",
    "",
    "Return the system prompt for this agent, and nothing else.",
  ].join("\n");

  const abort = controllerFor(request.signal);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, request.timeoutMs ?? REFINE_TIMEOUT_MS);

  let text = "";
  try {
    const run = query({
      prompt,
      options: {
        cwd: request.cwd,
        pathToClaudeCodeExecutable: request.executablePath,
        model: request.model,
        systemPrompt: META_PROMPT,
        // Writing a prompt needs no tools, and giving it any would let it
        // wander off reading the repository at the user's expense.
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
      if (message.type === "result" && message.subtype === "success") text = message.result ?? "";
    }
  } catch (err) {
    if (timedOut) {
      return {
        ok: false,
        prompt: "",
        note: "Gave up waiting for Claude Code. Your prompt is unchanged — try again, or write it yourself.",
      };
    }
    if (request.signal?.aborted) {
      return { ok: false, prompt: "", note: "Refinement cancelled. Your prompt is unchanged." };
    }
    return {
      ok: false,
      prompt: "",
      note: `Could not refine: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    return {
      ok: false,
      prompt: "",
      note: "Gave up waiting for Claude Code. Your prompt is unchanged — try again, or write it yourself.",
    };
  }

  const cleaned = strip(text);
  if (!cleaned) return { ok: false, prompt: "", note: "The refinement came back empty. Your prompt is unchanged." };

  const words = cleaned.split(/\s+/).length;
  return {
    ok: true,
    prompt: cleaned,
    note: `Expanded to ${words} words. Read it — it is a proposal, not a decision.`,
  };
}

/**
 * Models like to wrap a returned document in a fence, or announce it first.
 *
 * What survives this becomes an agent's system prompt verbatim, so anything
 * left behind sits in front of that agent on every run it ever does. The fence
 * was matched only when it was the entire reply, which meant a single line of
 * chatter after the closing fence — or an announcement before the opening one
 * — left the ``` markers themselves in the prompt.
 */
export function strip(text: string): string {
  let out = text.trim();

  // A fence anywhere, and whatever the model chose to tag it.
  const fence = /```[a-zA-Z]*[^\S\n]*\n([\s\S]*?)```/.exec(out);
  if (fence) out = fence[1].trim();

  // An announcement that sat outside the fence. It has to actually name the
  // prompt: a real first line can open "Here's what good work looks like:",
  // and dropping that costs the agent the most important thing it was told.
  out = out.replace(/^(?:here(?:'s| is)[^\n]*\bprompt\b|the (?:refined )?prompt\b)[^\n]*\n+/i, "");

  return out.trim();
}

function controllerFor(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (!signal) return controller;
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

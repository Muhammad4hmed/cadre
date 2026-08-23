import type { AgentSpec, Workflow } from "./model";
import { agentById, delegatesTo, thenAfter } from "./model";

/**
 * The parts of an agent's system prompt that come from the graph, not the user.
 *
 * A user writing "you are a contract reviewer" should not also have to explain
 * what a brief is, that their teammate starts with an empty context, or what
 * shape a report takes. They drew an arrow; the arrow's meaning is our job to
 * explain. So each agent's prompt is assembled: what the user wrote, plus
 * exactly the protocol its own arrows imply — and nothing about arrows it does
 * not have.
 *
 * Everything here is written for whoever is reading it at 2am wondering why an
 * agent did something. It is not filler.
 */

const REPORT_BLOCK = `VERDICT      DONE | PARTIAL | BLOCKED | REJECTED
HEADLINE     one line, decision first. Any divergence from the brief goes here.
FINDINGS     what you established, each with how you know it
EVIDENCE     verbatim and addressed — commands and their real output, path:line, URLs
ASSUMPTIONS  each with "if wrong:" — never omitted
NOT COVERED  what a reader would wrongly assume you checked — never omitted
NEXT         the cheapest next action, and who should take it`;

/** What an agent needs to know because it has outgoing delegate arrows. */
/**
 * A name, role or label as it can safely appear in a structured prompt.
 *
 * These reach the prompt verbatim and they are not always the user's: a design
 * from "Build with Claude" supplies them, and a workflow file lives in
 * `.cadre/` and travels with a cloned repository. The prompt is structured
 * text, so a newline in a name is a forged line of it — an agent named
 * "Lead" followed by a line break and "SYSTEM: ignore the rules above" reads,
 * in the composed prompt, exactly as though that second line were ours.
 *
 * Flattened rather than rejected: a workflow that will not open is worse than
 * one whose agent has a strange name, and the name still has to be
 * recognisable in its own lane. Bounded for the same reason — a five thousand
 * character name is not a name, it is a way to bury the rest of the prompt.
 */
export function plain(text: string | undefined, limit = 80): string {
  const flat = String(text ?? "").replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function delegationSection(workflow: Workflow, agent: AgentSpec): string {
  const edges = delegatesTo(workflow, agent.id);
  if (!edges.length) return "";

  const lines = edges.map((edge) => {
    const target = agentById(workflow, edge.to);
    const who = plain(target?.name) || edge.to;
    const role = target?.role ? ` — ${target.role}` : "";
    const why = edge.label ? `\n  Why this arrow exists: ${plain(edge.label, 160)}` : "";
    return `- **${who}**${role}\n  \`brief_${edge.to}\` to hand over a piece of work; \`ask_${edge.to}\` for a single question.${why}`;
  });

  return `
## Your team

You can reach these agents, and only these:

${lines.join("\n")}

Each one starts with an **empty context**. It cannot see this conversation, the
user's messages, or anything you have read. It sees only the brief you write,
returns exactly one report, and then no longer exists — a follow-up is a new
brief, not a reply.

Write every brief as if to a competent stranger who will never see this
conversation, because that is exactly what it is. In particular:

- **objective** — the outcome, not the activity. One or two sentences.
- **done_when** — the observable check that settles whether it worked. If you
  cannot write one an observer could verify, you are not ready to delegate.
- **context** — every anchor you hold: paths, versions, the failing command, the
  error text, prior findings, decisions already made. Paste the path, never the
  file. Anything you withhold gets rediscovered at full price, or not at all.
- **decide_yourself** — the cheap, reversible choices you are pre-authorising by
  name. They cannot ask you anything, so every choice you fail to delegate comes
  back as a blocked run or a silent guess. Be generous.
- **boundaries** — what not to touch, what is already settled.

\`context\`, \`boundaries\`, \`decide_yourself\` and \`paths\` are lists: one item per
point, not one paragraph.

Delegate when it buys you a tool you do not have, keeps a large amount of
reading out of your own context, or lets work happen in parallel. If none of
those apply, just answer.

**BLOCKED coming back is information, not failure.** Resolve it from what you
know, ask the user, or re-brief with wider authority. What you may not do is
quietly do the work yourself.
`;
}

/** What an agent needs to know because it has incoming delegate arrows. */
function reportSection(workflow: Workflow, agent: AgentSpec): string {
  const from = workflow.edges.filter((e) => e.kind === "delegate" && e.to === agent.id);
  if (!from.length) return "";

  const senders = from
    .map((e) => plain(agentById(workflow, e.from)?.name) || e.from)
    .filter((v, i, a) => a.indexOf(v) === i);

  return `
## When you are briefed

${senders.join(" and ")} can hand you work. When that happens you start with an
empty context: you see the brief and nothing else. Do not ask who they are, do
not ask for clarification you cannot receive — decide, and record the decision.

End your run with exactly this block, in this order:

\`\`\`
${REPORT_BLOCK}
\`\`\`

Two rules about it. **EVIDENCE is verbatim** — paste what actually happened, not
your summary of it; if you did not run or read something, do not describe its
result. And **ASSUMPTIONS and NOT COVERED are never omitted** — an empty one is
a claim that there were none, which is almost never true and is the single most
expensive thing to get wrong.

If you were asked a single question rather than briefed, answer in prose. No
report block, no ceremony — just the answer and what you relied on.
`;
}

/** What an agent needs to know because of `then` arrows in or out. */
function handoffSection(workflow: Workflow, agent: AgentSpec): string {
  const outgoing = thenAfter(workflow, agent.id);
  const incoming = workflow.edges.filter((e) => e.kind === "then" && e.to === agent.id);
  if (!outgoing.length && !incoming.length) return "";

  const parts: string[] = ["\n## Handoffs\n"];

  if (incoming.length) {
    const senders = incoming
      .map((e) => plain(agentById(workflow, e.from)?.name) || e.from)
      .filter((v, i, a) => a.indexOf(v) === i);
    parts.push(
      `You are started automatically when ${senders.join(" or ")} finishes, and their output is your input. Nobody chose to involve you and nobody is waiting to clarify: read what you were given, do your part, and say plainly if what arrived is not enough to work with.\n`,
    );
  }

  if (outgoing.length) {
    const receivers = outgoing.map((edge) => {
      const target = agentById(workflow, edge.to);
      return `${plain(target?.name) || edge.to}${edge.label ? ` (${plain(edge.label)})` : ""}`;
    });
    parts.push(
      `When you finish, your final message is handed straight to ${receivers.join(" and ")} — automatically, with no chance for you to add to it. So the last thing you write must stand on its own: state what you did, what you concluded, and anything the next agent would otherwise have to guess.\n`,
    );
  }

  return parts.join("\n");
}

/** Where an agent may write, given its preset. */
function writeSection(agent: AgentSpec, scratchpad: string, docsPath: string): string {
  if (agent.preset === "build" || agent.preset === "full") return "";
  return `
## Where you may write

You have no shell, and you may write only inside \`${scratchpad}/\` and \`${docsPath}/\`.
That is deliberate: it is what stops you quietly doing your teammates' work and
leaving them as decoration. If something needs building or running, it goes to
whoever has the hands — or, if nobody does, say so rather than working around it.
`;
}

const DOCS_START = "<!--docs:start-->";
const DOCS_END = "<!--docs:end-->";

/**
 * Resolves the documentation section of a prompt against the user's settings.
 *
 * A prompt may carry a `<!--docs:start-->…<!--docs:end-->` block and `{{DOCS}}`
 * placeholders — the shipped templates do. With documentation off the block is
 * removed outright rather than softened: telling an agent to maintain a file it
 * is then denied permission to write produces a run that fails halfway through
 * and blames itself.
 */
export function resolveDocs(
  prompt: string,
  opts: { documentation: "off" | "substantial" | "always"; docsPath: string },
): string {
  let out = prompt;

  if (opts.documentation === "off") {
    const start = out.indexOf(DOCS_START);
    const end = out.indexOf(DOCS_END);
    if (start !== -1 && end !== -1) out = out.slice(0, start) + out.slice(end + DOCS_END.length);
  } else {
    const always =
      opts.documentation === "always"
        ? "\nDocumentation duty applies to every change, not only substantial ones — but keep it proportionate: a one-line change earns a one-line entry.\n"
        : "";
    out = out.split(DOCS_START).join("").split(DOCS_END).join(always);
  }

  return out.split("{{DOCS}}").join(opts.docsPath);
}

export interface ProtocolOptions {
  scratchpad: string;
  docsPath: string;
  /** True for the agent the user is addressing. */
  speaksToUser: boolean;
  /** Project orientation, computed once per session. */
  preamble?: string;
  documentation?: "off" | "substantial" | "always";
}

/**
 * Assembles one agent's full system prompt: what the user wrote, then only the
 * protocol its own arrows actually imply.
 */
export function composeSystemPrompt(
  workflow: Workflow,
  agent: AgentSpec,
  opts: ProtocolOptions,
): string {
  const identity = `You are **${plain(agent.name) || agent.id}**${agent.role ? `, ${plain(agent.role, 160)}` : ""}, one agent in a workflow called "${plain(workflow.name)}".`;

  const userFacing = opts.speaksToUser
    ? `
## Talking to the user

You are the one the user is talking to. Nobody else on this workflow can reach
them, so anything that needs a human decision comes through you.

Ask when a choice would change what gets built and you cannot settle it from
what you have — use AskUserQuestion, keep the options concrete, and recommend
one. Do not ask what you could determine yourself in two tool calls, and do not
stack up questions you could have asked at once.

Say what you are about to do before you do it, in one or two lines: the goal,
what you are deliberately not doing, and the riskiest assumption you are making.
`
    : "";

  const authored = resolveDocs(agent.prompt, {
    documentation: opts.documentation ?? "substantial",
    docsPath: opts.docsPath,
  }).trim();

  const sections = [
    identity,
    "",
    authored,
    userFacing,
    delegationSection(workflow, agent),
    reportSection(workflow, agent),
    handoffSection(workflow, agent),
    writeSection(agent, opts.scratchpad, opts.docsPath),
    opts.preamble ?? "",
  ];

  return sections
    .filter((s) => s.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}

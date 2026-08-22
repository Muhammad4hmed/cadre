import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { TeammateId } from "./events";
import leadPrompt from "./prompts/lead.md";
import researcherPrompt from "./prompts/researcher.md";
import engineerPrompt from "./prompts/engineer.md";

/** The in-process MCP server that carries the team's own tools. */
export const TEAM_SERVER = "team";
export const ns = (tool: string): string => `mcp__${TEAM_SERVER}__${tool}`;

/**
 * Tools that spawn work, schedule it, or run it somewhere the user cannot see.
 *
 * None are in any teammate's `tools` allowlist, so they should already be
 * unavailable — but each one can silently multiply what a run costs, and the
 * allowlist is one edit away from being widened. Blocked explicitly for every
 * teammate: the team's only fan-out is a brief, which is visible in a lane and
 * counted against the session's spend.
 */
export const NEVER_AVAILABLE = [
  "Agent",           // raw subagent spawn — briefs are the only delegation path
  "Task",            // legacy alias for Agent
  "Workflow",        // fans out many agents at once
  "CronCreate",      // schedules runs the user is not present for
  "CronDelete",
  "CronList",
  "ScheduleWakeup",  // re-invokes later, off-screen
  "RemoteTrigger",
  "Monitor",         // polls in the background
  "SendMessage",     // out-of-band messaging between live agents
] as const;

export interface TeammateSpec {
  id: TeammateId;
  name: string;
  role: string;
  prompt: string;
  /** Exact allowlist. Anything absent is unavailable, not merely discouraged. */
  tools: string[];
  disallowedTools: string[];
  model: string;
  effort: EffortLevel;
  maxTurns: number;
}

/**
 * The Lead has no shell and no editor outside `.cadre/`. That is deliberate:
 * a Lead holding Bash and Edit quietly does the work itself and the team
 * becomes theatre. `git_view` gives it enough sight to verify a report without
 * giving it hands.
 */
const LEAD: TeammateSpec = {
  id: "lead",
  name: "Lead",
  role: "Interrogates the brief, decides scope, delegates",
  prompt: leadPrompt,
  tools: [
    "Read", "Grep", "Glob", "Write", "Edit", "AskUserQuestion",
    ns("brief_researcher"), ns("brief_engineer"), ns("git_view"),
  ],
  disallowedTools: [...NEVER_AVAILABLE, "Bash", "NotebookEdit", "WebSearch", "WebFetch", "TodoWrite"],
  model: "opus",
  effort: "high",
  maxTurns: 60,
};

const RESEARCHER: TeammateSpec = {
  id: "researcher",
  name: "Researcher",
  role: "Reads papers, docs and the web; reports findings",
  prompt: researcherPrompt,
  tools: ["WebSearch", "WebFetch", "Read", "Grep", "Glob", "Write", ns("ask_engineer"), ns("paper")],
  disallowedTools: [...NEVER_AVAILABLE, "Edit", "Bash", "AskUserQuestion"],
  model: "opus",
  effort: "high",
  maxTurns: 30,
};

const ENGINEER: TeammateSpec = {
  id: "engineer",
  name: "Engineer",
  role: "Writes, edits and runs the code",
  prompt: engineerPrompt,
  tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", ns("ask_researcher")],
  disallowedTools: [...NEVER_AVAILABLE, "WebSearch", "WebFetch", "AskUserQuestion"],
  model: "opus",
  effort: "xhigh",
  maxTurns: 60,
};

export const ROSTER: Record<TeammateId, TeammateSpec> = {
  lead: LEAD,
  researcher: RESEARCHER,
  engineer: ENGINEER,
};

/**
 * A peer answering a consult gets a variant with the peer tool and the brief
 * tools removed. Depth is bounded by capability, not by a counter: A→B→A is
 * not refused at runtime, it cannot be expressed.
 */
export function consultVariant(spec: TeammateSpec): TeammateSpec {
  const peerTools = [ns("ask_engineer"), ns("ask_researcher"), ns("brief_engineer"), ns("brief_researcher")];
  // Removing the capability is what bounds consult depth: A -> B -> A is not
  // refused at runtime, it cannot be expressed.
  return {
    ...spec,
    tools: spec.tools.filter((t) => !peerTools.includes(t)),
    disallowedTools: [...new Set([...spec.disallowedTools, ...peerTools])],
    maxTurns: 12,
  };
}

const DOCS_START = "<!--docs:start-->";
const DOCS_END = "<!--docs:end-->";

/**
 * Resolves the documentation section of a prompt against the user's settings:
 * substitutes the configured docs path, and removes the section entirely when
 * documentation is off — so a teammate is never told to maintain a file it has
 * no permission to write.
 */
export function composePrompt(
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

  return out.split("{{DOCS}}").join(opts.docsPath).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * Lets the model write `brief_researcher` — as the prompts do — and still reach
 * the namespaced MCP tool.
 */
export function toolAliases(): Record<string, string> {
  const short = ["brief_researcher", "brief_engineer", "ask_researcher", "ask_engineer", "git_view", "paper"];
  return Object.fromEntries(short.map((name) => [name, ns(name)]));
}

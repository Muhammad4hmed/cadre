import type { AgentSpec, Preset, Workflow } from "./model";
import { delegatesTo } from "./model";

/** The in-process MCP server carrying the workflow's own tools. */
export const TEAM_SERVER = "team";
export const ns = (tool: string): string => `mcp__${TEAM_SERVER}__${tool}`;

/**
 * Tools that spawn work, schedule it, or run it somewhere the user cannot see.
 *
 * Denied to every agent in every workflow, at every autonomy level, whatever
 * the user ticks in the advanced panel. A workflow's only fan-out is an arrow:
 * visible in a lane, attributed, and counted against the session's spend.
 */
export const NEVER_AVAILABLE = [
  "Agent",           // raw subagent spawn — arrows are the only delegation path
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

export interface PresetInfo {
  id: Preset;
  name: string;
  blurb: string;
  tools: string[];
  /** On top of NEVER_AVAILABLE. */
  denies: string[];
  /** Whether this agent may write anywhere, or only to the scratchpad and docs. */
  writesFreely: boolean;
  effort: string;
  maxTurns: number;
}

/**
 * Four presets, because the interesting distinctions are few.
 *
 * The one that matters is `writesFreely`. An agent that can quietly do the work
 * itself will, and then its teammates are theatre — so a coordinator or a
 * researcher gets sight and a scratchpad, and only a builder gets hands.
 */
export const PRESETS: Record<Preset, PresetInfo> = {
  readonly: {
    id: "readonly",
    name: "Read-only",
    blurb: "Reads the project and delegates. No shell, no editing outside its own notes.",
    tools: ["Read", "Grep", "Glob", "Write", "Edit", ns("git_view")],
    denies: ["Bash", "NotebookEdit", "WebSearch", "WebFetch", "TodoWrite"],
    writesFreely: false,
    effort: "high",
    maxTurns: 60,
  },
  research: {
    id: "research",
    name: "Research",
    blurb: "Web search and fetch, plus read-only project access. Writes reports, not code.",
    tools: ["WebSearch", "WebFetch", "Read", "Grep", "Glob", "Write", ns("git_view")],
    denies: ["Edit", "Bash", "NotebookEdit"],
    writesFreely: false,
    effort: "high",
    maxTurns: 30,
  },
  build: {
    id: "build",
    name: "Build",
    blurb: "Files and a shell. This is the one that actually changes things.",
    tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "NotebookEdit", "TodoWrite", ns("git_view")],
    denies: ["WebSearch", "WebFetch"],
    writesFreely: true,
    effort: "xhigh",
    maxTurns: 60,
  },
  full: {
    id: "full",
    name: "Everything",
    blurb: "Every tool at once. Convenient, and the least likely to keep its lane.",
    tools: [
      "Read", "Write", "Edit", "Bash", "Grep", "Glob", "NotebookEdit", "TodoWrite",
      "WebSearch", "WebFetch", ns("git_view"),
    ],
    denies: [],
    writesFreely: true,
    effort: "high",
    maxTurns: 60,
  },
};

export const PRESET_LIST: PresetInfo[] = [PRESETS.readonly, PRESETS.research, PRESETS.build, PRESETS.full];

/** Every tool a user may pick in the advanced panel, grouped for the UI. */
export const TOOL_CATALOGUE: { group: string; tools: { name: string; blurb: string }[] }[] = [
  {
    group: "Reading",
    tools: [
      { name: "Read", blurb: "Open a file" },
      { name: "Grep", blurb: "Search file contents" },
      { name: "Glob", blurb: "Find files by name" },
      { name: ns("git_view"), blurb: "Status, diff and show — read-only git" },
    ],
  },
  {
    group: "Writing",
    tools: [
      { name: "Write", blurb: "Create a file" },
      { name: "Edit", blurb: "Change a file" },
      { name: "NotebookEdit", blurb: "Change a Jupyter notebook" },
    ],
  },
  {
    group: "Running",
    tools: [{ name: "Bash", blurb: "Run shell commands" }],
  },
  {
    group: "Outside world",
    tools: [
      { name: "WebSearch", blurb: "Search the web" },
      { name: "WebFetch", blurb: "Fetch a URL" },
    ],
  },
  {
    group: "Other",
    tools: [
      { name: "TodoWrite", blurb: "Keep a task list" },
      { name: ns("paper"), blurb: "Compile a LaTeX paper and check its claims" },
    ],
  },
];

export interface ResolvedAgent {
  id: string;
  name: string;
  role: string;
  prompt: string;
  tools: string[];
  disallowedTools: string[];
  model: string;
  effort: string;
  maxTurns: number;
  writesFreely: boolean;
  skills?: string[];
  connectors?: string[];
}

/**
 * Turns a spec plus the graph around it into what the SDK needs.
 *
 * The delegate tools are derived from the arrows rather than stored, so an
 * agent's capabilities can never drift out of step with the picture the user
 * drew: delete the arrow and the tool is gone on the next run.
 */
export function resolveAgent(
  workflow: Workflow,
  agent: AgentSpec,
  opts: {
    defaultModel: string;
    /** True for the agent the user is addressing: only it may ask questions. */
    speaksToUser: boolean;
    /** Nested runs lose their own delegate tools once the depth cap is reached. */
    mayDelegate?: boolean;
  },
): ResolvedAgent {
  const preset = PRESETS[agent.preset] ?? PRESETS.readonly;
  const defaults = workflow.defaults ?? {};
  const base = agent.tools ?? preset.tools;

  const delegateTools = (opts.mayDelegate ?? true)
    ? delegatesTo(workflow, agent.id).flatMap((edge) => [ns(`brief_${edge.to}`), ns(`ask_${edge.to}`)])
    : [];

  const tools = [...new Set([...base, ...delegateTools, ...(opts.speaksToUser ? ["AskUserQuestion"] : [])])];

  // Three tiers, and the order matters.
  //
  // A preset's denies are a default: listing the tool explicitly in the
  // advanced panel is a deliberate override and wins. The user's own denies
  // beat their own allows, because an explicit "no" is the stronger statement.
  // NEVER_AVAILABLE beats everything and is not negotiable from configuration
  // — otherwise one tick in the advanced panel hands an agent the ability to
  // fan out work off-screen, which is the property the whole design rests on.
  const softDenied = new Set(preset.denies);
  for (const tool of base) softDenied.delete(tool);

  const denied = new Set<string>([
    ...NEVER_AVAILABLE,
    ...softDenied,
    ...(agent.disallowedTools ?? []),
  ]);
  if (!opts.speaksToUser) denied.add("AskUserQuestion");

  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    prompt: agent.prompt,
    tools: tools.filter((t) => !denied.has(t)),
    disallowedTools: [...denied],
    // Narrowest wins: the agent, then the workflow, then the workspace. Effort
    // falls back to the preset rather than the workspace, because a preset's
    // effort is chosen to suit the kind of work it describes.
    model: agent.model || defaults.model || opts.defaultModel,
    effort: agent.effort || defaults.effort || preset.effort,
    maxTurns: agent.maxTurns ?? defaults.maxTurns ?? preset.maxTurns,
    writesFreely: preset.writesFreely,
    skills: agent.skills ?? defaults.skills,
    connectors: agent.connectors ?? defaults.connectors,
  };
}

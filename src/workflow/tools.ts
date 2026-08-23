import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as z from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { AgentId, Workflow } from "./model";
import { agentById, delegatesTo } from "./model";
import { TEAM_SERVER } from "./presets";
import { buildPaper, checkClaims } from "../paper";
import { PROTECTED_EXCLUDES, isProtectedPath } from "../policy";

const run = promisify(execFile);

/**
 * A list the model may send either as an array or as a string.
 *
 * The schema says `array of string` plainly, and the model still sends
 * `"[\"a\",\"b\"]"` — or plain prose — often enough that every brief in a real
 * session was rejected with "expected array, received string". The model cannot
 * see the validation error until the call has already failed, and a rejected
 * brief costs a whole turn, so the tool accepts both shapes and normalises.
 */
const stringList = (
  description: string,
  { atLeastOne = false, optional = false }: { atLeastOne?: boolean; optional?: boolean } = {},
) => {
  const union = z.union([
    atLeastOne ? z.array(z.string()).min(1) : z.array(z.string()),
    atLeastOne ? z.string().min(1) : z.string(),
  ]);
  // .describe() must come LAST. Describing the union and then wrapping it in
  // .optional() drops the description from the JSON Schema the model receives,
  // silently — the field still validates, the model just stops being told what
  // it is for. Verified against the real MCP server in scripts/verify-mcp.mjs.
  return (optional ? union.optional() : union).describe(description);
};

/** Normalises whatever arrived into a list of non-empty lines. */
export function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  const text = value.trim();
  if (!text) return [];

  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {
      // Not JSON after all — fall through and treat it as prose.
    }
  }

  // Prose: split on lines and bullets, which are unambiguous. Deliberately not
  // on semicolons or commas — those occur inside a single item too often, and
  // shredding one coherent instruction into fragments is worse than keeping it.
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  return lines.length > 1 ? lines : [text];
}

const BRIEF_FIELDS = {
  objective: z.string().describe("What outcome you want, in one or two sentences."),
  done_when: z
    .string()
    .min(1)
    .describe("The observable check that settles whether this succeeded. If you cannot write one an observer could verify, you are not ready to delegate."),
  context: stringList(
    "Facts and addresses they need and cannot see: paths, prior findings, decisions already made, the failing command. They start with an empty context.",
    { optional: true },
  ),
  decide_yourself: stringList(
    "Choices you are delegating, by name. At least one — a brief that decides everything is you doing the work through someone else.",
    { atLeastOne: true },
  ),
  boundaries: stringList("What must not change or must not be done.", { optional: true }),
  budget: z.string().optional().describe("Effort ceiling, e.g. 'one consult allowed', 'stop after 3 failed attempts'."),
  authority: z
    .enum(["EXPLORE", "PATCH", "BUILD"])
    .optional()
    .describe("EXPLORE: read and run, change nothing. PATCH: modify the named paths. BUILD: create new files."),
  paths: stringList("Files they may touch. Omit for EXPLORE.", { optional: true }),
  deliver: z.string().optional().describe("Anything beyond the standard report block."),
};

const CONSULT_FIELDS = {
  question: z.string().describe("One specific question. If you are asking them to figure something out, that is a brief, not a question."),
  why: z.string().describe("What you will do differently depending on the answer."),
};

export interface WorkflowToolContext {
  /**
   * Runs one agent to completion and returns its report. The runner supplies
   * this so the tools stay free of query() plumbing and every nested run is
   * attributed to the right lane.
   */
  runAgent(args: {
    who: AgentId;
    kind: "brief" | "consult";
    id: string;
    prompt: string;
    from: AgentId;
    headline: string;
  }): Promise<string>;
  cwd: string;
  signal: AbortSignal;
  workflow: Workflow;
}

function makeCounter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(2, "0")}`;
}

function renderBrief(id: string, cwd: string, fields: Record<string, unknown>): string {
  const lines: string[] = [`BRIEF ${id}`, `WORKING DIRECTORY: ${cwd}`];
  const put = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    lines.push(`${label}: ${value}`);
  };
  const putList = (label: string, value: unknown) => {
    const items = toList(value);
    if (!items.length) return;
    lines.push(`${label}:`);
    for (const item of items) lines.push(`  - ${item}`);
  };
  put("OBJECTIVE", fields.objective);
  put("DONE WHEN", fields.done_when);
  put("AUTHORITY", fields.authority);
  putList("PATHS", fields.paths);
  putList("CONTEXT", fields.context);
  putList("DECIDE YOURSELF", fields.decide_yourself);
  putList("BOUNDARIES", fields.boundaries);
  put("BUDGET", fields.budget);
  put("DELIVER", fields.deliver);
  return lines.join("\n");
}

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

/**
 * The tools one agent gets, derived from its outgoing arrows.
 *
 * Every agent gets its own server instance, because the delegate tools differ
 * per agent: what you can reach is exactly what you have an arrow to. Deleting
 * an arrow removes the tool on the next run, with nothing to keep in sync.
 *
 * Delegation deliberately does NOT use the SDK's Agent tool. Running each agent
 * as a nested query we own means every streamed message is already attributed
 * to a known lane, rather than inferred from parent_tool_use_id.
 */
export function createWorkflowServer(
  ctx: WorkflowToolContext,
  forAgent: AgentId,
): McpSdkServerConfigWithInstance {
  const tools = [];
  const counters = new Map<AgentId, () => string>();

  for (const edge of delegatesTo(ctx.workflow, forAgent)) {
    const target = agentById(ctx.workflow, edge.to);
    if (!target) continue;

    const prefix = target.name.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "AG";
    if (!counters.has(target.id)) counters.set(target.id, makeCounter(prefix));
    const nextId = counters.get(target.id)!;

    const role = target.role ? ` ${target.role}.` : "";
    const why = edge.label ? ` Use it for: ${edge.label}.` : "";

    tools.push(
      tool(
        `brief_${target.id}`,
        `Delegate a piece of work to ${target.name}.${role}${why} They start with an empty context, see only this brief, return exactly one report, and then cease to exist.`,
        BRIEF_FIELDS,
        async (args) => {
          const id = nextId();
          return text(
            await ctx.runAgent({
              who: target.id,
              kind: "brief",
              id,
              from: forAgent,
              headline: String(args.objective),
              prompt: renderBrief(id, ctx.cwd, args as Record<string, unknown>),
            }),
          );
        },
      ),
    );

    tools.push(
      tool(
        `ask_${target.id}`,
        `Ask ${target.name} one specific question.${role} Returns prose, not a report. Cheaper than a brief; use it when you need an answer rather than a piece of work.`,
        CONSULT_FIELDS,
        async (args) => {
          const id = `consult-${nextId()}`;
          return text(
            await ctx.runAgent({
              who: target.id,
              kind: "consult",
              id,
              from: forAgent,
              headline: String(args.question),
              prompt: `${agentById(ctx.workflow, forAgent)?.name ?? forAgent} asks:\n\n${args.question}\n\nWhy they need it: ${args.why}\n\nAnswer in prose. Be brief, and say what you relied on. No report block.`,
            }),
          );
        },
      ),
    );
  }

  /**
   * Sight of the working tree without a shell. Not a shell: the subcommand is
   * an enum and arguments go to git as an argv array, so there is nowhere for
   * `-exec`, a pipeline or a backtick to land.
   */
  tools.push(
    tool(
      "git_view",
      "Look at the working tree. 'status' for what changed, 'stat' for a diff summary, 'diff' for the full patch, 'show' for one file's committed contents. Read-only.",
      {
        subcommand: z
          .enum(["status", "stat", "diff", "show"])
          .describe("status: what changed. stat: a diff summary. diff: the full patch. show: one file as committed."),
        paths: stringList("Optional paths to scope to. Required for 'show'.", { optional: true }),
      },
      async (args) => {
        const paths = toList(args.paths).filter((p) => !p.startsWith("-"));

        // The Read tool's deny rules do not reach git. Without this, `show`
        // prints a secret the same agent is forbidden to open directly.
        const blocked = paths.filter(isProtectedPath);
        if (blocked.length) {
          return text(
            `Refused: ${blocked.join(", ")} — credentials and keys are never readable, ` +
              "by any agent, at any autonomy level. Ask the user for what you need instead.",
          );
        }

        let argv: string[];
        switch (args.subcommand) {
          case "status": argv = ["status", "--short", "--branch"]; break;
          // A diff of a protected file leaks it just as surely as reading it,
          // so those paths are excluded from the pathspec rather than trusted
          // not to have changed.
          case "stat": argv = ["diff", "--stat", "--", ...(paths.length ? paths : ["."]), ...PROTECTED_EXCLUDES]; break;
          case "diff": argv = ["diff", "--", ...(paths.length ? paths : ["."]), ...PROTECTED_EXCLUDES]; break;
          case "show":
            if (!paths.length) return text("show needs a path.");
            argv = ["show", `HEAD:${paths[0]}`];
            break;
        }
        try {
          const { stdout } = await run("git", argv, {
            cwd: ctx.cwd,
            signal: ctx.signal,
            maxBuffer: 4_000_000,
            timeout: 20_000,
          });
          const out = stdout.trim();
          if (!out) return text("(no output — nothing matched)");
          const lines = out.split("\n");
          return text(
            lines.length > 600
              ? `${lines.slice(0, 600).join("\n")}\n… ${lines.length - 600} more lines. Scope with paths.`
              : out,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return text(`git ${argv.join(" ")} failed: ${message}`);
        }
      },
    ),
  );

  /**
   * Compiling a paper needs a shell an agent may not have. This is the narrow
   * capability that closes the gap: compile and verify only, nothing arbitrary.
   */
  tools.push(
    tool(
      "paper",
      "Compile the LaTeX paper, or check its claims ledger. 'build' returns the first LaTeX error. 'check' verifies that every \\claim{} in main.tex is declared in claims.json and that each declared claim's quoted evidence actually exists.",
      {
        action: z
          .enum(["build", "check"])
          .describe("build: compile main.tex to PDF. check: verify every claim against its declared evidence."),
        dir: z.string().optional().describe("Paper directory, relative to the workspace. Defaults to docs/paper."),
      },
      async (args) => {
        const dir = path.resolve(ctx.cwd, String(args.dir ?? "docs/paper"));
        // Not a bare prefix test: with the workspace at /home/me/proj, the
        // sibling /home/me/proj-evil starts with it and would have passed. This
        // tool takes a directory, so it is the one place a team tool can be
        // aimed somewhere, and `check` reports whether a quoted line is present
        // in a file — escaping reads, not only writes.
        const root = path.resolve(ctx.cwd);
        if (dir !== root && !dir.startsWith(root + path.sep)) {
          return text("The paper must live inside the workspace.");
        }

        if (args.action === "check") {
          const result = checkClaims(dir, ctx.cwd);
          const lines = result.verdicts.filter((v) => !v.ok).map((v) => `  ✗ ${v.id}: ${v.reason}`);
          return text(
            `${result.summary}\n${lines.join("\n")}\n\n` +
              (result.ok
                ? "Every claim traces to evidence that exists. This does not prove a source supports the sentence — read each one."
                : "Fix these before the paper is finished. A claim you cannot support must be removed, not softened."),
          );
        }

        const built = await buildPaper(dir);
        return text(built.ok ? `${built.detail} PDF at ${built.pdf}` : built.detail);
      },
    ),
  );

  return createSdkMcpServer({
    name: TEAM_SERVER,
    version: "2.0.0",
    instructions:
      "Tools for running your workflow. A brief goes to an agent who starts with an empty context and returns exactly one report.",
    tools,
  });
}

/** Lets the model write `brief_researcher` and still reach the namespaced tool. */
export function toolAliases(workflow: Workflow, forAgent: AgentId): Record<string, string> {
  const names = ["git_view", "paper"];
  for (const edge of delegatesTo(workflow, forAgent)) {
    names.push(`brief_${edge.to}`, `ask_${edge.to}`);
  }
  return Object.fromEntries(names.map((name) => [name, `mcp__${TEAM_SERVER}__${name}`]));
}

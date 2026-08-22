import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as z from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { TeammateId } from "./events";
import { TEAM_SERVER } from "./roster";
import { buildPaper, checkClaims } from "../paper";

const run = promisify(execFile);

/** What a brief carries. Prose lives inside the fields; the schema enforces presence. */
const BRIEF_FIELDS = {
  objective: z.string().describe("What outcome you want, in one or two sentences."),
  done_when: z
    .string()
    .min(1)
    .describe("The observable check that settles whether this succeeded. If you cannot write one an observer could verify, you are not ready to delegate."),
  context: z
    .array(z.string())
    .default([])
    .describe("Facts and addresses the teammate needs and cannot see: path:line, prior findings, decisions already made. They start with an empty context."),
  decide_yourself: z
    .array(z.string())
    .min(1)
    .describe("Choices explicitly delegated. At least one — a brief that decides everything is you doing the work through someone else."),
  boundaries: z.array(z.string()).optional().describe("What must not change or must not be done."),
  budget: z.string().optional().describe("Effort ceiling, e.g. 'one peer consult allowed', 'stop after 3 failed attempts'."),
  deliver: z.string().optional().describe("Anything beyond the standard report block."),
};

export interface TeamToolContext {
  /**
   * Runs one teammate to completion and returns its report text. The
   * orchestrator supplies this so the tools stay free of query() plumbing and
   * every nested run is attributed to the right lane.
   */
  runTeammate(args: {
    who: TeammateId;
    /** `brief` renders an assignment card; `consult` is a lighter question. */
    kind: "brief" | "consult";
    id: string;
    prompt: string;
    from: TeammateId;
    headline: string;
  }): Promise<string>;
  cwd: string;
  signal: AbortSignal;
}

/** Sequential ids so a report can be cross-referenced from the spec's ledger. */
function makeCounter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(2, "0")}`;
}

function renderBrief(id: string, cwd: string, fields: Record<string, unknown>): string {
  const lines: string[] = [`BRIEF ${id}`, `WORKING DIRECTORY: ${cwd}`];
  const put = (label: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (!value.length) return;
      lines.push(`${label}:`);
      for (const item of value) lines.push(`  - ${item}`);
      return;
    }
    lines.push(`${label}: ${value}`);
  };
  put("OBJECTIVE", fields.objective);
  put("DONE WHEN", fields.done_when);
  put("AUTHORITY", fields.authority);
  put("PATHS", fields.paths);
  put("CONTEXT", fields.context);
  put("DECIDE YOURSELF", fields.decide_yourself);
  put("BOUNDARIES", fields.boundaries);
  put("BUDGET", fields.budget);
  put("DELIVER", fields.deliver);
  return lines.join("\n");
}

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

/**
 * The team's own tools, served in-process.
 *
 * Delegation deliberately does NOT use the SDK's Task tool. Running each
 * teammate as a nested query() we own means every streamed message is already
 * attributed to a known teammate, so the UI never has to infer who was
 * speaking from parent_tool_use_id.
 */
export function createTeamServer(ctx: TeamToolContext): McpSdkServerConfigWithInstance {
  const nextResearch = makeCounter("R");
  const nextEngineering = makeCounter("E");

  const briefResearcher = tool(
    "brief_researcher",
    "Delegate a question to the Researcher, who has web search and fetch. They start with an empty context, see only this brief, return exactly one report, and then cease to exist. Use for anything whose answer lives outside the repository.",
    BRIEF_FIELDS,
    async (args) => {
      const id = nextResearch();
      return text(
        await ctx.runTeammate({
          who: "researcher",
          kind: "brief",
          id,
          from: "lead",
          headline: String(args.objective),
          prompt: renderBrief(id, ctx.cwd, args as Record<string, unknown>),
        }),
      );
    },
  );

  const briefEngineer = tool(
    "brief_engineer",
    "Delegate work to the Engineer, who has file editing and a shell. They start with an empty context, see only this brief, return exactly one report, and then cease to exist. Every file change goes through them — you have no editor outside .cadre/.",
    {
      ...BRIEF_FIELDS,
      authority: z
        .enum(["EXPLORE", "PATCH", "BUILD"])
        .describe("EXPLORE: read and run, change nothing. PATCH: modify the named paths. BUILD: create new files."),
      paths: z.array(z.string()).describe("Files the Engineer may touch. Empty for EXPLORE."),
    },
    async (args) => {
      const id = nextEngineering();
      return text(
        await ctx.runTeammate({
          who: "engineer",
          kind: "brief",
          id,
          from: "lead",
          headline: String(args.objective),
          prompt: renderBrief(id, ctx.cwd, args as Record<string, unknown>),
        }),
      );
    },
  );

  /** Peer consults: a question, never a handoff. The peer runs without peer tools. */
  const consultFields = {
    question: z.string().describe("One specific question. If you are asking someone to figure something out, that is a mis-scoped brief, not a consult."),
    why: z.string().describe("What you will do differently depending on the answer."),
  };

  const askResearcher = tool(
    "ask_researcher",
    "Ask the Researcher one question about the outside world — library behaviour, version differences, whether an API is deprecated. Returns plain prose, not a report. Never use it for something a command would settle: running it is cheaper and the result is stronger.",
    consultFields,
    async (args) => {
      return text(
        await ctx.runTeammate({
          who: "researcher",
          kind: "consult",
          id: `consult-${nextResearch()}`,
          from: "engineer",
          headline: String(args.question),
          prompt: `A teammate asks:\n\n${args.question}\n\nWhy they need it: ${args.why}\n\nAnswer in prose. Be brief and cite what you relied on. No report block.`,
        }),
      );
    },
  );

  const askEngineer = tool(
    "ask_engineer",
    "Ask the Engineer one question that only running something settles — does this reproduce, what does this actually print, does this build. Returns plain prose, not a report.",
    consultFields,
    async (args) => {
      return text(
        await ctx.runTeammate({
          who: "engineer",
          kind: "consult",
          id: `consult-${nextEngineering()}`,
          from: "researcher",
          headline: String(args.question),
          prompt: `A teammate asks:\n\n${args.question}\n\nWhy they need it: ${args.why}\n\nFind out and answer in prose. Paste the command and its real output. No report block.`,
        }),
      );
    },
  );

  /**
   * The Lead's eyes on the working tree. Not a shell: the subcommand is an enum
   * and arguments go to git as an argv array, so there is no place for `-exec`,
   * a pipeline, or a backtick to land.
   */
  const gitView = tool(
    "git_view",
    "Look at the working tree. 'status' for what changed, 'stat' for a diff summary, 'diff' for the full patch, 'show' for one file's committed contents. Read-only.",
    {
      subcommand: z.enum(["status", "stat", "diff", "show"]),
      paths: z.array(z.string()).default([]).describe("Optional paths to scope to. Required for 'show'."),
    },
    async (args) => {
      const paths = (args.paths ?? []).filter((p) => typeof p === "string" && !p.startsWith("-"));
      let argv: string[];
      switch (args.subcommand) {
        case "status": argv = ["status", "--short", "--branch"]; break;
        case "stat": argv = ["diff", "--stat", ...(paths.length ? ["--", ...paths] : [])]; break;
        case "diff": argv = ["diff", ...(paths.length ? ["--", ...paths] : [])]; break;
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
            ? `${lines.slice(0, 600).join("\n")}\n… ${lines.length - 600} more lines. Scope with paths, or send a verify ticket instead of reading it all.`
            : out,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return text(`git ${argv.join(" ")} failed: ${message}`);
      }
    },
  );

  /**
   * The Researcher has no shell, but it cannot finish a paper it cannot compile
   * or check. This is the narrow capability that closes that gap — compile and
   * verify only, no arbitrary execution, same shape as `git_view`.
   */
  const paper = tool(
    "paper",
    "Compile the LaTeX paper, or check its claims ledger. 'build' returns the first LaTeX error so you can fix it. 'check' verifies that every \\claim{} in main.tex is declared in claims.json and that each declared claim's quoted evidence actually exists in the file it names.",
    {
      action: z.enum(["build", "check"]),
      dir: z
        .string()
        .default("docs/paper")
        .describe("Paper directory, relative to the workspace."),
    },
    async (args) => {
      const dir = path.resolve(ctx.cwd, String(args.dir ?? "docs/paper"));
      if (!dir.startsWith(ctx.cwd)) return text("The paper must live inside the workspace.");

      if (args.action === "check") {
        const result = checkClaims(dir, ctx.cwd);
        const lines = result.verdicts
          .filter((v) => !v.ok)
          .map((v) => `  ✗ ${v.id}: ${v.reason}`);
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
  );

  return createSdkMcpServer({
    name: TEAM_SERVER,
    version: "1.0.0",
    instructions:
      "Tools for running your team. Briefs go to a teammate who starts with an empty context and returns exactly one report.",
    tools: [briefResearcher, briefEngineer, askResearcher, askEngineer, gitView, paper],
  });
}

/**
 * How a tool call is labelled in a lane.
 *
 * Pure, and deliberately kept out of the orchestrator: the transcript replay
 * needs the same labels, and must be runnable outside the extension host so it
 * can be checked against a real stored session.
 */

/** Namespace the SDK gives our in-process server's tools. */
export const TEAM_PREFIX = "mcp__team__";

export function shortToolName(name: string): string {
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

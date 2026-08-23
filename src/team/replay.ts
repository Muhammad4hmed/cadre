import { describeTool } from "./describe";
import type { TeamEvent } from "./events";

/**
 * Turning a stored session back into what you saw.
 *
 * The CLI restores the model's memory on resume either way; this restores the
 * user's. It is a pure function of the stored messages so it can be run against
 * a real transcript outside VS Code — see scripts/probe-replay.mjs.
 */

/** Enough for a long session; a transcript longer than this is trimmed at the front. */
export const REPLAY_LIMIT = 400;

export interface SessionMessage {
  type: "user" | "assistant" | "system";
  parent_tool_use_id: string | null;
  message?: unknown;
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

/** A tool_result's content is a string or a block array of its own. */
function flattenResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b as Block)?.text ?? "").join("").trim();
}

const firstLine = (body: string): string => body.split("\n").find((l) => l.trim())?.trim().slice(0, 160) ?? "";

/**
 * The CLI writes its own markers into the user role — an interruption is not
 * something the user typed, and replaying it as a chat bubble is a small lie.
 */
const CLI_MARKER = /^\[[^\]\n]{0,120}\]$/;

/** What a declined permission prompt leaves behind in the tool result. */
const DECLINED = /don't want to proceed|doesn't want to proceed|tool use was rejected|user doesn't want to take this action/i;

/** A report leads with VERDICT; anything else came back malformed or errored. */
function verdictOf(report: string, failed: boolean): "delivered" | "blocked" | "failed" {
  if (DECLINED.test(report)) return "blocked";
  if (failed) return "failed";
  const verdict = /^\s*VERDICT[:\s]+(\w+)/im.exec(report)?.[1]?.toUpperCase();
  if (verdict === "BLOCKED" || verdict === "REJECTED") return "blocked";
  return verdict ? "delivered" : "failed";
}

/** The report's own HEADLINE if it wrote one, else its first line. */
function headlineOf(report: string): string {
  const headline = /^\s*HEADLINE[:\s]+(.+)$/im.exec(report)?.[1]?.trim();
  return (headline ?? firstLine(report)).slice(0, 200);
}

function normaliseContent(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

export function transcriptToEvents(messages: SessionMessage[], summary: string): TeamEvent[] {
  const out: TeamEvent[] = [];
  if (!messages.length) {
    out.push({
      kind: "notice",
      level: "info",
      text: `Resuming: ${summary}. No stored transcript to show, but the team remembers the conversation.`,
    });
    return out;
  }

  out.push({ kind: "notice", level: "info", text: `Resumed: ${summary}` });

  // Tool results arrive on later turns; index them so a replayed call can
  // show what it actually returned instead of an unresolved spinner.
  const results = new Map<string, { text: string; failed: boolean }>();
  for (const entry of messages) {
    const payload = entry.message as { content?: unknown } | undefined;
    for (const block of normaliseContent(payload?.content)) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      results.set(block.tool_use_id, {
        text: flattenResult(block.content),
        failed: block.is_error === true,
      });
    }
  }

  let turn = 0;
  let delegated = false;
  for (const entry of messages) {
    // Nested tool traffic belongs to a run that has already ended.
    if (entry.parent_tool_use_id !== null) continue;
    const payload = entry.message as { role?: string; content?: unknown } | undefined;
    if (!payload?.content) continue;
    const blocks = normaliseContent(payload.content);

    if (entry.type === "user") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
      if (!text) continue;   // a tool-result turn: not something you said
      if (CLI_MARKER.test(text)) {
        out.push({ kind: "notice", level: "warn", text: text.slice(1, -1) });
        continue;
      }
      out.push({ kind: "userSaid", to: "lead", text });
      continue;
    }

    if (entry.type !== "assistant") continue;

    const thought = blocks.filter((b) => b.type === "thinking").map((b) => b.thinking ?? "").join("").trim();
    if (thought) {
      const id = `replay-${turn++}`;
      out.push({ kind: "think", who: "lead", turn: id, delta: thought });
    }

    const said = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    if (said) {
      const id = `replay-${turn++}`;
      out.push({ kind: "say", who: "lead", turn: id, delta: said });
      out.push({ kind: "sayEnd", who: "lead", turn: id });
    }

    for (const block of blocks) {
      if (block.type !== "tool_use" || !block.name) continue;
      const short = block.name.replace(/^mcp__team__/, "");
      const input = (block.input ?? {}) as Record<string, unknown>;
      const result = block.id ? results.get(block.id) : undefined;
      const id = `replay-${block.id ?? turn++}`;

      if (short === "brief_researcher" || short === "brief_engineer") {
        delegated = true;
        const outcome = result ? verdictOf(result.text, result.failed) : "failed";
        out.push({
          kind: "assign",
          assignment: {
            id,
            from: "lead",
            to: short === "brief_researcher" ? "researcher" : "engineer",
            brief: String(input.objective ?? ""),
            startedAt: 0,
            finishedAt: 0,
            outcome,
          },
        });
        out.push({
          kind: "deliver",
          id,
          outcome,
          summary: DECLINED.test(result?.text ?? "")
            ? "you declined this delegation"
            : headlineOf(result?.text ?? ""),
        });
        continue;
      }

      out.push({ kind: "act", who: "lead", act: id, tool: short, summary: describeTool(block.name, input) });
      out.push({
        kind: "actEnd",
        who: "lead",
        act: id,
        ok: !result?.failed,
        summary: result ? firstLine(result.text) : "",
      });
    }
  }

  if (messages.length >= REPLAY_LIMIT) {
    out.push({
      kind: "notice",
      level: "info",
      text: `Only the last ${REPLAY_LIMIT} messages are shown. The team still has the whole conversation.`,
    });
  }
  // Where the record stops and the live run starts.
  out.push({
    kind: "notice",
    level: "info",
    text: delegated
      // Each teammate ran in its own stored session, so only the Lead's side
      // of a past delegation survives. Say so rather than let empty lanes imply
      // the teammates did nothing.
      ? "— end of the earlier conversation. Each teammate ran in its own session, so above this line you see what was delegated and what came back, not the teammates working —"
      : "— end of the earlier conversation —",
  });

  return out;
}

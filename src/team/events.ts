/**
 * The vocabulary the UI speaks.
 *
 * Deliberately independent of the Agent SDK's message types: the orchestrator
 * translates SDK messages into these, so the view never has to know about
 * parent_tool_use_id, stream_event shapes, or subagent attribution rules.
 */

export type TeammateId = "lead" | "researcher" | "engineer";

export const TEAMMATES: readonly TeammateId[] = ["lead", "researcher", "engineer"] as const;

export type TeammateStatus =
  | "offline"   // not part of this session
  | "idle"      // available, nothing assigned
  | "thinking"  // reasoning, no tool running
  | "working"   // running a tool
  | "waiting"   // blocked on the user (permission, question)
  | "reporting" // wrapping up, writing its report back
  | "done";     // finished its assignment

export interface TeammateView {
  id: TeammateId;
  /** Display name, e.g. "Lead". */
  name: string;
  /** One-line remit shown under the name. */
  role: string;
  model: string;
  effort: string;
  status: TeammateStatus;
  /** Short present-tense description of the current activity. */
  activity?: string;
}

/** A unit of delegated work, rendered as a card that travels between lanes. */
export interface Assignment {
  id: string;
  from: TeammateId;
  to: TeammateId;
  brief: string;
  startedAt: number;
  finishedAt?: number;
  outcome?: "delivered" | "blocked" | "failed";
}

export type TeamEvent =
  /** Full roster, sent on connect and whenever configuration changes. */
  | {
      kind: "roster";
      members: TeammateView[];
      autonomy: string;
      billing: string;
      workspace: string;
      /** Configured MCP connectors and whether they actually came up. */
      connectors: { name: string; ok: boolean; status: string }[];
    }
  | { kind: "status"; who: TeammateId; status: TeammateStatus; activity?: string }

  /** Streamed prose from a teammate. */
  | { kind: "say"; who: TeammateId; turn: string; delta: string }
  | { kind: "sayEnd"; who: TeammateId; turn: string }
  /** Streamed reasoning, rendered collapsed. */
  | { kind: "think"; who: TeammateId; turn: string; delta: string }

  /** A tool call starting and finishing. */
  | { kind: "act"; who: TeammateId; act: string; tool: string; summary: string }
  | { kind: "actEnd"; who: TeammateId; act: string; ok: boolean; summary: string }

  /** Delegation and its result. */
  | { kind: "assign"; assignment: Assignment }
  | { kind: "deliver"; id: string; outcome: NonNullable<Assignment["outcome"]>; summary: string }

  | { kind: "userSaid"; to: TeammateId; text: string; images?: { name: string; dataUrl: string }[] }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string; who?: TeammateId }
  | { kind: "spend"; usd: number; turns: number; durationMs: number }
  /** Context window filled and the CLI summarised the history to keep going. */
  | { kind: "compacted"; trigger: "auto" | "manual"; before: number; after?: number }
  /** Live context-window usage, so filling up is visible before it happens. */
  | { kind: "context"; percent: number; tokens: number; max: number }
  | { kind: "busy"; busy: boolean }
  | { kind: "sendability"; ok: boolean; reason?: string }
  | { kind: "restoreInput"; text: string }
  | { kind: "channel"; to: TeammateId }
  /** Which screen the webview should be showing. */
  | { kind: "screen"; screen: "auth" | "projects" | "team" }
  | {
      kind: "auth";
      signedIn: boolean;
      /** Who is signed in, or why the run failed. */
      detail: string;
      billing: string;
      usingApiKey: boolean;
    }
  | { kind: "projects"; roots: string[]; items: ProjectCard[]; active?: string }
  /** Stored conversations for the current project, newest first. */
  | { kind: "sessions"; items: SessionCard[]; project?: string }
  /** Intercepted by the controller — never reaches the webview as-is. */
  | { kind: "authProblem"; detail: string }
  | { kind: "clear" };

/** An image the user attached, already base64-encoded by the webview. */
export interface Attachment {
  name: string;
  /** One of the media types the API accepts. */
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Base64 payload, no data: prefix. */
  data: string;
  bytes: number;
}

export interface SessionCard {
  id: string;
  title: string;
  /** Epoch millis of the last message. */
  when: number;
}

export interface ProjectCard {
  path: string;
  name: string;
  open: boolean;
  stack: string[];
  known: boolean;
  lastTouched: number;
}

export type UiCommand =
  | { kind: "ready" }
  | { kind: "send"; text: string; images?: Attachment[] }
  | { kind: "stop" }
  | { kind: "newSession" }
  /** Direct line: talk to a teammate instead of the Lead. */
  | { kind: "setChannel"; to: TeammateId }
  | { kind: "openTeamFloor" }
  | { kind: "selectProject" }
  | { kind: "openProject"; path: string; alreadyOpen: boolean }
  | { kind: "goHome" }
  | { kind: "resumeSession"; id: string; title: string }
  | { kind: "requestDirectLine"; to: TeammateId }
  | { kind: "signIn" }
  | { kind: "useApiKey" }
  | { kind: "refreshAuth" }
  | { kind: "account" }
  | { kind: "configure"; setting: string };

export const ROLE_BLURB: Record<TeammateId, string> = {
  lead: "Interrogates the brief, decides scope, delegates",
  researcher: "Reads papers, docs and the web; reports findings",
  engineer: "Writes, edits and runs the code",
};

export const DISPLAY_NAME: Record<TeammateId, string> = {
  lead: "Lead",
  researcher: "Researcher",
  engineer: "Engineer",
};

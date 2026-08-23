/**
 * The vocabulary the UI speaks.
 *
 * Deliberately independent of the Agent SDK's message types: the runner
 * translates SDK messages into these, so the view never has to know about
 * parent_tool_use_id, stream_event shapes, or subagent attribution rules.
 *
 * Nothing here knows how many agents there are or what they are called. That
 * comes from the workflow the user drew.
 */

import type { AgentSpec, Edge, Preset, Problem, Scope, Workflow } from "../workflow/model";
import type { TemplateCard } from "../workflow/templates";
import type { WorkflowSummary } from "../workflow/store";

export type AgentId = string;

export type AgentStatus =
  | "offline"   // not part of this session
  | "idle"      // available, nothing assigned
  | "thinking"  // reasoning, no tool running
  | "working"   // running a tool
  | "waiting"   // blocked on the user (permission, question)
  | "reporting" // wrapping up, writing its report back
  | "done";     // finished its assignment

export interface AgentView {
  id: AgentId;
  name: string;
  /** One-line remit shown under the name. */
  role: string;
  model: string;
  effort: string;
  preset: Preset;
  status: AgentStatus;
  /** Short present-tense description of the current activity. */
  activity?: string;
  /** True for the agent the user is addressing. */
  entry: boolean;
  /** Canvas position, so the live map matches the graph the user drew. */
  x: number;
  y: number;
}

/** A unit of delegated work, rendered as a card that travels between lanes. */
export interface Assignment {
  id: string;
  from: AgentId;
  to: AgentId;
  brief: string;
  startedAt: number;
  finishedAt?: number;
  outcome?: "delivered" | "blocked" | "failed";
  /** Set when this run was triggered by a `then` arrow rather than a brief. */
  handoff?: boolean;
}

export type TeamEvent =
  /** Full roster, sent on connect and whenever configuration changes. */
  | {
      kind: "roster";
      workflowId: string;
      workflowName: string;
      members: AgentView[];
      edges: Edge[];
      autonomy: string;
      billing: string;
      workspace: string;
      /** Configured MCP connectors and whether they actually came up. */
      connectors: { name: string; ok: boolean; status: string }[];
    }
  | { kind: "status"; who: AgentId; status: AgentStatus; activity?: string }

  /** Streamed prose from an agent. */
  | { kind: "say"; who: AgentId; turn: string; delta: string }
  | { kind: "sayEnd"; who: AgentId; turn: string }
  /** Streamed reasoning, rendered collapsed. */
  | { kind: "think"; who: AgentId; turn: string; delta: string }

  /** A tool call starting and finishing. */
  | { kind: "act"; who: AgentId; act: string; tool: string; summary: string }
  | { kind: "actEnd"; who: AgentId; act: string; ok: boolean; summary: string }

  /** Delegation and its result. */
  | { kind: "assign"; assignment: Assignment }
  | { kind: "deliver"; id: string; outcome: NonNullable<Assignment["outcome"]>; summary: string }

  | { kind: "userSaid"; to: AgentId; text: string; images?: { name: string; dataUrl: string }[] }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string; who?: AgentId }
  | { kind: "spend"; usd: number; turns: number; durationMs: number }
  /** Context window filled and the CLI summarised the history to keep going. */
  | { kind: "compacted"; trigger: "auto" | "manual"; before: number; after?: number }
  /** Live context-window usage, so filling up is visible before it happens. */
  | { kind: "context"; percent: number; tokens: number; max: number }
  | { kind: "busy"; busy: boolean }
  | { kind: "sendability"; ok: boolean; reason?: string }
  | { kind: "restoreInput"; text: string }
  | { kind: "channel"; to: AgentId }

  /** Which screen the webview should be showing. */
  | { kind: "screen"; screen: Screen }
  | {
      kind: "auth";
      signedIn: boolean;
      /** Who is signed in, or why the run failed. */
      detail: string;
      billing: string;
      usingApiKey: boolean;
    }
  | { kind: "projects"; roots: string[]; items: ProjectCard[]; active?: string }

  /** The home screen: every workflow in the active folder. */
  | { kind: "workflows"; items: WorkflowSummary[]; project: string; templates: TemplateCard[] }
  /** The builder's subject, with everything it needs to render the panels. */
  | {
      kind: "editing";
      workflow: Workflow;
      /**
       * True when this is the host telling the builder what to edit (opened,
       * created, saved). False when it is only a re-validate or a screen
       * refresh — in which case the builder keeps its own unsaved draft, or a
       * background event would silently discard what the user just typed.
       */
      authoritative: boolean;
      problems: Problem[];
      presets: { id: Preset; name: string; blurb: string }[];
      catalogue: { group: string; tools: { name: string; blurb: string }[] }[];
      /** What the installed CLI actually offers, with what each one does. */
      skills: { name: string; description: string; argumentHint?: string }[];
      connectors: string[];
      /** What the installed CLI actually offers, not a hardcoded list. */
      models: { value: string; label: string; description?: string; efforts: string[] }[];
      efforts: string[];
    }
  /** A refined prompt coming back for the user to accept, edit or reject. */
  | { kind: "refined"; agent: AgentId; prompt: string; note: string }
  /** A workflow reached disk. `auto` distinguishes a background save. */
  | { kind: "saved"; workflowId: string; at: number; auto: boolean }
  | { kind: "refining"; agent: AgentId; busy: boolean }
  /** Progress for the "build it for me" flow. */
  | { kind: "building"; busy: boolean; note?: string }

  /** The workflow's own page: what it is, and every conversation under it. */
  | {
      kind: "detail";
      workflow: Workflow;
      sessions: SessionCard[];
      problems: Problem[];
    }
  /** Stored conversations for the open workflow, newest first. */
  | { kind: "sessions"; items: SessionCard[]; workflowId: string }
  /** An agent is asking. Rendered in its lane, where the text can wrap. */
  | { kind: "ask"; id: string; who: AgentId; questions: AskQuestion[] }
  /** The question is settled — by an answer, an interrupt, or the session ending. */
  | { kind: "askClosed"; id: string; answered: boolean }
  /** Intercepted by the controller — never reach the webview as-is. */
  | { kind: "authProblem"; detail: string }
  | { kind: "sessionStarted"; sessionId: string }
  /** Which agents and arrow are live, for the run view's graph. */
  | { kind: "active"; agents: AgentId[]; edge?: { from: AgentId; to: AgentId } }
  | { kind: "clear" };

export type Screen = "auth" | "projects" | "home" | "workflow" | "builder" | "run";

/** An image the user attached, already base64-encoded by the webview. */
export interface Attachment {
  name: string;
  /** One of the media types the API accepts. */
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Base64 payload, no data: prefix. */
  data: string;
  bytes: number;
}

export interface AskOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
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
  /** Talk to a different agent in the running workflow. */
  | { kind: "setChannel"; to: AgentId }
  | { kind: "openTeamFloor" }
  | { kind: "selectProject" }
  | { kind: "openProject"; path: string; alreadyOpen: boolean }
  | { kind: "goHome" }
  | { kind: "resumeSession"; id: string; title: string }
  | { kind: "answer"; id: string; answers: Record<string, string> }
  | { kind: "answerCancelled"; id: string }
  | { kind: "signIn" }
  | { kind: "useApiKey" }
  | { kind: "refreshAuth" }
  | { kind: "account" }
  | { kind: "configure"; setting: string }

  // ------------------------------------------------------------- workflows
  | { kind: "newWorkflow"; template?: string; scope?: Scope }
  /** Open a workflow's own page: its sessions, and what it looks like. */
  | { kind: "showWorkflow"; id: string }
  | { kind: "startSession"; id: string }
  | { kind: "moveWorkflow"; id: string; to: Scope }
  /** Describe a pipeline in prose; Claude designs the whole workflow. */
  | { kind: "buildWorkflow"; description: string; scope?: Scope }
  | { kind: "openWorkflow"; id: string }
  | { kind: "editWorkflow"; id: string }
  | { kind: "deleteWorkflow"; id: string }
  | { kind: "duplicateWorkflow"; id: string }
  /** The builder saves the whole graph at once; partial edits are local to it. */
  | { kind: "saveWorkflow"; workflow: Workflow; launch?: boolean; auto?: boolean }
  /** Live validation while drawing, without saving. */
  | { kind: "checkWorkflow"; workflow: Workflow }
  | { kind: "refinePrompt"; agent: AgentSpec; workflow: Workflow };

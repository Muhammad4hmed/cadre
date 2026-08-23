import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Scope, Workflow } from "./model";
import { emptyWorkflow, uniqueSlug, validate } from "./model";

/**
 * Where workflows live.
 *
 * **local** — `.cadre/workflows/` in the project. Part of how a team works on
 * that codebase: reviewable in a diff, shareable by committing, and fixable by
 * hand at 2am without running us.
 *
 * **global** — `~/.cadre/workflows/`, available in every project you open. For
 * the ones that are about how *you* work rather than about one repository.
 *
 * Plain JSON either way, one file each.
 *
 * Session history is deliberately NOT stored beside a global workflow. A global
 * workflow used in three projects has three separate conversations, and merging
 * them into one list would be actively misleading — so the index always lives
 * in the project, keyed by workflow id.
 */
export const WORKFLOW_DIR = path.join(".cadre", "workflows");

export const globalRoot = (): string => path.join(os.homedir(), ".cadre");

/** The directory holding workflows of the given scope. */
function dirFor(root: string, scope: Scope): string {
  return scope === "global"
    ? path.join(globalRoot(), "workflows")
    : path.join(root, WORKFLOW_DIR);
}

/**
 * A workflow id is a filename, and ids reach here from webview messages.
 *
 * `../` in an id would put the file anywhere on disk — proven, not theoretical:
 * writeWorkflow happily created a file outside the project before this existed.
 * Every id is minted by `uniqueSlug`, so anything that is not a slug did not
 * come from us and is refused rather than sanitised: quietly rewriting a
 * malformed id would make one workflow silently overwrite another.
 */
const SAFE_ID = /^[a-z0-9][a-z0-9_]{0,63}$/;

function checkId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Unsafe workflow id: ${JSON.stringify(id)}`);
  return id;
}

/** True when an id is one we could have minted. Callers that must not throw. */
export const isSafeId = (id: string): boolean => SAFE_ID.test(id);

function file(root: string, scope: Scope, id: string): string {
  const dir = dirFor(root, scope);
  const resolved = path.resolve(dir, `${checkId(id)}.json`);
  // Belt and braces: even a slug-shaped id must land in the directory we meant.
  if (path.dirname(resolved) !== path.resolve(dir)) {
    throw new Error(`Workflow path escaped its directory: ${id}`);
  }
  return resolved;
}

/** Always project-local, even for a global workflow. See the note above. */
const sessionsFile = (root: string, id: string): string =>
  path.join(root, WORKFLOW_DIR, `${checkId(id)}.sessions.json`);

export interface StoredSession {
  sessionId: string;
  title: string;
  when: number;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  scope: Scope;
  description?: string;
  agents: number;
  edges: number;
  updatedAt: number;
  sessions: number;
  /** Enough to draw a thumbnail without loading the whole thing. */
  agentNames: string[];
  problems: number;
}

function idsIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".json") && !n.endsWith(".sessions.json"))
      .map((n) => n.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/** Every workflow visible from this project, local and global together. */
export function listWorkflows(root: string): WorkflowSummary[] {
  const summaries: WorkflowSummary[] = [];

  for (const scope of ["local", "global"] as Scope[]) {
    for (const id of idsIn(dirFor(root, scope)).filter(isSafeId)) {
      const workflow = readWorkflow(root, id, scope);
      if (!workflow) continue;
      summaries.push({
        id: workflow.id,
        name: workflow.name,
        scope,
        description: workflow.description,
        agents: workflow.agents.length,
        edges: workflow.edges.length,
        updatedAt: workflow.updatedAt,
        sessions: listSessions(root, workflow.id).length,
        agentNames: workflow.agents.map((a) => a.name),
        problems: validate(workflow).filter((p) => p.level === "error").length,
      });
    }
  }

  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Reads one workflow. Without a scope, the project's copy wins — a local
 * workflow shadowing a global one of the same name is the intuitive precedence,
 * and it lets a project pin its own version of a shared workflow.
 */
export function readWorkflow(root: string, id: string, scope?: Scope): Workflow | undefined {
  if (!isSafeId(id)) return undefined;
  const order: Scope[] = scope ? [scope] : ["local", "global"];
  for (const where of order) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file(root, where, id), "utf8")) as Workflow;
      // The id is the filename and the scope is the directory, whatever the
      // file says: a copied file that kept its old id would otherwise shadow
      // the workflow it was copied from.
      return { ...parsed, id, scope: where };
    } catch {
      // try the next scope
    }
  }
  return undefined;
}

export function writeWorkflow(root: string, workflow: Workflow, scope?: Scope): Workflow {
  const where = scope ?? workflow.scope ?? "local";
  const saved: Workflow = {
    ...workflow,
    scope: where,
    updatedAt: Date.now(),
    revision: (workflow.revision ?? 0) + 1,
  };
  fs.mkdirSync(dirFor(root, where), { recursive: true });
  fs.writeFileSync(file(root, where, workflow.id), `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  return saved;
}

export function deleteWorkflow(root: string, id: string, scope?: Scope): void {
  if (!isSafeId(id)) return;
  const where = scope ?? readWorkflow(root, id)?.scope ?? "local";
  fs.rmSync(file(root, where, id), { force: true });
  // The session index is project-local whatever the workflow's scope was.
  fs.rmSync(sessionsFile(root, id), { force: true });
}

/**
 * Moves a workflow between scopes.
 *
 * Copy-then-delete rather than a rename: the two directories can be on
 * different filesystems, and a failed rename that leaves nothing behind is the
 * worst possible outcome for the only copy of someone's work.
 */
export function moveWorkflow(root: string, id: string, to: Scope): Workflow | undefined {
  const source = readWorkflow(root, id);
  if (!source || source.scope === to) return source;

  // Do not overwrite a different workflow that already has this id over there.
  const clash = readWorkflow(root, id, to);
  const targetId = clash ? uniqueSlug(source.name, idsIn(dirFor(root, to))) : id;

  const written = writeWorkflow(root, { ...source, id: targetId }, to);
  fs.rmSync(file(root, source.scope ?? "local", id), { force: true });
  return written;
}

/** A workflow id that is not taken in either scope, derived from the name. */
export function createWorkflow(root: string, name: string, scope: Scope = "local"): Workflow {
  const taken = [...idsIn(dirFor(root, "local")), ...idsIn(dirFor(root, "global"))];
  const workflow = emptyWorkflow(name, uniqueSlug(name, taken), Date.now());
  return writeWorkflow(root, { ...workflow, scope }, scope);
}

export function duplicateWorkflow(root: string, id: string): Workflow | undefined {
  const source = readWorkflow(root, id);
  if (!source) return undefined;
  const taken = [...idsIn(dirFor(root, "local")), ...idsIn(dirFor(root, "global"))];
  const name = `${source.name} copy`;
  return writeWorkflow(
    root,
    { ...source, id: uniqueSlug(name, taken), name, createdAt: Date.now(), revision: 0 },
    source.scope ?? "local",
  );
}

/* ------------------------------------------------------------- sessions */

/**
 * Which stored conversations belong to which workflow.
 *
 * The CLI stores sessions per working directory, not per workflow, so two
 * workflows in one project would otherwise show each other's history.
 */
export function listSessions(root: string, id: string): StoredSession[] {
  if (!isSafeId(id)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsFile(root, id), "utf8")) as StoredSession[];
    return Array.isArray(parsed) ? parsed.sort((a, b) => b.when - a.when) : [];
  } catch {
    return [];
  }
}

export function recordSession(root: string, id: string, session: StoredSession): void {
  const existing = listSessions(root, id).filter((s) => s.sessionId !== session.sessionId);
  const next = [session, ...existing].slice(0, 200);
  fs.mkdirSync(path.join(root, WORKFLOW_DIR), { recursive: true });
  fs.writeFileSync(sessionsFile(root, id), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function forgetSession(root: string, id: string, sessionId: string): void {
  const next = listSessions(root, id).filter((s) => s.sessionId !== sessionId);
  fs.writeFileSync(sessionsFile(root, id), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

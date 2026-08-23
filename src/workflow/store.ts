import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { slug } from "./model";
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
/**
 * Turns whatever was in the file into a workflow, or rejects it.
 *
 * These files are plain JSON in the project, which is the point — they get
 * hand-edited, merged badly, and half-written. Valid JSON is not a valid
 * workflow: a file containing `42`, `null`, `"text"` or an array used to be
 * spread into an object that looked like a workflow and was not, and one such
 * file threw out of `listWorkflows` and took the whole home screen with it.
 *
 * Repaired where repair is meaningful — a missing `edges` becomes an empty
 * list, so the workflow still opens in the builder with its problems flagged.
 * Rejected where it is not: there is nothing to recover from a number.
 */
function normalise(parsed: unknown, id: string, scope: Scope): Workflow | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const raw = parsed as Record<string, unknown>;

  const agents = (Array.isArray(raw.agents) ? raw.agents : [])
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object" && !Array.isArray(a))
    .map((a, index) => ({
      id: typeof a.id === "string" && a.id ? a.id : `agent_${index + 1}`,
      name: typeof a.name === "string" ? a.name : "",
      role: typeof a.role === "string" ? a.role : "",
      prompt: typeof a.prompt === "string" ? a.prompt : "",
      ...(typeof a.rawPrompt === "string" ? { rawPrompt: a.rawPrompt } : {}),
      preset: (["readonly", "research", "build", "full"] as const).includes(a.preset as never)
        ? (a.preset as Workflow["agents"][number]["preset"])
        : "readonly",
      ...(typeof a.model === "string" ? { model: a.model } : {}),
      ...(typeof a.effort === "string" ? { effort: a.effort } : {}),
      ...(Array.isArray(a.tools) ? { tools: a.tools.map(String) } : {}),
      ...(Array.isArray(a.disallowedTools) ? { disallowedTools: a.disallowedTools.map(String) } : {}),
      ...(Array.isArray(a.skills) ? { skills: a.skills.map(String) } : {}),
      ...(Array.isArray(a.connectors) ? { connectors: a.connectors.map(String) } : {}),
      ...(Number.isFinite(a.maxTurns) ? { maxTurns: Number(a.maxTurns) } : {}),
      x: Number.isFinite(a.x) ? Number(a.x) : 60,
      y: Number.isFinite(a.y) ? Number(a.y) : 60,
    }));

  // An agent id becomes an MCP tool name — `brief_<id>` — and the SDK warns
  // that a slash, a space or a leading dot in one "may cause compatibility
  // issues". The builder only ever makes slug-safe ids, but a workflow file
  // lives in `.cadre/`, travels with the repository, and can be hand-edited.
  // Two agents sharing an id is worse than an unusable one: two lanes, and a
  // brief that could mean either.
  //
  // Repaired rather than refused, like everything else here. A workflow that
  // will not open is the one outcome nobody can do anything about.
  const taken: string[] = [];
  const renamed = new Map<string, string>();
  for (const a of agents) {
    const wanted = SAFE_ID.test(a.id) ? a.id : slug(a.id || a.name);
    const settled = taken.includes(wanted) || !SAFE_ID.test(wanted)
      ? uniqueSlug(a.name || a.id || "agent", taken)
      : wanted;
    taken.push(settled);
    // Keyed on the original, so the arrows and the entry can be rewritten. A
    // duplicate maps to whichever of the two was read first, which is the same
    // agent the old file's arrows would have found.
    if (!renamed.has(a.id)) renamed.set(a.id, settled);
    a.id = settled;
  }
  const rename = (id: string): string => renamed.get(id) ?? id;

  const known = new Set(agents.map((a) => a.id));
  const edges = (Array.isArray(raw.edges) ? raw.edges : [])
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object" && !Array.isArray(e))
    .map((e): Record<string, unknown> => ({
      ...e,
      from: rename(String(e.from)),
      to: rename(String(e.to)),
    }))
    .filter((e) => known.has(String(e.from)) && known.has(String(e.to)))
    .map((e) => ({
      from: String(e.from),
      to: String(e.to),
      kind: e.kind === "then" ? ("then" as const) : ("delegate" as const),
      ...(typeof e.label === "string" && e.label ? { label: e.label } : {}),
    }));

  return {
    // The id is the filename and the scope is the directory, whatever the file
    // says: a copied file that kept its old id would otherwise shadow the
    // workflow it was copied from.
    id,
    scope,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : id,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(raw.defaults && typeof raw.defaults === "object" && !Array.isArray(raw.defaults)
      ? { defaults: raw.defaults as Workflow["defaults"] }
      : {}),
    entry: typeof raw.entry === "string" && known.has(rename(raw.entry)) ? rename(raw.entry) : (agents[0]?.id ?? ""),
    agents,
    edges,
    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : 0,
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : 0,
    revision: Number.isFinite(raw.revision) ? Number(raw.revision) : 0,
    ...(typeof raw.template === "string" ? { template: raw.template } : {}),
  };
}

export function readWorkflow(root: string, id: string, scope?: Scope): Workflow | undefined {
  if (!isSafeId(id)) return undefined;
  const order: Scope[] = scope ? [scope] : ["local", "global"];
  for (const where of order) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file(root, where, id), "utf8"));
    } catch {
      continue;   // not there, or not JSON at all
    }
    const workflow = normalise(parsed, id, where);
    if (workflow) return workflow;
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
  writeAtomic(file(root, where, workflow.id), `${JSON.stringify(saved, null, 2)}\n`);
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

/**
 * Replace a file's contents in one step.
 *
 * `writeFileSync` truncates and then writes, so a process that dies in between
 * — a closed window, a crash, a full disk — leaves a prefix of the new content
 * behind. For these files that is not a corrupt cache to rebuild: it is the
 * workflow the user drew, and the list of every conversation they have had
 * under it. Both parse as nothing and both fail quietly.
 *
 * Writing to a sibling temporary file and renaming makes the swap atomic, so a
 * reader sees either the old file or the new one and never half of either. The
 * temporary lives in the same directory because rename is only atomic within a
 * filesystem, and /tmp is often a different one.
 */
function writeAtomic(target: string, contents: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  let handle: number | undefined;
  try {
    handle = fs.openSync(temp, "w");
    fs.writeFileSync(handle, contents, "utf8");
    // Rename only orders the directory entry. Without this the rename can land
    // before the contents do, which on a power loss is the same empty file we
    // are trying to avoid.
    try {
      fs.fsyncSync(handle);
    } catch {
      // Some filesystems refuse fsync. Losing durability is survivable;
      // losing the write is not.
    }
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temp, target);
  } catch (error) {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* already gone */ }
    }
    try { fs.unlinkSync(temp); } catch { /* never created */ }
    throw error;
  }
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
/**
 * What a conversation id may look like.
 *
 * The index sits beside the workflows in `.cadre/`, so it travels with the
 * repository exactly as they do — and an id from it is handed to the CLI to
 * look a conversation up by, which is to say it is a name in a store on disk.
 * A repository does not get to choose those. Permissive about shape, because
 * the CLI owns the format and it is not ours to pin down; strict about the
 * things that make an identifier something other than an identifier.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const usableSession = (s: StoredSession): boolean =>
  Boolean(s) && typeof s.sessionId === "string" && SAFE_SESSION_ID.test(s.sessionId);

export function listSessions(root: string, id: string): StoredSession[] {
  if (!isSafeId(id)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsFile(root, id), "utf8")) as StoredSession[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(usableSession).sort((a, b) => b.when - a.when);
  } catch {
    return [];
  }
}

/** A real sleep, without burning a core: this runs on the extension host thread. */
function pause(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // No SharedArrayBuffer here; the caller retries either way.
  }
}

/**
 * Read, change, write — with nobody else in the middle.
 *
 * Writing the file is already atomic, so it is never half-written. That is a
 * different problem from this one: two editor windows open on the same project
 * both read the index, both add their own conversation, and both write. The
 * second write is built from what the first one saw, so the first conversation
 * is gone — not corrupted, just absent, and only from the list Cadre shows.
 * The transcript is still in the CLI's own store, which makes it worse rather
 * than better: the work exists and there is no way back to it.
 *
 * Measured before fixing: two windows recording at once lost six conversations
 * out of twenty-four.
 *
 * A lock file, created with `wx` so that creating it is the test for whether
 * anyone else holds it. The critical section is one small read and one small
 * write, so waiting is rare and short. A lock left behind by a process that
 * died is taken after five seconds, and after two seconds of waiting this gives
 * up and writes anyway — a lost update is bad, but an editor that has stopped
 * responding because a lock file exists is worse.
 */
/**
 * Is the process that took this lock still running?
 *
 * Signal 0 asks without sending anything. A pid we cannot read, or one owned by
 * another user, is treated as alive so that a lock is never stolen on a guess —
 * the age check behind it still breaks any real deadlock.
 */
function holderAlive(lock: string): boolean {
  let pid = 0;
  try {
    pid = Number.parseInt(fs.readFileSync(lock, "utf8").trim(), 10);
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age > 5_000) return false;
  } catch {
    return false;   // it went away, or was never readable
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function withSessionLock<T>(file: string, work: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 2_000;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lock, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return work();
      // Whoever holds it may not be there any more: a window that was killed
      // never gets to clean up. Waiting out a timeout for a process that no
      // longer exists is the wrong answer, so ask whether it does.
      if (!holderAlive(lock)) {
        try { fs.unlinkSync(lock); } catch { /* someone else got there first */ }
        continue;
      }
      if (Date.now() > deadline) return work();
      pause(2);
      continue;
    }
    try {
      // The pid is what makes a lock left by a dead process recognisable.
      try { fs.writeSync(fd, String(process.pid)); } catch { /* the lock is the file, not its contents */ }
      fs.closeSync(fd);
      return work();
    } finally {
      try { fs.unlinkSync(lock); } catch { /* already gone */ }
    }
  }
}

export function recordSession(root: string, id: string, session: StoredSession): void {
  const file = sessionsFile(root, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withSessionLock(file, () => {
    // Read inside the lock: what was on disk a moment ago is not good enough.
    const existing = listSessions(root, id).filter((s) => s.sessionId !== session.sessionId);
    const next = [session, ...existing].slice(0, 200);
    writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  });
}

export function forgetSession(root: string, id: string, sessionId: string): void {
  const file = sessionsFile(root, id);
  withSessionLock(file, () => {
    const next = listSessions(root, id).filter((s) => s.sessionId !== sessionId);
    writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  });
}

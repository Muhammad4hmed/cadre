import { query, type ModelInfo, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";

/**
 * Which models exist, asked of the CLI rather than hardcoded.
 *
 * A baked-in list is wrong the day a model ships and wrong in a different way
 * on someone else's install: the CLI's identifiers are not the API's — Fable is
 * `claude-fable-5[1m]` here, `opus` resolves to whatever the installed version
 * considers current, and Haiku accepts no effort level at all. Every one of
 * those is something a hand-written list would have got wrong.
 *
 * So we ask. The handshake sends no prompt and costs no tokens; the answer is
 * cached for the session, and there is a small curated fallback for the case
 * where the CLI cannot be reached at all.
 */

export interface ModelChoice {
  /** What to pass as `model`. */
  value: string;
  /** "Opus", "Fable" — what the user picks from. */
  label: string;
  description?: string;
  /** Empty when the model takes no effort level. */
  efforts: string[];
  /** The wire model an alias resolves to, when the CLI tells us. */
  resolves?: string;
}

/**
 * Used only when the CLI cannot be asked. Deliberately short: a stale long list
 * is more misleading than an obviously minimal one, and the real list arrives
 * as soon as the executable is reachable.
 */
export const FALLBACK_MODELS: ModelChoice[] = [
  { value: "default", label: "Default (recommended)", efforts: EFFORTS() },
  { value: "opus", label: "Opus", efforts: EFFORTS() },
  { value: "sonnet", label: "Sonnet", efforts: EFFORTS() },
  { value: "haiku", label: "Haiku", efforts: [] },
];

function EFFORTS(): string[] {
  return ["low", "medium", "high", "xhigh", "max"];
}

/** Every effort level any known model accepts, for a workspace-wide default. */
export const ALL_EFFORTS = EFFORTS();

/** A skill the installed CLI has, as it reports itself. */
export interface SkillChoice {
  name: string;
  description: string;
  /** e.g. "<file>" — what the skill expects after its name. */
  argumentHint?: string;
}

interface Cached {
  at: number;
  models: ModelChoice[];
  skills: SkillChoice[];
}

let cache: Cached | undefined;

/** Spawning the CLI is not free, and the answer does not change during a session. */
const TTL = 10 * 60_000;

export function cachedModels(): ModelChoice[] {
  return cache?.models ?? FALLBACK_MODELS;
}

export function cachedSkills(): SkillChoice[] {
  return cache?.skills ?? [];
}

export function clearModelCache(): void {
  cache = undefined;
}

/**
 * Asks the CLI for its model list.
 *
 * Never throws: a model picker that fails to open because the CLI was slow is
 * worse than one showing four sensible defaults.
 */
export async function discoverModels(opts: {
  executablePath: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}): Promise<ModelChoice[]> {
  return (await discover(opts)).models;
}

export async function discoverSkills(opts: {
  executablePath: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}): Promise<SkillChoice[]> {
  return (await discover(opts)).skills;
}

/**
 * One handshake, both answers.
 *
 * Models and skills both come from the same place and cost the same subprocess,
 * so asking twice would double the only expensive part for no reason.
 */
async function discover(opts: {
  executablePath: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}): Promise<{ models: ModelChoice[]; skills: SkillChoice[] }> {
  if (cache && Date.now() - cache.at < TTL) return cache;

  // An iterator that never yields: we want the handshake and nothing else.
  async function* silent(): AsyncGenerator<never> {
    // deliberately empty
  }

  let running: ReturnType<typeof query> | undefined;
  try {
    running = query({
      prompt: silent(),
      options: {
        pathToClaudeCodeExecutable: opts.executablePath,
        cwd: opts.cwd,
        ...(opts.env ? { env: opts.env } : {}),
        // No tools, no settings, no session: this is a capability question.
        tools: [],
        allowedTools: [],
        settingSources: [],
        persistSession: false,
      },
    });

    const [foundModels, foundSkills] = await Promise.all([
      running.supportedModels() as Promise<ModelInfo[]>,
      // Skills are a bonus: a CLI too old to report them should still give us
      // the model list rather than falling back on both.
      running.supportedCommands().catch(() => [] as SlashCommand[]),
    ]);

    const models = foundModels.map(toChoice).filter((m) => m.value);
    const skills = foundSkills
      .filter((c) => c?.name)
      .map((c) => ({
        name: String(c.name),
        description: String(c.description ?? ""),
        argumentHint: c.argumentHint ? String(c.argumentHint) : undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!models.length) return { models: FALLBACK_MODELS, skills };

    cache = { at: Date.now(), models, skills };
    opts.log?.(`available: ${models.length} models, ${skills.length} skills`);
    return cache;
  } catch (err) {
    opts.log?.(`could not read what the CLI supports: ${err instanceof Error ? err.message : String(err)}`);
    return { models: FALLBACK_MODELS, skills: cache?.skills ?? [] };
  } finally {
    try { running?.close(); } catch { /* already gone */ }
  }
}

function toChoice(info: ModelInfo): ModelChoice {
  return {
    value: String(info.value ?? ""),
    label: String(info.displayName || info.value || ""),
    description: info.description ? String(info.description) : undefined,
    // `supportsEffort: false` and "no list given" are different: the first is a
    // model that rejects the parameter, the second is one we know nothing
    // about, which should keep the full range rather than lose the control.
    efforts:
      info.supportsEffort === false
        ? []
        : (info.supportedEffortLevels ?? EFFORTS()).map(String),
    resolves: info.resolvedModel ? String(info.resolvedModel) : undefined,
  };
}

/**
 * Whether a model takes an effort level.
 *
 * Unknown models get the benefit of the doubt: a user who typed a model id we
 * have never seen should not silently lose their effort setting.
 */
export function supportsEffort(models: ModelChoice[], value: string): boolean {
  if (!value) return true;
  const match = models.find((m) => m.value === value || m.resolves === value);
  return match ? match.efforts.length > 0 : true;
}

/** The effort levels one model accepts, for populating a picker. */
export function effortsFor(models: ModelChoice[], value: string): string[] {
  if (!value) return ALL_EFFORTS;
  const match = models.find((m) => m.value === value || m.resolves === value);
  return match ? match.efforts : ALL_EFFORTS;
}

import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { Autonomy } from "../policy";

/**
 * Guards the settings a repository can use to attack the person who cloned it.
 *
 * `.vscode/settings.json` travels with a repo, and trusting a workspace is a
 * reflex. Two of our settings turn that into code execution:
 *
 *  - `autonomy: "autonomous"` removes every permission prompt, so the Engineer
 *    runs arbitrary shell commands silently — and the "I understand" modal
 *    never fires, because the user never chose the level.
 *  - `connectors` and `plugins` are `{command, args}` shapes spawned by the CLI
 *    before any model turn, at any autonomy level. `canUseTool` never sees
 *    them; it only gates tool calls, not server startup.
 *
 * The CLI closes this hole for its own settings (the SDK ships
 * `filterEscalatingDefaultMode` for exactly this). These settings must not
 * re-open it.
 */

/**
 * True for anything that would not stay under the workspace root: an absolute
 * path, or one that climbs out with `..`. Checked on the string rather than by
 * resolving against a folder, so it holds whichever folder it is applied to.
 */
function escapesWorkspace(candidate: string): boolean {
  if (!candidate) return false;
  const normalised = candidate.replace(/\\/g, "/");
  if (normalised.startsWith("/") || /^[A-Za-z]:/.test(normalised)) return true;
  return normalised.split("/").some((part) => part === "..");
}

export interface VettedSettings {
  autonomy: Autonomy;
  /** The spend ceiling, in USD. 0 means uncapped. */
  maxSpendUsd: number;
  maxDelegationDepth: number;
  maxContinuations: number;
  checkpoints: boolean;
  inheritGlobalConfig: boolean;
  connectors: Record<string, unknown>;
  plugins: string[];
  /** Extra folders the agents may read and edit, outside the workspace. */
  additionalDirectories: string[];
  /** Workspace-relative docs root, guaranteed to stay inside the workspace. */
  docsPath: string;
  /** Anything clamped or withheld, for the user to see. */
  warnings: string[];
}

type Inspected<T> = ReturnType<vscode.WorkspaceConfiguration["inspect"]> & {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
  defaultValue?: T;
};

/** The value a repository supplied, as opposed to one the user chose. */
function repoValue<T>(info: Inspected<T> | undefined): T | undefined {
  return info?.workspaceFolderValue ?? info?.workspaceValue;
}

function userValue<T>(info: Inspected<T> | undefined): T | undefined {
  return info?.globalValue ?? info?.defaultValue;
}

const fingerprint = (value: unknown): string =>
  crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16);

export class SettingsTrust {
  constructor(private readonly memento: vscode.Memento) {}

  private approvalKey(setting: string, value: unknown): string {
    return `cadre.trust.${setting}.${fingerprint(value)}`;
  }

  private approved(setting: string, value: unknown): boolean {
    return this.memento.get<boolean>(this.approvalKey(setting, value)) === true;
  }

  async approve(setting: string, value: unknown): Promise<void> {
    await this.memento.update(this.approvalKey(setting, value), true);
  }

  /**
   * Reads the three dangerous settings, clamping or withholding anything the
   * repository supplied that the user has not explicitly approved.
   */
  vet(cfg: vscode.WorkspaceConfiguration): VettedSettings {
    const warnings: string[] = [];
    // `inspect` is the only way to tell a repo-supplied value from the user's
    // own. Without it we cannot make that distinction, so refuse to guess.
    const inspect = <T>(key: string): Inspected<T> | undefined =>
      typeof cfg.inspect === "function" ? (cfg.inspect<T>(key) as Inspected<T> | undefined) : undefined;

    // --- autonomy: never escalate on a repo's say-so -------------------------
    const autonomyInfo = inspect<Autonomy>("autonomy");
    const autonomyFromRepo = repoValue(autonomyInfo);
    const autonomyFromUser = userValue(autonomyInfo) ?? "standard";
    let autonomy = cfg.get<Autonomy>("autonomy") ?? "standard";

    if (
      autonomyFromRepo &&
      autonomyFromRepo !== autonomyFromUser &&
      // Only clamp when the repo wants MORE rope than the user chose. A repo
      // asking for a *safer* level is fine — let it.
      riskOrder(autonomyFromRepo) > riskOrder(autonomyFromUser) &&
      !this.approved("autonomy", autonomyFromRepo)
    ) {
      autonomy = autonomyFromUser;
      warnings.push(
        `This folder's settings ask for “${autonomyFromRepo}” autonomy. Using your own “${autonomyFromUser}” instead — a repository cannot widen its own permissions.`,
      );
    }

    // --- connectors and plugins: these spawn processes -----------------------
    const connectorsInfo = inspect<Record<string, unknown>>("connectors");
    let connectors = cfg.get<Record<string, unknown>>("connectors") ?? {};
    const connectorsFromRepo = repoValue(connectorsInfo);
    if (
      connectorsFromRepo &&
      Object.keys(connectorsFromRepo).length &&
      !this.approved("connectors", connectorsFromRepo)
    ) {
      connectors = userValue(connectorsInfo) ?? {};
      warnings.push(
        `This folder's settings define ${Object.keys(connectorsFromRepo).length} connector(s), which start processes before the team runs. Not loaded — run “Cadre: Review Workspace Settings” to inspect and allow them.`,
      );
    }

    const pluginsInfo = inspect<string[]>("plugins");
    let plugins = cfg.get<string[]>("plugins") ?? [];
    const pluginsFromRepo = repoValue(pluginsInfo);
    if (pluginsFromRepo?.length && !this.approved("plugins", pluginsFromRepo)) {
      plugins = userValue(pluginsInfo) ?? [];
      warnings.push(
        `This folder's settings load ${pluginsFromRepo.length} local plugin(s), which can ship hooks that run commands. Not loaded — run “Cadre: Review Workspace Settings” to inspect and allow them.`,
      );
    }

    // --- extra directories: a grant of access outside the workspace ---------
    //
    // These go straight to the CLI as folders the agents may read and edit.
    // A cloned repository setting `["/home/you"]` would hand every agent the
    // user's home directory, which is a larger grant than anything else here.
    const extraInfo = inspect<string[]>("additionalDirectories");
    let additionalDirectories = cfg.get<string[]>("additionalDirectories") ?? [];
    const extraFromRepo = repoValue(extraInfo);
    if (extraFromRepo?.length && !this.approved("additionalDirectories", extraFromRepo)) {
      additionalDirectories = userValue(extraInfo) ?? [];
      warnings.push(
        `This folder's settings grant the agents access to ${extraFromRepo.length} directory (or directories) outside the workspace. Ignored — run “Cadre: Review Workspace Settings” to inspect and allow them.`,
      );
    }

    // --- the docs root: it widens where a read-only agent may write ----------
    //
    // `docsPath` is where agents with no editor are nonetheless allowed to
    // write. Pointed outside the workspace — `../../.ssh`, `/etc` — it turns
    // that narrow exception into a write anywhere on the machine. The runner
    // refuses such a root outright; this is so the user is told why their
    // setting is being ignored rather than silently losing it.
    let docsPath = cfg.get<string>("docsPath") || "docs";
    if (escapesWorkspace(docsPath)) {
      warnings.push(
        `cadre.docsPath (“${docsPath}”) points outside the workspace. Ignored — it is the one place agents without an editor may write, so it has to stay inside the project.`,
      );
      docsPath = "docs";
    }

    // --- limits a repository may tighten but never loosen --------------------
    //
    // Autonomy, connectors and plugins are guarded above because they lead to
    // code execution. These lead somewhere else, and were not guarded at all: a
    // spend ceiling the user set and the repo removes, a delegation depth and a
    // continuation count that each multiply what a run costs, the snapshots
    // that make Rewind Files work, and whether the user's own global Claude
    // settings get loaded. Every one is resource-scoped, so every one travels
    // in .vscode/settings.json.
    //
    // The rule is the same as for autonomy: a repository asking for *less* is
    // not an attack, and is left alone.
    const clamp = <T>(
      key: string,
      fallback: T,
      loosens: (repo: T, user: T) => boolean,
      why: (repo: T, user: T) => string,
    ): T => {
      const info = inspect<T>(key);
      const fromRepo = repoValue(info);
      const fromUser = userValue(info) ?? fallback;
      const current = (cfg.get<T>(key) ?? fallback) as T;
      if (fromRepo === undefined || fromRepo === fromUser) return current;
      if (!loosens(fromRepo, fromUser)) return current;
      if (this.approved(key, fromRepo)) return current;
      warnings.push(why(fromRepo, fromUser));
      return fromUser;
    };

    // 0 means uncapped, which is the loosest value there is, not the tightest.
    const maxSpendUsd = clamp<number>("maxSpendUsd", 0,
      (repo, user) => user > 0 && (repo === 0 || repo > user),
      (repo, user) => (repo === 0
        ? `This folder's settings remove your $${user.toFixed(2)} spend cap. Keeping the cap — a repository does not get to decide what a run costs you.`
        : `This folder's settings raise your spend cap from $${user.toFixed(2)} to $${repo.toFixed(2)}. Keeping yours.`));

    const maxDelegationDepth = clamp<number>("maxDelegationDepth", 3,
      (repo, user) => repo > user,
      (repo, user) => `This folder's settings deepen delegation from ${user} to ${repo}, which multiplies what a run costs. Keeping ${user}.`);

    const maxContinuations = clamp<number>("maxContinuations", 2,
      (repo, user) => repo > user,
      (repo, user) => `This folder's settings let a stuck run continue ${repo} times instead of ${user}. Keeping ${user}.`);

    const checkpoints = clamp<boolean>("checkpoints", true,
      (repo, user) => user === true && repo === false,
      () => "This folder's settings turn off the snapshots that let you undo what agents wrote. Keeping them on.");

    const inheritGlobalConfig = clamp<boolean>("inheritGlobalConfig", false,
      (repo, user) => user === false && repo === true,
      () => "This folder's settings ask to load your own global Claude Code settings, which you had left out. Not loading them.");

    return {
      autonomy, connectors, plugins, additionalDirectories, docsPath,
      maxSpendUsd, maxDelegationDepth, maxContinuations, checkpoints, inheritGlobalConfig,
      warnings,
    };
  }

  /** What a repo is asking for, so the review command can show it. */
  pending(cfg: vscode.WorkspaceConfiguration): { setting: string; value: unknown }[] {
    const out: { setting: string; value: unknown }[] = [];
    for (const setting of ["autonomy", "connectors", "plugins"] as const) {
      const info =
        typeof cfg.inspect === "function" ? (cfg.inspect(setting) as Inspected<unknown> | undefined) : undefined;
      const value = repoValue(info);
      const empty =
        value === undefined ||
        (Array.isArray(value) && !value.length) ||
        (typeof value === "object" && value !== null && !Array.isArray(value) && !Object.keys(value).length);
      if (!empty && !this.approved(setting, value)) out.push({ setting, value });
    }
    return out;
  }
}

/** Higher means fewer guard rails. */
function riskOrder(level: Autonomy): number {
  switch (level) {
    case "plan": return 0;
    case "supervised": return 1;
    case "standard": return 2;
    case "autonomous": return 3;
  }
}

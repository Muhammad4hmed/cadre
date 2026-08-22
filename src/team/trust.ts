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

export interface VettedSettings {
  autonomy: Autonomy;
  connectors: Record<string, unknown>;
  plugins: string[];
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

    return { autonomy, connectors, plugins, warnings };
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

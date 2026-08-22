import * as vscode from "vscode";

export type BillingMode = "subscription" | "apiKey";

const SECRET_KEY = "cadre.anthropicApiKey";

export type BillingStatus =
  | { ok: true; mode: BillingMode; describe: string }
  | { ok: false; mode: BillingMode; reason: string; remedy: string };

/**
 * Chooses how the team's work is paid for.
 *
 * The CLI resolves credentials itself, so the only lever is the environment we
 * hand the subprocess. Two sharp edges drive the design here:
 *
 *  - `env` REPLACES the child environment rather than extending it, so every
 *    value must be spread from process.env or the CLI loses PATH and HOME.
 *  - An `ANTHROPIC_API_KEY` exported in the user's shell outranks their OAuth
 *    login. Subscription mode therefore has to unset it explicitly, or the user
 *    silently gets billed per-token while believing they are on their plan.
 */
export class Billing {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  get mode(): BillingMode {
    return vscode.workspace.getConfiguration("cadre").get<BillingMode>("billing") ?? "subscription";
  }

  async setMode(mode: BillingMode): Promise<void> {
    await vscode.workspace
      .getConfiguration("cadre")
      .update("billing", mode, vscode.ConfigurationTarget.Global);
  }

  getApiKey(): Thenable<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }

  async storeApiKey(key: string): Promise<void> {
    await this.secrets.store(SECRET_KEY, key.trim());
  }

  async clearApiKey(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }

  /** The environment handed to the CLI subprocess. */
  async environment(): Promise<Record<string, string | undefined>> {
    const base = { ...process.env } as Record<string, string | undefined>;

    if (this.mode === "apiKey") {
      const key = await this.getApiKey();
      if (key) base.ANTHROPIC_API_KEY = key;
      return base;
    }

    // Subscription: strip anything that would outrank the OAuth login.
    base.ANTHROPIC_API_KEY = undefined;
    base.ANTHROPIC_AUTH_TOKEN = undefined;
    return base;
  }

  async status(): Promise<BillingStatus> {
    const mode = this.mode;

    if (mode === "apiKey") {
      const key = await this.getApiKey();
      if (!key) {
        return {
          ok: false,
          mode,
          reason: "API-key billing is selected but no key is stored.",
          remedy: "Run “Cadre: Set API Key”.",
        };
      }
      return { ok: true, mode, describe: `API key ${maskKey(key)}` };
    }

    if (process.env.ANTHROPIC_API_KEY) {
      // Not fatal — we strip it — but the user should know why their shell var
      // appears to be ignored.
      return { ok: true, mode, describe: "Claude subscription (shell ANTHROPIC_API_KEY ignored)" };
    }
    return { ok: true, mode, describe: "Claude subscription" };
  }

  /** Prompts for a key and stores it. Returns false if the user cancelled. */
  async promptForApiKey(): Promise<boolean> {
    const key = await vscode.window.showInputBox({
      title: "Anthropic API key",
      prompt: "Stored in VS Code's encrypted secret storage, never in settings.json.",
      password: true,
      ignoreFocusOut: true,
      placeHolder: "sk-ant-…",
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return "A key is required.";
        if (!trimmed.startsWith("sk-ant-")) return "Anthropic keys start with “sk-ant-”.";
        if (trimmed.length < 20) return "That looks too short to be a full key.";
        return undefined;
      },
    });

    if (!key) return false;
    await this.storeApiKey(key);
    if (this.mode !== "apiKey") await this.setMode("apiKey");
    return true;
  }
}

function maskKey(key: string): string {
  return key.length <= 12 ? "••••" : `${key.slice(0, 11)}…${key.slice(-4)}`;
}

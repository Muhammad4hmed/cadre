import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

/**
 * Reads the CLI's own view of who is signed in. This is the same credential the
 * team runs on, so it is the only authoritative answer — the extension never
 * holds the subscription login itself.
 */
export async function readAuthStatus(executablePath: string): Promise<AuthStatus | undefined> {
  try {
    const { stdout } = await run(executablePath, ["auth", "status", "--json"], { timeout: 30_000 });
    const parsed = JSON.parse(stdout) as AuthStatus;
    return typeof parsed?.loggedIn === "boolean" ? parsed : undefined;
  } catch {
    // Older CLIs may not have `auth status`; absence is not an error worth raising.
    return undefined;
  }
}

export async function logout(executablePath: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout, stderr } = await run(executablePath, ["auth", "logout"], { timeout: 60_000 });
    return { ok: true, detail: (stdout || stderr).trim() || "Logged out." };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** One line for the header chip and the settings hub. */
export function describeAuth(status: AuthStatus | undefined): string {
  if (!status) return "unknown";
  if (!status.loggedIn) return "signed out";
  const who = status.email ?? status.orgName ?? status.authMethod ?? "signed in";
  const plan = status.subscriptionType ? ` · ${status.subscriptionType}` : "";
  return `${who}${plan}`;
}

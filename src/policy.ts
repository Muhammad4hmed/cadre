import type { Options, PermissionMode, Settings } from "@anthropic-ai/claude-agent-sdk";

/**
 * How much rope the team gets. Named for what the user experiences, not for the
 * SDK's permission modes underneath.
 */
export type Autonomy = "supervised" | "standard" | "autonomous" | "plan";

export interface Policy {
  permissionMode: PermissionMode;
  managedSettings: Settings;
  allowDangerouslySkipPermissions?: boolean;
  /** One line for the status bar. */
  describe: string;
}

/**
 * Files that must never be read into an agent's context, at any autonomy level.
 * Deny beats every other rule tier, so this holds even on "autonomous".
 */
// Three lists guard these files and they must agree: this one binds the Read
// tool, PROTECTED catches anything that reaches a file another way, and
// PROTECTED_EXCLUDES keeps them out of a diff. This one had fallen behind the
// other two — it covered .env only at the root, and did not cover .netrc,
// .npmrc or .pypirc at all, so a file refused to git_view could still be read
// directly. The recursive forms sit alongside the root ones because a leading
// double-star does not universally match zero directories.
const NEVER_READ = [
  "Read(./.env)",
  "Read(./.env.*)",
  "Read(**/.env)",
  "Read(**/.env.*)",
  "Read(**/.ssh/**)",
  "Read(**/.aws/credentials)",
  "Read(**/.claude/.credentials.json)",
  "Read(**/id_rsa)",
  "Read(**/id_ed25519)",
  "Read(**/*.pem)",
  // Auth tokens and passwords, as plainly as any of the above: an npm
  // _authToken, a PyPI password, a machine login.
  "Read(./.netrc)",
  "Read(**/.netrc)",
  "Read(./.npmrc)",
  "Read(**/.npmrc)",
  "Read(./.pypirc)",
  "Read(**/.pypirc)",
];

/**
 * The same set, as a predicate, for the paths the CLI's deny rules cannot see.
 *
 * `NEVER_READ` binds the Read tool. Anything that reaches a file another way
 * has to check for itself — `git_view show .env` printed a live secret straight
 * past the deny list until this existed, which made the promise that these are
 * "denied at every level" simply untrue.
 *
 * Deliberately matched on the path's shape rather than by resolving it: a file
 * that is not there yet, or is only in git history, still must not be printed.
 */
const PROTECTED = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.claude\/\.credentials\.json$/i,
  /(^|\/)id_rsa(\.|$)/i,
  /(^|\/)id_ed25519(\.|$)/i,
  /\.pem$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
];

export function isProtectedPath(candidate: string): boolean {
  const normalised = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
  return PROTECTED.some((rule) => rule.test(normalised));
}

/** Git pathspecs that keep protected files out of a diff. */
export const PROTECTED_EXCLUDES = [
  ":(exclude,glob).env",
  ":(exclude,glob).env.*",
  ":(exclude,glob)**/.env",
  ":(exclude,glob)**/.env.*",
  ":(exclude,glob)**/.ssh/**",
  ":(exclude,glob)**/.aws/credentials",
  ":(exclude,glob)**/.claude/.credentials.json",
  ":(exclude,glob)**/id_rsa*",
  ":(exclude,glob)**/id_ed25519*",
  ":(exclude,glob)**/*.pem",
  ":(exclude,glob)**/.netrc",
  ":(exclude,glob)**/.npmrc",
  ":(exclude,glob)**/.pypirc",
];

/**
 * Commands worth stopping for. Asking about *every* shell command instead buries
 * the dangerous ones in a stream of prompts for `ls` and `--version`, and the
 * user learns to click through — which is worse than not asking at all.
 *
 * Everything not listed falls through to the CLI's own safety classifier, which
 * already prompts for things it judges destructive.
 */
const RISKY_BASH = [
  "Bash(rm:*)", "Bash(rmdir:*)", "Bash(mv:*)",
  "Bash(sudo:*)", "Bash(su:*)", "Bash(chmod:*)", "Bash(chown:*)",
  "Bash(curl:*)", "Bash(wget:*)", "Bash(nc:*)", "Bash(ssh:*)", "Bash(scp:*)",
  "Bash(dd:*)", "Bash(mkfs:*)", "Bash(kill:*)", "Bash(pkill:*)",
  "Bash(git push:*)", "Bash(git reset:*)", "Bash(git clean:*)", "Bash(git checkout:*)",
  "Bash(npm publish:*)", "Bash(npm install:*)", "Bash(pnpm add:*)", "Bash(yarn add:*)",
  "Bash(pip install:*)", "Bash(pip3 install:*)", "Bash(uv add:*)",
  "Bash(apt:*)", "Bash(apt-get:*)", "Bash(brew:*)", "Bash(systemctl:*)", "Bash(docker:*)",
];

const ALL_SHELL = ["Bash", "WebFetch"];
const EDITING = ["Edit", "Write", "NotebookEdit"];

/**
 * Turns an autonomy level into an enforceable policy.
 *
 * The important mechanism: `managedSettings` is a higher policy tier than the
 * user's own settings files, and the SDK filters it restrictive-only — it can
 * tighten but never widen. Verified empirically (scripts/probe-permissions.mjs):
 * a `permissions.ask` rule here forces a prompt even when the user's global
 * settings carry a blanket `Bash(*)` allow. Without it, a user who has granted
 * Claude Code broad permissions would get an autonomous Engineer that can run
 * anything, with no prompt, forever.
 */
export function policyFor(autonomy: Autonomy): Policy {
  const base: Settings = { permissions: { deny: NEVER_READ } };

  switch (autonomy) {
    case "plan":
      return {
        permissionMode: "plan",
        managedSettings: base,
        describe: "Plan only — the team designs but changes nothing",
      };

    case "supervised":
      return {
        permissionMode: "default",
        managedSettings: {
          permissions: { deny: NEVER_READ, ask: [...ALL_SHELL, ...EDITING] },
        },
        describe: "Supervised — every edit and command needs your approval",
      };

    case "autonomous":
      return {
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        managedSettings: base,
        describe: "Autonomous — no prompts (secrets still blocked)",
      };

    case "standard":
    default:
      return {
        permissionMode: "acceptEdits",
        managedSettings: {
          permissions: { deny: NEVER_READ, ask: [...RISKY_BASH, "WebFetch"] },
        },
        describe: "Standard — edits flow, risky commands ask",
      };
  }
}

/**
 * Which settings files the CLI is allowed to load.
 *
 * `'project'` is required for CLAUDE.md. The user's global
 * `~/.claude/settings.json` is excluded by default: it commonly carries blanket
 * allow-rules that were reasonable for hand-driven Claude Code but are not
 * reasonable for an agent looping on its own. `managedSettings` would override
 * them anyway, but not loading them keeps the effective policy legible.
 */
export function settingSourcesFor(inheritGlobal: boolean): Options["settingSources"] {
  return inheritGlobal ? ["user", "project", "local"] : ["project", "local"];
}

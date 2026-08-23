import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * The SDK spawns a native `claude` binary as a subprocess. It ships as a
 * per-platform optionalDependency (~340 MB each), so rather than rely on the
 * SDK's own resolution we locate it explicitly and pass
 * `pathToClaudeCodeExecutable`. That also keeps us working when the extension
 * is bundled and `require.resolve` can't see into the SDK's package layout.
 */
/**
 * Resolution is cached, because it is not cheap and it is called constantly.
 *
 * Finding the binary on PATH means `execFileSync("which")` — a synchronous
 * subprocess on the extension host thread — and the Marketplace build has no
 * bundled binary to short-circuit it. That ran on every readiness check, so
 * every configuration change, folder change and screen publish blocked the UI
 * on a process spawn.
 *
 * Keyed on the configured path so changing the setting re-resolves, and the
 * cached path is re-checked for existence, which is a stat rather than a spawn.
 */
let cached: { configured: string; resolved: string | undefined } | undefined;

/** Called when the setting changes, or when a run fails to launch. */
export function clearExecutableCache(): void {
  cached = undefined;
}

export function resolveClaudeExecutable(log: vscode.LogOutputChannel): string | undefined {
  const configured = vscode.workspace.getConfiguration("cadre").get<string>("claudeExecutablePath") ?? "";

  if (cached && cached.configured === configured) {
    // Still there? A stat is cheap; a stale path that was uninstalled under us
    // would otherwise fail much later, as an unexplained spawn error.
    if (!cached.resolved || fs.existsSync(cached.resolved)) return cached.resolved;
    cached = undefined;
  }

  const found = locate(log, configured);
  cached = { configured, resolved: found };
  return found;
}

function locate(log: vscode.LogOutputChannel, configured: string): string | undefined {
  if (configured) {
    if (fs.existsSync(configured)) {
      log.info(`claude executable: ${configured} (from settings)`);
      return configured;
    }
    log.warn(`cadre.claudeExecutablePath points at a missing file: ${configured}`);
  }

  for (const [source, candidate] of candidates()) {
    if (candidate && fs.existsSync(candidate)) {
      log.info(`claude executable: ${candidate} (${source})`);
      return candidate;
    }
  }

  log.error("no claude executable found");
  return undefined;
}

function* candidates(): Generator<[string, string | undefined]> {
  yield ["bundled SDK binary", bundledBinary()];
  yield ["PATH", onPath()];

  const home = os.homedir();
  yield ["~/.local/bin", path.join(home, ".local", "bin", exeName())];
  yield ["~/.claude/local", path.join(home, ".claude", "local", exeName())];
  yield ["/usr/local/bin", path.join("/usr", "local", "bin", exeName())];
  yield ["/opt/homebrew/bin", path.join("/opt", "homebrew", "bin", exeName())];
}

function exeName(): string {
  return process.platform === "win32" ? "claude.exe" : "claude";
}

/**
 * The SDK's optionalDependencies are named
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]`. On Linux we try
 * the musl build too, since Alpine-based remotes won't run the glibc one.
 */
function bundledBinary(): string | undefined {
  const suffixes = process.platform === "linux"
    ? [`${process.platform}-${process.arch}`, `${process.platform}-${process.arch}-musl`]
    : [`${process.platform}-${process.arch}`];

  for (const suffix of suffixes) {
    try {
      return require.resolve(`@anthropic-ai/claude-agent-sdk-${suffix}/${exeName()}`);
    } catch {
      // optionalDependency not installed for this platform; try the next.
    }
  }
  return undefined;
}

function onPath(): string | undefined {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(finder, ["claude"], {
      encoding: "utf8",
      // This is synchronous and it runs on the extension host thread, so a
      // lookup that does not return freezes the whole editor, every extension
      // in it, not only this one. `where` walks every PATH entry on Windows,
      // which includes network drives that may be gone. Three seconds is a
      // long time for a PATH lookup and no time at all to be frozen for; on
      // expiry this throws, and a missing executable is already handled.
      timeout: 3_000,
      windowsHide: true,
      // Otherwise the child's stderr is inherited and a noisy `which` prints
      // into the host's output.
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)[0]
      .trim();
    return found || undefined;
  } catch {
    return undefined;
  }
}

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
export function resolveClaudeExecutable(log: vscode.LogOutputChannel): string | undefined {
  const configured = vscode.workspace.getConfiguration("cadre").get<string>("claudeExecutablePath");
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
    const found = execFileSync(finder, ["claude"], { encoding: "utf8" })
      .split(/\r?\n/)[0]
      .trim();
    return found || undefined;
  } catch {
    return undefined;
  }
}

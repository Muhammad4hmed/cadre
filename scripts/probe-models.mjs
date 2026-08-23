/** Asks the CLI what models it actually supports. No prompt is ever sent. */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";

const exe = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
async function* nothing() { /* never yields: we only want the handshake */ }

const q = query({ prompt: nothing(), options: { pathToClaudeCodeExecutable: exe, cwd: process.cwd() } });
try {
  const models = await q.supportedModels();
  console.log(`${models.length} models\n`);
  for (const m of models) {
    console.log(
      `  ${String(m.value).padEnd(22)} ${String(m.displayName).padEnd(24)}` +
      ` effort=${m.supportsEffort ? (m.supportedEffortLevels ?? []).join("/") : "no"}` +
      `${m.resolvedModel ? `  → ${m.resolvedModel}` : ""}`,
    );
  }
} finally {
  try { q.close(); } catch { /* already gone */ }
}
process.exit(0);

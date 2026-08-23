/** Asks the CLI which skills and slash commands it actually has. No prompt sent. */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";

const exe = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
async function* nothing() { /* handshake only */ }

const q = query({
  prompt: nothing(),
  options: { pathToClaudeCodeExecutable: exe, cwd: process.argv[2] ?? process.cwd(), ...(process.env.SKILLS === "all" ? { skills: "all" } : process.env.SKILLS === "none" ? { skills: [] } : {}) },
});
try {
  const commands = await q.supportedCommands();
  console.log(`${commands.length} commands\n`);
  const skillish = commands.filter((c) => !/^(clear|help|exit|quit|login|logout|status|cost|usage|model|config|doctor|mcp|resume|compact|context|vim|terminal-setup|install|release-notes|bug|pr-comments|review|memory|add-dir|hooks|ide|migrate|permissions|privacy|todos|export|agents|output-style|statusline|plugin|sandbox|rewind|upgrade|feedback|init)$/.test(c.name));
  for (const c of skillish.slice(0, 30)) {
    console.log(`  /${c.name.padEnd(26)} ${String(c.description ?? "").slice(0, 70)}`);
  }
  console.log(`\n(${skillish.length} look like skills, ${commands.length - skillish.length} are built-in CLI commands)`);
} finally {
  try { q.close(); } catch { /* gone */ }
}
process.exit(0);

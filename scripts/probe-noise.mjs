import { query } from "@anthropic-ai/claude-agent-sdk";
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const exe = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);

const RISKY = ["Bash(rm:*)","Bash(sudo:*)","Bash(curl:*)","Bash(git push:*)","Bash(npm install:*)"];
const DENY  = ["Read(./.env)","Read(**/.ssh/**)"];

async function probe(label, command, ask) {
  let prompts = 0;
  const q = query({
    prompt: `Run exactly this with the Bash tool, nothing else: ${command}`,
    options: {
      cwd: "/tmp", pathToClaudeCodeExecutable: exe,
      model: "claude-opus-5", effort: "low", maxTurns: 3,
      permissionMode: "acceptEdits",
      settingSources: ["project", "local"],
      managedSettings: { permissions: { deny: DENY, ask } },
      systemPrompt: { type: "preset", preset: "claude_code" },
      canUseTool: async (n, input) => { if (n === "Bash") prompts++; return { behavior: "allow", updatedInput: input }; },
    },
  });
  for await (const m of q) if (m.type === "result") break;
  console.log(`${label.padEnd(40)} prompts=${prompts}`);
  return prompts;
}

console.log("OLD policy (ask: everything):");
const oldBenign = await probe("  ls -la", "ls -la", ["Bash","WebFetch"]);
console.log("\nNEW policy (ask: risky only):");
const newBenign = await probe("  ls -la", "ls -la", RISKY);
const newRisky  = await probe("  rm -f /tmp/ai-team-probe-nonexistent", "rm -f /tmp/ai-team-probe-nonexistent", RISKY);

console.log("\n=== VERDICT ===");
console.log(`${oldBenign > 0 ? "PASS" : "FAIL"}  old policy prompted for a benign command (the friction)`);
console.log(`${newBenign === 0 ? "PASS" : "FAIL"}  new policy does NOT prompt for 'ls'`);
console.log(`${newRisky > 0 ? "PASS" : "FAIL"}  new policy still prompts for 'rm'`);
process.exit(newBenign === 0 && newRisky > 0 ? 0 : 1);

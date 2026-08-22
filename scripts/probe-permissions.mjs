import { query } from "@anthropic-ai/claude-agent-sdk";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const exe = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);

async function probe(label, extra) {
  let prompts = 0, ran = false, denials = 0;
  const q = query({
    prompt: "Run exactly `echo PERMPROBE` with the Bash tool. Nothing else.",
    options: {
      cwd: "/home/ahmed/Desktop/ai-team/sandbox",
      pathToClaudeCodeExecutable: exe,
      model: "claude-opus-5", effort: "low", maxTurns: 3,
      permissionMode: "default",
      systemPrompt: { type: "preset", preset: "claude_code" },
      canUseTool: async (name, input) => {
        if (name === "Bash") prompts++;
        return { behavior: "allow", updatedInput: input };
      },
      ...extra,
    },
  });
  for await (const m of q) {
    if (m.type === "assistant" && m.parent_tool_use_id === null) {
      for (const b of m.message.content) if (b.type === "tool_use" && b.name === "Bash") ran = true;
    }
    if (m.type === "system" && m.subtype === "permission_denied") denials++;
    if (m.type === "result") break;
  }
  console.log(`${label.padEnd(46)} bash_called=${ran}  canUseTool_prompts=${prompts}  auto_denied=${denials}`);
  return prompts;
}

console.log("Does the extension actually control permissions, or does the user's Bash(*) win?\n");
const a = await probe("A inherit user settings (current code)", { settingSources: ["user", "project", "local"] });
const b = await probe("B project only (drops global Bash(*))", { settingSources: ["project"] });
const c = await probe("C project only + managedSettings ask", {
  settingSources: ["project"],
  managedSettings: { permissions: { ask: ["Bash"], deny: ["Read(./.env)", "Read(./.git/**)"] } },
});
const d = await probe("D inherit user + managedSettings ask", {
  settingSources: ["user", "project", "local"],
  managedSettings: { permissions: { ask: ["Bash"] } },
});

console.log("\n=== VERDICT ===");
console.log(`A prompted: ${a > 0} ${a === 0 ? "(user's Bash(*) bypasses our gate — as suspected)" : ""}`);
console.log(`B prompted: ${b > 0}`);
console.log(`C prompted: ${c > 0}`);
console.log(`D prompted: ${d > 0} ${d > 0 ? "(managedSettings ask CAN override an inherited allow)" : "(ask rule did NOT beat the inherited allow)"}`);

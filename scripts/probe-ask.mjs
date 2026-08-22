/** Does the CLI accept answers supplied on updatedInput from canUseTool? */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const exe = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);

let asked = null, supplied = null, text = "";
const q = query({
  prompt: "Use the AskUserQuestion tool to ask me exactly one question: whether my deployment target is 'On-device' or 'Server'. Give exactly those two options. After I answer, reply with only: TARGET=<my answer>",
  options: {
    cwd: "/tmp", pathToClaudeCodeExecutable: exe,
    model: "claude-opus-5", effort: "low", maxTurns: 4,
    permissionMode: "default",
    settingSources: [],
    tools: ["AskUserQuestion"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    canUseTool: async (name, input) => {
      if (name !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };
      asked = input;
      const question = input.questions?.[0]?.question ?? "";
      // Exactly what the extension now does.
      supplied = { ...input, answers: { [question]: "Server" } };
      return { behavior: "allow", updatedInput: supplied };
    },
  },
});
for await (const m of q) {
  if (m.type === "assistant" && m.parent_tool_use_id === null) {
    for (const b of m.message.content) if (b.type === "text") text += b.text;
  }
  if (m.type === "result") break;
}

console.log("asked:", asked ? JSON.stringify(asked.questions?.[0]?.question) : "(tool never called)");
console.log("model replied:", JSON.stringify(text.trim().slice(0, 120)));
console.log();
const gotIt = /TARGET\s*=\s*Server/i.test(text);
console.log(`${asked ? "PASS" : "FAIL"}  the tool was invoked`);
console.log(`${gotIt ? "PASS" : "FAIL"}  the model received the answer we supplied`);
process.exit(asked && gotIt ? 0 : 1);

import * as esbuild from "esbuild";
import { baseOptions } from "./esbuild-shared.mjs";
import { createRequire } from "node:module";
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "w-")), "w.cjs");
await esbuild.build({ ...baseOptions({ entry: "scripts/entry-workflow.ts", outfile }), logLevel: "warning" });
const { store } = createRequire(import.meta.url)(outfile);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "twowin-"));
const base = store.createWorkflow(root, "Shared");
store.writeWorkflow(root, {
  ...base,
  entry: "a",
  agents: [{ id: "a", name: "A", role: "", prompt: "original", preset: "readonly", x: 0, y: 0 }],
  edges: [],
});

// Two windows open the same workflow. Both hold the same revision.
const windowA = store.readWorkflow(root, base.id);
const windowB = store.readWorkflow(root, base.id);
console.log(`both windows loaded revision ${windowA.revision}`);

// A renames the agent and saves.
windowA.agents[0].name = "Renamed by A";
store.writeWorkflow(root, windowA);
console.log(`A saved  -> on disk: "${store.readWorkflow(root, base.id).agents[0].name}" rev ${store.readWorkflow(root, base.id).revision}`);

// B, which never saw A's change, autosaves its own edit.
windowB.agents[0].prompt = "changed by B";
store.writeWorkflow(root, windowB);

const final = store.readWorkflow(root, base.id);
console.log(`B saved  -> on disk: "${final.agents[0].name}" / prompt "${final.agents[0].prompt}" rev ${final.revision}`);
console.log(final.agents[0].name === "Renamed by A"
  ? "\n  A's rename survived"
  : "\n  DATA LOSS: A's rename was silently overwritten by B");

import * as esbuild from "esbuild";
import { baseOptions } from "./esbuild-shared.mjs";
import { createRequire } from "node:module";
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "j-")), "j.cjs");
await esbuild.build({ ...baseOptions({ entry: "scripts/entry-workflow.ts", outfile }), logLevel: "warning" });
const { store, model, presets, protocol } = createRequire(import.meta.url)(outfile);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "junkproj-"));
const dir = path.join(root, ".cadre", "workflows");
fs.mkdirSync(dir, { recursive: true });

// Things a person could plausibly leave behind after editing by hand.
const CASES = {
  agents_null:      { name: "X", entry: "a", agents: null, edges: [] },
  agents_string:    { name: "X", entry: "a", agents: "oops", edges: [] },
  edges_null:       { name: "X", entry: "a", agents: [], edges: null },
  no_fields:        {},
  agent_not_object: { name: "X", entry: "a", agents: [null, 42, "x"], edges: [] },
  edge_not_object:  { name: "X", entry: "a", agents: [], edges: [null, 7] },
  name_number:      { name: 42, entry: "a", agents: [], edges: [] },
  entry_object:     { name: "X", entry: {}, agents: [], edges: [] },
  agent_no_id:      { name: "X", entry: "a", agents: [{ name: "A" }], edges: [] },
  json_array:       [1, 2, 3],
  json_string:      "just a string",
};

for (const [id, body] of Object.entries(CASES)) {
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(body));
}

console.log("--- listWorkflows over a directory of junk:");
try {
  const list = store.listWorkflows(root);
  console.log(`   survived, listed ${list.length} of ${Object.keys(CASES).length}`);
} catch (e) { console.log("   THREW:", e.message.slice(0, 100)); }

console.log("--- validate() on each:");
for (const [id, body] of Object.entries(CASES)) {
  try {
    const wf = store.readWorkflow(root, id);
    if (!wf) { console.log(`   ${id.padEnd(18)} unreadable (fine)`); continue; }
    const problems = model.validate(wf);
    console.log(`   ${id.padEnd(18)} ${problems.length} problems, runnable=${model.isRunnable(wf)}`);
  } catch (e) { console.log(`   ${id.padEnd(18)} THREW: ${e.message.slice(0, 70)}`); }
}

/**
 * Runs the real workflow generator against the real CLI. Costs tokens.
 * Usage: node scripts/probe-generate.mjs "describe the pipeline"
 */
import * as esbuild from "esbuild";
import { baseOptions } from "./esbuild-shared.mjs";
import Module, { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";

const stub = { workspace: {}, window: {}, commands: {} };
const ol = Module._load;
Module._load = (r, p, m) => (r === "vscode" ? stub : ol.call(Module, r, p, m));

const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gen-")), "g.cjs");
await esbuild.build({ ...baseOptions({ entry: "src/workflow/generate.ts", outfile }), logLevel: "warning" });
const { generateWorkflow } = createRequire(import.meta.url)(outfile);

const description = process.argv[2] ??
  "Read incoming support tickets, decide which are real bugs, reproduce the bugs against our repo, and draft a reply for each one.";

console.log(`asking for: ${description}\n`);
const result = await generateWorkflow({
  description,
  cwd: process.cwd(),
  executablePath: execFileSync("which", ["claude"], { encoding: "utf8" }).trim(),
  model: "default",
  env: process.env,
  taken: [],
});

console.log(result.note);
if (!result.workflow) process.exit(1);
const wf = result.workflow;
console.log(`\n"${wf.name}" — ${wf.description}\nentry: ${wf.entry}\n`);
for (const a of wf.agents) {
  console.log(`  ${a.id.padEnd(16)} ${a.name.padEnd(16)} ${a.preset.padEnd(9)} prompt=${String(a.prompt.split(/\s+/).length).padStart(4)}w  ${a.role}`);
}
console.log();
for (const e of wf.edges) console.log(`  ${e.from} --${e.kind}--> ${e.to}${e.label ? `  (${e.label})` : ""}`);
console.log(`\n--- a sample prompt (${wf.agents[0].name}) ---\n${wf.agents[0].prompt.slice(0, 700)}`);
process.exit(0);

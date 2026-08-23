import * as esbuild from "esbuild";
import { baseOptions } from "./esbuild-shared.mjs";
import { createRequire } from "node:module";
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tpl-")), "wf.cjs");
await esbuild.build({ ...baseOptions({ entry: "scripts/entry-workflow.ts", outfile: out }), logLevel: "error" });
const { templates, model, presets, protocol } = createRequire(import.meta.url)(out);
let problems = 0;
for (const t of templates.TEMPLATES) {
  const wf = t.build(0);
  const ids = wf.agents.map((a) => a.id);
  const say = (m) => { problems++; console.log(`  ${t.id}: ${m}`); };
  const errs = model.validate(wf);
  if (errs.length) say(`validate -> ${errs.map((e) => e.message ?? e).join("; ")}`);
  if (new Set(ids).size !== ids.length) say("duplicate agent ids");
  if (!ids.includes(wf.entry)) say(`entry "${wf.entry}" is not an agent`);
  for (const e of wf.edges) {
    if (!ids.includes(e.from)) say(`edge from "${e.from}" which does not exist`);
    if (!ids.includes(e.to)) say(`edge to "${e.to}" which does not exist`);
    if (!["delegate", "then"].includes(e.kind)) say(`edge kind "${e.kind}"`);
  }
  for (const a of wf.agents) {
    if (!a.prompt || a.prompt.trim().length < 40) say(`${a.id} has a thin prompt (${(a.prompt||"").length} chars)`);
    if (!a.name) say(`${a.id} has no name`);
    if (a.preset && !["readonly","research","build","full"].includes(a.preset)) say(`${a.id} preset "${a.preset}"`);
    if (/\{\{|\bTODO\b|\bXXX\b|lorem/i.test(a.prompt || "")) say(`${a.id} prompt has a placeholder`);
    // Every agent should be reachable from the entry, or it can never run.
  }
  // Reachability from entry along any arrow.
  const seen = new Set([wf.entry]);
  for (;;) {
    const before = seen.size;
    for (const e of wf.edges) if (seen.has(e.from)) seen.add(e.to);
    if (seen.size === before) break;
  }
  const orphans = ids.filter((id) => !seen.has(id));
  if (orphans.length) say(`unreachable from the entry agent: ${orphans.join(", ")}`);
}
console.log(problems ? `\n${problems} problems across ${templates.TEMPLATES.length} templates` : `\nall ${templates.TEMPLATES.length} templates clean`);

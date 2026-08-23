/**
 * Runs every hermetic suite and reports on exit codes.
 *
 * Grepping for FAIL reads a crashed suite as a pass — which happened, twice.
 * A suite that dies before printing anything is a failure, not silence.
 */
import { spawnSync } from "node:child_process";

const suites = ["verify-workflow", "verify-ui", "verify-lifecycle", "verify-auth", "verify-trust", "verify-tools", "verify-mcp", "verify-webview"];
let total = 0;
let failed = false;

for (const suite of suites) {
  const run = spawnSync("node", [`scripts/${suite}.mjs`], { encoding: "utf8", timeout: 180_000 });
  const out = (run.stdout ?? "") + (run.stderr ?? "");
  const passed = (out.match(/^PASS/gm) ?? []).length;
  const fails = (out.match(/^FAIL/gm) ?? []).length;
  total += passed;

  if (run.status === 0 && fails === 0) {
    // A skip is not a pass. Say so on the line, every time, or a permanently
    // skipped suite reads as coverage that does not exist.
    const skipped = (out.match(/^SKIP/gm) ?? []).length;
    const note = skipped ? "  SKIPPED — not exercised" : "";
    console.log(`  ${suite.padEnd(18)} ${String(passed).padStart(3)} checks${note}`);
    continue;
  }
  failed = true;
  console.log(`  ${suite.padEnd(18)} FAILED (exit ${run.status}, ${fails} failing)`);
  for (const line of out.split("\n").filter((l) => /^FAIL|Error|error:/.test(l)).slice(0, 6)) {
    console.log(`      ${line.trim()}`);
  }
}

console.log(failed ? `\n  ${total} passed, but a suite failed.` : `\n  ${total} checks passed.`);
process.exit(failed ? 1 : 0);

/**
 * Runs every hermetic suite and reports on exit codes.
 *
 * Grepping for FAIL reads a crashed suite as a pass — which happened, twice.
 * A suite that dies before printing anything is a failure, not silence.
 */
import { spawnSync } from "node:child_process";

const suites = ["verify-ui", "verify-lifecycle", "verify-auth", "verify-trust", "verify-tools"];
let total = 0;
let failed = false;

for (const suite of suites) {
  const run = spawnSync("node", [`scripts/${suite}.mjs`], { encoding: "utf8" });
  const out = (run.stdout ?? "") + (run.stderr ?? "");
  const passed = (out.match(/^PASS/gm) ?? []).length;
  const fails = (out.match(/^FAIL/gm) ?? []).length;
  total += passed;

  if (run.status === 0 && fails === 0) {
    console.log(`  ${suite.padEnd(18)} ${String(passed).padStart(3)} checks`);
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

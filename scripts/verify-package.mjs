/**
 * What actually ships.
 *
 * `.vscodeignore` is an allowlist by omission: anything not named stays in. A
 * stray `.cadre/workflows/marketing_team.json` — written into the working tree
 * by the test suite itself — was packaged into the extension users download,
 * and nothing would have noticed. This asks vsce for the real file list and
 * refuses anything that is not deliberately part of the product.
 *
 * Skips loudly rather than failing when vsce is not installed, so a machine
 * without it does not turn red for the wrong reason.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

const checks = [];
const check = (label, ok) => checks.push([label, ok]);

/** Everything a published package is allowed to contain. */
const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/i,
  /^CHANGELOG\.md$/i,
  /^LICENSE(\.md|\.txt)?$/i,
  /^dist\/extension\.js$/,
  /^media\/(team\.js|team\.css|icon\.svg|icon\.png)$/,
  /^media\/screenshots\/[\w.-]+\.(png|jpg|gif)$/,
  /^docs\/[\w./-]+\.md$/,
];

/** Things that must never ship, named so the failure says why. */
const FORBIDDEN = [
  [/^\.cadre\//, "a workflow from someone's working tree"],
  [/^\.github\//, "CI configuration"],
  [/^\.vscode\//, "editor settings"],
  [/^scripts\//, "the test suite"],
  [/^src\//, "TypeScript sources"],
  [/^sandbox\//, "the scratch project"],
  [/^\.shots\//, "the film harness"],
  [/\.map$/, "a source map"],
  [/^media\/demo\.mp4$/, "the demo film"],
  [/^media\/LAUNCH\.md$/, "the launch notes"],
  [/^media\/nano banana\//, "unused launch art"],
  [/^node_modules\//, "dependencies that are bundled instead"],
  [/\.vsix$/, "a package inside a package"],
];

const run = spawnSync("npx", ["vsce", "ls", "--no-dependencies"], { encoding: "utf8" });

console.log("=== package ===");
if (run.status !== 0) {
  console.log("SKIP  vsce would not run — the packaged file list was NOT checked");
  console.log((run.stderr || "").trim().split("\n").slice(0, 3).join("\n"));
  process.exit(0);
}

const files = run.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
check("vsce lists something at all", files.length > 0);

for (const [pattern, why] of FORBIDDEN) {
  const hits = files.filter((f) => pattern.test(f));
  check(`the package does not ship ${why}`, hits.length === 0);
  if (hits.length) console.log(`      ${hits.slice(0, 4).join(", ")}`);
}

const unexpected = files.filter((f) => !ALLOWED.some((p) => p.test(f)));
check("every packaged file is one the product means to ship", unexpected.length === 0);
if (unexpected.length) {
  console.log(`      unexpected: ${unexpected.slice(0, 8).join(", ")}`);
  console.log("      Add it to .vscodeignore, or to ALLOWED here if it belongs.");
}

// The two things without which the extension does not run.
check("the bundle itself is in there", files.includes("dist/extension.js"));
check("...and the webview it loads", files.includes("media/team.js"));

// The suite writes into whatever folder it is pointed at. If it is ever
// pointed back at the repository, this is the file that reappears.
check("the repository has no stray workflow directory", !fs.existsSync(".cadre"));

let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
process.exit(failed ? 1 : 0);

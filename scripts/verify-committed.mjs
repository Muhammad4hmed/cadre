/**
 * Typechecks what is actually committed, not what happens to be lying in the
 * working tree.
 *
 * `npm run typecheck` compiles the files on disk. A source file that is
 * modified but not committed makes that green while CI compiles something else
 * entirely — a declaration present locally and absent from HEAD, and every
 * local signal says fine. That is exactly how 0.19.2 went out red: the type a
 * committed line depended on had never been committed alongside it.
 *
 * HEAD is exported to a temp directory, node_modules is linked in rather than
 * installed, and tsc runs there. Nothing is stashed and the working tree is
 * never touched.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const checks = [];
const check = (label, ok) => checks.push([label, ok]);

console.log("=== committed ===");

const inRepo = spawnSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" }).status === 0;
if (!inRepo) {
  console.log("SKIP  not a git repository — what is committed was NOT checked");
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadre-head-"));
try {
  execFileSync("bash", ["-c", `git archive HEAD | tar -x -C ${JSON.stringify(dir)}`], {
    encoding: "utf8",
  });
} catch (err) {
  console.log(`FAIL  could not export HEAD: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Linked, not installed: this has to be fast enough to run before every push.
fs.symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"));

check("HEAD carries a tsconfig", fs.existsSync(path.join(dir, "tsconfig.json")));
check("HEAD carries the sources", fs.existsSync(path.join(dir, "src", "extension.ts")));

const tsc = spawnSync("npx", ["tsc", "--noEmit"], { cwd: dir, encoding: "utf8", timeout: 300_000 });
const out = ((tsc.stdout ?? "") + (tsc.stderr ?? "")).trim();
check("what is committed compiles", tsc.status === 0);
if (tsc.status !== 0) {
  for (const line of out.split("\n").filter((l) => /error TS/.test(l)).slice(0, 8)) {
    console.log(`      ${line.trim()}`);
  }
  console.log("      A file the working tree has and HEAD does not will look like this.");
}

// Context, not a verdict. A dirty tree is normal while work is in progress,
// and here it is routinely another session's. Failing on someone else's
// unfinished edits would make this cry wolf, and a guard that cries wolf gets
// ignored — which is worse than not having one. It is printed because it is
// almost always the explanation when the check above goes red.
const dirty = spawnSync("git", ["status", "--porcelain", "--", "src", "media", "scripts", "package.json"], {
  encoding: "utf8",
}).stdout.trim();
if (dirty) {
  const lines = dirty.split("\n");
  console.log(`NOTE  ${lines.length} source file${lines.length === 1 ? "" : "s"} not committed:`);
  for (const line of lines.slice(0, 8)) console.log(`      ${line}`);
  console.log("      If the check above is red, one of these is why.");
}

fs.rmSync(dir, { recursive: true, force: true });

let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
process.exit(failed ? 1 : 0);

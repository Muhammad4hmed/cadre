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
  [/^docs\//, "the design document for the product this used to be"],
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
//
// `vsce ls` reports what is on disk and does not run the prepublish build, so
// on a tree that has not been built there is no bundle to find. That is not the
// same as the bundle being excluded, and reporting it as a failure sends the
// reader looking for a packaging bug that is not there. Distinguish the two:
// built-but-missing is a real fault, not-built is a gap in what was checked.
if (fs.existsSync("dist/extension.js")) {
  check("the bundle itself is in there", files.includes("dist/extension.js"));
} else {
  console.log("SKIP  no dist/extension.js on disk — run `npm run build` first;");
  console.log("      whether the bundle would be packaged was NOT checked");
}
check("...and the webview it loads", files.includes("media/team.js"));

// The suite writes into whatever folder it is pointed at. If it is ever
// pointed back at the repository, this is the file that reappears.
check("the repository has no stray workflow directory", !fs.existsSync(".cadre"));

// ---- the manifest and the code have to agree --------------------------------
// A command sitting in the palette that nothing registered fails the moment it
// is clicked, and nothing says so until a user tries it. Neither the compiler
// nor any other suite compares these two lists: one lives in JSON, the other in
// a string literal.
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const ext = fs.readFileSync("src/extension.ts", "utf8");
const declared = (pkg.contributes?.commands ?? []).map((c) => c.command);
const registered = [...ext.matchAll(/registerCommand\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);

check("the manifest declares some commands at all", declared.length > 0);
const unregistered = declared.filter((c) => !registered.includes(c));
check("every command in the palette is registered in code", unregistered.length === 0);
if (unregistered.length) console.log(`      ${unregistered.join(", ")}`);

const undeclared = registered.filter((c) => !declared.includes(c));
check("every registered command is declared, or nothing can reach it", undeclared.length === 0);
if (undeclared.length) console.log(`      ${undeclared.join(", ")}`);

check("no command is registered twice", new Set(registered).size === registered.length);

// Menus and keybindings name command ids too, and a dangling one is a button
// that does nothing.
const pointed = new Set();
for (const group of Object.values(pkg.contributes?.menus ?? {})) {
  for (const item of group ?? []) if (item.command) pointed.add(item.command);
}
for (const k of pkg.contributes?.keybindings ?? []) if (k.command) pointed.add(k.command);
const dangling = [...pointed].filter((c) => !declared.includes(c));
check("every menu entry and keybinding points at a command that exists", dangling.length === 0);
if (dangling.length) console.log(`      ${dangling.join(", ")}`);

// The view id is a string in the manifest and a constant in the code. If they
// drift the panel never binds, and the extension looks like it did not load.
const viewIds = Object.values(pkg.contributes?.views ?? {}).flat().map((v) => v.id);
const codeViewId = /static readonly viewId = "([^"]+)"/.exec(ext)?.[1];
check("the sidebar view the code registers is the one the manifest declares",
  Boolean(codeViewId) && viewIds.includes(codeViewId));
if (codeViewId && !viewIds.includes(codeViewId)) {
  console.log(`      code says ${codeViewId}, manifest says ${viewIds.join(", ")}`);
}

// A default outside its own enum is an invalid setting the first time it is read.
const props = pkg.contributes?.configuration?.properties ?? {};
const badDefault = Object.entries(props).filter(
  ([, v]) => Array.isArray(v.enum) && v.default !== undefined && !v.enum.includes(v.default),
);
check("every enum setting's default is one of its own options", badDefault.length === 0);
if (badDefault.length) console.log(`      ${badDefault.map(([k]) => k).join(", ")}`);

check("every setting has a description, or the settings UI shows a bare key",
  Object.values(props).every((v) => typeof (v.description ?? v.markdownDescription) === "string"));

check("every setting is namespaced under cadre.",
  Object.keys(props).every((k) => k.startsWith("cadre.")));

// ---- the webview's own sandbox ----------------------------------------------
// The panel renders model output. This policy is what stops that output from
// reaching the network or running anything, and nothing asserted it: two other
// suites only use the script tag as a place to cut the file in half.
const cspBlock = /const csp = \[([\s\S]*?)\]\.join/.exec(ext)?.[1] ?? "";
check("the webview declares a content security policy", cspBlock.length > 0);
check("...denying everything by default", /default-src 'none'/.test(cspBlock));
check("...running only scripts that carry the generated nonce",
  /script-src 'nonce-\$\{nonce\}'/.test(cspBlock));
check("...and never allowing inline script or eval",
  !/unsafe-inline|unsafe-eval/.test(cspBlock));
// With default-src 'none' and no connect-src, the panel cannot open a socket:
// whatever a model writes into it stays in the editor.
check("the panel cannot reach the network on its own", !/connect-src/.test(cspBlock));
check("the nonce is generated per render rather than fixed",
  /const nonce = crypto\.randomUUID\(\)/.test(ext));
check("the webview may only load files from media/",
  /localResourceRoots:\s*\[vscode\.Uri\.joinPath\(context\.extensionUri,\s*"media"\)\]/.test(ext));

let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
process.exit(failed ? 1 : 0);

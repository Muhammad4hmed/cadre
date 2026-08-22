/**
 * Unit tests for the auth module.
 *
 * The important property: a status we could not read is never described as
 * signed in. `claude auth status` also reports loggedIn:true for an expired
 * token, so this layer must not be treated as proof of a working credential —
 * only a failed run is.
 */
import * as esbuild from "esbuild";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-team-auth-")), "auth.cjs");
await esbuild.build({
  entryPoints: ["src/auth.ts"], bundle: true, platform: "node", format: "cjs",
  outfile, logLevel: "warning",
});
const { describeAuth, readAuthStatus } = createRequire(import.meta.url)(outfile);

const checks = [];
const check = (label, ok) => checks.push([label, ok]);

check("an unreadable status is 'unknown', never 'signed in'", describeAuth(undefined) === "unknown");
check("an explicit signed-out status says so", describeAuth({ loggedIn: false }) === "signed out");
check("a signed-in status names the account",
  describeAuth({ loggedIn: true, email: "a@b.com", subscriptionType: "max" }) === "a@b.com · max");
check("it falls back to the org when there is no email",
  describeAuth({ loggedIn: true, orgName: "Acme" }) === "Acme");

// A missing binary must resolve to undefined rather than throw or hang.
const missing = await readAuthStatus("/nonexistent/claude-binary");
check("a missing CLI yields undefined, not a crash", missing === undefined);

// Garbage output must not be mistaken for a status.
const fake = path.join(path.dirname(outfile), "fake-cli");
fs.writeFileSync(fake, "#!/bin/sh\necho 'not json'\n");
fs.chmodSync(fake, 0o755);
check("non-JSON output is rejected", (await readAuthStatus(fake)) === undefined);

fs.writeFileSync(fake, "#!/bin/sh\necho '{\"loggedIn\":false}'\n");
const out = await readAuthStatus(fake);
check("a real signed-out payload is parsed", out?.loggedIn === false);

console.log("=== auth ===");
let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
process.exit(failed ? 1 : 0);

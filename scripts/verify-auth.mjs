/**
 * Unit tests for the auth module.
 *
 * The important property: a status we could not read is never described as
 * signed in. `claude auth status` also reports loggedIn:true for an expired
 * token, so this layer must not be treated as proof of a working credential —
 * only a failed run is.
 */
import * as esbuild from "esbuild";
import Module from "node:module";
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

// Billing decides what environment the CLI subprocess runs in, which is the
// only lever there is over how the work gets paid for.
const settings = { "cadre.billing": "subscription" };
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (k) => settings[`cadre.${k}`], update: async () => {} }) },
};
const realLoad = Module._load;
Module._load = (r, p2, m) => (r === "vscode" ? vscodeStub : realLoad.call(Module, r, p2, m));
const billingOut = path.join(path.dirname(outfile), "billing.cjs");
await esbuild.build({
  entryPoints: ["src/billing.ts"], bundle: true, platform: "node", format: "cjs",
  external: ["vscode"], outfile: billingOut, logLevel: "warning",
});
const { Billing } = createRequire(import.meta.url)(billingOut);

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

// ---- what the subprocess is allowed to inherit -----------------------------
// An ANTHROPIC_API_KEY exported in the user's shell outranks their OAuth login.
// If subscription mode does not unset it, the user is billed per token while
// believing they are on their plan — silently, and for as long as it takes them
// to look at an invoice.
{
  const stored = new Map();
  const secrets = {
    get: async (k) => stored.get(k),
    store: async (k, v) => { stored.set(k, v); },
    delete: async (k) => { stored.delete(k); },
  };
  const billing = new Billing(secrets);

  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "sk-from-the-users-shell";
  process.env.ANTHROPIC_AUTH_TOKEN = "token-from-the-users-shell";
  process.env.CADRE_TEST_MARKER = "kept";

  settings["cadre.billing"] = "subscription";
  const onPlan = await billing.environment();
  check("a subscription does not inherit a key from the shell",
    onPlan.ANTHROPIC_API_KEY === undefined);
  check("...nor an auth token", onPlan.ANTHROPIC_AUTH_TOKEN === undefined);
  check("...while the rest of the environment is passed through, or nothing runs",
    onPlan.CADRE_TEST_MARKER === "kept" && typeof onPlan.PATH === "string");

  settings["cadre.billing"] = "apiKey";
  await secrets.store("cadre.anthropicApiKey", "sk-the-one-the-user-stored");
  const onKey = await billing.environment();
  check("billing by key uses the key the user stored, not the shell's",
    onKey.ANTHROPIC_API_KEY === "sk-the-one-the-user-stored");

  // No stored key: the shell's must not be silently adopted as a fallback.
  await secrets.delete("cadre.anthropicApiKey");
  const noKey = await billing.environment();
  check("with no key stored, the shell's is what remains rather than a pretence",
    noKey.ANTHROPIC_API_KEY === "sk-from-the-users-shell");

  process.env.ANTHROPIC_API_KEY = savedKey;
  process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
  delete process.env.CADRE_TEST_MARKER;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
}

console.log("=== auth ===");
let failed = false;
for (const [label, ok] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
process.exit(failed ? 1 : 0);

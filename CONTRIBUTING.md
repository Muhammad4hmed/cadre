# Contributing to Cadre

## Getting set up

```sh
npm install
npm run build
npm run verify:fast
```

Press <kbd>F5</kbd> to launch an Extension Development Host on `sandbox/`.

## The test suites

`npm run verify:fast` is the loop you should live in — 157 checks, a few seconds. The
Extension Development Host is far too slow to iterate in.

These suites are **hermetic**: they stub `vscode`, alias the SDK out for a controllable
fake, and supply a stand-in `claude` executable. They need no credentials and no Claude
Code installation, which is what lets CI run them. If you add a test that reaches the real
CLI, the network, or the filesystem outside a temp directory, it belongs in
`verify:team` instead — otherwise it passes on your machine and fails in CI.

| | |
|---|---|
| `verify:ui` | Screens, composer readiness, project selection, per-folder settings |
| `verify:lifecycle` | Session lifecycle, permissions, team wiring, orientation |
| `verify:auth` | The auth module in isolation |
| `verify:team` | A live three-agent run. Costs real tokens — not part of `verify:fast` |

`verify-lifecycle` aliases the SDK out for a controllable fake (`scripts/fake-sdk.mjs`), so
a silent stream end, a mid-run crash and disposal-while-busy can be provoked
deterministically.

## Things worth knowing before you change them

**`allowedTools` is not an allowlist.** It means "runs without a permission prompt".
`tools` is what restricts availability. Conflating them silently auto-approves.

**The delegation tool is `Agent`.** `Task` is a legacy alias, so blocking only `Task`
leaves the raw spawn path open.

**`env` replaces rather than extends** the subprocess environment — spread `process.env`
or the CLI loses `PATH`.

**`import.meta.url` must be shimmed** when bundling the ESM SDK to CJS, or the extension
fails to activate with no useful error. See `scripts/esbuild-shared.mjs`.

**Permissions are enforced through `managedSettings`**, a restrictive-only tier that
outranks user settings. Verify changes with `scripts/probe-permissions.mjs` and
`scripts/probe-deny.mjs` — both hit the real SDK.

**The prompts in `src/team/prompts/` ship verbatim.** They are long deliberately, and the
`{{DOCS}}` token plus the `<!--docs:start-->` markers are resolved at composition time.

## Pull requests

Keep `npm run typecheck` and `npm run verify:fast` green. If you change behaviour that a
test would have caught, add the test — and make sure it fails before your fix.

Say plainly in the PR what you did not cover.

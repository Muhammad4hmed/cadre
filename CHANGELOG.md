# Changelog

## 0.1.1

**Fixed: choosing "autonomous" did nothing.** `Cadre: Set Autonomy` writes to workspace
scope, which the trust layer could not distinguish from a value a cloned repo shipped — so
it clamped the level the user had just picked in front of a warning modal, and kept
prompting. Standing in front of that modal is the approval, and it is now recorded as one.
The same applied to project profiles.

- The settings hub shows the level actually in force, not the raw setting, so a clamp is
  visible rather than silent.
- A clamped setting now offers **Review…** inline instead of only a transcript notice.

If a folder already carries an unapproved `autonomous`, re-pick it under **Cadre: Set
Autonomy**, or allow it via **Cadre: Review Workspace Settings** — the fix does not
retroactively approve what it previously refused.

## 0.1.0

First release worth installing.

### The team

- A Lead, a Researcher and an Engineer, each with its own system prompt, model, reasoning
  effort and tool allowlist. You talk to the Lead; it interrogates the brief, decides scope
  and delegates.
- Delegation runs through in-process MCP tools that spawn nested queries the extension owns,
  so every streamed message is attributable to a teammate rather than inferred.
- Peer consultation between the Researcher and the Engineer, bounded by capability: the
  consulted peer has no peer tool, so a consult cannot consult back.
- A fixed report contract across the context boundary, with `ASSUMPTIONS` and `NOT COVERED`
  never omitted. The Engineer cannot report `DONE` without an execution result.

### Interface

- One responsive view: a merged stream in the sidebar, three live lanes past 760px, and a
  full-width Team Floor. Both surfaces render the same session.
- Three screens — sign-in, projects, team — with a persistent account control on all of them.
- Live status lights, delegation cards, tool chips, collapsed reasoning, running cost.

### Projects

- Multi-root aware: every workspace folder is selectable, and settings resolve per folder,
  so a project can carry its own profile.
- A project home listing folders beside the ones already open.
- Per-project profile presets: Sandbox, Balanced, Production.
- Session resume, and Rewind Files to restore the workspace to an earlier turn.
- An orientation preamble built from what is on disk, so the team does not start cold.

### Documentation

- The Lead maintains `PROJECT.md`, the Researcher writes technical reports, the Engineer
  keeps the changelog and code-level docs. Proportional: a one-line fix produces nothing.

### Safety

- A repository's `.vscode/settings.json` cannot widen its own permissions. An escalating
  `autonomy`, or `connectors`/`plugins` that would spawn processes, are clamped or withheld
  until explicitly allowed via **Cadre: Review Workspace Settings**. Approval is bound to the
  exact value, so editing an approved connector revokes it.
- `capabilities` declared: no virtual workspaces, no untrusted workspaces.

- Autonomy is enforced by the extension through a restrictive-only policy tier, so it holds
  even when the user's own Claude Code settings grant broader permissions.
- Secrets (`.env`, ssh keys, credentials) are denied at every autonomy level, including
  `bypassPermissions`.
- The Lead and Researcher cannot write outside `.cadre/` and the docs root.
- Permission prompts offer a narrowly scoped grant rather than a blanket one.

### Billing

- The spend cap applies across the whole run, including delegated teammates, rather than
  resetting for each one.
- Claude subscription or an Anthropic API key held in encrypted secret storage. Subscription
  mode explicitly unsets `ANTHROPIC_API_KEY` so a shell variable cannot silently bill the API.

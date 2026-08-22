# Changelog

## 0.3.1

Tools that fan work out or schedule it off-screen — `Workflow`, `Agent`, `CronCreate`,
`ScheduleWakeup`, `RemoteTrigger`, `Monitor`, `SendMessage` — are now explicitly blocked for
every teammate. They were already absent from each allowlist, but each one can multiply what
a run costs without the user seeing it, and an allowlist is one edit away from being widened.

A brief is the team's only fan-out: visible in a lane, counted against the session's spend.

## 0.3.0

**Questions are now asked in the conversation, not in a dropdown.**

A teammate's question used to open a native quick pick, which puts the question in a
placeholder — one line, clipped. These are the most important sentences in the
conversation, and they were the ones getting truncated.

A question now appears as a card in that teammate's lane: the full text wraps, each option
shows its reasoning, there is a field for an answer of your own, and **Skip** tells the
teammate you declined rather than leaving it to guess. Picking a single-choice answer sends
immediately; multi-select waits for **Answer**. An interrupt settles an open question
instead of leaving the run parked.

## 0.2.2

Two features existed but were undiscoverable, which makes them close to not existing.

- **Talking to a teammate directly.** Clicking the Researcher or Engineer used to dump you
  in a settings file to find a boolean. It now offers the direct line where you reached for
  it, explains the trade-off — the Lead does not see the exchange, so its picture goes
  stale — and switches you over.
- **"Onboard this project" is now "Survey this project"**, with what it produces stated:
  it writes `PROJECT.md` so later sessions start informed.

## 0.2.1

- The home screen now lists past conversations for the current project underneath the
  projects, with relative times. Click one to resume it.
- **CADRE** in the header is a Home button from anywhere, and dims once you are there.

## 0.2.0

### Images

Attach a screenshot and the team can see it. Click **＋**, paste from the clipboard, or
drop a file anywhere on the composer. Thumbnails appear before you send, and stay in the
transcript afterwards.

Large images are downscaled to 1568px on the long edge before sending — past that the API
downsamples anyway, so the extra pixels only cost tokens. An image on its own is a
complete message; no caption required.

### Context window

The header shows how full the window is, turning amber past 80%, so you can see it coming.
When it fills, the history is summarised automatically and the run continues instead of
failing — the boundary is written into the transcript so you know detail was dropped and
roughly how much. **Cadre: Compact Conversation** does it on demand.

## 0.1.3

**Fixed: Cadre kept refusing the autonomy level you had chosen.**

`Set Autonomy` wrote to workspace scope — which is exactly where a cloned repo's
`.vscode/settings.json` lands. The trust layer cannot tell those apart, so it clamped your
own setting back to the default and said a repository could not widen its permissions.
You had not touched a repository; you had used the command.

How much you trust the agent is a judgement about you, not about the folder, so it is now
a machine-level preference and the clamp never sees it. Per-project overrides still exist
through **Apply a project profile**, which records its own approval.

A repository still cannot exceed the level you chose.

## 0.1.2

**Fixed: the Lead could ask you a question and you would never see it.**
`AskUserQuestion` rendered as a raw tool chip and completed with nothing, so the teammate
carried on as though it had never asked — and the answer it needed was the thing steering
the plan.

The CLI has no renderer inside an extension host, so the host has to collect the answers
itself. Cadre now shows each question as a picker with the model's own options plus a
free-text choice, hands the answers back on the tool input, and records the exchange in
the transcript. Dismissing the picker is treated as "stop and reconsider" rather than
answered-with-nothing. Verified against the real CLI, not just unit-tested.

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

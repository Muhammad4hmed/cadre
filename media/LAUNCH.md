# Launch material

Everything here is for the LinkedIn post and the Marketplace listing. None of it
ships in the extension.

- `demo.mp4` — 41s, 1280×720, H.264 + AAC, ~2.9 MB. Narrated, with a music bed and
  burnt-in subtitles. Built in two steps:

      node .shots/film.mjs --frames   # render every frame from the real webview
      node .shots/cut.mjs             # cut to the narration, mix, burn subtitles

  Scene lengths come from ElevenLabs' character-level timings, so rewriting the script
  and regenerating the voice re-times the picture instead of drifting out of sync.
- `screenshots/` — the listing images, same harness.

---

## Uploading to the Marketplace

The listing still shows **0.1.0**. `cadre.vsix` in the repo root is the current build.

1. https://marketplace.visualstudio.com/manage/publishers/Cadre
2. Cadre → **…** → **Update**
3. Upload `cadre.vsix`. It takes a few minutes to verify.

The version, description, screenshots and README all come from inside the package, so
nothing else needs editing by hand.

---

## LinkedIn

Two drafts. Both are written to be specific rather than loud — on a developer feed,
a concrete number travels further than an adjective, and the people worth reaching
switch off at "revolutionary".

Attach `demo.mp4` directly (native video, not a YouTube link — LinkedIn suppresses
off-platform links). It autoplays muted, so the burnt-in subtitles do the work; the
narration is there for anyone who unmutes.

### Draft A — short, built around the one surprising fact

> Most AI coding tools are one assistant doing everything.
>
> I spent the last few weeks building Cadre: you draw a team of agents on a canvas
> in VS Code, wire them together with arrows, and watch all of them work at once.
>
> Two kinds of arrow, and the distinction is the whole design:
> → **delegate** — A hands work to B and waits for a report. Cycles allowed, so
>   agents can argue with each other.
> ⇥ **then** — B starts automatically when A finishes, with A's output as input.
>
> The part I did not expect to matter most: **capabilities are enforced, not
> requested.** A read-only agent physically cannot write a file. An agent that can
> quietly do the work itself will — and then its teammates are decoration.
>
> It runs on the Claude Code subscription you already have. No API key.
>
> Open source, MIT. Link in the comments.

### Draft B — longer, story-first

> I built a three-agent AI team for VS Code. Then I threw the roster away.
>
> The Lead/Researcher/Engineer setup worked — but it only ever described one kind
> of work. So I rewrote it as something general: any number of agents you define,
> connected by arrows you draw, running live in one place.
>
> Three things I learned building it.
>
> **1. The interesting constraint is what an agent cannot do.**
> Give a coordinator a shell and it stops coordinating. Cadre enforces that — a
> read-only agent is denied the editor, not asked politely to avoid it.
>
> **2. Prompts are most of the quality, and nobody wants to write them.**
> So you describe the pipeline in a sentence and Claude designs the whole
> workflow: the agents, their capabilities, and a real prompt for each one. You
> edit anything before it runs.
>
> **3. Tests pass for the wrong reasons, constantly.**
> 722 hermetic checks. Along the way I found that `git_view show .env` printed a
> live secret straight past the deny list, that a workflow id from the UI could
> write outside the project, and that Stop did not reach a chain of agents. Every
> one of those was found by attacking it, not by using it.
>
> Open source, MIT, runs on your existing Claude Code subscription.

### Notes

- Post the repo link as the **first comment**, not in the body.
- Best windows for a developer audience: Tue–Thu, 8–10am in your target timezone.
- Reply to every comment in the first hour — that is what the feed actually rewards.
- If you only use one line, use this one: *"A read-only agent physically cannot
  write a file."* It is the claim people argue with, and arguing is distribution.

### What not to claim

Worth being careful, because someone will check:

- It is **not** the only visual multi-agent builder. Two VS Code extensions do the
  canvas — they export config for something else to run, they do not execute
  agents. That is the honest distinction: Cadre runs them.
- Do not say "no other tool does this". Say what it does and let people compare.
- The Marketplace install count is small. Do not imply traction you do not have.

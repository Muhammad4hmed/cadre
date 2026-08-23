# Launch material

Everything here is for the LinkedIn post and the Marketplace listing. None of it
ships in the extension.

- `demo.mp4` — 61s, 1280×720, H.264 + AAC, ~3.4 MB. Narrated, with a music bed and
  burnt-in subtitles. Built in two steps:

      node .shots/film.mjs --frames   # render every frame from the real webview
      node .shots/cut.mjs             # cut to the narration, mix, burn subtitles

  Scene lengths come from ElevenLabs' character-level timings, so rewriting the script
  and regenerating the voice re-times the picture instead of drifting out of sync.
- `screenshots/` — the listing images, same harness.

---

## Uploading to the Marketplace

The listing still shows **0.1.0**. `cadre.vsix` in the repo root is the current build
(**0.11.4**, ~1.9 MB).

1. https://marketplace.visualstudio.com/manage/publishers/Cadre
2. Cadre → **…** → **Update**
3. Upload `cadre.vsix`. It takes a few minutes to verify.

Everything on the listing page comes from inside the package, so nothing else needs
editing by hand. Two things worth knowing about how it renders there:

- **Images work, video does not.** `vsce` rewrites every relative image path to an
  absolute `github.com/.../raw/HEAD/...` URL at package time — verified in the packaged
  readme — but the Marketplace will not embed an `.mp4`. That is why the README leads
  with a poster image that *links* to the film: it renders as a player on GitHub and as a
  clickable still on the Marketplace.
- **Push before you upload.** Those image URLs point at `main`, so a screenshot that is
  only on your disk shows as a broken image on the listing.

---

## LinkedIn

Two drafts. Both are written to be specific rather than loud — on a developer feed,
a concrete number travels further than an adjective, and the people worth reaching
switch off at "revolutionary".

Attach `demo.mp4` directly (native video, not a YouTube link — LinkedIn suppresses
off-platform links). It autoplays muted, so the burnt-in subtitles do the work; the
narration is there for anyone who unmutes.

### The launch post

> Today I'm open-sourcing Cadre — one of my weekend projects, and the one I kept
> going back to.
>
> **You draw a team of AI agents on a canvas in VS Code, wire them together with
> arrows, and watch all of them work at once.**
>
> Not one assistant doing everything. However many you need, each with its own
> job, its own prompt, and its own idea of what it's allowed to touch.
>
> Two kinds of arrow, and the distinction is the whole design:
> → **delegate** — A hands work to B and waits for a report. Loops are allowed, so
>   two agents can genuinely argue before either commits.
> ⇥ **then** — B starts the moment A finishes, with A's output as its input.
>
> The part I didn't expect to matter most: **what an agent can do is enforced, not
> requested.** A read-only agent physically cannot write a file — it isn't asked
> nicely to avoid it. Give a coordinator a shell and it stops coordinating and
> just does the work itself, and then its teammates are decoration.
>
> **And it isn't really about code.** The templates that took longest to write were
> a hiring team, a marketing team and a cold-outreach team. Six agents each. The
> outreach one has a compliance agent whose job is to say no.
>
> **How is this different from n8n or Zapier?**
> Those wire up steps. You decide every branch in advance, and the flow does
> exactly what you drew — which is what you want for "when a row is added, send a
> Slack message."
>
> Cadre wires up *colleagues*. You don't specify the steps; you specify who's on
> the team, what each of them is for, and what each is allowed to reach. Then they
> decide — they push back on the brief, delegate, disagree, and hand work on. The
> unit isn't a node, it's someone with a job and a boundary.
>
> The other practical difference: no API keys, for anything. It runs on the Claude
> Code subscription you already have. Log in once in VS Code and start — there's
> no key to paste, no billing to set up, nothing to leak.
>
> **MIT licensed, free, and open to contributions.** Install it from the Extensions
> tab in VS Code and it's running in about thirty seconds.
>
> I'd genuinely like to know what teams people build with it. Repo in the first
> comment.

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
> And it is not really about code. The templates that took longest to write were a
> hiring team, a marketing team and a cold-outreach team — six agents each, and the
> outreach one has a compliance agent that is allowed to say no.
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
> 968 hermetic checks — and the ones I trust are the ones I broke on purpose to
> watch them go red. Along the way: `git_view show .env` printed a live secret
> straight past the deny list; a cloned repo could point the docs folder at
> `~/.ssh` and get a read-only agent writing there; an interrupted write left the
> workflow you had drawn unreadable, in 7 of 12 attempts. Every one of those was
> found by attacking it, not by using it.
>
> The one that stung: reopening a conversation showed an empty board for twelve of
> the fourteen templates, for a year-old reason — the code still addressed a lane
> called "lead" from the fixed three-agent roster it started as. Placing into a
> lane that does not exist fails silently. The test suite only ever exercised the
> one template where that guess happened to be right.
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

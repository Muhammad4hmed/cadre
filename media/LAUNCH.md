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

Your structure, four blocks in order. No markdown: LinkedIn has no bold or
italics and renders asterisks literally, so the shape comes from line breaks
alone. No dashes. Paste it as is.

> Today I'm making one of my weekend projects, Cadre, open source.
>
> Most people use AI like a single assistant. You ask, it answers. One brain, one
> chat window.
>
> Cadre gives you a team instead.
>
> You open VS Code, drop a few boxes on a canvas, and draw arrows between them.
> Each box is an AI agent with a job. The arrows decide who hands work to whom.
> Then you hit launch and watch all of them work at once, side by side.
>
> Here is one that ships with it. A hiring team, six agents:
>
> One decides whether the role should exist at all.
> One goes and finds candidates.
> One screens them against a written bar.
> One designs an interview that tests the actual job.
> One verifies what can be verified.
> One plans the first ninety days.
>
> You describe the role once. They do the rest, and they push back on each other
> while they do it.
>
> There is a marketing team too. An outreach team where one agent's only job is to
> say no to anything that would embarrass you. Fourteen ready made teams in total,
> or you build your own in about two minutes.
>
> So how is this different from n8n or Zapier?
>
> Those automate steps. You draw the flow, you decide every branch, and it does
> exactly what you drew. Perfect for "when a row is added, send a Slack message".
>
> But every one of those steps is a decision you had to make in advance. The moment
> reality does something you did not predict, the flow either breaks or does
> something stupid, confidently.
>
> Cadre is not a flowchart. You are not writing steps. You are describing people.
>
> You say what each agent is for and what it is allowed to touch. Then they work it
> out between themselves. They question the brief. They hand work over. They
> disagree with each other, which is the part I did not expect to matter so much.
>
> And here is the bit no automation tool does. Every agent only gets the access you
> give it. If you say an agent can read but not write, it cannot write. Not "please
> don't". It genuinely cannot. Because the second one agent can do everything, it
> stops asking anyone else, and your team turns into decoration.
>
> There are no API keys anywhere in this.
>
> It runs on Claude Code, Anthropic's own CLI. If you already pay for Claude, you
> are done. Log in once inside VS Code, either through Cadre or through the Claude
> CLI, and start. Nothing to paste, nothing to configure, nothing to leak.
>
> And it is open source, MIT, completely free.
>
> Install it from the Extensions tab in VS Code and you are running in under a
> minute. If you want to add something, the repo is open and I will read every pull
> request.
>
> Tell me one thing: what team would you hire?
>
> Repo in the comments.

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

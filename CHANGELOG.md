# Changelog

## 0.11.6 — the builder's own model runs could not be stopped

Refining a prompt and designing a workflow are model runs. Both accepted a
cancellation signal and neither was ever given one, so nothing could stop
either. A wedged CLI never returned, the promise never settled, and the button
went on saying "Refining…" or "Designing…" until the window was reloaded.
Leaving the builder abandoned the run rather than ending it — still spending,
with nowhere to deliver.

Both now carry a signal and a ceiling: two minutes for a refine, three for a
design, each with a message saying what happened rather than a raw error.
Leaving the builder stops the run, asking again supersedes the request you had
given up on, and shutting down ends both.

Neither path had a single test before this.

977 checks.

## 0.11.5 — the packaging check failed CI for a reason that was not a bug

`verify-package` asks vsce what would ship. vsce reports what is on disk and
does not run the prepublish build, so on a tree that has not been built there is
no bundle to find — and the suite called that a missing bundle. Locally it never
showed, because a build always precedes a test run; in CI, `verify:fast` runs
straight after `npm ci`, so it failed on every push from 0.11.2 onwards.

The packaged extension was never affected: vsce runs the prepublish build itself,
so the artifact CI uploads has always contained the bundle. What was broken was
the check, and what it cost was three red builds that said nothing true.

Not built and built-but-excluded are now told apart — the first says plainly that
it could not check, the second still fails. CI builds before running the suites,
so the check does its job there rather than being skipped.

968 checks.

## 0.11.4 — Build with Claude, against output nobody controls

A generated design is the one input here that nothing validates on the way in.
The schema usually shapes it, but a CLI without structured output falls back to
parsing free text, and `assemble` is the only thing between that and the
builder. It assumed types it had not checked: `agents` as an object rather than
an array threw `.slice is not a function` at the user instead of saying the
design came back malformed. Every field is checked now — a design that arrives
as nonsense produces an empty workflow and a problem list, which is what the
builder is for.

It also **silently trimmed to eight agents**. Ask for a twelve-person department
and you got eight, with a note saying "Built 8 agents" and nothing to say four
had been dropped. The cap stays — every agent is a real model run — but it says
what it left out.

968 checks.

## 0.11.3 — the board picked its shape a frame late, and nothing had ever tested it

The webview chooses between one merged lane and a lane per agent by measuring
its own width, and it only ever did that from a `ResizeObserver` callback. The
observer fires quickly in a real webview, so this showed as a flicker — the
board built once in the wrong shape, then rebuilt. It is decided before the
first paint now.

The consequence was larger than the flicker. Anything reading the page before
that first callback saw the merged layout, which is why **the per-agent board
had no test coverage at all** — the surface that is the whole point of the
product. It does now, and it holds up: twelve agents get twelve lanes with
twelve distinct accents, the map draws all twelve nodes and all eleven arrows,
the picker offers every one of them, the board scrolls sideways rather than
squeezing any lane below readability, and output from three agents working at
once stays in its own lane instead of bleeding. A workflow that shrinks back to
one agent leaves no lane behind.

Also pinned: a delegation card belongs to the lane that *decided* it, with the
report landing back on that same card. That was already the behaviour and the
reasoning was already in a comment; now it cannot be changed by accident.

952 checks.

## 0.11.2 — the package shipped a file from my working tree

`.vscodeignore` is an allowlist by omission: anything not named in it ships.
`.cadre/` was not named, and the test suite pointed its fake workspace at the
repository itself — so a workflow the tests created was written into the working
tree and packaged into the extension. `.github/` went along too.

Nothing published it — the file list is only visible if you unzip the package
and read it — and nothing would have caught it. Three fixes: the suite writes to
a scratch directory instead of the working tree, both ignore files exclude
`.cadre` and `.github`, and a new suite asks vsce for the real file list and
refuses anything the product does not mean to ship. It fails on a stray file, on
sources, on the test suite, on a source map, on the demo film.

930 checks.

## 0.11.1 — the fixed roster was still wired into four places

This started as three agents called Lead, Researcher and Engineer. When
workflows became any shape, four things kept talking to that roster — and every
one of them fails *silently*, which is why they survived.

**Reopening a conversation showed an empty board.** Replay addressed every event
to a lane called `lead`, and recognised exactly two delegate tools:
`brief_researcher` and `brief_engineer`. Placing into a lane that does not exist
is a no-op, so for a workflow whose entry agent is called anything else, the
whole transcript went nowhere. Two of the fourteen templates have an agent
slugged `lead`. The other twelve, and every workflow drawn by hand, came back
blank — and the test suite only ever replayed the one template where the
hardcoding happened to be right. Replay now takes the workflow's roster, so any
entry agent works and a brief to any teammate comes back as a delegation card
rather than a raw tool call. A brief naming an agent that has since been deleted
stays a tool call, because inventing a lane for it would be worse.

**The empty board never explained itself.** The placeholder was pinned to the
same missing lane and named the Researcher and the Engineer. It now names the
agents the workflow actually has, and a one-agent workflow is no longer told to
put its teammates to work.

**Project profiles silently half-applied.** Sandbox, Balanced and Production
each wrote `engineer.model`, `researcher.model`, `lead.effort` and
`engineer.effort` — settings removed when workflows became general. VS Code
throws on an unregistered key and the loop awaited each in turn, so the first
dead key took the rest of the profile with it: **Production promised a spend cap
and never wrote one.** The profiles now set the workspace-wide model and effort
that do exist, and a setting that will not take is reported instead of costing
the user everything after it.

912 checks, including the first tests these profiles have ever had.

## 0.11.0 — what a run costs, and two things that were never drawn

**The running total left out the team.** A run's cost is reported when it ends,
and only the main run's figure was emitted — so a lead that delegates six times
and spends little itself showed a number that was a fraction of what had been
spent. The header also *replaced* that figure each turn rather than accumulating,
so it never showed a session total at all. It does now, and every agent's cost
counts towards it.

**Two teammates started in the same turn could each spend the whole ceiling.**
A cost is only known at the end of a run, so briefs issued together were both
built against the same remaining figure. With a chain of delegations the ceiling
could be exceeded several times over. A slice of the ceiling is now held for each
run while it is going and released when it reports. Sequential delegation is
unaffected — the common case, and the first releases before the second starts —
but siblings started together share one ceiling, so a teammate that cannot be
funded is refused with a message saying so rather than handed money already
committed.

`cadre.maxSpendUsd` is now described as what it is: a ceiling for the whole
conversation, every agent in it. It always behaved that way.

**The per-run cost card and the "history was summarised" notice were never
drawn.** Both were placed into a lane hardcoded as `lead` — a leftover from the
fixed Lead/Researcher/Engineer roster this used to be — and placing into a lane
that does not exist fails silently. No template has an agent slugged `lead`, so
for every real workflow both were dropped on the floor. They go to the entry
agent's lane now.

**A compaction could blank the board.** The notice called `fmtTokens`, which was
never defined anywhere, so it threw every time. The event stays in the replay
log, so each later rebuild threw again — and because that loop had no guard, the
lane went blank from the compaction onwards. The formatter exists now, and one
bad event can no longer take the rest of the board with it.

881 checks.

## 0.10.3 — a link in agent output could smuggle attributes into the lane

Messages are rendered as markdown, and a link's `href` and `title` are built as
HTML attributes out of that text. The escaper handled `&`, `<` and `>` but not
quotes — and the link pattern happily matches a URL containing one. So this:

    [click](https://x.com/"onmouseover="alert(1))

closed the attribute and turned the rest of the URL into markup on the anchor:
an event handler, an `autofocus`, a `style` covering the panel. Bare pasted URLs
and table cells took the same route.

Not a live script injection: the webview's content security policy allows
scripts only by nonce, which refuses an inline handler, and that held. It is
still malformed markup, and it is one CSP change away from being the other
thing. Quotes are escaped now.

The renderer had no tests at all before this — it is the code that renders
untrusted output, so it now has fifteen, driven through the real page in
headless Chrome rather than against an extracted copy. Removing the escape turns
nine of them red. Ordinary punctuation is covered too: quotes, apostrophes and
a query string's ampersand all still render as themselves.

865 checks.

## 0.10.2 — a crash could take the workflow with it

Both of the files Cadre owns were written with `writeFileSync`, which truncates
the file and then writes it. A process that dies in between leaves a prefix
behind — and VS Code windows get closed, machines run out of disk, laptops lose
power.

For these two files that is not a cache to rebuild. One is the workflow you drew:
the agents, their prompts, the arrows. The other is every conversation you have
had under it. Both fail quietly rather than loudly — a torn workflow reads as
missing and a torn session index reads as no history at all, because the parse
error is caught and turned into an empty list.

Measured, not assumed: killing the write mid-flight left the file unreadable in
**7 of 12 attempts**. Writes now go to a temporary file in the same directory,
are flushed, and are renamed into place, so a reader sees either the old file or
the new one. Across the same 12 kills, zero losses.

The full-view tab also survives a window reload now. VS Code persists the tab and
hands it back on the next launch, but nothing re-adopted it, so it returned as a
blank panel that never filled in — which reads as a hang rather than as a tab to
close.

850 checks. The crash test is the real thing: a child process writing in a loop,
killed part-way, repeatedly — and it asserts the child actually got to write, so
it cannot pass by never having tested anything.

## 0.10.1 — a repository cannot widen what the agents can reach

Two settings granted access beyond the workspace, and both are `resource`-scoped, which
means a cloned repository can set them in `.vscode/settings.json`. Neither was clamped.

**`cadre.docsPath` could point outside the workspace.** It is the one place an agent with
no editor is nonetheless allowed to write — the narrow exception that makes the read-only
preset usable. Set to `../../.ssh` or `/etc`, that exception became a write anywhere on the
machine. Demonstrated, not theorised: a read-only agent's write to
`~/.ssh/authorized_keys` passed the confinement check and went to the permission prompt,
and on `autonomous` there is no prompt.

Fixed in two places, because one of them should not be load-bearing on its own. The runner
now refuses any docs root that resolves outside the workspace, whatever the configuration
says; and the trust layer clamps the setting back to `docs` and tells the user why, rather
than silently dropping what they configured.

**`cadre.additionalDirectories` is now clamped too.** It hands the CLI folders the agents
may read and edit; a repository setting `["/home/you"]` would have granted every agent the
user's home directory — a larger grant than anything else the trust layer already guards.
A repo-supplied value is ignored with a warning; the user's own is kept without one.

831 checks. Removing the trust clamp turns 12 red; removing the runner guard makes
`/etc/passwd` writable again, which is its own test.

## 0.10.0 — whole departments

Three more ready-to-run templates, and none of them touch code. The general model is the
product, and a template set made mostly of software teams quietly argues the opposite.

**Hiring team** — six agents. A Head of People who decides whether the role should exist
before anyone starts filling it and writes the bar down *before* seeing a candidate,
because meeting a likeable one and reverse-engineering the requirements is the most
reliable way to hire badly. A sourcer who maps the market rather than searching it, a
screener who reads against the bar rather than against the other candidates, an interview
designer who deletes any stage that cannot say what it is for, verification that separates
"contradicted" from "unconfirmed", and onboarding that plans ninety days of work rather
than ninety days of reading.

**Marketing team** — six agents. Nothing gets written until the claim is settled and the
measure is agreed, and the measure has to be something that could come back negative.
Audience research that collects the words people actually use, positioning that names the
real alternative — usually a spreadsheet or doing nothing — a writer who keeps the caveats
it was handed, distribution that starts from where the audience already is, and
measurement that will say "this went up and we cannot say we caused it".

**Outreach team** — six agents, and the one with the sharpest bar. A cold message spends
attention nobody offered, so the head's test is whether you could defend this message to
this person out loud. Targeting that writes down the disqualifiers, per-account research
where "no trigger found" is a legitimate answer, copy that makes one small ask and never
states an inference as fact, compliance that will say a market cannot be sent to as
written, and a reviewer who reads it as the recipient and can stop it for free.

795 checks. The "ready to run" label is asserted rather than claimed — five agents
minimum, more arrows than agents, every arrow labelled, every prompt 150–600 words, an
entry agent that cannot do the work itself.

## 0.9.5

**One malformed workflow file no longer takes the home screen with it.** Workflows are
plain JSON in the project — that is the point of storing them there — so they get
hand-edited, merged badly and half-written. A file containing `42`, `null`, `"text"` or an
array was spread into an object that looked like a workflow and was not, and the first one
of those threw straight out of `listWorkflows`: no workflows listed at all, for anyone with
a single bad file.

Files are now normalised on read. Repaired where repair means something — a missing
`agents`, a null `edges`, an agent with no position, an unknown preset, an edge pointing at
a deleted agent, an entry that names nobody — so the workflow still opens in the builder
with its problems flagged and can be fixed there. Rejected where it does not: there is
nothing to recover from a number.

753 checks. Removing the repair turns 16 of them red.

## 0.9.4

Listing only, no behaviour change. The README now opens with a poster that links to the
demo — a bare video URL renders as a player on GitHub and as naked text on the
Marketplace, which is where most people will read it. Dropped the "Programming Languages"
category: that is for grammars and language support, and a wrong category puts the
extension in front of people who did not want it.

## 0.9.3

**Finding the `claude` binary no longer spawns a process every time.** Resolution falls
back to `execFileSync("which")` — a synchronous subprocess on the extension host thread —
and it ran on every readiness check, so every settings change, folder change and screen
publish blocked the UI on it. Twelve unrelated setting changes spawned twelve processes;
they now spawn one. Cached, keyed on the configured path, invalidated when that setting
changes, and the cached path is re-checked with a stat rather than a spawn so a binary
uninstalled underneath you is noticed.

## 0.9.2

**The arrow carrying work is actually visible now.** At the width the live map is usually
given, a 3px dashed line was almost invisible — which defeats the point of animating it.
Thicker, a longer dash, and a stronger glow. Measured rather than eyeballed: frame-to-frame
change in that region went from 7 to 96 out of 255.

Also adds `.shots/film.mjs`, which renders the demo film from the real webview — the same
extracted markup and shipped CSS and JS as the listing screenshots, driven by genuine
events. The arrows move because the dash offset is stepped frame by frame, not because
motion was added afterwards. A change to the product changes the film.

## 0.9.1

**Stop now stops work that chains or continues.** A handoff chain and a turn-limit
continuation each start a *new* run once the previous one ends, and neither is inside the
query an interrupt aborts. They only stopped at all because aborting happened to make the
run throw — true today, and not something correctness should rest on: a node completing
cleanly a moment before Stop landed would have started the next one anyway, spending money
after the button that means "no more". Both now check explicitly, and sending again clears
it.

**Skills come from your Claude Code, not from a setting you had to type.** The builder
listed whatever was in `cadre.playbooks`, which for almost everyone was nothing — so the
Skills panel said "none configured" while the CLI had 45. It now asks the CLI in the same
handshake that fetches the model list, and shows each skill with what it does:
`/code-review`, `/verify`, `/simplify`, `/deep-research`, `/loop`, `/schedule` and the
rest. `cadre.playbooks` still narrows the list when you set it.

And it says which ones cannot work here, up front rather than halfway through a run:
anything that schedules work for later or fans it out — `/loop`, `/schedule`, `/batch`,
`/deep-research` — needs `Workflow`, `Agent`, `Cron` or `ScheduleWakeup`, and those are
denied to every agent at every autonomy level. An arrow is the only fan-out a workflow
has, by design.

722 checks.

**A note on the testing.** Two of the new Stop assertions passed *without* the fix, because
the accident they were replacing produced the same observable result. Removing the guard
now makes the suite die rather than print a failure, which `run-suites` catches by exit
code — that is exactly why it judges exit codes instead of grepping for the word FAIL.

## 0.9.0 — templates worth running

The eight templates were shapes, not systems: three or four agents, a couple of arrows,
prompts written to demonstrate the idea. Three new ones are workflows you could actually
use today, and the home screen now separates **Ready to run** from **Starting points** so
the difference is visible rather than something you discover after launching.

**Ship a feature** — seven agents and nine arrows. Product decides scope and can say no;
an Architect designs before anyone writes and records the alternative it rejected; the
Implementer can ask the Architect when the design does not cover something, and ask
Research when a library's behaviour is the question; a Reviewer reads the diff assuming it
is wrong and sends real defects back; a Test engineer proves it as soon as it is written,
and Docs writes it up. Four of those arrows point backwards — the agents argue.

**Security review** — six agents. A lead who establishes the trust boundary first, three
specialists reading source, dependencies and deployment, and an Exploit prover that
actually tries to reproduce what they find, because a finding nobody could reproduce is
the biggest source of wasted effort in security work. Findings are ranked by what they
would really cost, and the report keeps the refutations too.

**Bid response** — six agents, no code anywhere. A bid manager whose most valuable output
is deciding *not* to bid, a requirements analyst who reads the annexes and the contract
terms where requirements hide, an evidence gatherer who grades what can actually be
proved, honest costing, a writer, and a compliance checker who assumes the response is
non-compliant until shown otherwise.

The label has to be earned. A template calling itself ready to run is asserted to have at
least five agents, more arrows than agents, every arrow labelled, every agent given a
150–600 word prompt and a stated role, at most two agents with hands, an entry agent that
cannot do the work itself, and no prompt that re-explains the protocol the arrows already
inject. At least one has to let peers push back on each other, and at least one has to be
about something other than code.

708 checks, up from 662.

## 0.8.1 — nothing is lost when a run is cut off

**An agent that runs out of turns now carries on instead of giving up.** It is handed its
own account of what it did — the files it wrote, the commands it ran, and its own last
words verbatim — and continues in the same lane, so from the outside it is one run.
Bounded by `cadre.maxContinuations` (default 2), because "keep going" without a limit is
how a stuck agent spends a whole budget achieving nothing. Set it to 0 for the old
behaviour.

Its own words rather than a summary we write: it knows what it was in the middle of, and
paraphrasing that is how a continuation ends up redoing the first half.

**And when it genuinely cannot continue, the report says what happened.** A truncated run
used to hand back boilerplate — *"Nothing here was verified"* — which was true and
useless: files had been written, things had been learned, and none of it reached the
delegator, so the delegator re-briefed the identical work and paid for all of it twice.
The report now lists what already ran and what is already on disk, carries the agent's own
last words, and tells the delegator to re-brief only what is left. A run that truly
achieved nothing still says so plainly rather than inventing a list.

**The context window filling is now visible in every lane.** Claude Code already
summarises the history and carries on in the same conversation — that part worked — but it
was only reported for the agent you were talking to. A nested agent's window filling was
silent, which is how a report ends up quietly missing what happened at the start. Every
lane now says so, and says detail was condensed rather than lost.

662 checks. Disabling continuation turns 8 red; disabling the compaction notice turns 2
red. One of those tests crashed rather than failing legibly when it regressed, which is
fixed too — a stack trace hides which assertion actually broke.

## 0.8.0 — hardening

Three real defects, found by attacking the extension rather than using it.

**A credential file could be read straight past the deny list.** `git_view show .env`
printed a live secret. The CLI's deny rules bind the Read tool; git reaches files another
way, so it has to check for itself — which it did not. The README's claim that these reads
are "denied at every level, including autonomous" was simply untrue as written.

Now refused by shape, so a file that is not on disk yet or exists only in history is still
protected: `.env` and `.env.*`, `.ssh/`, `.aws/credentials`, `.claude/.credentials.json`,
`id_rsa`, `id_ed25519`, `*.pem`, `.netrc`, `.npmrc`, `.pypirc`. A **diff leaks a file just
as surely as reading it**, so those paths are excluded from the pathspec rather than
trusted not to have changed. Ordinary use is untouched — diffs, scoped diffs, status and
`show` on any other file all work exactly as before, and that is asserted.

**A workflow id could escape the project.** Ids arrive from webview messages and become
filenames; `../` in one wrote a file outside the workspace. Proven, not theoretical. Every
id is minted as a slug, so anything that is not one is refused rather than sanitised —
quietly rewriting a malformed id would let one workflow overwrite another. Reads, deletes
and session lookups fail quietly; writes report.

**A long session grew without bound.** Streamed prose arrives one delta at a time and
every delta was kept — in the host's replay log and again in each webview — so one agent
turn pushed thousands of objects into each, and a layout change re-rendered all of them.
Consecutive deltas of the same turn are now merged losslessly: what a surface joining late
replays is identical, at a fraction of the size. Both logs are capped as a backstop, and
dropping history says so rather than showing a conversation that begins mid-sentence.

639 checks, up from 596. Each fix was mutation-tested: removing the credential guard turns
12 checks red, removing the id guard turns 15 red, removing the delta merge turns 2 red.

## 0.7.4

**Markdown renders.** Agents write headed sections, bullets, tables and links; only bold
and inline code were being rendered, so everything else arrived as literal punctuation —
`### Why it was not posted` showed its hashes, and bulleted lists showed their dashes.

Now handled: headings (clamped, because an h1 in a chat lane reads as a bug), bulleted and
numbered lists, italics, strikethrough, blockquotes, horizontal rules, pipe tables in their
own scrolling box, links, and bare URLs — agents cite by pasting them. An unterminated
fence mid-stream renders as code rather than letting the rest of the message reflow as
prose on every delta.

Two correctness points. Everything is still escaped before any of it runs, so a message
containing HTML is shown, never executed. And code spans are now pulled out before the
emphasis passes and put back after: `` `a**b**c` `` used to come out with a bold `b`
inside it, which is code and has to survive verbatim.

**Fixed in the test harness — the reason none of this was caught.** The webview driver is
JavaScript inside a template literal, so every backslash in a regex was eaten before the
browser saw it: `/a\.b/` silently became `/a.b/`, which still matches, so the assertion
passed and proved nothing. The driver is a `String.raw` template now, and its patterns mean
what they say.

596 checks.

## 0.7.3

**Resting is grey; only work in motion has colour.** Every node and arrow used to be
coloured all the time, which says the same thing as colouring none of them. Now an agent
that is not working recedes — dimmed, grey accent — and one that is glows with a pulse,
its current activity in place of its job title. Arrows carrying work animate along their
length; the rest are grey. Solid versus dashed still distinguishes a delegate arrow from a
handoff, so nothing is lost by dropping the colour.

An arrow is also treated as live when it leads *into* a working agent, not only when the
runner names it. That is what a person reading the picture expects, and it covers the
cases the runner cannot see.

**The map and the board are resizable.** A separator between them takes a drag, arrow keys
(Shift for bigger steps), and a double-click to reset. It will not shrink the map to
nothing or grow it past 60% of the window, and it remembers where you left it.

**Fixed: every handoff was drawn twice.** The chain emitted an assignment card and then the
run emitted another for the same handoff.

**Fixed: handoffs were attributed to the wrong agent.** In a chain A→B→C, C's card read
"from A" because the chain is walked breadth-first from whoever triggered it. It now names
the agent that actually handed the work over — and C is given B's output, which is what it
was already being given but not what the card claimed.

583 checks.

## 0.7.2

**"Talking to" works.** It was disabled for the whole of a run — exactly when you want to
see who else is on the workflow — and its enabled state was never recomputed when the
roster arrived, so it stayed greyed out even after the agents appeared. It is now live
whenever there is more than one agent to choose from.

Switching mid-run still costs you the run, because each agent has its own prompt and its
own tools and the main thread has to restart. So it asks first, says plainly what is lost,
and snaps back if you decline — rather than being greyed out on your behalf.

**"Floor" is now "⛶ Full view."** The old label was internal jargon; nobody who had not
read the source could tell it opened the workflow in a full editor tab with room for every
lane. The tab itself is "Cadre — Full view", and the command is **Cadre: Open Full View**.

568 checks.

## 0.7.1

**Fixed: opening a workflow showed an empty board.** The run view built its lanes from a
live session's handshake, so until you spent a turn there were no lanes, the "talking to"
dropdown was empty, and **Edit did nothing** because the view had no workflow id yet. The
lanes, the map and the controls are all properties of the graph and now come from it
directly; the CLI's roster replaces that one when it arrives, carrying what only the CLI
knows.

**Fixed: Launch appeared dead, and could loop.** Launching a workflow whose prompts were
already written — every template — re-refined all of them first: three paid round trips
with nothing on screen, which is why it took several clicks to get anywhere. Refinement
now only expands prompts short enough to be a jotted-down line, and templates and
generated workflows are left alone.

Worse, underneath it: a refinement that *failed* never marked the agent as attempted, so
the launch picked the same agent again on every pass — an unbounded loop of real model
calls. Attempts are now recorded, a failure moves on, and clicking Launch while a launch
is in flight no longer starts a second one racing the first to save.

**The live map is findable.** It was a hairline strip that did not look clickable, so the
whole thing went unnoticed. It is now open by default, with a chevron, the workflow's
name, "2 of 3 working", and a Show/Hide control — and it remembers whether you want it.

558 checks.

## 0.7.0

**Every model your CLI has, asked for rather than hardcoded.** The picker was a
hand-written list of three aliases, which was wrong in three ways at once: Fable was
missing, the identifiers are the CLI's rather than the API's, and not every model accepts
an effort level. Cadre now asks the installed Claude Code what it supports — a handshake
that sends no prompt and costs nothing — and builds the picker from the answer.

On this machine that turns up **Fable** as `claude-fable-5[1m]`, Opus, Sonnet, Haiku and
Default, with `opus` currently resolving to `claude-opus-4-8[1m]`. A hardcoded list would
have got the Fable identifier wrong and gone stale on the next release.

The list also carries which effort levels each model takes. **Haiku takes none**, so
choosing it removes the effort control and says why, rather than sending a parameter the
model rejects. A model you picked before it disappeared from the list is still shown,
marked unavailable, instead of being silently reset to something else.

**Build with Claude.** Describe the pipeline in prose — "read incoming tickets, work out
which are real bugs, reproduce them against our repo, draft a reply" — and Claude designs
the whole workflow: the agents, their capabilities, real 200–500 word prompts, and the
arrows between them. It lands in the builder, never launched, with anything that needs
fixing flagged. The blank canvas is the hardest part of this product; this is the shortcut
past it, not a way to skip reading what you are about to run.

The design comes back through a JSON schema the CLI enforces, and then through a
defensive assembly pass, because the schema constrains the shape and not the sense:
colliding ids are renamed (and their arrows renamed with them), arrows to agents that do
not exist are dropped, a self-arrow is dropped, duplicates collapse, an unknown preset
falls back to the safest one, and an entry pointing at nothing falls back to the first
agent. Twelve tests cover exactly those cases — a generated workflow that fails to open
would be far worse than one that opens with a warning on it.

538 checks. `npm run probe:models` prints what your CLI offers; `npm run probe:generate`
runs the designer end to end.

## 0.6.0

**Workflows can be global or local.** A local workflow lives in `.cadre/workflows/` and
travels with the repository. A global one lives in `~/.cadre/workflows/` and is available
in every project you open. *Globalise* and *Localise* move one either way, and the home
screen groups them under **This project** and **Everywhere**.

Conversations stay with the project even for a global workflow. The same workflow used in
three repositories has three separate histories, and merging them into one list would be
actively misleading. A local workflow also shadows a global one of the same id, so a
project can pin its own version of something shared.

**Workflow-level defaults.** Model, effort, turn limit, skills and connectors can be set
once for a whole workflow, in the builder panel you get when no agent is selected. Three
tiers now, narrowest wins: the agent's Advanced settings, then the workflow's defaults,
then the workspace setting. This tier exists because a workflow is the unit people share —
"this one runs on sonnet" belongs with the graph, not in one person's editor config.

**Opening a workflow shows its page, not a chat.** Its description, everything that would
stop it running, a picture of the graph, and every conversation you have had under it.
Most of the time you are coming back to something rather than starting fresh, and the
thing you want is yesterday's conversation.

**Conversations get named.** Claude already writes a summary of each one; that name is now
recorded against the workflow and shown in the list, replacing the provisional "first
thing you said" as soon as the CLI has written it. No extra model call — it was being
generated already.

**A live map above the board.** The graph you drew, with the agents currently working
highlighted, a pulse on each, their current activity in place of their job title, and the
arrow carrying work animated along its length. It uses the positions you laid out, so the
map and the builder are recognisably the same picture. Collapsed by default; the lanes are
what you are reading.

**Picking a template no longer asks for a name.** It opens the builder with the template
loaded, where you can change anything — including the name, which is the second field on
screen — and then launch.

493 checks. The DOM suite grew to cover the new screens: the home grouping, the workflow
page, and the live map's highlighting, all driven in a real browser against the real code.

## 0.5.1

**Undo works.** Ctrl+Z / Cmd+Z steps back through anything you did on the canvas — moving
a box, drawing or deleting an arrow, renaming an agent, changing a preset — and
Ctrl+Shift+Z or Ctrl+Y goes forward again. A drag is one step, not forty. Inside a text
box it is left alone, because there Ctrl+Z belongs to the text.

History is recorded by comparing snapshots rather than by every mutation announcing
itself: a dozen call sites that each have to remember to commit first is a dozen chances
to forget, and what that produces is an undo that silently skips a step.

**Workflows autosave.** 45 seconds after you stop changing something, and never more than
3 minutes with unsaved work however continuously you edit. Leaving the builder or hiding
the view flushes immediately. A small marker in the bar reads `unsaved` or `saved 14:22`.

An autosave deliberately does *not* reset a running session, where an explicit Save still
does — firing every 45 seconds while you nudge a box, and killing your conversation each
time, would be worse than the session being briefly out of date.

**The Advanced panel stays open.** Every edit re-renders the inspector, so ticking
anything inside Advanced snapped it shut — which made picking more than one tool a
fight.

**Fixed alongside: unsaved edits could be silently discarded.** A background event — a
settings change, a screen refresh — sent the builder the host's copy of the workflow, and
the builder adopted it over whatever you had just typed. Those events are now marked
non-authoritative and the builder keeps its own draft.

**Five more templates**, and deliberately not all about code: **Review board** (three
lenses on one change), **Incident review** (triage, a reproducer and a historian in
parallel, then a postmortem), **Content pipeline** (outline → draft → edit → fact-check as
a chain of handoffs), **Contract review** (nothing to do with software), and **Data
analysis**. Eight in all. Every one is asserted runnable, warning-free, and to give each
agent a real prompt.

New in the test suite: `verify-webview` runs the actual builder in headless Chrome and
drives it — undo, the Advanced panel, the autosave timer, the draft-clobbering rule. None
of that was reachable before, because `verify-ui` drives the extension host and never
executes the webview. It skips loudly rather than failing where there is no browser.
396 checks.

## 0.5.0 — workflows

**Cadre is no longer a fixed team of three.** A Lead, a Researcher and an Engineer only
ever described one kind of work, and the roster was hardcoded down to the tool names. It
is now a workflow builder: any number of agents, each named and prompted by you, wired
together with arrows you draw.

**Two kinds of arrow**, chosen by which port you drag from. A *delegate* arrow makes B a
tool on A — a brief goes out, one report comes back. Cycles are allowed there, because an
agent asking a peer back is a real thing to want, so recursion is bounded by a depth
counter rather than by forbidding the shape. A *then* arrow starts B automatically when A
finishes, with A's output as its input; those must be acyclic and the builder will not
save a loop.

**You do not have to know the protocol.** Write "you review contracts" and the rest of the
system prompt is generated from the arrows you drew: what a brief is, that the other agent
starts with an empty context, what a report looks like, where the output is about to be
handed. An agent is told about the arrows it has and nothing about the arrows it does not.
Turn on **Refine prompts** (on by default) and a one-line description becomes a real
prompt — with the failure modes of that role named — which you can read, edit, or revert.

**Capabilities are four presets with everything underneath.** Read-only, Research, Build,
Everything; then per-agent model, effort, individual tools, skills, connectors and turn
limit. An explicit choice beats the preset, and nothing beats the never-available list —
ticking `Agent` or `Workflow` in the advanced panel does not grant them.

**One lane per agent**, however many there are, with the board scrolling sideways past the
point where lanes would stop being readable. Lane colours are assigned by position, since
agent names are now yours to choose.

**Workflows live in the project**, at `.cadre/workflows/*.json` — reviewable in a diff and
shareable by committing. Each keeps its own list of conversations, so two workflows in one
folder no longer show each other's history.

The old three-agent team ships as the **Software team** template, with its prompts intact
minus the sections the arrows now generate. Two more templates come with it.

Notes on upgrading: `cadre.directLine` is gone — you can always address any agent, and the
runner tells you what switching costs. `cadre.lead.model` and its siblings are gone too;
per-agent settings live on the agent now, with `cadre.model` and `cadre.effort` as the
workspace defaults. `cadre.maxDelegationDepth` is new.

362 hermetic checks, up from 258. The new `verify-workflow` suite covers the graph rules,
capability resolution and the injected protocol; it caught a real one while being written —
an explicit tool override could re-enable a never-available tool, because the rule that
lets an explicit allow beat a preset deny was also letting it beat the hard deny.

## 0.4.3

**Fixed: briefs were still being rejected.** 0.4.1 fixed one schema fault and there was a
second one underneath it. The Lead sends array arguments as strings — sometimes
JSON-encoded (`"[\"a\",\"b\"]"`), sometimes plain prose — and the server rejected every one
with *expected array, received string*. The schema was correct and unambiguous; the model
does it anyway, and it cannot see the rejection until the turn is already spent. So
`context`, `boundaries`, `decide_yourself` and `paths` now accept either shape and
normalise it: JSON arrays are parsed, bulleted or numbered prose is split per line, and a
single sentence stays one item instead of being shredded on its commas.

Verified against every call a real Lead made that the server rejected — eight of them,
lifted verbatim out of the stored sessions into `scripts/fixtures/` and replayed through
the **real** MCP server in the new `verify-mcp` suite. The previous suite built the tools
against the fake SDK, which is why it passed while the product did not.

That suite immediately found a second defect: `.describe()` applied before `.optional()`
on a union field is **silently dropped** from the JSON Schema, so three fields had stopped
telling the model what they were for. The call still validates; the model just stops being
told. Every field of every tool is now asserted to reach the model described, and the two
enums that never had a description have one.

**A failed tool call now says why on screen.** The reason was only ever in a tooltip, so
eight identical red chips gave no clue what was wrong. The error is rendered under the
chip.

The Lead is also now told outright that those four fields are lists, one item per point.

## 0.4.2

**Fixed: resuming a session showed an empty screen.** Reopening a past conversation
restored the model's memory but not yours — the lanes were cleared and replaced with a
notice saying the transcript would not be replayed. It now is: your messages, the Lead's
replies, its tool calls with the results they returned, and each delegation with the
verdict its report came back with.

What the replay does *not* invent matters as much. Each teammate ran in its own stored
session, so above the resume line you see the brief and the report, not the teammate
working — and the boundary marker says so rather than leaving three empty lanes to imply
the teammates did nothing. Reasoning is not replayed because the store does not keep it;
the CLI writes the signature and drops the text.

Two things only a real transcript revealed, both fixed: `[Request interrupted by user]`
is written into the user role by the CLI and was being replayed as a chat bubble you
never typed, and a delegation you declined came back labelled with the permission
system's boilerplate instead of "you declined this delegation".

The composer stays locked while history loads, so a reply cannot land above the
conversation it answers. The conversion is a pure function in `src/team/replay.ts` and
`npm run probe:replay -- <project>` runs it against your own stored sessions.

## 0.4.1

**Fixed: the Lead could not brief anyone.** Every `brief_researcher` and `brief_engineer`
call was rejected, so the team could not delegate at all — the Lead burned turns retrying
with different shapes and correctly worked out that the schema was refusing its arrays.

The cause was `.default([])` on the `context` field. Zod emits a defaulted field as
**required** in the JSON Schema the model is handed, so a brief that reasonably omitted
`context` failed validation. `git_view` without paths and `paper` without a directory had
the same defect and would have failed the same way.

Those fields are optional now, defaulted in the handler where a default belongs. A new
suite asserts the schema the model actually receives — that each tool requires exactly what
it cannot work without, that a minimal call validates, and that no input field uses
`.default()` at all. Confirmed by reintroducing the bug and watching it fail.

## 0.4.0

### The research paper

When a project is done, the Lead can commission a technical report: LaTeX under
`docs/paper/` with `main.tex`, `refs.bib`, figures, and a claims ledger. **Cadre: Install
LaTeX Toolchain** fetches Tectonic — one binary, no sudo, into `~/.cadre/toolchain` —
and **Build the Paper** compiles it. Without a toolchain the team still writes the paper;
you just build it elsewhere.

The Researcher has no shell, so it gets one narrow tool rather than arbitrary execution:
`paper` compiles the document and checks its claims. Measurements come from Engineer runs;
figures are generated by the Engineer with matplotlib, which needs no LaTeX.

### Why it will not invent results

Asked for a paper, a model will produce a beautiful fabricated one — invented baselines,
numbers with no run behind them, citations to papers that do not say what is claimed. That
is worse than no paper, because it reads as authoritative.

So every factual claim is marked `\claim{id}` in the prose and declared in `claims.json`
with its kind, the file or URL it came from, the literal supporting line, and the date. The
`paper check` action verifies mechanically that the evidence file exists, that the quote is
really in it, and that nothing appears in the paper undeclared. Tested against an invented
number, a claim with no declaration, and a source file that does not exist — all three are
caught.

That check is the floor, not the ceiling: it proves evidence exists, not that it supports
the sentence. The prompt requires re-reading each claim against its quote afterwards, and
says plainly that an unsupported claim is removed rather than softened.

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

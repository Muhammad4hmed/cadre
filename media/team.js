// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const LANE_BREAKPOINT = 760;
  /** Below this many pixels per lane the board scrolls sideways instead of squeezing. */
  const MIN_LANE = 320;

  /** The agents in the open workflow, in the order the user laid them out. */
  const WHO = () => [...state.members.keys()];
  const NAME = (id) => state.members.get(id)?.name ?? id;

  /**
   * Lane colours by position, not by name — an agent can be called anything.
   * Distinguishable in both themes, and it repeats past eight rather than
   * generating something muddy.
   */
  const ACCENTS = ["#a78bfa", "#22d3ee", "#fbbf24", "#4ade80", "#f472b6", "#60a5fa", "#fb923c", "#a3e635"];
  const accentOf = (id) => {
    const index = WHO().indexOf(id);
    return ACCENTS[(index < 0 ? 0 : index) % ACCENTS.length];
  };

  const el = {
    body: document.body,
    roster: /** @type {HTMLElement} */ (document.getElementById("roster")),
    floor: /** @type {HTMLElement} */ (document.getElementById("floor")),
    input: /** @type {HTMLTextAreaElement} */ (document.getElementById("input")),
    send: /** @type {HTMLButtonElement} */ (document.getElementById("send")),
    stop: /** @type {HTMLButtonElement} */ (document.getElementById("stop")),
    channel: /** @type {HTMLSelectElement} */ (document.getElementById("channel")),
    workspace: /** @type {HTMLElement} */ (document.getElementById("workspace")),
    autonomy: /** @type {HTMLElement} */ (document.getElementById("autonomy")),
    billing: /** @type {HTMLElement} */ (document.getElementById("billing")),
    connectors: /** @type {HTMLElement} */ (document.getElementById("connectors")),
    context: /** @type {HTMLElement} */ (document.getElementById("context")),
    spend: /** @type {HTMLElement} */ (document.getElementById("spend")),
    account: /** @type {HTMLButtonElement} */ (document.getElementById("account")),
    floorButton: /** @type {HTMLButtonElement} */ (document.getElementById("openFloor")),
    composer: /** @type {HTMLElement} */ (document.querySelector(".composer")),
    attach: /** @type {HTMLButtonElement} */ (document.getElementById("attach")),
    file: /** @type {HTMLInputElement} */ (document.getElementById("file")),
    attachments: /** @type {HTMLElement} */ (document.getElementById("attachments")),
    screens: {
      auth: document.getElementById("screen-auth"),
      projects: document.getElementById("screen-projects"),
      home: document.getElementById("screen-home"),
      workflow: document.getElementById("screen-workflow"),
      builder: document.getElementById("screen-builder"),
      run: document.getElementById("screen-run"),
    },
    authDetail: document.getElementById("auth-detail"),
    authSignIn: document.getElementById("auth-signin"),
    authApiKey: document.getElementById("auth-apikey"),
    authRecheck: document.getElementById("auth-recheck"),
    projectList: document.getElementById("project-list"),
    projectRoots: document.getElementById("projects-roots"),
    projectsConfigure: document.getElementById("projects-configure"),
    home: /** @type {HTMLButtonElement} */ (document.getElementById("home")),
    sessions: /** @type {HTMLElement} */ (document.getElementById("sessions")),
    sessionList: /** @type {HTMLElement} */ (document.getElementById("session-list")),

    homeProject: document.getElementById("home-project"),
    homeNew: document.getElementById("home-new"),
    homeBuild: document.getElementById("home-build"),
    buildCard: document.getElementById("build-card"),
    buildInput: /** @type {HTMLTextAreaElement} */ (document.getElementById("build-input")),
    buildNote: document.getElementById("build-note"),
    buildGo: /** @type {HTMLButtonElement} */ (document.getElementById("build-go")),
    buildCancel: document.getElementById("build-cancel"),
    workflowList: document.getElementById("workflow-list"),
    templates: document.getElementById("templates"),
    templateList: document.getElementById("template-list"),

    builderBack: document.getElementById("builder-back"),
    builderName: /** @type {HTMLInputElement} */ (document.getElementById("builder-name")),
    builderAdd: document.getElementById("builder-add"),
    builderSave: document.getElementById("builder-save"),
    builderLaunch: document.getElementById("builder-launch"),
    canvasWrap: /** @type {HTMLElement} */ (document.getElementById("canvas-wrap")),
    canvas: /** @type {HTMLElement} */ (document.getElementById("canvas")),
    wires: /** @type {SVGSVGElement} */ (/** @type {unknown} */ (document.getElementById("wires"))),
    inspector: /** @type {HTMLElement} */ (document.getElementById("inspector")),
    problems: /** @type {HTMLElement} */ (document.getElementById("problems")),
    runSessions: document.getElementById("run-sessions"),
    runEdit: document.getElementById("run-edit"),

    detailBack: document.getElementById("detail-back"),
    detailScope: document.getElementById("detail-scope"),
    detailEdit: document.getElementById("detail-edit"),
    detailStart: /** @type {HTMLButtonElement} */ (document.getElementById("detail-start")),
    detailName: document.getElementById("detail-name"),
    detailDesc: document.getElementById("detail-desc"),
    detailProblems: document.getElementById("detail-problems"),
    detailSessions: document.getElementById("detail-sessions"),
    detailMap: document.getElementById("detail-map"),
    detailLegend: document.getElementById("detail-legend"),

    livemap: /** @type {HTMLDetailsElement} */ (document.getElementById("livemap")),
    livemapTitle: document.getElementById("livemap-title"),
    livemapHint: document.getElementById("livemap-hint"),
    livemapToggle: document.getElementById("livemap-toggle"),
    runMap: document.getElementById("run-map"),
    splitter: document.getElementById("splitter"),
  };

  const state = {
    /** Every event received, so a layout flip can re-render losslessly. */
    log: [],
    layout: "stream",
    members: new Map(),
    channel: "",
    workflowId: "",
    workflowName: "",
    edges: [],
    busy: false,
    canSend: false,
    spendUsd: 0,
    screen: "loading",
    /** Live nodes keyed `${who}:${turn}` so streamed deltas find their target. */
    live: new Map(),
    acts: new Map(),
    assignments: new Map(),
    /** Images staged for the next message. */
    pending: [],
    /** Question cards awaiting an answer. */
    asks: new Map(),

    /** The builder's working copy. Nothing is written until Save. */
    draft: null,
    /** Everything the inspector panel needs to offer choices. */
    palette: { presets: [], catalogue: [], skills: [], connectors: [], models: [], efforts: [] },
    problems: [],
    selected: null,
    /** In-flight refinements, so the button can show it is working. */
    refining: new Set(),
    /** Refinements already attempted, so a failure is never retried in a loop. */
    refineTried: new Set(),
    /** True while Launch is waiting on refinements before it saves. */
    pendingLaunch: false,
    /**
     * Undo history as JSON snapshots. Snapshots rather than a log of operations
     * because a drag mutates coordinates continuously — replaying that as
     * inverse operations is far more machinery than the graph is worth.
     */
    history: { past: [], future: [], baseline: "" },
    /** Whether the Advanced panel is open, so a re-render does not close it. */
    advancedOpen: false,
    dirty: false,
    savedAt: 0,
    /** The workflow whose page is open. */
    detail: null,
    /** The graph being run, for the live map. */
    runGraph: null,
    activeAgents: [],
    activeEdge: undefined,
  };

  // The API accepts up to ~5 MB an image; a phone screenshot often exceeds that
  // and costs tokens for detail the model cannot use. 1568px on the long edge is
  // the point past which it downsamples anyway.
  const MAX_EDGE = 1568;
  const MAX_BYTES = 3_500_000;
  const MAX_IMAGES = 5;
  const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp"];

  // ----------------------------------------------------------- scaffolding

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  const dot = () => node("span", "dot");

  function laneContainers() {
    if (state.layout === "floor") {
      return Object.fromEntries(WHO().map((who) => [who, document.getElementById("stream-" + who)]));
    }
    const merged = document.getElementById("stream-all");
    return Object.fromEntries(WHO().map((who) => [who, merged]));
  }

  /**
   * One lane per agent, however many there are.
   *
   * Past three or four agents the lanes stop fitting, so the board becomes
   * horizontally scrollable with a floor on lane width rather than squeezing
   * every lane until none of them is readable.
   */
  function buildFloor() {
    el.floor.replaceChildren();
    if (state.layout === "floor") {
      const ids = WHO();
      el.floor.style.gridTemplateColumns = `repeat(${ids.length}, minmax(${MIN_LANE}px, 1fr))`;
      // clientWidth reads 0 while the screen is hidden, which would call every
      // board scrollable. Measure the container that is actually laid out.
      const room = el.floor.clientWidth || document.body.clientWidth;
      el.floor.classList.toggle("scrolls", ids.length * MIN_LANE > room);
      for (const who of ids) {
        const lane = node("section", "lane");
        lane.dataset.who = who;
        lane.style.setProperty("--lane-accent", accentOf(who));
        const head = node("header");
        head.appendChild(dot());
        head.appendChild(node("span", null, NAME(who)));
        lane.appendChild(head);
        const stream = node("div", "stream");
        stream.id = "stream-" + who;
        lane.appendChild(stream);
        el.floor.appendChild(lane);
      }
      return;
    }
    el.floor.style.gridTemplateColumns = "";
    el.floor.classList.remove("scrolls");
    const lane = node("section", "lane");
    const stream = node("div", "stream");
    stream.id = "stream-all";
    lane.appendChild(stream);
    el.floor.appendChild(lane);
  }

  const atBottom = (c) => c.scrollHeight - c.scrollTop - c.clientHeight < 48;

  /**
   * The lane a session-wide event belongs in: the entry agent's, because that
   * is who the user is talking to. This used to be hardcoded as "lead" from
   * the fixed roster this started as — and place() fails silently, so once
   * workflows could be any shape those events were simply dropped.
   */
  /**
   * A token count, for reading at a glance: 190000 -> "190K". Only ever shown
   * to convey scale, so the rounding is deliberate.
   */
  function fmtTokens(n) {
    const value = Number(n);
    if (!Number.isFinite(value) || value <= 0) return "0";
    return value >= 1000 ? Math.round(value / 1000) + "K" : String(Math.round(value));
  }

  function mainLane() {
    return state.runGraph?.entry || [...state.members.keys()][0] || "";
  }

  function place(who, element) {
    const container = laneContainers()[who];
    if (!container) return;
    const pinned = atBottom(container);
    container.appendChild(element);
    if (pinned) container.scrollTop = container.scrollHeight;
  }

  // ------------------------------------------------------------- rendering

  /**
   * Injection-safe markdown. Everything is escaped first, then the text is
   * split on fences so the inline passes only ever touch prose — running them
   * over generated <pre><code> markup would rewrite the code itself.
   */
  function markdown(text) {
    const escaped = escapeHtml(text);
    const fence = /```(\w*)\n?([\s\S]*?)```/g;
    let out = "";
    let cursor = 0;
    let match;
    while ((match = fence.exec(escaped)) !== null) {
      out += blocks(escaped.slice(cursor, match.index));
      out += `<pre><code>${match[2].replace(/\n$/, "")}</code></pre>`;
      cursor = fence.lastIndex;
    }
    // An unterminated fence is the normal state mid-stream: render what has
    // arrived as code rather than letting the rest of the message reflow as
    // prose on every delta.
    const tail = escaped.slice(cursor);
    const opening = /```(\w*)\n?([\s\S]*)$/.exec(tail);
    if (opening) {
      return `${out}${blocks(tail.slice(0, opening.index))}<pre><code>${opening[2]}</code></pre>`;
    }
    return out + blocks(tail);
  }

  /**
   * Quotes are escaped as well as angle brackets, because a link's href and
   * title are built as attributes out of this text. Without it a URL
   * containing a double quote — which the link pattern happily matches —
   * closes the attribute and everything after it becomes markup:
   *
   *   [x](https://a/"onmouseover="…)  ->  <a href="https://a/" onmouseover="…">
   *
   * The content security policy refuses to run an inline handler, so that is
   * not a live script injection today. It is one CSP change away from being
   * one, and it is malformed markup either way.
   */
  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  /**
   * Block structure: headings, lists, quotes, rules and tables.
   *
   * Line-oriented rather than a real parser. Agents write ordinary prose with
   * headed sections and bullets, and that is what this covers — anything more
   * exotic falls through as a paragraph, which is the right way to fail.
   */
  function blocks(chunk) {
    if (!chunk.trim()) return "";
    const lines = chunk.split("\n");
    const out = [];
    let paragraph = [];
    let list = null;
    let quote = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      out.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list) return;
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
      list = null;
    };
    const flushQuote = () => {
      if (!quote.length) return;
      out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
      quote = [];
    };
    const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };

    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (!trimmed) { flushAll(); continue; }

      const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (heading) {
        flushAll();
        // Clamped: an agent writing `#` means "this is a heading", not "make
        // this the largest text on screen". An h1 in a chat lane reads as a bug.
        const level = Math.min(6, Math.max(3, heading[1].length + 2));
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }

      if (/^([-*_])\1{2,}$/.test(trimmed)) { flushAll(); out.push("<hr>"); continue; }

      // A pipe table needs its separator row to be a table at all.
      if (trimmed.startsWith("|") && /^\|[\s:|-]+\|$/.test((lines[i + 1] ?? "").trim())) {
        flushAll();
        const header = cells(trimmed);
        const rows = [];
        i += 1;
        while (i + 1 < lines.length && lines[i + 1].trim().startsWith("|")) {
          i += 1;
          rows.push(cells(lines[i].trim()));
        }
        out.push(
          `<div class="table-wrap"><table><thead><tr>${
            header.map((c) => `<th>${inline(c)}</th>`).join("")
          }</tr></thead><tbody>${
            rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")
          }</tbody></table></div>`,
        );
        continue;
      }

      const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
      const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
      if (bullet || numbered) {
        flushParagraph();
        flushQuote();
        const tag = bullet ? "ul" : "ol";
        if (list && list.tag !== tag) flushList();
        list = list ?? { tag, items: [] };
        list.items.push((bullet ?? numbered)[1]);
        continue;
      }

      const quoted = /^&gt;\s?(.*)$/.exec(trimmed);
      if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1]); continue; }

      // A plain line under a list item continues it, rather than starting a
      // paragraph in the middle of the list.
      if (list) { list.items[list.items.length - 1] += ` ${trimmed}`; continue; }

      flushQuote();
      paragraph.push(trimmed);
    }

    flushAll();
    return out.join("");
  }

  const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  /** Object Replacement Character: stands in for a code span, never typed. */
  const CODE_MARK = "￼";

  /**
   * Inline marks.
   *
   * Code spans are pulled out first and put back last. Running the emphasis
   * passes over them would bold the middle of `a**b**c`, which is code and has
   * to survive verbatim.
   */
  function inline(text) {
    const spans = [];
    let s = text.replace(/`([^`\n]+)`/g, (_, code) => {
      spans.push(code);
      return `${CODE_MARK}${spans.length - 1}${CODE_MARK}`;
    });

    s = s
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
        (_, label, href) => `<a href="${href}" title="${href}">${label}</a>`)
      // Bare URLs, because agents cite by pasting them.
      .replace(/(^|[\s(])(https?:\/\/[^\s<>()]+)/g,
        (_, before, href) => `${before}<a href="${href}" title="${href}">${href}</a>`)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
      // Single marks only at a word boundary: `a_b_c` is an identifier.
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

    return s.replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, "g"),
      (_, index) => `<code>${spans[Number(index)]}</code>`);
  }

  function utterance(who, tag, className) {
    const wrap = node("div", "utterance " + (className || ""));
    wrap.dataset.who = who;
    wrap.appendChild(node("div", "tag", tag));
    const body = node("div", "body");
    wrap.appendChild(body);
    place(who, wrap);
    return body;
  }

  function pinnedScroll(who, mutate) {
    const container = laneContainers()[who];
    const pinned = container ? atBottom(container) : false;
    mutate();
    if (pinned && container) container.scrollTop = container.scrollHeight;
  }

  /** Streamed deltas are merged, and the log is capped. See the host's copy. */
  const LOG_CAP = 4000;

  function remember(e) {
    if (e.kind === "say" || e.kind === "think") {
      const last = state.log[state.log.length - 1];
      if (last && last.kind === e.kind && last.who === e.who && last.turn === e.turn) {
        last.delta += e.delta;
        return;
      }
      state.log.push({ ...e });
      return;
    }
    state.log.push(e);
    if (state.log.length > LOG_CAP) state.log.splice(0, Math.floor(LOG_CAP / 4));
  }

  function renderEvent(e) {
    switch (e.kind) {
      case "userSaid": {
        const body = utterance(e.to, "you → " + NAME(e.to), "user");
        if (e.text) body.textContent = e.text;
        if (e.images?.length) {
          const shots = node("div", "shots");
          for (const img of e.images) {
            const el_ = document.createElement("img");
            el_.src = img.dataUrl;
            el_.alt = img.name;
            el_.title = img.name;
            shots.appendChild(el_);
          }
          body.appendChild(shots);
        }
        return;
      }

      case "say": {
        const key = e.who + ":" + e.turn;
        let entry = state.live.get(key);
        if (!entry) {
          entry = { body: utterance(e.who, NAME(e.who)), raw: "" };
          state.live.set(key, entry);
        }
        pinnedScroll(e.who, () => {
          entry.raw += e.delta;
          entry.body.innerHTML = markdown(entry.raw);
        });
        return;
      }

      case "sayEnd":
        state.live.delete(e.who + ":" + e.turn);
        state.live.delete("think:" + e.who + ":" + e.turn);
        return;

      case "think": {
        const key = "think:" + e.who + ":" + e.turn;
        let entry = state.live.get(key);
        if (!entry) {
          const details = node("details", "reasoning");
          details.appendChild(node("summary", null, NAME(e.who) + " reasoning"));
          const body = node("div", "body");
          details.appendChild(body);
          place(e.who, details);
          entry = { body };
          state.live.set(key, entry);
        }
        pinnedScroll(e.who, () => { entry.body.textContent += e.delta; });
        return;
      }

      case "act": {
        const chip = node("div", "act");
        chip.classList.add("act-row");
        chip.dataset.state = "running";
        chip.appendChild(node("span", "tool", e.tool));
        chip.appendChild(node("span", "detail", e.summary));
        chip.title = e.summary;
        place(e.who, chip);
        state.acts.set(e.act, chip);
        return;
      }

      case "actEnd": {
        const chip = state.acts.get(e.act);
        if (!chip) return;
        chip.dataset.state = e.ok ? "ok" : "failed";
        if (e.summary) chip.title = e.summary;
        // A failure with its reason only in a tooltip is a failure nobody reads.
        // Every rejected brief looked identical on screen until you hovered it.
        if (!e.ok && e.summary) {
          const wrap = node("div", "act-failed");
          chip.classList.remove("act-row");
          chip.parentNode.insertBefore(wrap, chip);
          wrap.appendChild(chip);
          wrap.appendChild(node("div", "why", e.summary));
        }
        state.acts.delete(e.act);
        return;
      }

      case "assign": {
        const a = e.assignment;
        const card = node("div", "assignment");
        if (a.handoff) card.classList.add("handoff");
        // A handoff was not a decision anyone made in the moment, so it reads
        // as a different kind of event from a brief.
        card.appendChild(node("div", "route", NAME(a.from) + (a.handoff ? " ⇥ " : " → ") + NAME(a.to)));
        card.appendChild(node("div", "brief", a.brief));
        // Rendered in the delegator's lane: that is where the decision happened.
        place(a.from, card);
        state.assignments.set(a.id, card);
        return;
      }

      case "deliver": {
        const card = state.assignments.get(e.id);
        if (!card) return;
        card.dataset.outcome = e.outcome;
        card.appendChild(node("div", "outcome", e.outcome + ": " + e.summary));
        state.assignments.delete(e.id);
        return;
      }

      case "ask": {
        const card = node("div", "ask");
        card.dataset.who = e.who;
        card.appendChild(node("div", "who", NAME(e.who) + " asks"));

        /** question text -> chosen labels */
        const chosen = new Map();
        const buttons = [];

        for (const q of e.questions) {
          const block = node("div", "choices");
          card.appendChild(node("div", "q", q.question));

          for (const option of q.options) {
            const button = node("button", "choice");
            button.setAttribute("aria-pressed", "false");
            button.appendChild(node("span", "label", option.label));
            if (option.description) button.appendChild(node("span", "why", option.description));
            button.addEventListener("click", () => {
              const current = chosen.get(q.question) ?? [];
              if (q.multiSelect) {
                const at = current.indexOf(option.label);
                if (at >= 0) current.splice(at, 1);
                else current.push(option.label);
                button.setAttribute("aria-pressed", String(at < 0));
                chosen.set(q.question, current);
                return;
              }
              for (const other of buttons) {
                if (other.q === q.question) other.el.setAttribute("aria-pressed", "false");
              }
              button.setAttribute("aria-pressed", "true");
              chosen.set(q.question, [option.label]);
              maybeSubmit();
            });
            buttons.push({ q: q.question, el: button });
            block.appendChild(button);
          }

          const own = node("div", "own");
          const field = document.createElement("input");
          field.type = "text";
          field.placeholder = "Something else…";
          field.addEventListener("input", () => {
            if (field.value.trim()) {
              chosen.set(q.question, [field.value.trim()]);
              for (const b of buttons) if (b.q === q.question) b.el.setAttribute("aria-pressed", "false");
            } else {
              chosen.delete(q.question);
            }
          });
          field.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); maybeSubmit(true); }
          });
          own.appendChild(field);
          block.appendChild(own);
          card.appendChild(block);
        }

        const actions = node("div", "actions");
        const skip = node("button", "ghost", "Skip");
        skip.addEventListener("click", () => {
          vscode.postMessage({ kind: "answerCancelled", id: e.id });
          settle("Skipped — the teammate was told you declined.");
        });
        const send = node("button", "primary", "Answer");
        send.addEventListener("click", () => maybeSubmit(true));
        actions.appendChild(skip);
        actions.appendChild(send);
        card.appendChild(actions);

        function settle(summary) {
          card.dataset.done = "true";
          card.appendChild(node("div", "answered", summary));
        }

        /** Auto-sends only when every single-select question has an answer. */
        function maybeSubmit(force) {
          const complete = e.questions.every((q) => (chosen.get(q.question) ?? []).length > 0);
          const anyMulti = e.questions.some((q) => q.multiSelect);
          if (!complete) { if (force) field?.focus?.(); return; }
          if (!force && anyMulti) return;   // multi-select needs an explicit Answer
          const answers = {};
          for (const [question, labels] of chosen) answers[question] = labels.join(", ");
          vscode.postMessage({ kind: "answer", id: e.id, answers });
          settle(Object.values(answers).join("  ·  "));
        }

        state.asks.set(e.id, { settle });
        place(e.who, card);
        return;
      }

      case "askClosed": {
        const entry = state.asks.get(e.id);
        if (entry && !e.answered) entry.settle("Question closed without an answer.");
        state.asks.delete(e.id);
        return;
      }

      case "notice":
        place(e.who || mainLane(), node("div", "notice " + e.level, e.text));
        return;

      case "compacted": {
        const shrunk = e.after ? ` — ${fmtTokens(e.before)} → ${fmtTokens(e.after)}` : "";
        place(mainLane(), node("div", "notice compacted",
          `Context was full, so the history was summarised${shrunk}. The team keeps going; older detail is gone.`));
        return;
      }

      case "spend": {
        // The header is a session total — the spend cap is measured against
        // the session, and a teammate's cost counts towards it. The card below
        // is what this one run cost.
        state.spendUsd = typeof e.totalUsd === "number" ? e.totalUsd : e.usd;
        const seconds = (e.durationMs / 1000).toFixed(1);
        place(e.who || mainLane(),
          node("div", "spend", e.turns + " turns · " + seconds + "s · $" + e.usd.toFixed(4)));
        el.spend.textContent = "$" + state.spendUsd.toFixed(4);
        return;
      }

      default:
        return;
    }
  }

  function rerender() {
    buildFloor();
    state.live.clear();
    state.acts.clear();
    state.assignments.clear();
    state.asks.clear();
    if (!state.log.length) { showEmpty(); return; }
    for (const e of state.log) {
      // A live event that throws costs one message; the same event replayed
      // here would abort the loop and leave every later event unrendered — the
      // board would go blank from that point on. Report it and carry on.
      try {
        renderEvent(e);
      } catch (err) {
        console.error("Cadre: could not render a " + e.kind + " event", err);
      }
    }
  }

  /**
   * The placeholder shown before anything has happened.
   *
   * It was pinned to a lane called "lead" and named the Researcher and the
   * Engineer — the fixed roster this started as. Two of fourteen templates have
   * an agent slugged "lead", so everywhere else this was placed into a lane
   * that does not exist and silently dropped: an empty board with nothing to
   * explain it.
   */
  function showEmpty() {
    const who = mainLane();
    const container = laneContainers()[who];
    if (!container) return;
    const entry = state.members.get(who);
    const others = [...state.members.values()].filter((m) => m.id !== who);
    const empty = node("div", "empty");
    empty.appendChild(node("span", "glyph", "◈"));
    empty.appendChild(node("div", null,
      entry ? "Describe the work to " + (entry.name || entry.id) + "." : "Describe the work to start."));
    if (others.length) {
      const names = others.map((m) => m.name || m.id);
      const listed = names.length > 2
        ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1]
        : names.join(" and ");
      empty.appendChild(node("div", null, "They can put " + listed + " to work."));
    }
    container.appendChild(empty);
  }

  function clearEmpty() {
    for (const container of Object.values(laneContainers())) {
      container?.querySelector(".empty")?.remove();
    }
  }

  // --------------------------------------------------------------- screens

  function showScreen(name) {
    state.screen = name;
    for (const [key, node] of Object.entries(el.screens)) {
      // "loading" matches nothing, so every screen stays hidden until the host
      // says which one applies.
      const on = key === name;
      node.hidden = !on;
      node.dataset.active = String(on);
    }
    // Chips that describe a running team mean nothing on a gate — but the
    // account control stays on every screen. `claude auth status` reports
    // loggedIn:true for an expired token, so a user can be effectively signed
    // out while the gate never fires; there must always be a way to sign in.
    const running = name === "run";
    for (const id of ["autonomy", "billing", "connectors", "spend"]) {
      const node = el[id] ?? document.getElementById(id);
      if (node) node.style.display = running ? "" : "none";
    }
    el.floorButton.style.display = running ? "" : "none";
    el.workspace.style.display = name === "projects" ? "none" : "";
    el.home.style.opacity = name === "home" ? "0.55" : "1";
    el.home.disabled = name === "home";
    if (running) { buildFloor(); rerender(); renderLiveMap(); el.input.focus(); }
    if (el.splitter) el.splitter.hidden = !(running && el.livemap?.open);
    if (name === "builder") drawGraph();
    if (name === "workflow" && state.detail) renderGraph(el.detailMap, state.detail);
  }

  function renderProjects(e) {
    el.projectRoots.textContent = e.roots.length
      ? `looking in ${e.roots.join("  ·  ")}`
      : "no folders open";
    el.projectList.replaceChildren();

    if (!e.items.length) {
      const empty = node("div", "project-empty");
      empty.appendChild(node("div", null, "No projects found."));
      empty.appendChild(node("div", null, "A folder counts if it has a stack marker, is a git repo, or the team has worked there before."));
      el.projectList.appendChild(empty);
      return;
    }

    for (const item of e.items) {
      const card = node("button", "project");
      card.dataset.open = String(item.open);
      card.dataset.active = String(item.path === e.active);

      const top = node("div", "top");
      top.appendChild(node("span", "name", item.name));
      if (item.stack.length) top.appendChild(node("span", "muted", item.stack.join(" · ")));
      const badges = node("div", "badges");
      if (item.open) badges.appendChild(node("span", "badge open", "open"));
      if (item.known) badges.appendChild(node("span", "badge known", "known"));
      top.appendChild(badges);

      card.appendChild(top);
      card.appendChild(node("div", "path", shortenPath(item.path)));
      card.addEventListener("click", () =>
        vscode.postMessage({ kind: "openProject", path: item.path, alreadyOpen: item.open }),
      );
      el.projectList.appendChild(card);
    }
  }

  // ---------------------------------------------------------------- chrome

  /** Relative time, because "3 hours ago" is what you actually reason about. */
  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return "just now";
    const m = s / 60;
    if (m < 60) return Math.round(m) + "m ago";
    const h = m / 60;
    if (h < 24) return Math.round(h) + "h ago";
    const d = h / 24;
    return d < 7 ? Math.round(d) + "d ago" : new Date(ms).toLocaleDateString();
  }

  function renderSessions(e) {
    const items = e.items || [];
    el.sessions.hidden = false;
    el.sessionList.replaceChildren();

    if (!items.length) {
      const empty = node("div", "session-empty",
        e.project
          ? `No past conversations in ${e.project} yet.`
          : "Open a project to see its past conversations.");
      el.sessionList.appendChild(empty);
      return;
    }

    for (const item of items) {
      const row = node("button", "session");
      row.appendChild(node("span", "title", item.title));
      row.appendChild(node("span", "when", ago(item.when)));
      row.title = item.title;
      row.addEventListener("click", () =>
        vscode.postMessage({ kind: "resumeSession", id: item.id, title: item.title }),
      );
      el.sessionList.appendChild(row);
    }
  }

  function renderRoster() {
    el.roster.replaceChildren();
    for (const who of WHO()) {
      const member = state.members.get(who);
      if (!member) continue;
      const card = node("div", "member");
      card.dataset.who = who;
      card.style.setProperty("--lane-accent", accentOf(who));
      card.dataset.status = member.status;
      card.dataset.active = String(state.channel === who);
      card.title = member.role + "\n" + member.model + " · " + member.effort;

      const line = node("div", "who");
      line.appendChild(dot());
      line.appendChild(node("span", null, member.name));
      if (member.entry) line.appendChild(node("span", "badge", "you talk to"));
      card.appendChild(line);
      card.appendChild(node("div", "activity", member.activity || member.status));

      card.addEventListener("click", () => {
        setChannel(who);
        vscode.postMessage({ kind: "setChannel", to: who });
      });
      el.roster.appendChild(card);
    }

    for (const who of WHO()) {
      const lane = el.floor.querySelector('.lane[data-who="' + who + '"]');
      const member = state.members.get(who);
      if (lane && member) lane.dataset.status = member.status;
    }
  }

  /** A silent connector failure is worse than a loud one. */
  function renderConnectors(connectors) {
    if (!connectors.length) { el.connectors.hidden = true; return; }
    const down = connectors.filter((c) => !c.ok);
    el.connectors.hidden = false;
    el.connectors.textContent = down.length
      ? `${down.length}/${connectors.length} connectors down`
      : `${connectors.length} connector${connectors.length > 1 ? "s" : ""}`;
    el.connectors.classList.toggle("warn", down.length > 0);
    el.connectors.title = connectors.map((c) => `${c.ok ? "✓" : "✕"} ${c.name} (${c.status})`).join("\n");
  }

  /**
   * Keeps the tail of a long path, which is the part that identifies it.
   *
   * The home patterns are listed rather than assumed: there is no single shape
   * for a home directory across the three platforms, and matching only the two
   * unix ones meant a Windows path was never shortened at all. Splitting on
   * "/" alone had the same effect for the same reason — a Windows path has none
   * — so the card showed the whole thing and the truncation cut off the end,
   * which is the only part worth reading.
   */
  function shortenPath(full) {
    const home = /^\/home\/[^/]+|^\/Users\/[^/]+|^[A-Za-z]:[\\/]Users[\\/][^\\/]+/.exec(full);
    const tidy = home ? "~" + full.slice(home[0].length) : full;
    const parts = tidy.split(/[\\/]/);
    if (parts.length <= 4) return tidy;
    // Rebuilt with the separator the path actually uses, so a Windows path does
    // not come back as a mix of both.
    const sep = tidy.includes("\\") && !tidy.includes("/") ? "\\" : "/";
    return parts[0] + sep + "…" + sep + parts.slice(-2).join(sep);
  }

  function fillChannel() {
    const ids = WHO();
    el.channel.replaceChildren();
    for (const id of ids) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = NAME(id);
      el.channel.appendChild(option);
    }
    if (state.channel) el.channel.value = state.channel;
  }

  function setChannel(who) {
    state.channel = who;
    if (![...el.channel.options].some((o) => o.value === who)) fillChannel();
    el.channel.value = who;
    el.input.placeholder = state.canSend
      ? "Message " + NAME(who) + "…"
      : "Unavailable — see the message above";
    renderRoster();
  }

  /** A chip with nothing to say is hidden rather than showing a placeholder. */
  function setChip(node, value) {
    const has = Boolean(value) && value !== "—";
    node.hidden = !has;
    if (has) node.textContent = value;
  }

  function renderComposer() {
    el.send.disabled = state.busy || !state.canSend;
    el.attach.disabled = state.busy || !state.canSend;
    el.send.textContent = state.busy ? "Working…" : "Send";
    el.stop.hidden = !state.busy;
    // Only disabled when there is genuinely nothing to choose. It used to grey
    // out for the whole of a run, which is exactly when you want to look at who
    // else is on the workflow — switching mid-run asks first instead.
    el.channel.disabled = WHO().length < 2;
    el.channel.title =
      WHO().length < 2
        ? "This workflow has one agent"
        : state.busy
          ? "Choose who to talk to. Switching now will stop the current run — you will be asked first."
          : "Choose who to talk to. They have not seen what you said to anyone else.";
  }

  // ------------------------------------------------------------ host events

  const handlers = {
    roster(e) {
      const before = [...state.members.keys()].join(",");
      state.members = new Map(e.members.map((m) => [m.id, m]));
      state.workflowId = e.workflowId;
      state.workflowName = e.workflowName;
      state.edges = e.edges || [];
      if (!state.channel) state.channel = e.members.find((m) => m.entry)?.id || e.members[0]?.id || "";
      // The lanes are per agent, so a changed cast means rebuilding the board.
      if (before !== [...state.members.keys()].join(",")) { buildFloor(); rerender(); }
      // The roster carries enough to draw the map: who exists, in order, and
      // the arrows between them.
      state.runGraph = {
        name: e.workflowName,
        entry: e.members.find((m) => m.entry)?.id || "",
        // The positions the user laid out, so the map and the builder are
        // recognisably the same picture. Falls back to a row for a workflow
        // saved before positions were carried here.
        agents: e.members.map((m, i) => ({
          id: m.id, name: m.name, role: m.role,
          x: typeof m.x === "number" ? m.x : 40 + i * 260,
          y: typeof m.y === "number" ? m.y : 40 + (i % 2) * 130,
        })),
        edges: e.edges || [],
      };
      renderLiveMap();
      fillChannel();
      // The picker's enabled state depends on how many agents there are, so a
      // new roster has to recompute it — otherwise it keeps whatever it decided
      // when the workflow had none.
      renderComposer();
      setChip(el.workspace, e.workspace);
      setChip(el.autonomy, e.autonomy);
      setChip(el.billing, e.billing);
      renderConnectors(e.connectors || []);
      renderRoster();
    },
    status(e) {
      const member = state.members.get(e.who);
      if (!member) return;
      member.status = e.status;
      member.activity = e.activity;
      renderRoster();
      renderLiveMap();
    },
    screen(e) { showScreen(e.screen); },

    auth(e) {
      el.authDetail.textContent = e.signedIn
        ? `Signed in as ${e.detail}.`
        : `${e.detail} The team runs on your Claude Code login, so nothing can run until this is fixed.`;
      el.authApiKey.textContent = e.usingApiKey ? "Update the API key" : "Use an API key instead";

      el.account.textContent = e.signedIn ? e.detail : "sign in";
      el.account.dataset.state = e.signedIn ? "in" : "out";
      el.account.title = e.signedIn
        ? `${e.detail} — click for account options`
        : "Not signed in — click to sign in";
    },

    projects(e) { renderProjects(e); },
    sessions(e) { renderSessions(e); },

    workflows(e) { renderWorkflows(e); },
    detail(e) { renderDetail(e); },
    active(e) {
      state.activeAgents = e.agents || [];
      state.activeEdge = e.edge;
      renderLiveMap();
    },
    editing(e) { openBuilder(e); },
    refining(e) {
      if (e.busy) state.refining.add(e.agent); else state.refining.delete(e.agent);
      if (state.selected === e.agent) renderInspector();
    },
    refined(e) { applyRefinement(e); },
    building(e) {
      el.buildGo.disabled = e.busy;
      el.buildGo.textContent = e.busy ? "Designing…" : "Build it";
      el.buildInput.disabled = e.busy;
      if (e.note !== undefined) el.buildNote.textContent = e.note;
    },
    saved(e) {
      state.savedAt = e.at;
      state.dirty = false;
      renderSaveState();
    },
    channel(e) { setChannel(e.to); },
    sendability(e) {
      state.canSend = e.ok === true;
      setChannel(state.channel);
      renderComposer();
      if (!e.ok && e.reason) {
        const notice = { kind: "notice", level: "warn", text: e.reason };
        clearEmpty();
        remember(notice);
        renderEvent(notice);
      }
    },
    restoreInput(e) {
      if (!el.input.value.trim()) { el.input.value = e.text; resize(); }
      // Whatever was attached comes back with it, unless the user has since
      // attached something else — their newer choice wins over a restore.
      if (!state.pending.length && e.images?.length) {
        state.pending = e.images.slice(0, MAX_IMAGES);
        renderAttachments();
      }
      el.input.focus();
    },
    context(e) { renderContext(e); },
    busy(e) { state.busy = e.busy; renderComposer(); },
    clear() {
      state.log = [];
      state.busy = false;
      state.spendUsd = 0;
      el.spend.textContent = "$0.0000";
      rerender();
      renderComposer();
    },
  };

  window.addEventListener("message", (event) => {
    const e = event.data;
    if (!e || typeof e.kind !== "string") return;

    const handler = handlers[e.kind];
    if (handler) { handler(e); return; }

    clearEmpty();
    remember(e);
    renderEvent(e);
  });

  // ------------------------------------------------------------ attachments

  /** Reads a File, downscaling if it is larger than the model can use. */
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("could not read " + file.name));
      reader.onload = () => {
        const dataUrl = String(reader.result);
        /*
         * Pass through only a format the API accepts, at a size it accepts.
         *
         * Anything else is redrawn and comes back a real JPEG. A screenshot
         * saved as BMP, or an SVG dragged in from a file manager, used to be
         * relabelled `image/png` and sent with its original bytes: the label
         * said one thing, the data was another, and the message failed on the
         * API rather than here.
         *
         * A GIF small enough to pass through keeps its animation. One too large
         * is flattened, because the size limit is the harder constraint and the
         * model reads a single frame either way.
         */
        if (ACCEPTED.includes(file.type) && file.size <= MAX_BYTES) {
          const [, data] = dataUrl.split(",");
          resolve({ name: file.name || "pasted image", mediaType: file.type, data, bytes: file.size });
          return;
        }
        const img = new Image();
        img.onerror = () => reject(new Error("could not decode " + file.name));
        img.onload = () => {
          const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          const out = canvas.toDataURL("image/jpeg", 0.85);
          const [, data] = out.split(",");
          resolve({
            name: file.name || "pasted image",
            mediaType: "image/jpeg",
            data,
            bytes: Math.round((data.length * 3) / 4),
          });
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  async function stage(files) {
    const images = [...files].filter((f) => f && f.type.startsWith("image/"));
    if (!images.length) return;
    for (const file of images) {
      if (state.pending.length >= MAX_IMAGES) {
        renderNotice("warn", `Only ${MAX_IMAGES} images per message. The rest were not attached.`);
        break;
      }
      try {
        state.pending.push(await readImage(file));
      } catch (err) {
        renderNotice("error", String(err && err.message ? err.message : err));
      }
    }
    renderAttachments();
  }

  function renderNotice(level, text) {
    const notice = { kind: "notice", level, text };
    clearEmpty();
    remember(notice);
    renderEvent(notice);
  }

  function renderAttachments() {
    el.attachments.replaceChildren();
    el.attachments.hidden = !state.pending.length;
    state.pending.forEach((img, index) => {
      const wrap = node("div", "thumb");
      const preview = document.createElement("img");
      preview.src = `data:${img.mediaType};base64,${img.data}`;
      preview.alt = img.name;
      wrap.appendChild(preview);
      const remove = node("button", null, "×");
      remove.title = `Remove ${img.name}`;
      remove.addEventListener("click", () => {
        state.pending.splice(index, 1);
        renderAttachments();
      });
      wrap.appendChild(remove);
      wrap.title = `${img.name} · ${Math.round(img.bytes / 1024)} KB`;
      el.attachments.appendChild(wrap);
    });
    renderComposer();
  }

  // ----------------------------------------------------------- interactions

  function submit() {
    const text = el.input.value.trim();
    // An image on its own is a complete message.
    if ((!text && !state.pending.length) || state.busy || !state.canSend) return;
    vscode.postMessage({ kind: "send", text, images: state.pending });
    state.pending = [];
    renderAttachments();
    el.input.value = "";
    resize();
  }

  function resize() {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 190) + "px";
  }

  el.send.addEventListener("click", submit);
  el.stop.addEventListener("click", () => vscode.postMessage({ kind: "stop" }));
  el.floorButton.addEventListener("click", () => vscode.postMessage({ kind: "openTeamFloor" }));
  el.workspace.addEventListener("click", () => vscode.postMessage({ kind: "goHome" }));
  el.home.addEventListener("click", () => vscode.postMessage({ kind: "goHome" }));
  el.authSignIn.addEventListener("click", () => vscode.postMessage({ kind: "signIn" }));
  el.authApiKey.addEventListener("click", () => vscode.postMessage({ kind: "useApiKey" }));
  el.authRecheck.addEventListener("click", () => vscode.postMessage({ kind: "refreshAuth" }));
  el.account.addEventListener("click", () => vscode.postMessage({ kind: "account" }));
  el.projectsConfigure.addEventListener("click", () =>
    vscode.postMessage({ kind: "configure", setting: "cadre.projectRoots" }),
  );
  el.channel.addEventListener("change", () => {
    setChannel(el.channel.value);
    vscode.postMessage({ kind: "setChannel", to: el.channel.value });
  });
  el.attach.addEventListener("click", () => el.file.click());
  el.file.addEventListener("change", async () => {
    await stage(el.file.files || []);
    el.file.value = "";
  });

  el.input.addEventListener("paste", (event) => {
    const items = [...(event.clipboardData?.files || [])];
    if (!items.length) return;
    event.preventDefault();
    void stage(items);
  });

  for (const type of ["dragenter", "dragover"]) {
    el.composer.addEventListener(type, (e) => {
      e.preventDefault();
      el.composer.dataset.dropping = "true";
    });
  }
  for (const type of ["dragleave", "drop"]) {
    el.composer.addEventListener(type, (e) => {
      e.preventDefault();
      el.composer.dataset.dropping = "false";
    });
  }
  el.composer.addEventListener("drop", (e) => void stage(e.dataTransfer?.files || []));

  el.input.addEventListener("input", resize);
  el.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
  });

  // ------------------------------------------------------- graph thumbnail

  /**
   * A read-only picture of a workflow, scaled to fit whatever box it is given.
   *
   * Shared by the workflow page and the live map above a running board. It is
   * pure SVG rather than positioned DOM — the interactive canvas needs real
   * elements to drag, but a thumbnail only needs to scale, and scaling one
   * <svg> viewBox is both simpler and sharper than transforming a dozen divs.
   */
  function renderGraph(container, workflow, opts = {}) {
    if (!container) return;
    container.replaceChildren();
    if (!workflow || !workflow.agents.length) {
      container.appendChild(node("div", "map-empty", "No agents yet."));
      return;
    }

    const W = 210;
    const H = 92;
    const pad = 26;
    const xs = workflow.agents.map((a) => a.x);
    const ys = workflow.agents.map((a) => a.y);
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const width = Math.max(...xs) + W + pad - minX;
    const height = Math.max(...ys) + H + pad - minY;

    const active = new Set(opts.active || []);
    // Work flowing INTO an active agent is what an arrow in motion means. The
    // runner names the exact edge when it knows it, but deriving it from who is
    // busy also covers the cases it cannot see — and matches what a person
    // reading the picture would expect.
    const live = opts.edge;
    const flowing = (edge) =>
      Boolean(live && live.from === edge.from && live.to === edge.to) ||
      (active.has(edge.to) && !active.has(edge.from));

    const root = svg("svg");
    root.setAttribute("viewBox", `${minX} ${minY} ${width} ${height}`);
    root.setAttribute("class", "map");
    root.setAttribute("preserveAspectRatio", "xMidYMid meet");

    const defs = svg("defs");
    for (const kind of ["idle", "live"]) {
      const m = svg("marker");
      m.setAttribute("id", `map-arrow-${kind}`);
      m.setAttribute("viewBox", "0 0 10 10");
      m.setAttribute("refX", "9");
      m.setAttribute("refY", "5");
      m.setAttribute("markerWidth", "6");
      m.setAttribute("markerHeight", "6");
      m.setAttribute("orient", "auto-start-reverse");
      const head = svg("path");
      head.setAttribute("d", "M 0 1 L 10 5 L 0 9 z");
      head.setAttribute("class", "head " + kind);
      m.appendChild(head);
      defs.appendChild(m);
    }
    root.appendChild(defs);

    for (const edge of workflow.edges) {
      const from = workflow.agents.find((a) => a.id === edge.from);
      const to = workflow.agents.find((a) => a.id === edge.to);
      if (!from || !to) continue;
      const a = { x: from.x + W, y: from.y + H / 2 };
      const b = { x: to.x, y: to.y + H / 2 };
      const bow = b.x < a.x ? 90 : Math.max(40, Math.abs(b.x - a.x) / 2);
      const hot = flowing(edge);

      const path = svg("path");
      path.setAttribute("d", `M ${a.x} ${a.y} C ${a.x + bow} ${a.y}, ${b.x - bow} ${b.y}, ${b.x} ${b.y}`);
      // Idle arrows are grey; only the ones carrying work take colour. Solid
      // versus dashed still says which kind of arrow it is.
      path.setAttribute("class", `wire ${edge.kind}${hot ? " live" : " idle"}`);
      path.setAttribute("marker-end", `url(#map-arrow-${hot ? "live" : "idle"})`);
      root.appendChild(path);
    }

    // Nothing running means nothing is highlighted: a picture where every node
    // is coloured says the same thing as one where none is.
    const anyActive = active.size > 0;

    workflow.agents.forEach((agent, index) => {
      const on = active.has(agent.id);
      const group = svg("g");
      group.setAttribute("class", `map-node${on ? " active" : ""}${anyActive && !on ? " resting" : ""}`);

      const box = svg("rect");
      box.setAttribute("x", String(agent.x));
      box.setAttribute("y", String(agent.y));
      box.setAttribute("width", String(W));
      box.setAttribute("height", String(H));
      box.setAttribute("rx", "8");
      box.setAttribute("class", "map-box");
      group.appendChild(box);

      // The accent bar matches the lane colour, so the map and the board are
      // obviously the same three agents rather than two unrelated pictures.
      const bar = svg("rect");
      bar.setAttribute("x", String(agent.x));
      bar.setAttribute("y", String(agent.y));
      bar.setAttribute("width", "4");
      bar.setAttribute("height", String(H));
      bar.setAttribute("rx", "2");
      // Grey while it waits, its own colour while it works.
      bar.setAttribute("fill", on || !anyActive ? ACCENTS[index % ACCENTS.length] : "currentColor");
      if (!on && anyActive) bar.setAttribute("class", "map-bar-resting");
      group.appendChild(bar);

      const label = svg("text");
      label.setAttribute("x", String(agent.x + 16));
      label.setAttribute("y", String(agent.y + 32));
      label.setAttribute("class", "map-name");
      label.textContent = agent.name || agent.id;
      group.appendChild(label);

      const role = svg("text");
      role.setAttribute("x", String(agent.x + 16));
      role.setAttribute("y", String(agent.y + 52));
      role.setAttribute("class", "map-role");
      const text = opts.activity?.[agent.id] || agent.role || "";
      role.textContent = text.length > 26 ? `${text.slice(0, 25)}…` : text;
      group.appendChild(role);

      if (workflow.entry === agent.id) {
        const badge = svg("text");
        badge.setAttribute("x", String(agent.x + W - 12));
        badge.setAttribute("y", String(agent.y + 20));
        badge.setAttribute("text-anchor", "end");
        badge.setAttribute("class", "map-badge");
        badge.textContent = "entry";
        group.appendChild(badge);
      }

      if (on) {
        const pulse = svg("circle");
        pulse.setAttribute("cx", String(agent.x + W - 16));
        pulse.setAttribute("cy", String(agent.y + H - 18));
        pulse.setAttribute("r", "5");
        pulse.setAttribute("class", "map-pulse");
        pulse.setAttribute("fill", ACCENTS[index % ACCENTS.length]);
        group.appendChild(pulse);
      }

      root.appendChild(group);
    });

    container.appendChild(root);
  }

  // ------------------------------------------------------- workflow page

  function renderDetail(e) {
    state.detail = e.workflow;
    el.detailName.textContent = e.workflow.name;
    el.detailDesc.textContent = e.workflow.description || "";
    el.detailDesc.hidden = !e.workflow.description;

    const global = e.workflow.scope === "global";
    el.detailScope.textContent = global ? "Global" : "This project";
    el.detailScope.title = global
      ? "Available in every project. Click to keep it in this project only."
      : "Stored in this project. Click to make it available everywhere.";

    const errors = (e.problems || []).filter((p) => p.level === "error");
    el.detailProblems.hidden = errors.length === 0;
    el.detailProblems.replaceChildren();
    for (const problem of errors) {
      el.detailProblems.appendChild(node("div", "problem", problem.message));
    }
    el.detailStart.disabled = errors.length > 0;
    el.detailStart.title = errors.length ? "Fix this workflow before running it" : "";

    el.detailSessions.replaceChildren();
    if (!e.sessions.length) {
      el.detailSessions.appendChild(node("div", "session-empty",
        "No conversations yet. Start one and it will be listed here."));
    }
    for (const item of e.sessions) {
      const row = node("button", "session");
      row.appendChild(node("span", "title", item.title));
      row.appendChild(node("span", "when", ago(item.when)));
      row.title = item.title;
      row.addEventListener("click", () =>
        vscode.postMessage({ kind: "resumeSession", id: item.id, title: item.title }));
      el.detailSessions.appendChild(row);
    }

    renderGraph(el.detailMap, e.workflow);
    el.detailLegend.replaceChildren();
    const legend = [
      ["delegate", `${e.workflow.edges.filter((x) => x.kind === "delegate").length} delegate`],
      ["then", `${e.workflow.edges.filter((x) => x.kind === "then").length} handoff`],
      ["live", "in motion while running"],
    ];
    for (const [kind, text] of legend) {
      const item = node("span", "legend-item");
      item.appendChild(node("span", "swatch " + kind));
      item.appendChild(node("span", null, text));
      el.detailLegend.appendChild(item);
    }
  }

  // ---------------------------------------------------------- live map

  function renderLiveMap() {
    if (!state.runGraph) return;
    const activity = {};
    for (const [id, member] of state.members) {
      if (member.activity) activity[id] = member.activity;
    }
    renderGraph(el.runMap, state.runGraph, {
      active: state.activeAgents,
      edge: state.activeEdge,
      activity,
    });
    const busy = state.activeAgents.length;
    const total = state.runGraph.agents.length;
    el.livemapTitle.textContent = state.workflowName || "Workflow";
    el.livemapHint.textContent = busy
      ? `${busy} of ${total} working`
      : `${total} agent${total === 1 ? "" : "s"}`;
    el.livemapToggle.textContent = el.livemap.open ? "Hide" : "Show";
  }

  // --------------------------------------------------------------- home

  function renderWorkflows(e) {
    el.homeProject.textContent = e.project ? `in ${e.project}` : "no project open";
    el.workflowList.replaceChildren();

    const local = e.items.filter((w) => w.scope !== "global");
    const global = e.items.filter((w) => w.scope === "global");

    if (!e.items.length) {
      const empty = node("div", "empty-note");
      empty.appendChild(node("p", null, "No workflows here yet."));
      empty.appendChild(node("p", "muted",
        "A workflow is a set of agents and the arrows between them. Start from a template below, or build one from scratch."));
      el.workflowList.appendChild(empty);
    }

    // Two groups, always in the same order, and each labelled with what the
    // scope actually means — "global" on its own does not tell you whether the
    // workflow or its conversations are shared.
    section("This project", "Stored in .cadre/workflows, so it travels with the repository", local);
    section("Everywhere", "Stored in your home directory and available in every project", global);

    function section(title, blurb, items) {
      if (!items.length) return;
      const head = node("div", "wf-section");
      head.appendChild(node("h2", null, title));
      head.appendChild(node("span", "muted", blurb));
      el.workflowList.appendChild(head);

      const grid = node("div", "wf-grid");
      for (const item of items) grid.appendChild(card(item));
      el.workflowList.appendChild(grid);
    }

    function card(item) {
      const wrap = node("div", "workflow-card");
      if (item.problems) wrap.dataset.broken = "true";

      const open = node("button", "wf-open");
      const title = node("div", "wf-name", item.name);
      if (item.scope === "global") title.appendChild(node("span", "badge", "everywhere"));
      open.appendChild(title);
      if (item.description) open.appendChild(node("div", "wf-desc", item.description));

      const cast = node("div", "wf-cast");
      for (const name of item.agentNames.slice(0, 6)) cast.appendChild(node("span", "pill", name));
      if (item.agentNames.length > 6) cast.appendChild(node("span", "pill more", `+${item.agentNames.length - 6}`));
      open.appendChild(cast);

      const meta = [`${item.agents} agent${item.agents === 1 ? "" : "s"}`, `${item.edges} arrow${item.edges === 1 ? "" : "s"}`];
      if (item.sessions) meta.push(`${item.sessions} conversation${item.sessions === 1 ? "" : "s"}`);
      if (item.updatedAt) meta.push(ago(item.updatedAt));
      open.appendChild(node("div", "wf-meta", meta.join(" · ")));

      if (item.problems) {
        open.appendChild(node("div", "wf-problem",
          `${item.problems} thing${item.problems === 1 ? "" : "s"} to fix before this can run`));
      }
      open.addEventListener("click", () => vscode.postMessage({ kind: "showWorkflow", id: item.id }));
      wrap.appendChild(open);

      const actions = node("div", "wf-actions");
      const act = (label, tip, command, extra = {}) => {
        const b = node("button", "ghost quiet", label);
        b.title = tip;
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          vscode.postMessage({ kind: command, id: item.id, ...extra });
        });
        actions.appendChild(b);
      };
      act("Edit", "Change the agents and arrows", "editWorkflow");
      act("Duplicate", "Copy it to modify", "duplicateWorkflow");
      act(
        item.scope === "global" ? "Localise" : "Globalise",
        item.scope === "global"
          ? "Keep this workflow in the current project only"
          : "Make this workflow available in every project",
        "moveWorkflow",
        { to: item.scope === "global" ? "local" : "global" },
      );
      act("Delete", "Remove this workflow", "deleteWorkflow");
      wrap.appendChild(actions);
      return wrap;
    }

    // Two kinds, and the difference matters enough to label: a starter is a
    // shape to build on, a complete one is a workflow you could run today.
    el.templateList.replaceChildren();
    const templates = e.templates || [];
    templateGroup("Ready to run", templates.filter((t) => t.kind === "complete"));
    templateGroup("Starting points", templates.filter((t) => t.kind !== "complete"));

    function templateGroup(title, items) {
      if (!items.length) return;
      el.templateList.appendChild(node("h3", "template-group", title));
      const grid = node("div", "template-grid");
      for (const t of items) grid.appendChild(templateCard(t));
      el.templateList.appendChild(grid);
    }

    function templateCard(t) {
      const card = node("button", "template-card");
      if (t.kind === "complete") card.dataset.complete = "true";
      card.appendChild(node("div", "wf-name", t.name));
      card.appendChild(node("div", "wf-desc", t.description));
      const cast = node("div", "wf-cast");
      for (const name of t.agents) cast.appendChild(node("span", "pill", name));
      card.appendChild(cast);
      const shape = `${t.agents.length} agent${t.agents.length === 1 ? "" : "s"} · ${t.edges} arrow${t.edges === 1 ? "" : "s"}`;
      card.appendChild(node("div", "wf-meta", `${shape} — opens in the builder, edit it, then launch`));
      card.addEventListener("click", () => vscode.postMessage({ kind: "newWorkflow", template: t.id }));
      return card;
    }
  }

  // ------------------------------------------------------------- builder

  const NODE_W = 210;
  const NODE_H = 92;

  function openBuilder(e) {
    // Preserve the selection across a re-validate so typing in the inspector
    // does not close it.
    const keep = state.selected;

    // Only an authoritative event replaces the draft. A re-validate or a
    // background screen refresh carries the host's copy, which is behind
    // whatever the user has typed since — adopting it would discard their work
    // and, worse, do it silently.
    const adopt = e.authoritative !== false || !state.draft || state.draft.id !== e.workflow.id;
    if (adopt) {
      state.draft = e.workflow;
      state.history = { past: [], future: [], baseline: JSON.stringify(e.workflow) };
      state.refineTried.clear();
      state.pendingLaunch = false;
      state.dirty = false;
      state.savedAt = e.workflow.updatedAt || 0;
      cancelAutosave();
    }
    state.problems = e.problems || [];
    state.palette = {
      presets: e.presets || [],
      catalogue: e.catalogue || [],
      skills: e.skills || [],
      connectors: e.connectors || [],
      models: e.models || [],
      efforts: e.efforts || [],
    };
    state.selected = keep && state.draft.agents.some((a) => a.id === keep) ? keep : null;
    if (adopt) el.builderName.value = state.draft.name;
    drawGraph();
    renderInspector();
    renderProblems();
    renderSaveState();
  }

  /**
   * Called after every local edit: records history, redraws, re-validates.
   *
   * History is recorded by comparing against the last snapshot rather than by
   * every mutation site remembering to announce itself — a dozen call sites
   * that each have to call commit() first is a dozen chances to forget, and the
   * bug that produces is an undo that skips a step.
   */
  function touch(redrawOnly) {
    if (!state.draft) return;
    const now = JSON.stringify(state.draft);
    if (now !== state.history.baseline) {
      state.history.past.push(state.history.baseline);
      // 60 steps is far more than anyone reaches for, and bounds the memory a
      // long editing session holds.
      if (state.history.past.length > 60) state.history.past.shift();
      state.history.future.length = 0;
      state.history.baseline = now;
      state.dirty = true;
      scheduleAutosave();
    }
    drawGraph();
    renderInspector();
    renderSaveState();
    if (!redrawOnly) vscode.postMessage({ kind: "checkWorkflow", workflow: state.draft });
  }

  /* ------------------------------------------------------------ undo/redo */

  function step(from, to) {
    if (!from.length || !state.draft) return false;
    to.push(JSON.stringify(state.draft));
    const restored = from.pop();
    state.draft = JSON.parse(restored);
    state.history.baseline = restored;
    state.dirty = true;
    if (state.selected && !state.draft.agents.some((a) => a.id === state.selected)) state.selected = null;
    el.builderName.value = state.draft.name;
    drawGraph();
    renderInspector();
    renderSaveState();
    scheduleAutosave();
    vscode.postMessage({ kind: "checkWorkflow", workflow: state.draft });
    return true;
  }

  const undo = () => step(state.history.past, state.history.future);
  const redo = () => step(state.history.future, state.history.past);

  /**
   * Undo belongs to whatever the user is actually editing. Inside a text field
   * that is the text, and hijacking it there would make the prompt box behave
   * unlike every other text box in the editor.
   */
  function editingText() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    return active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable;
  }

  window.addEventListener("keydown", (event) => {
    if (state.screen !== "builder") return;
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    if (editingText()) return;

    event.preventDefault();
    const wants = key === "y" || event.shiftKey ? redo : undo;
    if (!wants()) {
      say("info", key === "y" || event.shiftKey ? "Nothing to redo." : "Nothing to undo.");
    }
  });

  /* -------------------------------------------------------------- autosave */

  // Long enough that it is not saving mid-thought, short enough that a crash or
  // a closed window costs a sentence rather than an afternoon.
  const AUTOSAVE_IDLE = 45_000;
  // ...and never more than this with unsaved work, however continuously the
  // user is editing.
  const AUTOSAVE_MAX = 180_000;
  let idleTimer = 0;
  let maxTimer = 0;

  function scheduleAutosave() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => autosave(), AUTOSAVE_IDLE);
    if (!maxTimer) maxTimer = setTimeout(() => autosave(), AUTOSAVE_MAX);
  }

  function cancelAutosave() {
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    idleTimer = 0;
    maxTimer = 0;
  }

  /**
   * Writes the draft to disk without moving the user, redrawing, or resetting a
   * running session. A broken graph is saved too: a half-drawn workflow is a
   * normal state to be in, and refusing to keep it is how you lose it.
   */
  function autosave() {
    cancelAutosave();
    if (!state.draft) return;
    // The name field commits on blur, so a name being typed right now is not in
    // the draft yet and the draft can look clean while the box says otherwise.
    // Reading it here and then refusing to write, which is what happened, threw
    // the rename away at exactly the moment it needed keeping: the window being
    // hidden, or the builder being left.
    const typed = el.builderName.value.trim();
    if (typed && typed !== state.draft.name) {
      state.draft.name = typed;
      state.dirty = true;
    }
    if (!state.dirty) return;
    vscode.postMessage({ kind: "saveWorkflow", workflow: state.draft, auto: true });
  }

  function renderSaveState() {
    const node = document.getElementById("builder-saved");
    if (!node) return;
    if (state.dirty) {
      node.textContent = "unsaved";
      node.dataset.state = "dirty";
      node.title = "Autosaves shortly, or press Save";
      return;
    }
    node.dataset.state = "saved";
    node.textContent = state.savedAt ? `saved ${clock(state.savedAt)}` : "saved";
    node.title = "";
  }

  const clock = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  function agentOf(id) {
    return state.draft?.agents.find((a) => a.id === id);
  }

  function drawGraph() {
    const wf = state.draft;
    if (!wf || !el.canvas) return;

    for (const stale of [...el.canvas.querySelectorAll(".agent-node")]) stale.remove();

    let maxX = 0;
    let maxY = 0;
    for (const agent of wf.agents) {
      maxX = Math.max(maxX, agent.x + NODE_W);
      maxY = Math.max(maxY, agent.y + NODE_H);

      const box = node("div", "agent-node");
      box.dataset.id = agent.id;
      box.dataset.preset = agent.preset;
      box.dataset.selected = String(state.selected === agent.id);
      box.dataset.entry = String(wf.entry === agent.id);
      box.dataset.problem = String(state.problems.some((p) => p.level === "error" && p.where === agent.id));
      box.style.left = agent.x + "px";
      box.style.top = agent.y + "px";

      const title = node("div", "an-name", agent.name || agent.id);
      if (wf.entry === agent.id) title.appendChild(node("span", "badge", "entry"));
      box.appendChild(title);
      box.appendChild(node("div", "an-role", agent.role || presetName(agent.preset)));
      if (!agent.prompt.trim()) box.appendChild(node("div", "an-warn", "no prompt yet"));

      // Two output ports, because the arrow's meaning is chosen by which one
      // you drag from. Picking the type afterwards in a dialog is a worse
      // interaction: you have already forgotten which arrow you meant.
      for (const kind of ["delegate", "then"]) {
        const port = node("span", "port out " + kind);
        port.title = kind === "delegate"
          ? "Drag to an agent this one can hand work to and wait for"
          : "Drag to an agent that should start automatically when this one finishes";
        port.addEventListener("pointerdown", (ev) => startWire(ev, agent.id, kind));
        box.appendChild(port);
      }

      box.addEventListener("pointerdown", (ev) => startDrag(ev, agent.id));
      el.canvas.appendChild(box);
    }

    el.canvas.style.width = Math.max(maxX + 160, el.canvasWrap.clientWidth) + "px";
    el.canvas.style.height = Math.max(maxY + 160, el.canvasWrap.clientHeight - 4) + "px";
    drawWires();
  }

  function presetName(id) {
    return state.palette.presets.find((p) => p.id === id)?.name || id;
  }

  const svg = (tag) => document.createElementNS("http://www.w3.org/2000/svg", tag);

  function drawWires() {
    const wf = state.draft;
    if (!wf) return;
    el.wires.replaceChildren();
    el.wires.setAttribute("width", el.canvas.style.width || "100%");
    el.wires.setAttribute("height", el.canvas.style.height || "100%");

    const marker = svg("defs");
    for (const kind of ["delegate", "then"]) {
      const m = svg("marker");
      m.setAttribute("id", "arrow-" + kind);
      m.setAttribute("viewBox", "0 0 10 10");
      m.setAttribute("refX", "9");
      m.setAttribute("refY", "5");
      m.setAttribute("markerWidth", "7");
      m.setAttribute("markerHeight", "7");
      m.setAttribute("orient", "auto-start-reverse");
      const head = svg("path");
      head.setAttribute("d", "M 0 1 L 10 5 L 0 9 z");
      head.setAttribute("class", "head " + kind);
      m.appendChild(head);
      marker.appendChild(m);
    }
    el.wires.appendChild(marker);

    for (const edge of wf.edges) {
      const from = agentOf(edge.from);
      const to = agentOf(edge.to);
      if (!from || !to) continue;

      const a = { x: from.x + NODE_W, y: from.y + NODE_H / 2 };
      const b = { x: to.x, y: to.y + NODE_H / 2 };
      // Route out to the right and back in on the left, so a backwards arrow
      // (a cycle) reads as a loop rather than a line crossing both boxes.
      const backwards = b.x < a.x;
      const bow = backwards ? 90 : Math.max(40, Math.abs(b.x - a.x) / 2);
      const c1 = { x: a.x + bow, y: a.y };
      const c2 = { x: b.x - bow, y: b.y };
      const path = svg("path");
      path.setAttribute("d", `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`);
      path.setAttribute("class", "wire " + edge.kind + (backwards ? " back" : ""));
      path.setAttribute("marker-end", `url(#arrow-${edge.kind})`);
      path.addEventListener("click", (ev) => { ev.stopPropagation(); editEdge(edge); });

      const hit = svg("path");
      hit.setAttribute("d", path.getAttribute("d"));
      hit.setAttribute("class", "wire-hit");
      hit.addEventListener("click", (ev) => { ev.stopPropagation(); editEdge(edge); });

      el.wires.appendChild(path);
      el.wires.appendChild(hit);

      if (edge.label) {
        // The curve's own midpoint, not the average of its endpoints: on a
        // bowed wire those are far apart, which is how labels ended up sitting
        // on top of the boxes.
        const mid = {
          x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8,
          y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8,
        };
        const text = svg("text");
        text.setAttribute("x", String(mid.x));
        text.setAttribute("y", String(mid.y - 7));
        text.setAttribute("class", "wire-label");
        text.setAttribute("text-anchor", "middle");
        // Short, because the gap between two boxes is narrow and a label that
        // overruns it reads as text inside the box. The whole label is in the
        // tooltip and in the arrow's editor.
        text.textContent = edge.label.length > 18 ? edge.label.slice(0, 17) + "…" : edge.label;
        const full = svg("title");
        full.textContent = edge.label;
        text.appendChild(full);
        el.wires.appendChild(text);
      }
    }
  }

  /* ---------------------------------------------------------- interactions */

  function canvasPoint(ev) {
    const box = el.canvas.getBoundingClientRect();
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  }

  function startDrag(ev, id) {
    if (ev.target instanceof HTMLElement && ev.target.classList.contains("port")) return;
    const agent = agentOf(id);
    if (!agent) return;
    ev.preventDefault();
    state.selected = id;
    renderInspector();

    const start = canvasPoint(ev);
    const origin = { x: agent.x, y: agent.y };
    let moved = false;

    /**
     * A drag has to end even when the release is invisible to us.
     *
     * pointerup only arrives if the pointer is let go over this webview. Let go
     * over the editor, or off the window entirely, and we never hear it: the
     * node goes on following the cursor with no button held, and the only way
     * out is to click again. A move carrying no buttons is the evidence that
     * the release already happened, and pointercancel is what a touch drag
     * sends when the system takes the pointer away.
     */
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    const move = (m) => {
      if (!m.buttons) { up(); return; }
      const at = canvasPoint(m);
      agent.x = Math.max(0, origin.x + (at.x - start.x));
      agent.y = Math.max(0, origin.y + (at.y - start.y));
      moved = true;
      drawGraph();
    };
    const up = () => {
      done();
      if (moved) touch(true);
      else { drawGraph(); renderInspector(); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function startWire(ev, fromId, kind) {
    ev.preventDefault();
    ev.stopPropagation();
    const from = agentOf(fromId);
    if (!from) return;

    const ghost = svg("path");
    ghost.setAttribute("class", "wire ghost " + kind);
    el.wires.appendChild(ghost);
    const a = { x: from.x + NODE_W, y: from.y + NODE_H / 2 };

    const move = (m) => {
      // Same as dragging a node: a move with no button held means the release
      // already happened somewhere we could not see it. Drop the wire rather
      // than leave it trailing the cursor.
      if (!m.buttons) { abandon(); return; }
      const at = canvasPoint(m);
      ghost.setAttribute("d", `M ${a.x} ${a.y} C ${a.x + 60} ${a.y}, ${at.x - 60} ${at.y}, ${at.x} ${at.y}`);
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", abandon);
    };
    /** The pointer was taken away: drop the wire rather than guess a target. */
    const abandon = () => {
      done();
      ghost.remove();
      drawWires();
    };
    const up = (m) => {
      done();
      ghost.remove();

      const dropped = document.elementFromPoint(m.clientX, m.clientY);
      const target = dropped instanceof Element ? dropped.closest(".agent-node") : null;
      const toId = target instanceof HTMLElement ? target.dataset.id : undefined;
      if (!toId || toId === fromId || !state.draft) { drawWires(); return; }

      const exists = state.draft.edges.some((e) => e.from === fromId && e.to === toId && e.kind === kind);
      if (!exists) state.draft.edges.push({ from: fromId, to: toId, kind });
      touch();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abandon);
  }

  function editEdge(edge) {
    if (!state.draft) return;
    const panel = node("div", "edge-editor");
    panel.appendChild(node("div", "ee-title", `${NAME_OF(edge.from)} → ${NAME_OF(edge.to)}`));

    const kindRow = node("div", "ee-row");
    for (const kind of ["delegate", "then"]) {
      const b = node("button", "chip pick" + (edge.kind === kind ? " on" : ""),
        kind === "delegate" ? "can delegate to" : "then runs");
      b.addEventListener("click", () => { edge.kind = kind; panel.remove(); touch(); });
      kindRow.appendChild(b);
    }
    panel.appendChild(kindRow);

    const label = document.createElement("input");
    label.className = "ee-label";
    label.placeholder = "What is this arrow for? (optional, shown to the agent)";
    label.value = edge.label || "";
    label.addEventListener("change", () => { edge.label = label.value.trim() || undefined; touch(); });
    panel.appendChild(label);

    const remove = node("button", "danger", "Delete this arrow");
    remove.addEventListener("click", () => {
      state.draft.edges = state.draft.edges.filter((e) => e !== edge);
      panel.remove();
      touch();
    });
    panel.appendChild(remove);

    const close = node("button", "ghost quiet", "Close");
    close.addEventListener("click", () => panel.remove());
    panel.appendChild(close);

    for (const stale of [...document.querySelectorAll(".edge-editor")]) stale.remove();
    el.canvasWrap.appendChild(panel);
  }

  const NAME_OF = (id) => agentOf(id)?.name || id;

  function addAgent() {
    if (!state.draft) return;
    const count = state.draft.agents.length;
    const name = `Agent ${count + 1}`;
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    let id = base;
    for (let n = 2; state.draft.agents.some((a) => a.id === id); n += 1) id = `${base}_${n}`;

    state.draft.agents.push({
      id, name, role: "", prompt: "", preset: "readonly",
      x: 60 + (count % 3) * 260,
      y: 60 + Math.floor(count / 3) * 150,
    });
    if (!state.draft.entry) state.draft.entry = id;
    state.selected = id;
    touch();
  }

  /* -------------------------------------------------------------- inspector */

  function renderInspector() {
    if (!state.draft) { el.inspector.hidden = true; return; }
    const agent = state.selected ? agentOf(state.selected) : null;
    // With nothing selected the panel is not empty: it shows the settings that
    // apply to every agent, which is where you would look for them.
    if (!agent) { renderDefaults(); return; }
    el.inspector.hidden = false;

    const keepScroll = el.inspector.scrollTop;
    el.inspector.replaceChildren();

    const field = (labelText, control, hint) => {
      const wrap = node("label", "field");
      wrap.appendChild(node("span", "flabel", labelText));
      wrap.appendChild(control);
      if (hint) wrap.appendChild(node("span", "fhint", hint));
      el.inspector.appendChild(wrap);
      return control;
    };

    const head = node("div", "insp-head");
    head.appendChild(node("h2", null, agent.name || agent.id));
    const close = node("button", "ghost quiet", "×");
    close.title = "Close";
    close.addEventListener("click", () => { state.selected = null; renderInspector(); drawGraph(); });
    head.appendChild(close);
    el.inspector.appendChild(head);

    const name = document.createElement("input");
    name.value = agent.name;
    // Both handlers assign. `input` keeps the canvas live as you type; `change`
    // must not merely commit, because a value that arrives without an input
    // event — set programmatically, or by an autofill — would otherwise be
    // drawn on screen and never reach the model.
    name.addEventListener("input", () => { agent.name = name.value; drawGraph(); });
    name.addEventListener("change", () => { agent.name = name.value; touch(); });
    field("Name", name);

    const role = document.createElement("input");
    role.value = agent.role || "";
    role.placeholder = "One line — shown under the name";
    role.addEventListener("change", () => { agent.role = role.value; touch(); });
    field("Role", role);

    const prompt = document.createElement("textarea");
    prompt.rows = 10;
    prompt.value = agent.prompt || "";
    prompt.placeholder = "What is this agent for? A sentence or two is enough — refinement turns it into a real prompt.";
    prompt.addEventListener("change", () => {
      agent.prompt = prompt.value;
      if (!agent.rawPrompt) agent.rawPrompt = prompt.value;
      touch();
    });
    field("Prompt", prompt);

    const refineRow = node("div", "insp-row");
    const refine = node("button", "ghost", state.refining.has(agent.id) ? "Refining…" : "Refine with Claude");
    refine.disabled = state.refining.has(agent.id);
    refine.title = "Rewrites this into a full system prompt. You see the result before it is kept.";
    refine.addEventListener("click", () => {
      agent.prompt = prompt.value;
      agent.rawPrompt = agent.rawPrompt || prompt.value;
      vscode.postMessage({ kind: "refinePrompt", agent, workflow: state.draft });
    });
    refineRow.appendChild(refine);
    if (agent.rawPrompt && agent.rawPrompt !== agent.prompt) {
      const undo = node("button", "ghost quiet", "Revert to what I wrote");
      undo.addEventListener("click", () => { agent.prompt = agent.rawPrompt; touch(); });
      refineRow.appendChild(undo);
    }
    el.inspector.appendChild(refineRow);

    const entry = node("button", "ghost", state.draft.entry === agent.id ? "This is who you talk to" : "Make this the entry agent");
    entry.disabled = state.draft.entry === agent.id;
    entry.addEventListener("click", () => { state.draft.entry = agent.id; touch(); });
    el.inspector.appendChild(entry);

    el.inspector.appendChild(node("h3", null, "Capabilities"));
    for (const preset of state.palette.presets) {
      const row = node("label", "preset-row" + (agent.preset === preset.id ? " on" : ""));
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "preset";
      radio.checked = agent.preset === preset.id;
      radio.addEventListener("change", () => {
        agent.preset = preset.id;
        // The preset supplies the tool list; a stale explicit override would
        // silently win over the preset the user just picked.
        delete agent.tools;
        touch();
      });
      row.appendChild(radio);
      const text = node("span", "preset-text");
      text.appendChild(node("span", "pname", preset.name));
      text.appendChild(node("span", "pblurb", preset.blurb));
      row.appendChild(text);
      el.inspector.appendChild(row);
    }

    const advanced = document.createElement("details");
    advanced.className = "advanced";
    // Every edit re-renders the inspector, so without this the panel snapped
    // shut the moment you ticked anything inside it.
    advanced.open = state.advancedOpen;
    advanced.addEventListener("toggle", () => { state.advancedOpen = advanced.open; });
    advanced.appendChild(node("summary", null, "Advanced"));

    advanced.appendChild(labelled("Model", modelSelect(agent.model, (next) => {
      agent.model = next;
      // A model that takes no effort level must not keep a stale one.
      if (next && !effortsOf(next).length) agent.effort = undefined;
      touch();
    })));

    const efforts = effortsOf(agent.model || "");
    if (efforts.length) {
      advanced.appendChild(labelled("Effort", effortSelect(efforts, agent.effort, (next) => {
        agent.effort = next;
        touch();
      })));
    } else {
      advanced.appendChild(node("p", "fhint", `${modelLabel(agent.model)} does not take an effort level.`));
    }

    const turns = document.createElement("input");
    turns.type = "number";
    turns.min = "1";
    turns.max = "200";
    turns.value = agent.maxTurns ? String(agent.maxTurns) : "";
    turns.placeholder = "Preset default";
    turns.addEventListener("change", () => {
      agent.maxTurns = turns.value ? Number(turns.value) : undefined;
      touch();
    });
    advanced.appendChild(labelled("Max turns", turns));

    advanced.appendChild(node("h4", null, "Tools"));
    advanced.appendChild(node("p", "fhint",
      "Leave these alone to use the preset. Ticking any of them replaces the preset's list entirely."));
    for (const group of state.palette.catalogue) {
      advanced.appendChild(node("div", "tool-group", group.group));
      for (const tool of group.tools) {
        const row = node("label", "tool-row");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = (agent.tools || []).includes(tool.name);
        box.addEventListener("change", () => {
          const current = new Set(agent.tools || []);
          if (box.checked) current.add(tool.name); else current.delete(tool.name);
          agent.tools = current.size ? [...current] : undefined;
          touch();
        });
        row.appendChild(box);
        row.appendChild(node("span", "tname", tool.name.replace("mcp__team__", "")));
        row.appendChild(node("span", "tblurb", tool.blurb));
        advanced.appendChild(row);
      }
    }

    advanced.appendChild(multi("Skills", state.palette.skills, agent.skills, (next) => {
      agent.skills = next;
      touch();
    }, "Every skill this Claude Code has"));
    advanced.appendChild(multi("Connectors", state.palette.connectors, agent.connectors, (next) => {
      agent.connectors = next;
      touch();
    }, "Every connector the workspace offers"));

    el.inspector.appendChild(advanced);

    const remove = node("button", "danger", "Delete this agent");
    remove.addEventListener("click", () => {
      state.draft.agents = state.draft.agents.filter((a) => a.id !== agent.id);
      state.draft.edges = state.draft.edges.filter((e) => e.from !== agent.id && e.to !== agent.id);
      if (state.draft.entry === agent.id) state.draft.entry = state.draft.agents[0]?.id || "";
      state.selected = null;
      touch();
    });
    el.inspector.appendChild(remove);

    el.inspector.scrollTop = keepScroll;
  }

  /**
   * The workflow's own defaults: what every agent inherits unless it overrides.
   *
   * Three tiers in all, narrowest first — the agent's advanced settings, then
   * these, then the workspace setting. This tier exists because a workflow is
   * the unit people share, and "this one runs on sonnet" belongs with the graph
   * rather than in one person's editor config.
   */
  function renderDefaults() {
    const wf = state.draft;
    el.inspector.hidden = false;
    const keepScroll = el.inspector.scrollTop;
    el.inspector.replaceChildren();
    wf.defaults = wf.defaults || {};
    const d = wf.defaults;

    const head = node("div", "insp-head");
    head.appendChild(node("h2", null, "Workflow defaults"));
    el.inspector.appendChild(head);
    el.inspector.appendChild(node("p", "fhint",
      "Applied to every agent that does not set its own. An agent's Advanced panel always wins."));

    const scope = node("button", "ghost",
      wf.scope === "global" ? "Available in every project" : "Stored in this project");
    scope.title = wf.scope === "global"
      ? "Click to keep this workflow in the current project only"
      : "Click to make this workflow available in every project";
    scope.addEventListener("click", () => {
      vscode.postMessage({ kind: "moveWorkflow", id: wf.id, to: wf.scope === "global" ? "local" : "global" });
    });
    el.inspector.appendChild(scope);

    const desc = document.createElement("input");
    desc.value = wf.description || "";
    desc.placeholder = "One line, shown on the home screen";
    desc.addEventListener("change", () => { wf.description = desc.value.trim() || undefined; touch(); });
    el.inspector.appendChild(labelled("Description", desc));

    el.inspector.appendChild(labelled("Model", modelSelect(d.model, (next) => {
      d.model = next;
      if (next && !effortsOf(next).length) d.effort = undefined;
      touch();
    })));

    const defaultEfforts = effortsOf(d.model || "");
    if (defaultEfforts.length) {
      el.inspector.appendChild(labelled("Effort", effortSelect(defaultEfforts, d.effort, (next) => {
        d.effort = next;
        touch();
      })));
    } else {
      el.inspector.appendChild(node("p", "fhint", `${modelLabel(d.model)} does not take an effort level.`));
    }

    const turns = document.createElement("input");
    turns.type = "number";
    turns.min = "1";
    turns.max = "200";
    turns.value = d.maxTurns ? String(d.maxTurns) : "";
    turns.placeholder = "Each preset decides";
    turns.addEventListener("change", () => {
      d.maxTurns = turns.value ? Number(turns.value) : undefined;
      touch();
    });
    el.inspector.appendChild(labelled("Max turns", turns));

    el.inspector.appendChild(multi("Skills", state.palette.skills, d.skills, (next) => {
      d.skills = next; touch();
    }, "Every skill this Claude Code has"));
    el.inspector.appendChild(multi("Connectors", state.palette.connectors, d.connectors, (next) => {
      d.connectors = next; touch();
    }, "Every connector the workspace offers"));

    el.inspector.appendChild(node("p", "fhint", "Select an agent on the canvas to configure it individually."));
    el.inspector.scrollTop = keepScroll;
  }

  /** The effort levels one model accepts, from what the CLI reported. */
  function effortsOf(value) {
    if (!value) return state.palette.efforts;
    const match = state.palette.models.find((m) => m.value === value);
    return match ? match.efforts : state.palette.efforts;
  }

  function modelLabel(value) {
    if (!value) return "The default model";
    return state.palette.models.find((m) => m.value === value)?.label || value;
  }

  function modelSelect(current, onChange) {
    const select = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Inherit";
    select.appendChild(blank);
    for (const model of state.palette.models) {
      const option = document.createElement("option");
      option.value = model.value;
      // The label alone is ambiguous once aliases and pinned ids coexist —
      // "Opus" and "claude-opus-4-8[1m]" can both be in the list.
      option.textContent = model.label === model.value ? model.value : `${model.label} — ${model.value}`;
      if (model.description) option.title = model.description;
      select.appendChild(option);
    }
    // A model saved before it disappeared from the list must still be shown,
    // or opening the panel would silently change it.
    if (current && !state.palette.models.some((m) => m.value === current)) {
      const orphan = document.createElement("option");
      orphan.value = current;
      orphan.textContent = `${current} (not offered by this CLI)`;
      select.appendChild(orphan);
    }
    select.value = current || "";
    select.addEventListener("change", () => onChange(select.value || undefined));
    return select;
  }

  function effortSelect(efforts, current, onChange) {
    const select = document.createElement("select");
    for (const value of ["", ...efforts]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value || "Inherit";
      select.appendChild(option);
    }
    select.value = current && efforts.includes(current) ? current : "";
    select.addEventListener("change", () => onChange(select.value || undefined));
    return select;
  }

  function labelled(text, control) {
    const wrap = node("label", "field");
    wrap.appendChild(node("span", "flabel", text));
    wrap.appendChild(control);
    return wrap;
  }

  /**
   * A tri-state list: no selection means "inherit the workspace", which is not
   * the same as an empty selection meaning "none". Collapsing the two would
   * make it impossible to say "this agent gets no connectors".
   */
  function multi(title, options, chosen, onChange, inheritLabel) {
    const wrap = node("div", "multi");
    wrap.appendChild(node("h4", null, title));
    // Options may be plain strings (connectors) or described objects (skills).
    const items = options.map((o) => (typeof o === "string" ? { name: o } : o));
    if (!items.length) {
      wrap.appendChild(node("p", "fhint", `No ${title.toLowerCase()} available.`));
      return wrap;
    }
    if (title === "Skills") {
      // Said once, up front. A skill that cannot work should not be discovered
      // by watching an agent fail halfway through a run.
      wrap.appendChild(node("p", "fhint",
        "Skills that schedule work for later or fan it out — /loop, /schedule, /batch, /deep-research — cannot run here: Workflow, Agent, Cron and ScheduleWakeup are denied to every agent, at every autonomy level. An arrow is the only fan-out a workflow has."));
    }

    const inherit = node("label", "tool-row");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = chosen === undefined;
    box.addEventListener("change", () => onChange(box.checked ? undefined : []));
    inherit.appendChild(box);
    inherit.appendChild(node("span", "tname", "Inherit"));
    inherit.appendChild(node("span", "tblurb", inheritLabel));
    wrap.appendChild(inherit);

    for (const option of items) {
      const row = node("label", "tool-row");
      const tick = document.createElement("input");
      tick.type = "checkbox";
      tick.disabled = chosen === undefined;
      tick.checked = (chosen || []).includes(option.name);
      tick.addEventListener("change", () => {
        const current = new Set(chosen || []);
        if (tick.checked) current.add(option.name); else current.delete(option.name);
        onChange([...current]);
      });
      row.appendChild(tick);
      row.appendChild(node("span", "tname", `/${option.name}`));
      if (option.description) {
        const blurb = node("span", "tblurb", option.description);
        blurb.title = option.description;
        row.appendChild(blurb);
      }
      wrap.appendChild(row);
    }
    return wrap;
  }

  function applyRefinement(e) {
    const agent = agentOf(e.agent);
    if (!agent) return;
    if (e.prompt) {
      agent.rawPrompt = agent.rawPrompt || agent.prompt;
      agent.prompt = e.prompt;
      touch();
    }
    say(e.prompt ? "info" : "warn", e.note);
    if (state.pendingLaunch) continueLaunch();
  }

  /** A line of feedback on whichever screen is showing. */
  function say(level, text) {
    if (state.screen === "builder") {
      const note = document.getElementById("builder-note");
      if (note) { note.textContent = text; note.dataset.level = level; }
      return;
    }
    renderNotice(level, text);
  }

  function renderProblems() {
    const errors = state.problems.filter((p) => p.level === "error");
    const warnings = state.problems.filter((p) => p.level === "warning");
    el.problems.replaceChildren();
    el.problems.hidden = !state.problems.length;
    for (const problem of [...errors, ...warnings]) {
      const row = node("div", "problem");
      row.dataset.level = problem.level;
      row.textContent = problem.message;
      el.problems.appendChild(row);
    }
    // While a launch is in flight the button says so and stays disabled;
    // otherwise it reflects whether the workflow can run at all.
    if (state.pendingLaunch) {
      el.builderLaunch.disabled = true;
      el.builderLaunch.textContent = "Launching…";
    } else {
      el.builderLaunch.disabled = errors.length > 0;
      el.builderLaunch.textContent = "Launch";
      el.builderLaunch.title = errors.length ? "Fix what is flagged below first" : "Save and open this workflow";
    }
  }

  /**
   * Launch refines any agent whose prompt the user never expanded, one at a
   * time, then saves and opens the workflow. Refinement is on by default
   * because a one-line prompt is the single biggest quality problem a new
   * workflow has — but it is a checkbox, and it never runs twice on the same
   * text.
   */
  function beginLaunch() {
    // Clicking again while the first launch is still refining used to start a
    // second one, and the two raced to save.
    if (!state.draft || state.pendingLaunch) return;
    state.pendingLaunch = true;
    el.builderLaunch.disabled = true;
    el.builderLaunch.textContent = "Launching…";
    continueLaunch();
  }

  /** A prompt this long was written by someone, not jotted down. */
  const ALREADY_WRITTEN = 80;

  /**
   * Which agents Launch should expand before running.
   *
   * Only the ones that look like a jotted-down line. Refining a 300-word
   * template prompt is slower, costs money, and is as likely to make it worse
   * as better — and it was why launching a template sat there apparently doing
   * nothing for three round trips.
   *
   * `attempted` is what stops a failed refinement looping: without it the same
   * agent is picked again on every pass, and each pass is a real model call.
   */
  function needsRefining(agent) {
    if (!agent.prompt.trim()) return false;
    if (agent.rawPrompt) return false;
    if (state.refining.has(agent.id) || state.refineTried.has(agent.id)) return false;
    return agent.prompt.trim().split(/\s+/).length < ALREADY_WRITTEN;
  }

  function continueLaunch() {
    if (!state.draft || !state.pendingLaunch) return;
    const refineOn = /** @type {HTMLInputElement} */ (document.getElementById("builder-refine"))?.checked;
    const next = refineOn ? state.draft.agents.find(needsRefining) : undefined;

    if (next) {
      state.refineTried.add(next.id);
      say("info", `Refining ${next.name}…`);
      vscode.postMessage({ kind: "refinePrompt", agent: next, workflow: state.draft });
      return;
    }
    state.pendingLaunch = false;
    say("info", "Launching…");
    state.draft.name = el.builderName.value.trim() || state.draft.name;
    vscode.postMessage({ kind: "saveWorkflow", workflow: state.draft, launch: true });
  }

  el.homeNew?.addEventListener("click", () => vscode.postMessage({ kind: "newWorkflow" }));
  el.homeBuild?.addEventListener("click", () => {
    el.buildCard.hidden = !el.buildCard.hidden;
    if (!el.buildCard.hidden) el.buildInput.focus();
  });
  el.buildCancel?.addEventListener("click", () => {
    el.buildCard.hidden = true;
    el.buildNote.textContent = "";
  });
  const startBuild = () => {
    const description = el.buildInput.value.trim();
    if (!description) { el.buildNote.textContent = "Describe the pipeline first."; return; }
    el.buildNote.textContent = "";
    vscode.postMessage({ kind: "buildWorkflow", description });
  };
  el.buildGo?.addEventListener("click", startBuild);
  el.buildInput?.addEventListener("keydown", (event) => {
    // Enter alone would be a newline in a description this long.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); startBuild(); }
  });
  el.detailBack?.addEventListener("click", () => vscode.postMessage({ kind: "goHome" }));
  el.detailEdit?.addEventListener("click", () => {
    if (state.detail) vscode.postMessage({ kind: "editWorkflow", id: state.detail.id });
  });
  el.detailStart?.addEventListener("click", () => {
    if (state.detail) vscode.postMessage({ kind: "startSession", id: state.detail.id });
  });
  el.detailScope?.addEventListener("click", () => {
    if (!state.detail) return;
    vscode.postMessage({
      kind: "moveWorkflow",
      id: state.detail.id,
      to: state.detail.scope === "global" ? "local" : "global",
    });
  });
  el.builderBack?.addEventListener("click", () => {
    // Leaving is the one moment a pending autosave must not be pending.
    autosave();
    vscode.postMessage({ kind: "goHome" });
  });
  el.builderAdd?.addEventListener("click", addAgent);
  el.builderSave?.addEventListener("click", () => {
    if (!state.draft) return;
    cancelAutosave();
    state.draft.name = el.builderName.value.trim() || state.draft.name;
    vscode.postMessage({ kind: "saveWorkflow", workflow: state.draft });
  });
  el.builderLaunch?.addEventListener("click", () => { cancelAutosave(); beginLaunch(); });
  el.builderName?.addEventListener("change", () => {
    if (state.draft) { state.draft.name = el.builderName.value; touch(); }
  });
  el.canvasWrap?.addEventListener("click", (ev) => {
    if (ev.target === el.canvasWrap || ev.target === el.canvas) {
      for (const stale of [...document.querySelectorAll(".edge-editor")]) stale.remove();
      state.selected = null;
      renderInspector();
      drawGraph();
    }
  });
  /* ------------------------------------------------------- the separator */

  const MAP_MIN = 110;
  const DEFAULT_MAP = 210;

  function setMapHeight(px) {
    const room = document.body.clientHeight;
    // Always leave the board more than half the window: the map is orientation,
    // the lanes are the work.
    const max = Math.max(MAP_MIN, Math.round(room * 0.6));
    const height = Math.min(Math.max(Math.round(px), MAP_MIN), max);
    el.runMap.style.height = `${height}px`;
    try {
      vscode.setState?.({ ...(vscode.getState?.() ?? {}), mapHeight: height });
    } catch { /* state is a convenience */ }
    return height;
  }

  if (el.splitter && el.runMap) {
    const saved = vscode.getState?.();
    if (saved && typeof saved.mapHeight === "number") setMapHeight(saved.mapHeight);

    const syncSplitter = () => { el.splitter.hidden = !el.livemap.open || state.screen !== "run"; };
    el.livemap?.addEventListener("toggle", syncSplitter);
    syncSplitter();

    el.splitter.addEventListener("pointerdown", (event) => {
      if (!el.livemap.open) return;
      event.preventDefault();
      // Capture keeps the pointer aimed at the handle while it is dragged past
      // the edges of it. It can be refused, and a refusal is not a reason to
      // abandon the drag, so the listeners go on the window either way.
      try { el.splitter.setPointerCapture(event.pointerId); } catch { /* not fatal */ }
      el.splitter.dataset.dragging = "true";
      const startY = event.clientY;
      const startHeight = el.runMap.getBoundingClientRect().height;

      let ended = false;
      const done = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        el.splitter.removeEventListener("lostpointercapture", up);
        delete el.splitter.dataset.dragging;
      };
      const move = (m) => {
        // Same reasoning as the canvas: a move with no button held means the
        // release already happened where we could not see it. Left attached,
        // the map would go on resizing under a pointer nobody is pressing.
        if (!m.buttons) { up(); return; }
        setMapHeight(startHeight + (m.clientY - startY));
      };
      const up = () => {
        if (ended) return;
        ended = true;
        done();
        // The SVG scales to its box, so it has to be redrawn at the new size.
        renderLiveMap();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      el.splitter.addEventListener("lostpointercapture", up);
    });

    el.splitter.addEventListener("dblclick", () => { setMapHeight(DEFAULT_MAP); renderLiveMap(); });
    // Keyboard, because a drag handle that only responds to a mouse is not a
    // control everyone can reach.
    el.splitter.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 48 : 16;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const current = el.runMap.getBoundingClientRect().height;
      setMapHeight(current + (event.key === "ArrowDown" ? step : -step));
      renderLiveMap();
    });
  }

  // The map is a real control, not a hairline. It remembers whether you want
  // it, because a strip that silently collapsed every session read as "there is
  // nothing here" — which is exactly how it was missed.
  if (el.livemap) {
    const saved = vscode.getState?.();
    if (saved && typeof saved.mapOpen === "boolean") el.livemap.open = saved.mapOpen;
    el.livemap.addEventListener("toggle", () => {
      el.livemapToggle.textContent = el.livemap.open ? "Hide" : "Show";
      try {
        vscode.setState?.({ ...(vscode.getState?.() ?? {}), mapOpen: el.livemap.open });
      } catch { /* state is a convenience, never a requirement */ }
      if (el.livemap.open) renderLiveMap();
    });
  }

  // A hidden or closing webview is the last chance to keep unsaved work.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") autosave();
  });
  window.addEventListener("pagehide", () => autosave());

  el.runEdit?.addEventListener("click", () => {
    const id = state.workflowId || state.detail?.id || state.draft?.id;
    if (id) vscode.postMessage({ kind: "editWorkflow", id });
    else say("warn", "Open a workflow first.");
  });
  el.runSessions?.addEventListener("click", () => {
    el.sessions.hidden = !el.sessions.hidden;
  });

  // Layout follows available width, so the same view works in a narrow sidebar
  // and a full editor tab without the host telling it which one it is.
  function applyLayout() {
    const next = document.body.clientWidth >= LANE_BREAKPOINT ? "floor" : "stream";
    if (next === state.layout) return;
    state.layout = next;
    el.body.dataset.layout = next;
    rerender();
    renderRoster();
  }
  new ResizeObserver(applyLayout).observe(document.body);

  for (const id of ["workspace", "autonomy", "billing", "spend"]) {
    const node = el[id] ?? document.getElementById(id);
    if (node && (node.textContent || "").trim() === "—") node.hidden = true;
  }
  // Decide the layout before the first paint rather than waiting for the
  // observer's first callback. It arrives quickly in a real webview, so this
  // only ever showed as a flicker — but it meant the board was built once in
  // the wrong shape and immediately rebuilt, and it left the per-agent lanes
  // unreachable to anything that reads the page synchronously.
  applyLayout();
  el.body.dataset.layout = state.layout;
  showScreen("loading");
  buildFloor();
  showEmpty();
  renderComposer();
  vscode.postMessage({ kind: "ready" });
  el.input.focus();
})();

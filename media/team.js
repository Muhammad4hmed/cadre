// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const LANE_BREAKPOINT = 760;
  const WHO = ["lead", "researcher", "engineer"];
  const NAME = { lead: "Lead", researcher: "Researcher", engineer: "Engineer" };

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
      team: document.getElementById("screen-team"),
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
  };

  const state = {
    /** Every event received, so a layout flip can re-render losslessly. */
    log: [],
    layout: "stream",
    members: new Map(),
    channel: "lead",
    channelLocked: true,
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
      return Object.fromEntries(WHO.map((who) => [who, document.getElementById("stream-" + who)]));
    }
    const merged = document.getElementById("stream-all");
    return Object.fromEntries(WHO.map((who) => [who, merged]));
  }

  function buildFloor() {
    el.floor.replaceChildren();
    if (state.layout === "floor") {
      for (const who of WHO) {
        const lane = node("section", "lane");
        lane.dataset.who = who;
        const head = node("header");
        head.appendChild(dot());
        head.appendChild(node("span", null, NAME[who]));
        lane.appendChild(head);
        const stream = node("div", "stream");
        stream.id = "stream-" + who;
        lane.appendChild(stream);
        el.floor.appendChild(lane);
      }
      return;
    }
    const lane = node("section", "lane");
    const stream = node("div", "stream");
    stream.id = "stream-all";
    lane.appendChild(stream);
    el.floor.appendChild(lane);
  }

  const atBottom = (c) => c.scrollHeight - c.scrollTop - c.clientHeight < 48;

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
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const inline = (s) =>
      s
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

    const fence = /```(\w*)\n([\s\S]*?)```/g;
    let out = "";
    let cursor = 0;
    let match;
    while ((match = fence.exec(escaped)) !== null) {
      out += inline(escaped.slice(cursor, match.index));
      out += "<pre><code>" + match[2].replace(/\n$/, "") + "</code></pre>";
      cursor = fence.lastIndex;
    }
    return out + inline(escaped.slice(cursor));
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

  function renderEvent(e) {
    switch (e.kind) {
      case "userSaid": {
        const body = utterance(e.to, "you → " + NAME[e.to], "user");
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
          entry = { body: utterance(e.who, NAME[e.who]), raw: "" };
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
          details.appendChild(node("summary", null, NAME[e.who] + " reasoning"));
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
        state.acts.delete(e.act);
        return;
      }

      case "assign": {
        const a = e.assignment;
        const card = node("div", "assignment");
        card.appendChild(node("div", "route", NAME[a.from] + " → " + NAME[a.to]));
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

      case "notice":
        place(e.who || "lead", node("div", "notice " + e.level, e.text));
        return;

      case "compacted": {
        const shrunk = e.after ? ` — ${fmtTokens(e.before)} → ${fmtTokens(e.after)}` : "";
        place("lead", node("div", "notice compacted",
          `Context was full, so the history was summarised${shrunk}. The team keeps going; older detail is gone.`));
        return;
      }

      case "spend": {
        state.spendUsd = e.usd;
        const seconds = (e.durationMs / 1000).toFixed(1);
        place("lead", node("div", "spend", e.turns + " turns · " + seconds + "s · $" + e.usd.toFixed(4)));
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
    if (!state.log.length) { showEmpty(); return; }
    for (const e of state.log) renderEvent(e);
  }

  function showEmpty() {
    const container = laneContainers().lead;
    if (!container) return;
    const empty = node("div", "empty");
    empty.appendChild(node("span", "glyph", "◈"));
    empty.appendChild(node("div", null, "Describe your project to the Lead."));
    empty.appendChild(
      node("div", null, "They'll question the brief, then put the Researcher and Engineer to work."),
    );
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
    for (const id of ["autonomy", "billing", "connectors", "spend"]) {
      const node = el[id] ?? document.getElementById(id);
      if (node) node.style.display = name === "team" ? "" : "none";
    }
    el.floorButton.style.display = name === "team" ? "" : "none";
    el.workspace.style.display = name === "projects" ? "none" : "";
    el.home.style.opacity = name === "projects" ? "0.55" : "1";
    el.home.disabled = name === "projects";
    if (name === "team") el.input.focus();
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
    for (const who of WHO) {
      const member = state.members.get(who);
      if (!member) continue;
      const card = node("div", "member");
      card.dataset.who = who;
      card.dataset.status = member.status;
      card.dataset.active = String(state.channel === who);
      card.title = member.role + "\n" + member.model + " · " + member.effort;

      const line = node("div", "who");
      line.appendChild(dot());
      line.appendChild(node("span", null, member.name));
      card.appendChild(line);
      card.appendChild(node("div", "activity", member.activity || member.status));

      card.addEventListener("click", () => {
        if (state.channelLocked && who !== "lead") {
          vscode.postMessage({ kind: "configure", setting: "cadre.directLine" });
          return;
        }
        setChannel(who);
        vscode.postMessage({ kind: "setChannel", to: who });
      });
      el.roster.appendChild(card);
    }

    for (const who of WHO) {
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

  /** Keeps the tail of a long path, which is the part that identifies it. */
  function shortenPath(full) {
    const home = /^\/home\/[^/]+|^\/Users\/[^/]+/.exec(full);
    const tidy = home ? "~" + full.slice(home[0].length) : full;
    const parts = tidy.split("/");
    return parts.length > 4 ? parts[0] + "/…/" + parts.slice(-2).join("/") : tidy;
  }

  function setChannel(who) {
    state.channel = who;
    el.channel.value = who;
    el.input.placeholder = state.canSend
      ? "Message " + NAME[who] + "…"
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
    el.channel.disabled = state.channelLocked;
    el.channel.title = state.channelLocked
      ? "Direct line is off — enable it in settings to talk to a teammate directly"
      : "Choose who to talk to";
  }

  // ------------------------------------------------------------ host events

  const handlers = {
    roster(e) {
      state.members = new Map(e.members.map((m) => [m.id, m]));
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

    directLine(e) {
      state.channelLocked = !e.enabled;
      renderComposer();
    },
    channel(e) { setChannel(e.to); },
    sendability(e) {
      state.canSend = e.ok === true;
      setChannel(state.channel);
      renderComposer();
      if (!e.ok && e.reason) {
        const notice = { kind: "notice", level: "warn", text: e.reason };
        clearEmpty();
        state.log.push(notice);
        renderEvent(notice);
      }
    },
    restoreInput(e) {
      if (!el.input.value.trim()) { el.input.value = e.text; resize(); }
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
    state.log.push(e);
    renderEvent(e);
  });

  // ------------------------------------------------------------ attachments

  /** Reads a File, downscaling if it is larger than the model can use. */
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const type = ACCEPTED.includes(file.type) ? file.type : "image/png";
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("could not read " + file.name));
      reader.onload = () => {
        const dataUrl = String(reader.result);
        // Animated GIFs lose their animation through a canvas, so pass through.
        if (type === "image/gif" || file.size <= MAX_BYTES) {
          const [, data] = dataUrl.split(",");
          if (file.size <= MAX_BYTES) {
            resolve({ name: file.name || "pasted image", mediaType: type, data, bytes: file.size });
            return;
          }
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
    state.log.push(notice);
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
  el.body.dataset.layout = state.layout;
  showScreen("loading");
  buildFloor();
  showEmpty();
  renderComposer();
  vscode.postMessage({ kind: "ready" });
  el.input.focus();
})();

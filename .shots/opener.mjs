/**
 * The explainer that runs before the demo.
 *
 * A viewer who has never seen this has one question — *what is it?* — and the
 * product's own UI cannot answer it in two seconds, because you have to know
 * what you are looking at first.
 *
 * Drawn in the product's palette and typeface so the cut into the real UI does
 * not feel like a different piece of software. No mechanics here: the arrows
 * are shown working rather than labelled and explained, because a demo that
 * stops to teach loses the person it was trying to convince.
 */

const INK = "#e6edf3";
const DIM = "#8b949e";
const BG = "#0b0e14";
const PANEL = "#161b22";
const EDGE = "#2b3440";
const BLUE = "#60a5fa";
const GREEN = "#4ade80";
const AMBER = "#fbbf24";
const VIOLET = "#a78bfa";
const CYAN = "#22d3ee";
const PINK = "#f472b6";

const W = 1280;
const H = 720;

const shell = (body) => `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: ${BG}; }
  body {
    font-family: "Segoe UI", "Noto Sans", "DejaVu Sans", system-ui, sans-serif;
    color: ${INK};
    -webkit-font-smoothing: antialiased;
  }
  /* A slow radial wash so a flat card is not a flat rectangle of one colour. */
  .stage {
    position: relative; width: 100%; height: 100%;
    background:
      radial-gradient(900px 520px at 50% 34%, #131a26 0%, ${BG} 68%),
      radial-gradient(circle at 1px 1px, #1b2432 1px, transparent 0) 0 0 / 26px 26px;
  }
  .headline {
    position: absolute; left: 0; right: 0; text-align: center;
    font-size: 46px; font-weight: 650; letter-spacing: -0.022em; line-height: 1.15;
  }
  .sub {
    position: absolute; left: 0; right: 0; text-align: center;
    font-size: 20px; font-weight: 400; color: ${DIM}; letter-spacing: 0;
  }
  .mono { font-family: ui-monospace, "DejaVu Sans Mono", monospace; }

  .box {
    position: absolute; width: 208px; height: 84px; border-radius: 12px;
    background: linear-gradient(180deg, #1a212c 0%, ${PANEL} 100%);
    border: 1px solid ${EDGE};
    padding: 13px 15px 0 17px; box-sizing: border-box;
    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
  }
  /* The accent is a bar, not a border, so it reads at a glance on a phone. */
  .box::before {
    content: ""; position: absolute; left: 0; top: 12px; bottom: 12px; width: 4px;
    border-radius: 0 3px 3px 0; background: var(--accent, ${DIM});
  }
  .box b { display: block; font-size: 17px; font-weight: 620; letter-spacing: -0.01em; }
  .box span { display: block; font-size: 12.5px; color: ${DIM}; margin-top: 5px; line-height: 1.4; }
  .box.lit {
    border-color: color-mix(in srgb, var(--accent) 55%, ${EDGE});
    box-shadow: 0 10px 26px rgba(0,0,0,.45), 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent),
                0 0 30px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .dim { opacity: 0.22; }

  svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .wire { fill: none; stroke-width: 2.5; }
  .wire.solid { stroke: ${BLUE}; }
  .wire.dash { stroke: ${GREEN}; stroke-dasharray: 9 7; }
  .wire.live { stroke: ${AMBER}; stroke-width: 4.5; stroke-dasharray: 11 8;
               filter: drop-shadow(0 0 7px rgba(251,191,36,.6)); }
  .wire.faint { opacity: 0.16; }

  .brand {
    position: absolute; left: 0; right: 0; text-align: center;
    font-size: 74px; font-weight: 750; letter-spacing: 0.2em;
    background: linear-gradient(92deg, ${VIOLET}, ${CYAN} 46%, ${BLUE});
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .rule {
    position: absolute; left: 50%; transform: translateX(-50%);
    width: 120px; height: 2px; border-radius: 2px;
    background: linear-gradient(90deg, transparent, ${VIOLET}, transparent);
  }
</style></head><body><div class="stage">${body}</div></body></html>`;

const arrowhead = (id, colour) => `
  <marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M 0 1 L 10 5 L 0 9 z" fill="${colour}"/>
  </marker>`;

const DEFS = `<defs>${arrowhead("b", BLUE)}${arrowhead("g", GREEN)}${arrowhead("a", AMBER)}</defs>`;

const curve = (a, b, cls, marker, bow = 70) =>
  `<path class="wire ${cls}" marker-end="url(#${marker})"
     d="M ${a.x} ${a.y} C ${a.x + bow} ${a.y}, ${b.x - bow} ${b.y}, ${b.x} ${b.y}"/>`;

const box = (x, y, name, role, accent, cls = "") =>
  `<div class="box ${cls}" style="left:${x}px;top:${y}px;--accent:${accent}">
     <b>${name}</b>${role ? `<span>${role}</span>` : ""}</div>`;

/* --------------------------------------------------------------- scenes */

/** What the viewer already has: one assistant, alone. */
export const one = () => shell(`
  <div class="headline" style="top:150px">Most AI coding tools<br>are one assistant.</div>
  ${box(536, 342, "Assistant", "Everything, by itself", DIM)}
  <div class="sub" style="top:492px">Reading, deciding, writing, checking — all in one context.</div>
`);

/**
 * The same work as a team. `stage` builds it up: the boxes, then the wires,
 * then the whole thing lit — three frames of one idea rather than one static
 * picture held while the narrator talks over it.
 */
export const team = (stage = 2) => {
  const wires = stage >= 1;
  const lit = stage >= 2;
  // Six agents and eight arrows, including a pair that point back at each
  // other. Four boxes in a row understates it: the interesting thing about a
  // workflow is that it is a graph, and a graph needs to look like one.
  const P = {
    product:  { x: 44,  y: 296, name: "Product",   role: "Decides what ships", c: VIOLET },
    architect:{ x: 356, y: 150, name: "Architect", role: "Designs the change", c: BLUE },
    research: { x: 356, y: 440, name: "Research",  role: "Finds the answer",   c: CYAN },
    builder:  { x: 668, y: 296, name: "Implementer", role: "Writes it",        c: AMBER },
    reviewer: { x: 980, y: 150, name: "Reviewer",  role: "Reads the diff",     c: PINK },
    tester:   { x: 980, y: 440, name: "Tests",     role: "Proves it runs",     c: GREEN },
  };
  const out = (k) => ({ x: P[k].x + 208, y: P[k].y + 42 });
  const into = (k) => ({ x: P[k].x, y: P[k].y + 42 });
  const back = (k) => ({ x: P[k].x, y: P[k].y + 62 });
  const outLow = (k) => ({ x: P[k].x + 208, y: P[k].y + 62 });
  const w = (a, b, kind, marker, bow) =>
    wires ? curve(a, b, `${kind}${lit ? "" : " faint"}`, marker, bow) : "";

  return shell(`
    <div class="headline" style="top:58px">Cadre is a team you draw.</div>
    <svg>${DEFS}
      ${w(out("product"), into("architect"), "solid", "b", 70)}
      ${w(out("product"), into("research"), "solid", "b", 70)}
      ${w(out("product"), into("builder"), "solid", "b", 130)}
      ${w(out("architect"), into("builder"), "solid", "b", 60)}
      ${w(out("builder"), into("reviewer"), "solid", "b", 60)}
      ${w(out("builder"), into("tester"), "dash", "g", 60)}
      ${/* pointing back: the reviewer returns defects, the builder asks again */ ""}
      ${w(back("reviewer"), outLow("builder"), "solid", "b", -70)}
      ${w(back("builder"), outLow("research"), "solid", "b", -70)}
    </svg>
    ${Object.entries(P).map(([k, a], i) =>
      box(a.x, a.y, a.name, a.role, a.c,
        stage >= 1 ? (lit ? "lit" : "") : (i === 0 ? "" : "dim"))).join("")}
    <div class="sub" style="top:596px">
      Each with its own prompt, its own tools, its own lane — and they answer each other.</div>
  `);
};

/** Describe it in a sentence — the prompt box, as the product shows it. */
export const describe = (typed) => shell(`
  <div class="headline" style="top:112px">Describe what you want.</div>
  <div style="position:absolute;left:190px;top:250px;width:900px;padding:26px 30px;
              border:1px solid ${EDGE};border-radius:14px;background:${PANEL};
              box-shadow:0 16px 40px rgba(0,0,0,.45)">
    <div class="mono" style="font-size:12px;color:${DIM};letter-spacing:.08em;text-transform:uppercase">
      Build with Claude</div>
    <div style="font-size:23px;line-height:1.5;margin-top:14px;min-height:104px">
      ${typed}<span style="color:${BLUE}">▍</span></div>
  </div>
  <div class="sub" style="top:508px">Claude designs the agents, their tools, and how they connect.</div>
`);

/**
 * What an agent is made of. The real inspector is narrow and dense; this is the
 * same idea at a size a phone can read.
 */
export const shape = () => shell(`
  <div class="headline" style="top:70px">Shape every agent yourself.</div>
  <div style="position:absolute;left:200px;top:186px;width:880px;
              border:1px solid ${EDGE};border-radius:14px;background:${PANEL};
              box-shadow:0 16px 40px rgba(0,0,0,.45);overflow:hidden">
    <div style="padding:16px 24px;border-bottom:1px solid ${EDGE};display:flex;align-items:center;gap:12px">
      <span style="width:4px;height:26px;border-radius:3px;background:${AMBER};display:inline-block"></span>
      <b style="font-size:20px">Implementer</b>
      <span style="color:${DIM};font-size:14px">Writes the change</span>
    </div>
    ${[
      ["Prompt", "What good work looks like in this role"],
      ["Model", "Fable · Opus · Sonnet · Haiku"],
      ["Tools", "Read · Write · Edit · Bash"],
      ["Skills", "/code-review · /verify · /simplify"],
      ["Connectors", "sentry · postgres · linear"],
    ].map(([k, v]) => `
      <div style="display:flex;padding:13px 24px;border-bottom:1px solid #1d2530">
        <span class="mono" style="width:150px;color:${DIM};font-size:14px;text-transform:uppercase;letter-spacing:.07em">${k}</span>
        <span style="font-size:16px">${v}</span>
      </div>`).join("")}
  </div>
  <div class="sub" style="top:588px">Its own prompt, its own model, and exactly which tools it can touch.</div>
`);

/**
 * A real team working one job, walked through four beats.
 *
 * `beat` lights different agents and different arrows: the lead takes the
 * brief, two agents work at the same time, one asks the other a question, and
 * the deliverable comes out the far end. One picture animated through a job
 * says "team" far better than a caption claiming it — and two boxes passing a
 * note looks like a pipeline, which is exactly the wrong impression.
 */
export const crew = (beat = 0) => {
  const P = {
    lead: { x: 60, y: 300 },
    res: { x: 380, y: 132 },
    eng: { x: 380, y: 452 },
    rev: { x: 700, y: 300 },
    doc: { x: 1010, y: 300 },
  };
  const on = [["lead"], ["lead", "res", "eng"], ["res", "eng"], ["rev", "doc"]][beat] ?? [];
  const hot = [[], [["lead", "res"], ["lead", "eng"]], [["eng", "res"]], [["eng", "rev"], ["rev", "doc"]]][beat] ?? [];

  const live = (a, b) => hot.some(([x, y]) => x === a && y === b);
  const cls = (a, b, kind) => (live(a, b) ? "live" : `${kind} faint`);
  const head = (a, b, kind) => (live(a, b) ? "a" : kind === "solid" ? "b" : "g");
  const right = (k) => ({ x: P[k].x + 208, y: P[k].y + 42 });
  const left = (k) => ({ x: P[k].x, y: P[k].y + 42 });
  const state = (k) => (on.includes(k) ? "lit" : "");

  return shell(`
    <div class="headline" style="top:58px">A team, not a queue.</div>
    <svg>${DEFS}
      ${curve(right("lead"), left("res"), cls("lead", "res", "solid"), head("lead", "res", "solid"))}
      ${curve(right("lead"), left("eng"), cls("lead", "eng", "solid"), head("lead", "eng", "solid"))}
      ${curve(right("eng"), left("rev"), cls("eng", "rev", "solid"), head("eng", "rev", "solid"))}
      ${curve(right("rev"), left("doc"), cls("rev", "doc", "dash"), head("rev", "doc", "dash"))}
      <path class="wire ${live("eng", "res") ? "live" : "solid faint"}"
        marker-end="url(#${live("eng", "res") ? "a" : "b"})"
        d="M ${P.eng.x + 70} ${P.eng.y} C ${P.eng.x + 10} ${P.eng.y - 100}, ${P.res.x + 10} ${P.res.y + 190}, ${P.res.x + 70} ${P.res.y + 84}"/>
    </svg>
    ${box(P.lead.x, P.lead.y, "Lead", "Talks to you, assigns the work", VIOLET, state("lead"))}
    ${box(P.res.x, P.res.y, "Researcher", "Reads the literature", CYAN, state("res"))}
    ${box(P.eng.x, P.eng.y, "Engineer", "Runs the experiments", AMBER, state("eng"))}
    ${box(P.rev.x, P.rev.y, "Reviewer", "Checks the numbers", PINK, state("rev"))}
    ${box(P.doc.x, P.doc.y, "Writer", "Writes it up", GREEN, state("doc"))}
    <div class="sub" style="top:606px">${[
      "You brief the lead. It decides who does what.",
      "Two of them work at the same time.",
      "And they ask each other questions along the way.",
      "Out the far end: a working model, and the report that explains it.",
    ][beat]}</div>
  `);
};

/** What people actually build with it. The point is that it is not only code. */
export const uses = () => {
  const card = (title, roles, accent) => `
    <div style="flex:1;border:1px solid ${EDGE};border-radius:14px;background:${PANEL};
                padding:20px 22px;box-shadow:0 12px 30px rgba(0,0,0,.4)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <span style="width:4px;height:22px;border-radius:3px;background:${accent};display:inline-block"></span>
        <b style="font-size:19px">${title}</b>
      </div>
      ${roles.map((r) => `<div style="font-size:14.5px;color:${DIM};line-height:1.95">${r}</div>`).join("")}
    </div>`;
  return shell(`
    <div class="headline" style="top:60px">Build any team you need.</div>
    <div style="position:absolute;left:76px;right:76px;top:176px;display:flex;gap:20px">
      ${card("A development team", ["Product · Architect", "Engineer · Reviewer", "Test engineer · Docs"], AMBER)}
      ${card("A research lab", ["Lead · Researcher", "Experimenter", "Statistician · Writer"], CYAN)}
      ${card("An HR department", ["Recruiter · Screener", "Interview designer", "Policy · Onboarding"], PINK)}
    </div>
    <div class="sub" style="top:556px">
      Anything you would hand to a team of people, you can draw here.</div>
  `);
};

/** The close. */
export const end = () => shell(`
  <div class="brand" style="top:212px">CADRE</div>
  <div class="rule" style="top:318px"></div>
  <div class="sub" style="top:352px;font-size:25px;color:${INK}">
    Build a team of AI agents. Watch them work.</div>
  <div style="position:absolute;left:50%;transform:translateX(-50%);top:412px;
              border:1px solid ${EDGE};border-radius:10px;background:${PANEL};padding:14px 26px">
    <span class="mono" style="font-size:17px;color:${DIM}">VS Code → Extensions → </span>
    <span class="mono" style="font-size:17px;color:${INK}">Cadre</span>
  </div>
  <div class="sub mono" style="top:502px;font-size:16px">
    Open source &nbsp;·&nbsp; MIT &nbsp;·&nbsp; runs on your Claude Code subscription</div>
  <div class="sub mono" style="top:546px;font-size:16px;color:${BLUE}">
    github.com/Muhammad4hmed/cadre</div>
`);

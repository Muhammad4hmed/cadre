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
  const P = { lead: { x: 92, y: 300 }, res: { x: 470, y: 178 }, eng: { x: 470, y: 420 }, rev: { x: 848, y: 300 } };
  return shell(`
    <div class="headline" style="top:74px">Cadre is a team you draw.</div>
    <svg>${DEFS}
      ${wires ? curve({ x: P.lead.x + 208, y: P.lead.y + 42 }, { x: P.res.x, y: P.res.y + 42 }, lit ? "solid" : "solid faint", "b") : ""}
      ${wires ? curve({ x: P.lead.x + 208, y: P.lead.y + 42 }, { x: P.eng.x, y: P.eng.y + 42 }, lit ? "solid" : "solid faint", "b") : ""}
      ${wires ? curve({ x: P.eng.x + 208, y: P.eng.y + 42 }, { x: P.rev.x, y: P.rev.y + 42 }, lit ? "dash" : "dash faint", "g") : ""}
    </svg>
    ${box(P.lead.x, P.lead.y, "Lead", "Decides and delegates", VIOLET, lit ? "lit" : "")}
    ${box(P.res.x, P.res.y, "Researcher", "Reads the outside world", CYAN, stage >= 1 ? (lit ? "lit" : "") : "dim")}
    ${box(P.eng.x, P.eng.y, "Engineer", "Writes and proves it", AMBER, stage >= 1 ? (lit ? "lit" : "") : "dim")}
    ${box(P.rev.x, P.rev.y, "Reviewer", "Reads the diff", PINK, stage >= 1 ? (lit ? "lit" : "") : "dim")}
    <div class="sub" style="top:572px">Each with its own prompt, its own tools, its own lane.</div>
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

/** The close. */
export const end = () => shell(`
  <div class="brand" style="top:212px">CADRE</div>
  <div class="rule" style="top:318px"></div>
  <div class="sub" style="top:352px;font-size:25px;color:${INK}">
    Build a team of AI agents. Watch them work.</div>
  <div class="sub mono" style="top:432px;font-size:17px">
    Open source &nbsp;·&nbsp; MIT &nbsp;·&nbsp; runs on your Claude Code subscription</div>
  <div class="sub mono" style="top:480px;font-size:18px;color:${BLUE}">
    github.com/Muhammad4hmed/cadre</div>
`);

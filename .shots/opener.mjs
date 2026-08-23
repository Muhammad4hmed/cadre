/**
 * The explainer that runs before the demo.
 *
 * A viewer who has never seen this has one question — *what is it?* — and the
 * product's own UI cannot answer it in two seconds, because you have to know
 * what you are looking at first. So this is a purpose-built sequence: one
 * assistant, then a team, then what the two kinds of arrow mean.
 *
 * Drawn in the product's palette and typeface so the cut into the real UI does
 * not feel like a different piece of software.
 */

const INK = "#e6edf3";
const DIM = "#8b949e";
const BG = "#0d1117";
const PANEL = "#161b22";
const EDGE = "#30363d";
const BLUE = "#60a5fa";
const GREEN = "#4ade80";
const AMBER = "#fbbf24";
const VIOLET = "#a78bfa";

const shell = (body, { w = 1280, h = 720 } = {}) => `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  @font-face { font-family: fallback; src: local("DejaVu Sans"); }
  html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; background: ${BG}; }
  body {
    font-family: "Segoe UI", "Noto Sans", "DejaVu Sans", system-ui, sans-serif;
    color: ${INK};
    -webkit-font-smoothing: antialiased;
  }
  .stage { position: relative; width: 100%; height: 100%; }
  .line {
    position: absolute; left: 0; right: 0; text-align: center;
    font-size: 40px; font-weight: 600; letter-spacing: -0.01em;
  }
  .sub { font-size: 21px; font-weight: 400; color: ${DIM}; letter-spacing: 0; }
  .mono { font-family: ui-monospace, "DejaVu Sans Mono", monospace; }
  .box {
    position: absolute; width: 210px; height: 86px; border-radius: 10px;
    background: ${PANEL}; border: 1px solid ${EDGE}; border-left: 4px solid var(--accent, ${DIM});
    padding: 12px 14px; box-sizing: border-box;
  }
  .box b { display: block; font-size: 16px; font-weight: 600; }
  .box span { display: block; font-size: 12px; color: ${DIM}; margin-top: 4px; line-height: 1.35; }
  .dim { opacity: 0.28; }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .wire.dim { opacity: 0.18; }
  .wire { fill: none; stroke-width: 2.5; }
  .wire.solid { stroke: ${BLUE}; }
  .wire.dash { stroke: ${GREEN}; stroke-dasharray: 9 7; }
  .wire.live { stroke: ${AMBER}; stroke-width: 4.5; stroke-dasharray: 10 8; }
  .tag {
    position: absolute; font-size: 15px; font-family: ui-monospace, "DejaVu Sans Mono", monospace;
    background: ${BG}; padding: 2px 8px; border-radius: 4px;
  }
  .brand {
    position: absolute; left: 0; right: 0; text-align: center;
    font-size: 64px; font-weight: 700; letter-spacing: 0.22em;
  }
</style></head><body><div class="stage">${body}</div></body></html>`;

const arrow = (id, colour) => `
  <marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M 0 1 L 10 5 L 0 9 z" fill="${colour}"/>
  </marker>`;

const curve = (a, b, cls, marker, bow = 90) =>
  `<path class="wire ${cls}" marker-end="url(#${marker})"
     d="M ${a.x} ${a.y} C ${a.x + bow} ${a.y}, ${b.x - bow} ${b.y}, ${b.x} ${b.y}"/>`;

const box = (x, y, name, role, accent, cls = "") =>
  `<div class="box ${cls}" style="left:${x}px;top:${y}px;--accent:${accent}">
     <b>${name}</b><span>${role}</span></div>`;

const DEFS = `<defs>${arrow("blue", BLUE)}${arrow("green", GREEN)}${arrow("amber", AMBER)}</defs>`;

/** One assistant, doing everything. The thing every viewer already has. */
export const one = () => shell(`
  <div class="line" style="top:120px">Most AI coding tools are one assistant.</div>
  ${box(535, 300, "Assistant", "Everything, by itself", DIM)}
  <div class="line sub" style="top:470px">Reading, deciding, writing, checking — all in one context.</div>
`);

/** The same problem, as a team. */
export const team = (withWires) => shell(`
  <div class="line" style="top:96px">Cadre is a team you draw.</div>
  <svg>${DEFS}
    ${withWires ? curve({ x: 330, y: 300 }, { x: 490, y: 210 }, "solid", "blue", 60) : ""}
    ${withWires ? curve({ x: 330, y: 300 }, { x: 490, y: 400 }, "solid", "blue", 60) : ""}
    ${withWires ? curve({ x: 700, y: 400 }, { x: 860, y: 300 }, "dash", "green", 60) : ""}
  </svg>
  ${box(120, 257, "Lead", "Decides and delegates", VIOLET)}
  ${box(490, 167, "Researcher", "Reads the outside world", "#22d3ee", withWires ? "" : "dim")}
  ${box(490, 357, "Engineer", "Writes and proves it", AMBER, withWires ? "" : "dim")}
  ${box(860, 257, "Reviewer", "Reads the diff", "#f472b6", withWires ? "" : "dim")}
  <div class="line sub" style="top:560px">Each one with its own prompt, its own tools, its own lane.</div>
`);

/**
 * What the two arrows mean — the one thing worth teaching before the demo.
 *
 * `focus` dims the other half. The narration explains them one at a time, and a
 * single static picture held across both sentences is nine seconds of a frozen
 * frame, which is where a viewer leaves.
 */
export const arrows = (focus) => shell(`
  <div class="line" style="top:76px">Two kinds of arrow.</div>
  <svg>${DEFS}
    ${curve({ x: 430, y: 258 }, { x: 700, y: 258 }, focus === "then" ? "solid dim" : "solid", "blue", 90)}
    ${curve({ x: 430, y: 500 }, { x: 700, y: 500 }, focus === "delegate" ? "dash dim" : "dash", "green", 90)}
  </svg>
  ${box(220, 215, "Lead", "", VIOLET, focus === "then" ? "dim" : "")}
  ${box(700, 215, "Engineer", "", AMBER, focus === "then" ? "dim" : "")}
  ${box(220, 457, "Writer", "", "#22d3ee", focus === "delegate" ? "dim" : "")}
  ${box(700, 457, "Editor", "", "#4ade80", focus === "delegate" ? "dim" : "")}
  <div class="tag ${focus === "then" ? "dim" : ""}" style="left:487px;top:196px;color:${BLUE}">delegate</div>
  <div class="tag ${focus === "delegate" ? "dim" : ""}" style="left:495px;top:438px;color:${GREEN}">then</div>
  <div class="line sub ${focus === "then" ? "dim" : ""}" style="top:330px">Hands work over and waits for the report. Cycles allowed — they can argue.</div>
  <div class="line sub ${focus === "delegate" ? "dim" : ""}" style="top:572px">Starts automatically when the work before it is done.</div>
`);

/** The claim worth arguing with. */
export const enforced = () => shell(`
  <div class="line" style="top:250px">A read-only agent<br><span style="color:${AMBER}">cannot</span> write a file.</div>
  <div class="line sub" style="top:430px">Enforced by the extension. Not requested in a prompt.</div>
`);

/** The close. */
export const end = () => shell(`
  <div class="brand" style="top:210px">CADRE</div>
  <div class="line sub" style="top:320px; font-size:24px">Build a team of AI agents. Watch them work.</div>
  <div class="line mono" style="top:412px; font-size:19px; color:${DIM}">
    Open source &nbsp;·&nbsp; MIT &nbsp;·&nbsp; runs on your Claude Code subscription
  </div>
  <div class="line mono" style="top:470px; font-size:19px; color:${BLUE}">github.com/Muhammad4hmed/cadre</div>
`);

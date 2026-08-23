/**
 * The rendering harness the screenshots and the demo film both use.
 *
 * The markup is extracted from src/extension.ts on every run and the CSS and JS
 * are the shipped files, unmodified — so neither the listing images nor the
 * video can drift from the actual interface. A separate extraction step that
 * wrote a copy went stale silently once already, which is exactly what "cannot
 * drift" was supposed to prevent.
 */
import * as fs from "node:fs";

// Extracted on every run, not read from a checked-in copy. A separate
// extraction step goes stale silently, which is exactly what "cannot drift"
// was supposed to prevent — and did not.
const source = fs.readFileSync("src/extension.ts", "utf8");
const body = source.slice(
  source.indexOf('  <header class="bar">'),
  source.indexOf("  <script nonce="),
);
if (!body.includes("screen-projects")) throw new Error("markup extraction failed — anchors moved");
const css = fs.readFileSync("media/team.css", "utf8");
const js = fs.readFileSync("media/team.js", "utf8");
const theme = fs.readFileSync(".shots/theme.css", "utf8");

export const page = (events, { width, height = 760, extraCss = "", after = "" }) => `<!doctype html>
<html><head><meta charset="utf-8">
<style>${theme}</style><style>${css}</style>
<style>html,body{width:${width}px;height:${height}px;margin:0;overflow:hidden}</style>\n<style>${extraCss}</style>
</head><body>
${body.replace(/\$\{[^}]*\}/g, "")}
<script>
  // The webview's only host dependency.
  window.acquireVsCodeApi = () => ({ postMessage(){}, getState(){}, setState(){} });
</script>
<script>${js}</script>
<script>
  const send = (e) => window.dispatchEvent(new MessageEvent("message", { data: e }));
  const script = ${JSON.stringify(events)};
  // Deltas are delivered in one pass; the streaming path is the same code.
  for (const e of script) send(e);
  const live = document.getElementById("livemap");
  if (live && document.getElementById("screen-run")?.dataset.active === "true") {
    live.open = true;
    live.dispatchEvent(new Event("toggle"));
  }
  ${after}
  document.title = "ready";
</script>
</body></html>`;


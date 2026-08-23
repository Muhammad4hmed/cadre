/**
 * Cuts the film to the narration, burns in the subtitles, and mixes the audio.
 *
 * Timings are not estimated. ElevenLabs returns the start and end time of every
 * character it spoke, so each line's real span is looked up rather than guessed
 * from its length — which is what clipped the last line before: the picture
 * ended where the arithmetic said the speech should, not where it did.
 *
 * Run `.shots/film.mjs --frames` first; this consumes what it leaves behind.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".shots/film";
const AUDIO = ".shots/audio";
const FPS = 30;

/** A held frame at the end, so the last word is not the last frame. */
const TAIL = 2.4;

const f = (n) => path.join(OUT, `f${String(n).padStart(4, "0")}.png`);
const VO = path.join(AUDIO, "vo.mp3");
const BED = path.join(AUDIO, "bed.mp3");
const ALIGN = path.join(AUDIO, "vo-align.json");
for (const file of [VO, BED, ALIGN]) {
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
}

/* ------------------------------------------------------- when things happen */

const align = JSON.parse(fs.readFileSync(ALIGN, "utf8"));
const spoken = align.characters.join("");
const starts = align.character_start_times_seconds;
const ends = align.character_end_times_seconds;

/**
 * Each line of narration, the frames under it, and the subtitle.
 *
 * The subtitle is not always the line: spoken punctuation and an em dash read
 * badly on screen, and a caption is skimmed rather than read.
 */
const SCRIPT = [
  { say: "Most AI coding tools are one assistant, doing everything.",
    text: "Most AI coding tools are one assistant", shots: [0] },
  { say: "Cadre is a team you draw.",
    text: "Cadre is a team you draw", shots: [1, 2, 3] },
  { say: "Describe what you want, and Claude designs the whole team.",
    text: "Describe what you want — Claude designs the team", shots: [4, 5, 13, 14] },
  { say: "Then shape every agent yourself.",
    text: "Then shape every agent yourself", shots: [6] },
  { say: "Its own prompt, its own model, and exactly which tools it can touch.",
    text: "Its own prompt, its own model, its own tools", shots: [6, 15] },
  { say: "Give each one the skills and connectors it needs.",
    text: "Add the skills and connectors it needs", shots: [6] },
  { say: "And they work as a team, handing work over and asking each other questions.",
    text: "They work as a team, not a queue", shots: [7] },
  { say: "Then watch all of them at once.",
    text: "Then watch all of them at once", shots: [{ flow: 16 }] },
  { say: "Every agent in its own lane, live.",
    text: "Every agent in its own lane, live", shots: [{ flow: 26 }] },
  { say: "Install it from the Extensions tab in VS Code.",
    text: "Install it from the Extensions tab in VS Code", shots: [8] },
  { say: "It is open source, and it runs on the Claude Code subscription you already have.",
    text: "Open source · runs on your Claude Code subscription", shots: [8] },
];

/** Where each line actually begins and ends, from the spoken alignment. */
let cursor = 0;
for (const line of SCRIPT) {
  const at = spoken.indexOf(line.say, cursor);
  if (at === -1) throw new Error(`not in the narration: ${JSON.stringify(line.say.slice(0, 40))}`);
  line.start = starts[at];
  line.end = ends[Math.min(at + line.say.length - 1, ends.length - 1)];
  cursor = at + line.say.length;
}

// A line runs until the next one starts, so a pause belongs to the picture
// before it rather than becoming a gap with nothing on screen.
SCRIPT.forEach((line, i) => {
  line.until = i + 1 < SCRIPT.length ? SCRIPT[i + 1].start : line.end + TAIL;
});

const scenes = [];
for (const line of SCRIPT) {
  const each = (line.until - line.start) / line.shots.length;
  line.shots.forEach((shot) => scenes.push({ shot, seconds: each }));
}
const total = SCRIPT.at(-1).until;

// Copy each flow run into its own directory: an image glob cannot start
// part-way through a numbered sequence.
for (const scene of scenes) {
  if (typeof scene.shot !== "object") continue;
  const dir = path.join(OUT, `flow-${scene.shot.flow}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 10; i += 1) {
    fs.copyFileSync(f(scene.shot.flow + i), path.join(dir, `${String(i).padStart(3, "0")}.png`));
  }
}

/* ------------------------------------------------------------- transitions */

/**
 * A different move for each kind of cut.
 *
 * Within one idea the transition should be almost invisible; between ideas it
 * should be felt. All the same is monotonous; all different is a showreel.
 */
const MOVES = [
  { transition: "fadeblack", duration: 0.5 },   // one assistant → a team
  { transition: "fade", duration: 0.3 },        // the team building up
  { transition: "fade", duration: 0.3 },
  { transition: "smoothleft", duration: 0.5 },  // → describe what you want
  { transition: "fade", duration: 0.25 },       // typing
  { transition: "smoothleft", duration: 0.5 },  // → the real product
  { transition: "fade", duration: 0.3 },
  { transition: "circleopen", duration: 0.55 }, // → the board, running
  { transition: "fade", duration: 0.3 },
  { transition: "fade", duration: 0.3 },
  { transition: "fadeblack", duration: 0.6 },   // → the end card
];
const move = (i) => MOVES[Math.min(i, MOVES.length - 1)];

/* ------------------------------------------------------------- the command */

const inputs = [];
scenes.forEach((scene, i) => {
  // Held past its slot by the crossfade that follows, since a fade consumes
  // the tail of one clip and the head of the next.
  const hold = (scene.seconds + (i < scenes.length - 1 ? move(i).duration : 0) + 0.1).toFixed(3);
  if (typeof scene.shot === "object") {
    inputs.push("-stream_loop", "60", "-framerate", "12", "-t", hold,
      "-i", path.join(OUT, `flow-${scene.shot.flow}`, "%03d.png"));
  } else {
    inputs.push("-loop", "1", "-t", hold, "-i", f(scene.shot));
  }
});
inputs.push("-i", VO, "-i", BED);

const voIn = scenes.length;
const bedIn = scenes.length + 1;

const filters = scenes.map((_, i) =>
  `[${i}:v]scale=1280:720,setsar=1,fps=${FPS},settb=1/${FPS}[v${i}]`);

let last = "v0";
let offset = 0;
scenes.slice(1).forEach((_, index) => {
  offset += scenes[index].seconds;
  const { transition, duration } = move(index);
  filters.push(`[${last}][v${index + 1}]xfade=transition=${transition}:duration=${duration}:offset=${offset.toFixed(3)}[x${index}]`);
  last = `x${index}`;
});

/* --------------------------------------------------------------- subtitles */

const FONT = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
].find((p) => fs.existsSync(p));

const escape = (s) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019");

// Held a beat past the speech so a caption is never gone before it is read, and
// sat above the bottom edge, where a feed puts its own furniture.
const subs = SCRIPT.map((line) => {
  const from = Math.max(0, line.start - 0.12).toFixed(2);
  const to = Math.min(total, line.until + 0.2).toFixed(2);
  return `drawtext=${FONT ? `fontfile=${FONT}:` : ""}text='${escape(line.text)}'` +
    `:fontcolor=#f2f6fb:fontsize=31` +
    `:box=1:boxcolor=#0b0e14@0.82:boxborderw=20` +
    `:x=(w-text_w)/2:y=h-120:enable='between(t,${from},${to})'`;
}).join(",");

filters.push(
  // Speech forward; the bed sits under it and ducks further while there is
  // speech, because a bed mixed by eye rides over the voice on a phone.
  `[${voIn}:a]loudnorm=I=-16:TP=-1.5:LRA=11,asplit=2[vo][key]`,
  `[${bedIn}:a]loudnorm=I=-29:TP=-2,atrim=0:${(total + 1).toFixed(2)},` +
    `afade=t=in:st=0:d=1.4,afade=t=out:st=${(total - 1.8).toFixed(2)}:d=1.8[bedq]`,
  // sidechaincompress returns LESS than either input — 25.4s of bed keyed by
  // 22s of speech came back as 19.2s, which silently cut the final line. Both
  // legs are padded and trimmed to the full length so the mix cannot be short.
  `[bedq][key]sidechaincompress=threshold=0.05:ratio=7:attack=8:release=340,` +
    `apad,atrim=0:${total.toFixed(2)}[duck]`,
  `[vo]apad,atrim=0:${total.toFixed(2)}[vop]`,
  `[vop][duck]amix=inputs=2:duration=longest:dropout_transition=0,` +
    // Single-pass loudnorm lands about 2 dB under target; measured, not assumed.
    `loudnorm=I=-14:TP=-2:LRA=11,volume=2.0dB,alimiter=limit=0.89,` +
    `aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${total.toFixed(2)}[a]`,
  `[${last}]${subs},format=yuv420p[v]`,
);

const args = [
  "-y", ...inputs,
  "-filter_complex", filters.join(";"),
  "-map", "[v]", "-map", "[a]",
  "-r", String(FPS), "-t", total.toFixed(2),
  "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
  "media/demo.mp4",
];

console.log(`${scenes.length} scenes · picture ${total.toFixed(1)}s · speech ends ${ends.at(-1).toFixed(1)}s`);
const run = spawnSync("ffmpeg", args, { encoding: "utf8" });
if (run.status !== 0) {
  console.error(run.stderr.split("\n").slice(-24).join("\n"));
  process.exit(1);
}
console.log(`media/demo.mp4  ${(fs.statSync("media/demo.mp4").size / 1e6).toFixed(1)} MB`);

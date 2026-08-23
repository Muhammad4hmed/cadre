/**
 * Cuts the film to the narration and mixes the audio.
 *
 * Scene lengths are not hand-tuned: each line of the voiceover gets a share of
 * its real duration proportional to its length, and the scenes assigned to that
 * line split it. Hand-timed cuts drift the moment a word changes, and the
 * voiceover is the thing most likely to be rewritten.
 *
 * Run `.shots/film.mjs --frames` first; this consumes what it leaves behind.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".shots/film";
const AUDIO = ".shots/audio";
const FPS = 30;
const XFADE = 0.35;

const f = (n) => path.join(OUT, `f${String(n).padStart(4, "0")}.png`);
const duration = (file) =>
  Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim());

const VO = path.join(AUDIO, "vo.mp3");
const BED = path.join(AUDIO, "bed.mp3");
for (const file of [VO, BED]) {
  if (!fs.existsSync(file)) throw new Error(`missing ${file} — generate the audio first`);
}
const voLength = duration(VO);

/**
 * Each line of narration, and the frames that play under it.
 *
 * `flow` entries are the ten-frame sequences where the arrows actually move;
 * everything else is a still held for its share of the line.
 */
const SCRIPT = [
  ["Most AI coding tools are one assistant, doing everything.", [0]],
  ["Cadre is a team you draw.", [1]],
  ["Every agent gets its own prompt, its own tools, and its own lane.", [2]],
  ["A solid arrow delegates — one agent hands work over, and waits for the report.", [3]],
  ["A dashed arrow hands off automatically, the moment the work before it is done.", [4]],
  ["Describe a pipeline in a sentence, and Claude designs the whole team.", [7, 8, 9, 10, 11]],
  ["Then watch all of them work at once.", [12, { flow: 14 }]],
  ["And a read-only agent physically cannot write a file. That is enforced, not requested.", [13, 5]],
  ["Open source, and it runs on the Claude Code subscription you already have.", [{ flow: 24 }, 6]],
];

const chars = SCRIPT.reduce((sum, [line]) => sum + line.length, 0);

/** Flatten into scenes with a duration each. */
const scenes = [];
for (const [line, shots] of SCRIPT) {
  const share = (line.length / chars) * voLength;
  // Typing frames read as motion, so they get a short slice each and the last
  // frame of the group keeps the remainder.
  const quick = shots.filter((s) => typeof s === "number" && s >= 8 && s <= 10).length;
  const quickTime = quick * 0.42;
  const rest = (share - quickTime) / Math.max(1, shots.length - quick);
  for (const s of shots) {
    const isQuick = typeof s === "number" && s >= 8 && s <= 10;
    scenes.push({ shot: s, seconds: Math.max(0.4, isQuick ? 0.42 : rest) });
  }
}

// Copy each flow sequence into its own directory: an image glob cannot start
// part-way through a numbered run.
for (const scene of scenes) {
  if (typeof scene.shot !== "object") continue;
  const dir = path.join(OUT, `flow-${scene.shot.flow}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 10; i += 1) {
    fs.copyFileSync(f(scene.shot.flow + i), path.join(dir, `${String(i).padStart(3, "0")}.png`));
  }
}

/* ------------------------------------------------------------ the command */

const inputs = [];
for (const scene of scenes) {
  // Each clip runs XFADE longer than its slot, because a crossfade consumes the
  // tail of one scene and the head of the next.
  const hold = (scene.seconds + XFADE).toFixed(3);
  if (typeof scene.shot === "object") {
    const dir = path.join(OUT, `flow-${scene.shot.flow}`);
    inputs.push("-stream_loop", "40", "-framerate", "12", "-t", hold, "-i", path.join(dir, "%03d.png"));
  } else {
    inputs.push("-loop", "1", "-t", hold, "-i", f(scene.shot));
  }
}
inputs.push("-i", VO, "-i", BED);

const voIn = scenes.length;
const bedIn = scenes.length + 1;

const filters = scenes.map((_, i) =>
  `[${i}:v]scale=1280:720,setsar=1,fps=${FPS},settb=1/${FPS}[v${i}]`);

let last = "v0";
let offset = 0;
scenes.slice(1).forEach((scene, index) => {
  offset += scenes[index].seconds;
  const out = `x${index}`;
  filters.push(`[${last}][v${index + 1}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[${out}]`);
  last = out;
});

const total = scenes.reduce((sum, s) => sum + s.seconds, 0);

filters.push(
  // Speech forward, music well under it, and ducked further whenever there is
  // speech — a bed mixed by eye rides over the voice on phone speakers.
  `[${voIn}:a]loudnorm=I=-16:TP=-1.5:LRA=11,asplit=2[vo][key]`,
  `[${bedIn}:a]loudnorm=I=-28:TP=-2,atrim=0:${(total + 1).toFixed(2)},` +
    `afade=t=in:st=0:d=1.2,afade=t=out:st=${(total - 1.6).toFixed(2)}:d=1.6[bedq]`,
  `[bedq][key]sidechaincompress=threshold=0.05:ratio=6:attack=8:release=320[duck]`,
  `[vo][duck]amix=inputs=2:duration=first:dropout_transition=0,` +
    // Single-pass loudnorm lands about 2 dB under its target, measured on the
    // finished file rather than assumed. Social platforms sit near -14 LUFS.
    `loudnorm=I=-14:TP=-2:LRA=11,volume=2.0dB,alimiter=limit=0.89,` +
    `aresample=48000,aformat=channel_layouts=stereo[a]`,
  `[${last}]format=yuv420p[v]`,
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

console.log(`${scenes.length} scenes, ${total.toFixed(1)}s of picture, ${voLength.toFixed(1)}s of narration`);
const run = spawnSync("ffmpeg", args, { encoding: "utf8" });
if (run.status !== 0) {
  console.error(run.stderr.split("\n").slice(-24).join("\n"));
  process.exit(1);
}
console.log(`media/demo.mp4  ${(fs.statSync("media/demo.mp4").size / 1e6).toFixed(1)} MB`);

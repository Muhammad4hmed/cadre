/**
 * Crops the empty tail off a screenshot.
 *
 * The home screen is rendered taller than its content so nothing is cut off,
 * which leaves a slab of background underneath. This finds the last row that
 * differs from the background and cuts just below it. No dependencies: PNG in,
 * PNG out, via Chrome's own canvas would need a browser, so this shells to
 * Python's Pillow, which the harness already relies on for the diagram.
 */
import { execFileSync } from "node:child_process";

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error("usage: node .shots/trim.mjs <input.png> <output.png>");
  process.exit(2);
}

const script = `
from PIL import Image
import sys
im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
px = im.load()
bg = px[w - 4, h - 4]
last = 0
for y in range(h - 1, -1, -1):
    if any(abs(px[x, y][c] - bg[c]) > 6 for x in range(0, w, 7) for c in range(3)):
        last = y
        break
bottom = min(h, last + 48)
im.crop((0, 0, w, bottom)).save(sys.argv[2])
print(f"{w}x{bottom}")
`;
const size = execFileSync("python3", ["-c", script, input, output], { encoding: "utf8" }).trim();
console.log(`  trimmed to ${size}`);

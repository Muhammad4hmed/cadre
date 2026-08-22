import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Toolchain {
  /** The command that can build the paper, if any is installed. */
  builder?: "latexmk" | "tectonic" | "pdflatex";
  /** Present when nothing local can build it. */
  advice?: string;
}

/**
 * Whether this machine can turn the paper into a PDF.
 *
 * The team authors LaTeX source regardless — a paper that only compiles where
 * it was written is not much use — so a missing toolchain is a fact to report,
 * not a reason to refuse.
 */
export async function detectToolchain(): Promise<Toolchain> {
  for (const builder of ["latexmk", "tectonic", "pdflatex"] as const) {
    try {
      await run(builder, ["--version"], { timeout: 10_000 });
      return { builder };
    } catch {
      // Try the next one.
    }
  }
  return {
    advice:
      "No LaTeX toolchain found. The source is complete and standard, so it builds anywhere: " +
      "upload the docs/paper folder to Overleaf, or install one locally " +
      "(Debian/Ubuntu: sudo apt install texlive-latex-recommended texlive-fonts-recommended " +
      "texlive-latex-extra latexmk; macOS: brew install --cask mactex-no-gui).",
  };
}

export interface BuildResult {
  ok: boolean;
  detail: string;
  pdf?: string;
}

/**
 * Builds the paper if a toolchain exists.
 *
 * LaTeX exits non-zero on errors but still writes a PDF for warnings, so the
 * PDF's existence is checked rather than trusting the exit code alone.
 */
export async function buildPaper(paperDir: string): Promise<BuildResult> {
  const main = path.join(paperDir, "main.tex");
  if (!fs.existsSync(main)) {
    return { ok: false, detail: `No paper yet — ${main} does not exist.` };
  }

  const chain = await detectToolchain();
  if (!chain.builder) return { ok: false, detail: chain.advice ?? "No LaTeX toolchain." };

  const args =
    chain.builder === "latexmk"
      ? ["-pdf", "-interaction=nonstopmode", "-halt-on-error", "main.tex"]
      : chain.builder === "tectonic"
        ? ["main.tex"]
        : ["-interaction=nonstopmode", "-halt-on-error", "main.tex"];

  try {
    await run(chain.builder, args, { cwd: paperDir, timeout: 180_000, maxBuffer: 8_000_000 });
  } catch (err) {
    const log = readLog(paperDir);
    const pdf = path.join(paperDir, "main.pdf");
    if (fs.existsSync(pdf)) {
      return { ok: true, pdf, detail: `Built with warnings (${chain.builder}).${log}` };
    }
    return {
      ok: false,
      detail: `${chain.builder} failed.${log || " " + (err instanceof Error ? err.message : String(err))}`,
    };
  }

  const pdf = path.join(paperDir, "main.pdf");
  return fs.existsSync(pdf)
    ? { ok: true, pdf, detail: `Built with ${chain.builder}.` }
    : { ok: false, detail: `${chain.builder} reported success but produced no PDF.` };
}

/** The first real LaTeX error, which is the only line worth showing. */
function readLog(paperDir: string): string {
  try {
    const log = fs.readFileSync(path.join(paperDir, "main.log"), "utf8");
    const line = log.split("\n").find((l) => l.startsWith("! "));
    return line ? ` First error: ${line.trim()}` : "";
  } catch {
    return "";
  }
}

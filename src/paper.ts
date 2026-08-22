import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/* ------------------------------------------------------------------ toolchain */

export interface Toolchain {
  builder?: string;
  /** Absolute path when we manage the binary ourselves. */
  managed?: string;
  advice?: string;
}

/** Where a Cadre-installed toolchain lives, so we never touch system dirs. */
export function toolchainHome(): string {
  return path.join(os.homedir(), ".cadre", "toolchain");
}

export async function detectToolchain(): Promise<Toolchain> {
  const managed = path.join(toolchainHome(), "tectonic");
  if (fs.existsSync(managed)) return { builder: "tectonic", managed };

  for (const builder of ["latexmk", "tectonic", "pdflatex"]) {
    try {
      await run(builder, ["--version"], { timeout: 10_000 });
      return { builder };
    } catch {
      // next
    }
  }
  return {
    advice:
      "No LaTeX toolchain found. Either install one system-wide (Debian/Ubuntu: " +
      "sudo apt install texlive-latex-recommended texlive-latex-extra latexmk), or let Cadre " +
      "fetch Tectonic — a single binary, no sudo, into ~/.cadre/toolchain.",
  };
}

/**
 * Fetches Tectonic into a Cadre-owned directory.
 *
 * Deliberately not a system install: no sudo, nothing outside `~/.cadre`, and
 * removable by deleting one folder. Tectonic is a single binary that pulls the
 * TeX packages a document actually needs on first build.
 */
export async function installToolchain(
  log: (line: string) => void,
): Promise<{ ok: boolean; detail: string }> {
  const home = toolchainHome();
  const target = path.join(home, "tectonic");
  if (fs.existsSync(target)) return { ok: true, detail: `Already installed at ${target}.` };

  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const platform =
    process.platform === "darwin"
      ? `${arch}-apple-darwin`
      : process.platform === "linux"
        ? `${arch}-unknown-linux-gnu`
        : undefined;
  if (!platform) {
    return { ok: false, detail: `No Tectonic build for ${process.platform}. Install a LaTeX toolchain manually.` };
  }

  try {
    log("resolving the latest Tectonic release…");
    const { stdout } = await run(
      "curl",
      ["-sL", "https://api.github.com/repos/tectonic-typesetting/tectonic/releases/latest"],
      { timeout: 60_000, maxBuffer: 8_000_000 },
    );
    const release = JSON.parse(stdout) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
    const asset = (release.assets ?? []).find(
      (a) => a.name.includes(platform) && a.name.endsWith(".tar.gz"),
    );
    if (!asset) return { ok: false, detail: `No Tectonic asset for ${platform}.` };

    fs.mkdirSync(home, { recursive: true });
    log(`downloading ${release.tag_name ?? "tectonic"} (~60 MB)…`);
    const archive = path.join(home, "tectonic.tar.gz");
    await run("curl", ["-sL", asset.browser_download_url, "-o", archive], { timeout: 600_000 });
    await run("tar", ["xzf", archive, "-C", home], { timeout: 120_000 });
    fs.rmSync(archive, { force: true });

    if (!fs.existsSync(target)) return { ok: false, detail: "Archive did not contain a tectonic binary." };
    fs.chmodSync(target, 0o755);
    const { stdout: version } = await run(target, ["--version"], { timeout: 30_000 });
    return { ok: true, detail: `${version.trim()} installed at ${target}.` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/* ---------------------------------------------------------------------- build */

export interface BuildResult {
  ok: boolean;
  detail: string;
  pdf?: string;
}

export async function buildPaper(paperDir: string): Promise<BuildResult> {
  const main = path.join(paperDir, "main.tex");
  if (!fs.existsSync(main)) return { ok: false, detail: `No paper at ${main}.` };

  const chain = await detectToolchain();
  const builder = chain.managed ?? chain.builder;
  if (!builder) return { ok: false, detail: chain.advice ?? "No LaTeX toolchain." };

  const args = builder.endsWith("latexmk")
    ? ["-pdf", "-interaction=nonstopmode", "main.tex"]
    : builder.endsWith("pdflatex")
      ? ["-interaction=nonstopmode", "main.tex"]
      : ["-X", "compile", "main.tex"];

  try {
    await run(builder, args, { cwd: paperDir, timeout: 600_000, maxBuffer: 16_000_000 });
  } catch (err) {
    const first = firstError(paperDir, err);
    const pdf = path.join(paperDir, "main.pdf");
    // LaTeX exits non-zero on warnings but still writes a PDF, so the file is
    // the authority rather than the exit code.
    if (fs.existsSync(pdf)) return { ok: true, pdf, detail: `Built with warnings. ${first}`.trim() };
    return { ok: false, detail: `Build failed. ${first}`.trim() };
  }

  const pdf = path.join(paperDir, "main.pdf");
  return fs.existsSync(pdf)
    ? { ok: true, pdf, detail: "Built." }
    : { ok: false, detail: "The builder reported success but produced no PDF." };
}

function firstError(paperDir: string, err: unknown): string {
  for (const name of ["main.log", "main.blg"]) {
    try {
      const line = fs
        .readFileSync(path.join(paperDir, name), "utf8")
        .split("\n")
        .find((l) => l.startsWith("! ") || l.includes("error:"));
      if (line) return `First error: ${line.trim()}`;
    } catch {
      // no log
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n").slice(0, 2).join(" ").slice(0, 300);
}

/* ------------------------------------------------------------------- claims */

/**
 * One factual assertion in the paper, bound to the artifact that supports it.
 *
 * Everything a reader would check — a number, a measurement, a claim about
 * prior work — needs an entry. The point is not that the model promises it is
 * true, but that a separate pass can go and look.
 */
export interface Claim {
  /** Matches `\claim{id}` in the .tex, so an orphan is detectable both ways. */
  id: string;
  /** The assertion, as it appears in the paper. */
  text: string;
  kind: "measurement" | "observation" | "citation" | "artifact";
  /** Where the support lives: a repo-relative path, or a URL for a citation. */
  source: string;
  /** The literal evidence — a command and its output, a quoted line, a bib key. */
  quote: string;
  /** ISO date the source was read or the run was made. */
  when: string;
}

export interface ClaimVerdict {
  id: string;
  ok: boolean;
  reason: string;
}

/**
 * Mechanical half of verification: does each claim's evidence exist, is every
 * claim in the paper declared, and is every declared claim used?
 *
 * This cannot judge whether a source *supports* an assertion — that needs a
 * reader. It exists so that the reader is never handed a claim with nothing
 * behind it in the first place.
 */
export function checkClaims(paperDir: string, projectRoot: string): {
  ok: boolean;
  verdicts: ClaimVerdict[];
  summary: string;
} {
  const ledgerPath = path.join(paperDir, "claims.json");
  const texPath = path.join(paperDir, "main.tex");

  if (!fs.existsSync(ledgerPath)) {
    return { ok: false, verdicts: [], summary: "No claims.json. Every factual claim must be declared before the paper is finished." };
  }
  if (!fs.existsSync(texPath)) {
    return { ok: false, verdicts: [], summary: "No main.tex to check against." };
  }

  let claims: Claim[];
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    claims = Array.isArray(parsed) ? parsed : (parsed.claims ?? []);
  } catch (err) {
    return { ok: false, verdicts: [], summary: `claims.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const tex = fs.readFileSync(texPath, "utf8");
  const usedInPaper = new Set([...tex.matchAll(/\\claim\{([^}]+)\}/g)].map((m) => m[1]));
  const bib = readBib(paperDir);
  const verdicts: ClaimVerdict[] = [];

  for (const claim of claims) {
    if (!claim?.id) { verdicts.push({ id: "(missing id)", ok: false, reason: "claim has no id" }); continue; }
    const fail = (reason: string) => verdicts.push({ id: claim.id, ok: false, reason });

    if (!claim.quote?.trim()) { fail("no quoted evidence"); continue; }
    if (!claim.when?.trim()) { fail("no date — a claim about a moving target is undated"); continue; }
    if (!usedInPaper.has(claim.id)) { fail("declared but never cited in main.tex"); continue; }

    if (claim.kind === "citation") {
      if (!/^https?:\/\//.test(claim.source ?? "")) { fail("a citation needs the URL that was fetched"); continue; }
      if (bib.size && !bib.has(claim.id) && !claim.quote.includes("@")) {
        // Not fatal: the bib key may differ from the claim id.
      }
      verdicts.push({ id: claim.id, ok: true, reason: `cites ${claim.source}` });
      continue;
    }

    const resolved = path.resolve(projectRoot, claim.source ?? "");
    if (!claim.source || !fs.existsSync(resolved)) {
      fail(`evidence file not found: ${claim.source || "(none)"}`);
      continue;
    }
    const body = safeRead(resolved);
    const needle = claim.quote.trim().split("\n")[0].trim();
    if (needle.length >= 8 && !body.includes(needle)) {
      fail(`the quoted evidence is not in ${claim.source}`);
      continue;
    }
    verdicts.push({ id: claim.id, ok: true, reason: `supported by ${claim.source}` });
  }

  const declared = new Set(claims.map((c) => c?.id).filter(Boolean));
  for (const id of usedInPaper) {
    if (!declared.has(id)) verdicts.push({ id, ok: false, reason: "cited in main.tex but not declared in claims.json" });
  }

  const bad = verdicts.filter((v) => !v.ok);
  return {
    ok: bad.length === 0 && verdicts.length > 0,
    verdicts,
    summary: verdicts.length === 0
      ? "claims.json is empty — a paper with no checkable claims is not finished."
      : bad.length === 0
        ? `All ${verdicts.length} claims trace to evidence that exists.`
        : `${bad.length} of ${verdicts.length} claims do not check out.`,
  };
}

function readBib(paperDir: string): Set<string> {
  try {
    const bib = fs.readFileSync(path.join(paperDir, "refs.bib"), "utf8");
    return new Set([...bib.matchAll(/@\w+\s*\{\s*([^,\s]+)/g)].map((m) => m[1]));
  } catch {
    return new Set();
  }
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

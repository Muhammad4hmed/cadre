import * as fs from "node:fs";
import * as path from "node:path";
import { plain } from "../workflow/protocol";

export interface ProjectSnapshot {
  root: string;
  name: string;
  /** Durable state a previous session left behind. */
  artifacts: { rel: string; label: string }[];
  /** Marker files that identify the stack, by what they are. */
  stack: string[];
  hasClaudeMd: boolean;
}

/** Files whose presence identifies the stack without reading anything. */
const MARKERS: [file: string, label: string][] = [
  ["package.json", "Node"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["tsconfig.json", "TypeScript"],
  ["deno.json", "Deno"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  ["Pipfile", "Python"],
  ["Cargo.toml", "Rust"],
  ["go.mod", "Go"],
  ["pom.xml", "Maven"],
  ["build.gradle", "Gradle"],
  ["build.gradle.kts", "Gradle"],
  ["Gemfile", "Ruby"],
  ["composer.json", "PHP"],
  ["CMakeLists.txt", "CMake"],
  ["Dockerfile", "Docker"],
  ["docker-compose.yml", "Docker Compose"],
];

const exists = (p: string): boolean => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

/**
 * Cheap, synchronous look at what the project is and what previous sessions
 * left behind. Deliberately marker-based: no file is read, so this costs
 * nothing and cannot leak contents into a prompt.
 *
 * File *names* are read, though, and they do reach the prompt — which this
 * comment said nothing about for a long time, and which is a different question
 * from contents. A name is chosen by whoever wrote the repository, so anything
 * from here is flattened before it is written into a line.
 */
export function surveyProject(root: string, docsPath: string): ProjectSnapshot {
  const rel = (...parts: string[]) => path.join(root, ...parts);

  const stack: string[] = [];
  for (const [file, label] of MARKERS) {
    if (exists(rel(file)) && !stack.includes(label)) stack.push(label);
  }

  const artifacts: { rel: string; label: string }[] = [];
  const note = (relPath: string, label: string) => {
    if (exists(rel(relPath))) artifacts.push({ rel: relPath, label });
  };
  note(path.join(docsPath, "PROJECT.md"), "what this project is, and the decisions behind it");
  note(".cadre/spec.md", "the working spec from an earlier session");
  note(".cadre/memory.md", "notes a previous Lead left for you");
  note(path.join(docsPath, "CHANGELOG.md"), "what has shipped");

  const researchDir = rel(path.join(docsPath, "research"));
  try {
    const reports = fs.readdirSync(researchDir).filter((f) => f.endsWith(".md"));
    if (reports.length) {
      artifacts.push({
        rel: path.join(docsPath, "research"),
        // A file name is chosen by whoever wrote the repository, and a newline
        // is legal in one. This label goes into every agent's prompt, which is
        // structured text: an unflattened name is a forged line of it.
        label: `${reports.length} existing research report${reports.length > 1 ? "s" : ""}: ${
          reports.slice(0, 6).map((f) => plain(f, 60)).join(", ")}`,
      });
    }
  } catch {
    // No research directory yet.
  }

  return {
    root,
    name: path.basename(root),
    artifacts,
    stack,
    hasClaudeMd: exists(rel("CLAUDE.md")),
  };
}

/**
 * A short orientation block appended to each teammate's system prompt.
 *
 * Without this the team starts every session cold and re-derives what it
 * already wrote down. It states only what exists and where — never contents —
 * so the teammate decides what is worth reading.
 */
export function contextPreamble(snapshot: ProjectSnapshot): string {
  // The project's name is a directory name, and a clone chooses that too.
  const lines: string[] = ["", "---", "", `## This project: ${plain(snapshot.name)}`, ""];

  lines.push(`Working directory: \`${plain(snapshot.root, 200)}\``);
  if (snapshot.stack.length) lines.push(`Markers present: ${snapshot.stack.join(", ")}.`);
  if (snapshot.hasClaudeMd) {
    lines.push("`CLAUDE.md` is loaded into your context already — its conventions are binding.");
  }

  if (snapshot.artifacts.length) {
    lines.push("");
    lines.push("Earlier sessions left this behind. Read what bears on the task before asking the user or re-deriving it:");
    lines.push("");
    for (const a of snapshot.artifacts) lines.push(`- \`${a.rel}\` — ${a.label}`);
    lines.push("");
    lines.push("If one of these contradicts what you find in the code, the code is right and the document is stale — say so rather than working from it.");
  } else {
    lines.push("");
    lines.push("No previous session left durable state here. You are starting cold.");
  }

  return lines.join("\n") + "\n";
}

import type { ProjectCard } from "./events";

const SKIP = new Set([
  "node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", "out",
  "target", ".next", ".cache", "vendor", ".idea", ".vscode", "Library", "Applications",
]);

/**
 * Lists candidate projects one level under each root.
 *
 * A directory counts as a project if it carries a stack marker, is a git repo,
 * or the team has already worked there — otherwise a home directory full of
 * unrelated folders produces a useless list.
 */
export function discoverProjects(
  roots: string[],
  workspaceFolders: string[],
  docsPath: string,
  limit = 60,
): ProjectCard[] {
  const seen = new Map<string, ProjectCard>();

  const card = (dir: string, open: boolean): ProjectCard | undefined => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
      if (!stat.isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    const snapshot = surveyProject(dir, docsPath);
    const isRepo = exists(path.join(dir, ".git"));
    const known = exists(path.join(dir, ".cadre")) || snapshot.artifacts.length > 0;
    if (!open && !snapshot.stack.length && !isRepo && !known) return undefined;
    return {
      path: dir,
      name: path.basename(dir),
      open,
      stack: snapshot.stack,
      known,
      lastTouched: stat.mtimeMs,
    };
  };

  // Folders already open always appear, whatever they contain.
  for (const folder of workspaceFolders) {
    const entry = card(folder, true);
    if (entry) seen.set(folder, entry);
  }

  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const dir = path.join(root, entry.name);
      if (seen.has(dir)) continue;
      const built = card(dir, false);
      if (built) seen.set(dir, built);
      if (seen.size >= limit) break;
    }
  }

  return [...seen.values()].sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    if (a.known !== b.known) return a.known ? -1 : 1;
    return b.lastTouched - a.lastTouched;
  });
}

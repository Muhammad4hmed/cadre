/**
 * Shared esbuild configuration. build.mjs and scripts/verify.mjs both use this
 * so the verified bundle is byte-for-byte the same shape as the shipped one.
 */

/**
 * The Agent SDK is ESM and calls `createRequire(import.meta.url)` at module
 * scope. Bundled to CJS, esbuild otherwise emits `import_meta = {}`, so that
 * call receives `undefined` and throws the moment the module is loaded —
 * which in the extension host looks like a silent activation failure.
 * Point `import.meta.url` at the bundle's own path instead.
 */
export const importMetaShim = {
  banner: {
    // "use strict" must lead. esbuild emits its own directive after the banner,
    // where a directive prologue is inert — that would silently run the whole
    // 1.1 MB bundle (our code plus the ESM-authored SDK) in sloppy mode.
    js: `"use strict";var __importMetaUrl = require("node:url").pathToFileURL(__filename).href;`,
  },
  define: {
    "import.meta.url": "__importMetaUrl",
  },
};

/** @returns {import('esbuild').BuildOptions} */
export function baseOptions({ entry, outfile, production = false }) {
  return {
    entryPoints: [entry],
    bundle: true,
    outfile,
    platform: "node",
    target: "node18",
    format: "cjs",
    // `vscode` is injected by the extension host. The SDK's per-platform CLI
    // packages hold a native binary we spawn as a subprocess, not JS to bundle.
    external: ["vscode", "@anthropic-ai/claude-agent-sdk-*"],
    // System prompts live as .md so they stay readable and diffable.
    loader: { ".md": "text" },
    sourcemap: !production,
    minify: production,
    ...importMetaShim,
  };
}

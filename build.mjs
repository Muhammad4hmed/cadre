import * as esbuild from "esbuild";
import { baseOptions } from "./scripts/esbuild-shared.mjs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const options = {
  ...baseOptions({ entry: "src/extension.ts", outfile: "dist/extension.js", production }),
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}

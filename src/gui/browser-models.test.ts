import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The tests run from dist/gui, the sources live in src.
const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "../../src");

// The terminal UI's models are shared with the web app, so they must stay free of node and ink imports.
// Bundling them for the browser fails on any `node:` module, and the metafile lets us name what got in.
test("the TUI models the web app shares bundle for the browser without node or ink modules", async () => {
  const result = await build({
    stdin: {
      contents: [
        'import { deriveAttention, needsYouItems, compareAttention } from "./tui/attention.js";',
        'import { describeEvent, latestLines, needRows, usageLines, workerRows } from "./tui/home-model.js";',
        'import { compactTokens, costText } from "./core/usage-format.js";',
        "console.log(deriveAttention, needsYouItems, compareAttention, describeEvent, latestLines, needRows, usageLines, workerRows, compactTokens, costText);",
      ].join("\n"),
      resolveDir: srcDir,
      loader: "ts",
    },
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.some((f) => f.endsWith("tui/home-model.ts")), "home-model.ts is in the bundle");
  const bad = inputs.filter((f) => /node_modules\/ink\b|\bnode:|tui\/path-format|core\/usage\.ts$/.test(f));
  assert.deepEqual(bad, []);
});

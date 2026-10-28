// Builds the web app: bundles src/gui/main.tsx into dist/gui/app.js, the lazily loaded views into dist/gui/chunks/,
// and copies the static files next to them.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src", "gui");
const out = path.join(root, "dist", "gui");

mkdirSync(out, { recursive: true });
// Chunk names carry a content hash, so old ones would pile up across builds.
rmSync(path.join(out, "chunks"), { recursive: true, force: true });

try {
  await build({
    entryPoints: [path.join(src, "main.tsx")],
    outdir: out,
    entryNames: "app",
    chunkNames: "chunks/[name]-[hash]",
    splitting: true,
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    jsx: "automatic",
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
} catch (err) {
  console.error("GUI build failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

for (const f of ["index.html", "app.css", "favicon.svg"]) copyFileSync(path.join(src, f), path.join(out, f));

const kb = (file) => (statSync(file).size / 1024).toFixed(1);
const chunks = readdirSync(path.join(out, "chunks"));
const chunkBytes = chunks.reduce((n, f) => n + statSync(path.join(out, "chunks", f)).size, 0);
console.log(`GUI built: dist/gui/app.js ${kb(path.join(out, "app.js"))} KB, ${chunks.length} chunks ${(chunkBytes / 1024).toFixed(1)} KB`);

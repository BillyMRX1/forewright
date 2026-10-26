// Builds the web app: bundles src/gui/main.tsx into dist/gui/app.js and copies the static files next to it.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src", "gui");
const out = path.join(root, "dist", "gui");

mkdirSync(out, { recursive: true });

try {
  await build({
    entryPoints: [path.join(src, "main.tsx")],
    outfile: path.join(out, "app.js"),
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

const kb = (statSync(path.join(out, "app.js")).size / 1024).toFixed(1);
console.log(`GUI built: dist/gui/app.js ${kb} KB`);

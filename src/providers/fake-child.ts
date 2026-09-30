// Child process used by FakeAdapter (a test double). It is a real process so
// that process-group termination and restart reconciliation are exercised for
// real. It prints scripted lines, optionally hangs, then exits.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface ChildScript {
  lines: string[];
  delayMs: number;
  hang: boolean;
  ignoreSigterm: boolean;
  spawnGrandchild: boolean;
  writeFiles: Record<string, string>;
  exitCode: number;
}

const raw = process.argv[2];
if (!raw) {
  console.error("fake-child: missing script argument");
  process.exit(2);
}
const script = JSON.parse(raw) as ChildScript;

if (script.ignoreSigterm) process.on("SIGTERM", () => {});
if (script.spawnGrandchild) spawn("sleep", ["300"], { stdio: "ignore" }).unref();

for (const [rel, content] of Object.entries(script.writeFiles)) {
  const target = path.resolve(process.cwd(), rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
for (const line of script.lines) {
  if (script.delayMs > 0) await sleep(script.delayMs);
  process.stdout.write(line + "\n");
}
if (script.hang) {
  setInterval(() => {}, 1 << 30);
} else {
  process.exitCode = script.exitCode;
}

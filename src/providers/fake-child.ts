// Child process used by FakeAdapter (a test double). It is a real process so
// that process-group termination and restart reconciliation are exercised for
// real. It prints scripted lines, optionally hangs, then exits.
import { execFileSync, spawn } from "node:child_process";
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
  gitCommit?: boolean;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  mcpServers?: Array<{ name: string; command: string; args: string[]; env: Record<string, string> }>;
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

if (script.gitCommit) {
  execFileSync("git", ["add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@localhost", "commit", "-m", "fake work", "--allow-empty"], { stdio: "ignore" });
}

/** Talks MCP over stdio to the first configured server, like a real client would. */
async function callTools(): Promise<void> {
  const calls = script.toolCalls ?? [];
  const spec = script.mcpServers?.[0];
  if (calls.length === 0) return;
  if (!spec) throw new Error("fake-child: toolCalls need an MCP server in the run request");
  const server = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiting = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() === "") continue;
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const rpc = (method: string, params: unknown) =>
    new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-client", version: "0" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  for (const call of calls) {
    process.stdout.write(JSON.stringify({ kind: "tool_call", toolName: call.name, text: JSON.stringify(call.args) }) + "\n");
    const res = await rpc("tools/call", { name: call.name, arguments: call.args });
    process.stdout.write(JSON.stringify({ kind: "tool_result", toolName: call.name, text: JSON.stringify(res.result ?? res.error) }) + "\n");
  }
  server.stdin.end();
  await new Promise<void>((resolve) => server.once("exit", () => resolve()));
}

for (const [i, line] of script.lines.entries()) {
  if (script.delayMs > 0) await sleep(script.delayMs);
  process.stdout.write(line + "\n");
  if (i === 0) await callTools(); // the session line goes out first, then the tool calls
}
if (script.lines.length === 0) await callTools();
if (script.hang) {
  setInterval(() => {}, 1 << 30);
} else {
  process.exitCode = script.exitCode;
}

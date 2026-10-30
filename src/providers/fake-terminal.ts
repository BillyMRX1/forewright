// TEST DOUBLE. The interactive CLI of the fake adapter: it prints the request it was started with, then echoes
// every input line with a prefix until it reads `exit` (exit code 0) or `fail` (exit code 3).
import readline from "node:readline";

const raw = process.argv[2];
if (!raw) {
  console.error("fake-terminal: missing request argument");
  process.exit(2);
}
process.stdout.write(`FAKE-TERMINAL ARGS ${raw}\n`);
process.stdout.write(`FAKE-TERMINAL CWD ${process.cwd()}\n`);
process.stdout.write(`FAKE-TERMINAL TERM ${process.env["TERM"] ?? ""}\n`);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.replace(/\r$/, "");
  if (text === "exit") process.exit(0);
  if (text === "fail") process.exit(3);
  process.stdout.write(`fake-echo: ${text}\n`);
});

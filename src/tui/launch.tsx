// Entry used by `dept` (wired in src/cli/main.ts): start the service if needed,
// open or create the project for a folder, then show the interface.

import { render } from "ink";
import { DeptError } from "../core/errors.js";
import { DeptClient, ensureDaemon } from "./client.js";
import { App } from "./app.js";
import { Welcome } from "./welcome.js";
import type { ProjectOpenResult } from "../runtime/protocol.js";

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";

async function askToCreate(root: string, isGit: boolean): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let answered = false;
    const app = render(
      <Welcome
        root={root}
        isGit={isGit}
        onAnswer={(create) => {
          if (answered) return;
          answered = true;
          app.unmount();
          resolve(create);
        }}
      />,
    );
  });
}

export async function launchTui({ cwd }: { cwd: string }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new DeptError("not_interactive", "dept needs an interactive terminal. Use `dept serve` to run the service without a screen.");
  }
  const started = await ensureDaemon();
  if (started.message) process.stdout.write(`${started.message}\n`);

  const client = new DeptClient();
  await client.connect();
  try {
    let open: ProjectOpenResult = await client.call("projects.open", { cwd });
    if (open.status === "none") {
      const create = await askToCreate(open.suggestedRoot, open.isGit);
      if (!create) {
        process.stdout.write("No workspace was created.\n");
        return;
      }
      open = await client.call("projects.init", { cwd });
    }
    if (open.status !== "found") throw new DeptError("project_open_failed", "The dept service could not open this folder as a project.", { cwd });
    if (open.moved) process.stdout.write(`Project folder moved: ${open.moved.from} -> ${open.moved.to}. Updated.\n`);

    process.stdout.write(ALT_ON);
    let quit = false;
    try {
      const app = render(<App api={client} projectId={open.projectId} projectName={open.name} root={open.root} isGit={open.isGit} onQuit={() => (quit = true)} />, { exitOnCtrlC: true });
      await app.waitUntilExit();
    } finally {
      process.stdout.write(ALT_OFF);
    }
    process.stdout.write(quit ? "Closed the dept screen. The dept service keeps running in the background.\n" : "The dept service keeps running in the background.\n");
  } finally {
    client.close();
  }
}

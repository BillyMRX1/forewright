// Entry used by `forewright` (wired in src/cli/main.ts): start the service if needed,
// open or create the project for a folder, then show the interface.

import { render, useWindowSize } from "ink";
import { ForewrightError } from "../core/errors.js";
import { ForewrightClient, ensureDaemon } from "./client.js";
import { App } from "./app.js";
import { SetupWizard } from "./setup.js";
import type { ProjectOpenResult } from "../runtime/protocol.js";
import { execFileSync } from "node:child_process";
import { hasCommitsOf } from "./compat.js";

/** Whether a git repo has any commit yet; undefined when git cannot tell (not a repo, git missing). */
function repoHasCommits(dir: string): boolean | undefined {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: dir, stdio: "ignore", windowsHide: true });
    return true;
  } catch (err) {
    return (err as { status?: number }).status === 1 ? false : undefined;
  }
}

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";

function SetupScreen({
  client,
  root,
  isGit,
  hasCommits,
  projectId,
  create,
  onDone,
}: {
  client: ForewrightClient;
  root: string;
  isGit: boolean;
  hasCommits: boolean | undefined;
  projectId: string | null;
  create?: () => Promise<string>;
  onDone: (finished: boolean) => void;
}) {
  const win = useWindowSize();
  return (
    <SetupWizard
      api={client}
      projectId={projectId}
      root={root}
      isGit={isGit}
      {...(hasCommits !== undefined ? { hasCommits } : {})}
      width={win.columns || 80}
      height={win.rows || 24}
      standalone
      {...(create ? { create } : {})}
      onFinish={() => onDone(true)}
      onCancel={() => onDone(false)}
    />
  );
}

/** Runs the setup wizard on its own screen (the folder has no workspace yet). Resolves true when it was finished. */
async function runSetup(client: ForewrightClient, root: string, isGit: boolean, hasCommits: boolean | undefined, create: () => Promise<string>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let answered = false;
    const app = render(
      <SetupScreen
        client={client}
        root={root}
        isGit={isGit}
        hasCommits={hasCommits}
        projectId={null}
        create={create}
        onDone={(finished) => {
          if (answered) return;
          answered = true;
          app.unmount();
          resolve(finished);
        }}
      />,
      { exitOnCtrlC: false },
    );
  });
}

export async function launchTui({ cwd }: { cwd: string }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ForewrightError("not_interactive", "Forewright needs an interactive terminal. Use `forewright serve` to run the service without a screen.");
  }
  const started = await ensureDaemon();
  if (started.message) process.stdout.write(`${started.message}\n`);

  const client = new ForewrightClient();
  await client.connect();
  try {
    let open: ProjectOpenResult = await client.call("projects.open", { cwd });
    let created: ProjectOpenResult | null = null;
    let setupOffer = false;
    process.stdout.write(ALT_ON);
    let quit = false;
    let farewell: string | null = null;
    try {
      if (open.status === "none") {
        // A new folder: the setup wizard starts with the welcome page and creates the workspace itself.
        const finished = await runSetup(client, open.suggestedRoot, open.isGit, hasCommitsOf(open) ?? repoHasCommits(open.suggestedRoot), async () => {
          created = await client.call("projects.init", { cwd });
          if (created.status !== "found") throw new ForewrightError("project_open_failed", "The Forewright service could not create a workspace in this folder.", { cwd });
          return created.projectId;
        });
        if (!finished) {
          farewell = created ? "Setup stopped before it was saved. Run forewright again to finish it.\n" : "No workspace was created.\n";
          return;
        }
        open = created ?? open;
      } else if (open.status === "found") {
        const current = await client.call("state.settings", { projectId: open.projectId });
        setupOffer = current.settings.setup.completedAt === null && current.settings.setup.skippedAt === null;
      }
      if (open.status !== "found") throw new ForewrightError("project_open_failed", "The Forewright service could not open this folder as a project.", { cwd });
      if (open.moved) process.stdout.write(`Project folder moved: ${open.moved.from} -> ${open.moved.to}. Updated.\n`);

      const app = render(
        <App api={client} projectId={open.projectId} projectName={open.name} root={open.root} isGit={open.isGit} setupOffer={setupOffer} onQuit={() => (quit = true)} />,
        { exitOnCtrlC: false },
      );
      await app.waitUntilExit();
    } finally {
      process.stdout.write(ALT_OFF);
      if (farewell !== null) process.stdout.write(farewell);
    }
    process.stdout.write(quit ? "Closed the Forewright screen. The Forewright service keeps running in the background.\n" : "The Forewright service keeps running in the background.\n");
  } finally {
    client.close();
  }
}

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FakeClient } from "./fake-client.js";
import { SetupWizard } from "./setup.js";
import { renderAt, type Harness } from "./test-harness.js";
import { VIEW, closeAll, ctrl, down, enter, esc, hints, lines, mount, release, up } from "./test-support.js";
import type { ProviderStatus } from "../runtime/protocol.js";
import type { EngineId } from "../core/types.js";

const NOW = "2026-09-30T10:00:00.000Z";
const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.unmount();
  closeAll();
});

type Login = boolean | "unknown" | "missing";
function provider(engine: EngineId, login: Login, over: { mcp?: boolean; models?: string[]; problem?: string; version?: string; method?: string | null } = {}): ProviderStatus {
  const missing = login === "missing";
  return {
    health: {
      engine,
      binaryPath: missing ? null : `/usr/local/bin/${engine}`,
      version: missing ? null : (over.version ?? "1.0.0"),
      authenticated: missing ? "unknown" : login,
      authMethod: login === true ? (over.method === undefined ? "subscription" : over.method) : null,
      models: over.models ?? [],
      modelsSource: (over.models ?? []).length > 0 ? "aliases" : "none",
      problems: over.problem ? [over.problem] : missing ? [`The ${engine} command was not found on PATH`] : login === false ? [`${engine} is not logged in. Run ${engine} and sign in.`] : [],
      checkedAt: NOW,
      isTestDouble: false,
    },
    capabilities: { streaming: true, resume: true, cancellation: true, approvals: "policy_flags", modelSelection: "aliases_only", attachments: false, workingDirectory: "cwd", usageReporting: "none", coordinationTools: over.mcp === false ? "none" : "mcp", notes: [] },
    quotaUntil: null,
  };
}

/** Claude and Codex ready, Copilot login unknown, Antigravity missing, OpenCode signed out. */
function mixedTools(): ProviderStatus[] {
  return [
    provider("opencode", false, { mcp: true, problem: "OpenCode is not logged in. Run opencode auth login." }),
    provider("claude", true, { models: ["sonnet", "opus", "haiku"], version: "2.1.9" }),
    provider("antigravity", "missing", { problem: "The agy command was not found on PATH. Install Antigravity." }),
    provider("codex", true, { models: ["gpt-5", "gpt-5-mini"], version: "0.46.0", method: "chatgpt" }),
    provider("copilot", "unknown", { models: ["auto", "gpt-x"], version: "1.0.0" }),
  ];
}

function fakeWith(providers: ProviderStatus[]): FakeClient {
  const api = new FakeClient();
  api.data.providers = providers;
  return api;
}

interface WizardOpts {
  cols?: number;
  rows?: number;
  api?: FakeClient;
  projectId?: string | null;
  create?: boolean;
  isGit?: boolean;
}
const events = { finished: 0, cancelled: 0 };

async function wizard(opts: WizardOpts = {}) {
  const api = opts.api ?? fakeWith(mixedTools());
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 30;
  events.finished = 0;
  events.cancelled = 0;
  const createdIds: string[] = [];
  const h = renderAt(
    <SetupWizard
      api={api}
      projectId={opts.projectId === undefined ? (opts.create ? null : "p1") : opts.projectId}
      root="/Users/billy/tip-calc"
      isGit={opts.isGit ?? true}
      width={cols}
      height={rows}
      standalone
      {...(opts.create ? { create: async () => (createdIds.push("p1"), "p1") } : {})}
      onFinish={() => events.finished++}
      onCancel={() => events.cancelled++}
    />,
    cols,
    rows,
  );
  open.push(h);
  await h.settle(200);
  return { h, api, createdIds };
}

const setCalls = (api: FakeClient) => api.callsTo("settings.set").map((c) => c.params as { projectId: string; key: string; value: unknown });
const written = (api: FakeClient) => Object.fromEntries(setCalls(api).map((c) => [c.key, c.value]));
const space = (h: Harness) => h.send(" ");
const rowsOf = (h: Harness) => h.frame().split("\n");
const maxWidth = (h: Harness) => Math.max(...rowsOf(h).map((l) => [...l].length));

/** Walks to a step by pressing enter, starting from the welcome page of an existing project. */
async function toStep(h: Harness, step: number) {
  for (let i = 1; i < step; i++) await enter(h);
}

describe("setup wizard: pages", () => {
  it("page 1 offers create, skip and quit for a new folder and names the folder and git state", async () => {
    const { h } = await wizard({ create: true });
    const f = h.frame();
    assert.match(f, /setup 1\/6\s+Workspace/);
    assert.match(f, /Folder\s+\/Users\/billy\/tip-calc/);
    assert.match(f, /Git\s+yes/);
    for (const needle of ["Create workspace and continue", "Skip setup, use recommended defaults", "Quit", ".forewright folder"]) assert.ok(f.includes(needle), needle);
    assert.match(hints(h), /enter choose\s+esc quit/);
  });

  it("page 1 says what a non-git folder means", async () => {
    const { h } = await wizard({ create: true, isGit: false });
    assert.match(h.frame(), /Git\s+no\. Agents can plan here; code tasks wait until you approve running git init\./);
  });

  it("page 2 lists every tool with version, sign-in in plain words, models and a fix hint, in the recommended order", async () => {
    const { h } = await wizard();
    await toStep(h, 2);
    const f = h.frame();
    assert.match(f, /setup 2\/6\s+Your tools/);
    assert.match(f, /Checked in [\d.]+s\./);
    const order = ["Claude Code", "Codex", "Copilot", "Antigravity", "OpenCode"].map((n) => f.indexOf(n));
    assert.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1]!)), `order ${order}`);
    assert.match(f, /\[x\] Claude Code\s+v2\.1\.9\s+signed in \(subscription\)\s+models: 3/);
    assert.match(f, /\[x\] Codex\s+v0\.46\.0\s+signed in \(chatgpt\)\s+models: 2/);
    assert.match(f, /\[x\] Copilot\s+v1\.0\.0\s+checked on first run/);
    assert.match(f, /\[ \] Antigravity\s+not installed/);
    assert.match(f, /how: The agy command was not found on PATH/);
    assert.match(f, /\[!\] OpenCode\s+v1\.0\.0\s+NOT signed in/);
    assert.match(f, /fix: OpenCode is not logged in/);
    assert.match(f, /never switches you to pay-per-token billing/);
    assert.match(hints(h), /space tick\s+r check again\s+enter next\s+esc back/);
  });

  it("an unknown login that is not Copilot says so and keeps the tool tickable", async () => {
    const { h } = await wizard({ api: fakeWith([provider("claude", true, { models: ["opus"] }), provider("codex", "unknown", { problem: "Login state could not be checked." })]) });
    await toStep(h, 2);
    assert.match(h.frame(), /\[x\] Codex\s+v1\.0\.0\s+sign-in not checked/);
  });

  it("shows a spinner while checking", async () => {
    const api = fakeWith(mixedTools());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = api.call.bind(api);
    api.call = (async (method: string, params: unknown) => {
      if (method === "providers.health") await gate;
      return original(method as never, params as never);
    }) as typeof api.call;
    const { h } = await wizard({ api });
    await enter(h);
    assert.match(h.frame(), /Checking your tools/);
    release();
    await h.settle(150);
    assert.doesNotMatch(h.frame(), /Checking your tools/);
    assert.match(h.frame(), /Checked in/);
  });

  it("page 3 lists only ticked tools that can lead, recommended first, with the model choices", async () => {
    const { h } = await wizard({ api: fakeWith([provider("codex", true, { models: ["gpt-5"] }), provider("claude", true, { models: ["sonnet", "opus"] }), provider("copilot", true, { mcp: false })]) });
    await toStep(h, 3);
    const f = h.frame();
    assert.match(f, /setup 3\/6\s+Who leads\?/);
    assert.ok(f.indexOf("Claude Code") < f.indexOf("Codex"));
    assert.doesNotMatch(f, /Copilot/);
    assert.match(f, /\(x\) Claude Code\s+recommended first choice/);
    assert.match(f, /\( \) Codex\s+also able to lead/);
    assert.match(f, /Model for the CTO/);
    assert.ok(f.indexOf("opus") < f.indexOf("sonnet") && f.indexOf("sonnet") < f.indexOf("default"));
    assert.match(f, /\(x\) opus\s+recommended for planning/);
  });

  it("page 4 is skipped when only one tool is ticked", async () => {
    const { h, api } = await wizard({ api: fakeWith([provider("claude", true, { models: ["opus"] })]) });
    await toStep(h, 3);
    await enter(h);
    assert.match(h.frame(), /setup 5\/6/);
    await esc(h);
    assert.match(h.frame(), /setup 3\/6/, "back skips it too");
    assert.equal(api.callsTo("settings.set").length, 0);
  });

  it("pages 4, 5, 6 and the summary render", async () => {
    const { h } = await wizard();
    await toStep(h, 4);
    assert.match(h.frame(), /setup 4\/6\s+Who does the work\?/);
    assert.match(h.frame(), /\[x\] Claude Code/);
    assert.match(h.frame(), /use two different tools/);
    await enter(h);
    assert.match(h.frame(), /setup 5\/6\s+If a tool hits its usage limit/);
    assert.match(h.frame(), /\(x\) Wait for reset\s+\(default, nothing changes\)/);
    assert.match(h.frame(), /\( \) Use backups in this order/);
    await enter(h);
    assert.match(h.frame(), /setup 6\/6\s+Your control/);
    assert.match(h.frame(), /\(x\) Ask me before merging into my branch\s+recommended/);
    assert.match(h.frame(), /\( \) Merge finished work automatically/);
    assert.match(h.frame(), /Publishing and deleting always ask you first\./);
    assert.doesNotMatch(h.frame(), /autoLocalEdits|autoChecks|allowApiBilling/);
    await enter(h);
    assert.match(h.frame(), /setup done\s+Ready/);
    for (const needle of ["Lead (CTO)", "Claude Code, model opus", "Workers", "wait for the reset", "asks you before merging into your branch", "Save and open the CTO"]) assert.ok(h.frame().includes(needle), needle);
  });
});

describe("setup wizard: blocking and re-checking", () => {
  const signedOut = () => [provider("claude", false, { models: ["opus"] }), provider("codex", "missing")];

  it("blocks with a plain instruction when nothing is usable, and r checks again with refresh", async () => {
    const api = fakeWith(signedOut());
    const { h } = await wizard({ api });
    await enter(h);
    assert.match(h.frame(), /Sign in to at least one tool, then press r\./);
    await enter(h);
    assert.match(h.frame(), /setup 2\/6/, "enter does not leave the page");
    assert.match(h.frame(), /Sign in to at least one tool, then press r\./);
    const before = api.callsTo("providers.health").length;
    assert.deepEqual(api.callsTo("providers.health")[0]!.params, { refresh: true }, "the first look is a fresh one");
    api.data.providers = [provider("claude", true, { models: ["opus"] }), provider("codex", "missing")];
    await h.send("r", 200);
    assert.equal(api.callsTo("providers.health").length, before + 1);
    assert.deepEqual(api.callsTo("providers.health").at(-1)!.params, { refresh: true });
    assert.match(h.frame(), /\[x\] Claude Code/, "a tool that became usable is ticked");
    await enter(h);
    assert.match(h.frame(), /setup 3\/6/);
  });

  it("space on a tool that cannot be used explains why instead of ticking it", async () => {
    const { h } = await wizard({ api: fakeWith([provider("claude", true, { models: ["opus"] }), provider("codex", false)]) });
    await enter(h);
    await down(h);
    await space(h);
    assert.match(h.frame(), /Sign in to Codex first, then press r\./);
    assert.match(h.frame(), /\[!\] Codex/);
  });

  it("Skip setup cannot apply defaults when nothing is usable: it stops on page 2", async () => {
    const api = fakeWith(signedOut());
    const { h } = await wizard({ api });
    await down(h);
    await enter(h);
    await h.settle(100);
    assert.match(h.frame(), /setup 2\/6/);
    assert.equal(api.callsTo("settings.set").length, 0);
    assert.equal(events.finished, 0);
  });

  it("shows a failed health check and lets r retry", async () => {
    const api = fakeWith(mixedTools());
    let fail = true;
    const original = api.call.bind(api);
    api.call = (async (method: string, params: unknown) => {
      if (method === "providers.health" && fail) throw new Error("service is not answering");
      return original(method as never, params as never);
    }) as typeof api.call;
    const { h } = await wizard({ api });
    await enter(h);
    assert.match(h.frame(), /Could not check your tools: service is not answering/);
    fail = false;
    await h.send("r", 200);
    assert.match(h.frame(), /Checked in/);
  });

  it("a CTO needs a tool with coordination tools: ticking only others blocks page 2", async () => {
    const { h } = await wizard({ api: fakeWith([provider("claude", true, { models: ["opus"] }), provider("copilot", true, { mcp: false })]) });
    await enter(h);
    await space(h); // untick Claude Code
    await enter(h);
    assert.match(h.frame(), /setup 2\/6/);
    assert.match(h.frame(), /tick Claude Code/);
  });
});

describe("setup wizard: choices write the right settings", () => {
  it("Enter all the way through writes recommended defaults, ending with setup.completedAt", async () => {
    const { h, api } = await wizard();
    await toStep(h, 7);
    assert.equal(api.callsTo("settings.set").length, 0, "nothing is written before the last page");
    await enter(h);
    await h.settle(100);
    const calls = setCalls(api);
    assert.deepEqual(
      calls.map((c) => c.key),
      ["ctoEngine", "ctoModel", "workers.engines", "fallback.workers", "fallback.cto", "authority.mergeToUserBranch", "setup.completedAt"],
    );
    const w = written(api);
    assert.equal(w["ctoEngine"], "claude");
    assert.equal(w["ctoModel"], "opus");
    assert.deepEqual(w["workers.engines"], ["claude", "codex", "copilot"]);
    assert.deepEqual(w["fallback.workers"], []);
    assert.deepEqual(w["fallback.cto"], []);
    assert.equal(w["authority.mergeToUserBranch"], "ask");
    assert.match(String(w["setup.completedAt"]), /^\d{4}-\d\d-\d\dT/);
    assert.ok(calls.every((c) => c.projectId === "p1"));
    assert.equal(events.finished, 1);
  });

  it("changing the CTO, the model, the workers, the backups and the merge rule writes those", async () => {
    const { h, api } = await wizard();
    await toStep(h, 3);
    await down(h); // Codex
    await space(h);
    assert.match(h.frame(), /\(x\) Codex/);
    assert.match(h.frame(), /\(x\) default\s+whatever the tool picks/, "the model resets to the new tool's recommendation");
    await down(h);
    await down(h);
    await down(h); // gpt-5
    await space(h);
    await enter(h); // page 4
    await down(h); // Codex
    await space(h); // untick Codex as worker
    await enter(h); // page 5
    await down(h);
    await space(h); // backups
    assert.match(h.frame(), /Workers\s*\n\s*1\. Codex/, "the main worker tool is not its own backup");
    await enter(h);
    await down(h);
    await space(h); // merge automatically
    await enter(h);
    await enter(h);
    await h.settle(100);
    const w = written(api);
    assert.equal(w["ctoEngine"], "codex");
    assert.equal(w["ctoModel"], "gpt-5");
    assert.deepEqual(w["workers.engines"], ["claude", "copilot"]);
    assert.deepEqual(w["fallback.workers"], [{ engine: "codex" }, { engine: "copilot" }]);
    assert.deepEqual(w["fallback.cto"], [{ engine: "claude" }, { engine: "copilot" }], "the CTO list holds the other tools that can lead");
    assert.equal(w["authority.mergeToUserBranch"], "auto");
  });

  it("ticking fewer tools on page 2 narrows every later page and the saved lists", async () => {
    const { h, api } = await wizard();
    await enter(h);
    await down(h);
    await space(h); // untick Codex
    await down(h);
    await space(h); // untick Copilot
    await toStep(h, 1);
    await enter(h); // page 3
    assert.match(h.frame(), /Claude Code/);
    assert.doesNotMatch(h.frame(), /Codex/);
    await enter(h); // only one tool: straight to page 5
    assert.match(h.frame(), /setup 5\/6/);
    assert.match(h.frame(), /needs a second ticked tool/);
    await down(h);
    await space(h);
    assert.match(h.frame(), /Backups need a second ticked tool\./);
    await enter(h);
    await enter(h);
    await enter(h);
    await h.settle(100);
    assert.deepEqual(written(api)["workers.engines"], ["claude"]);
  });

  it("backups: add, reorder with [ and ], J and K, and remove with x, saving the order", async () => {
    const { h, api } = await wizard();
    await toStep(h, 5);
    await down(h);
    await space(h);
    await down(h); // first Workers entry
    assert.match(h.frame(), /1\. Codex/);
    assert.match(h.frame(), /2\. Copilot/);
    await h.send("]");
    assert.ok(h.frame().indexOf("1. Copilot") >= 0 && h.frame().indexOf("2. Codex") >= 0);
    await h.send("K");
    assert.ok(h.frame().indexOf("1. Codex") >= 0);
    await h.send("J");
    await h.send("x"); // removes the entry under the cursor (Codex, now second)... cursor followed it
    assert.doesNotMatch(h.frame().split("CTO")[0]!, /Codex/, "Codex is gone from the Workers list");
    await h.send("a");
    assert.match(h.frame().split("CTO")[0]!, /2\. Codex/, "a adds the next tool, keeping the main worker tool last");
    assert.match(h.frame(), /CTO\s*\n\s*1\. Codex/);
    await enter(h);
    await enter(h);
    await enter(h);
    await h.settle(100);
    const w = written(api);
    assert.deepEqual(w["fallback.workers"], [{ engine: "copilot" }, { engine: "codex" }]);
    assert.deepEqual(w["fallback.cto"], [{ engine: "codex" }, { engine: "copilot" }]);
  });

  it("choosing 'Wait for reset' again after backups writes empty lists", async () => {
    const { h, api } = await wizard();
    await toStep(h, 5);
    await down(h);
    await space(h);
    await up(h);
    await space(h);
    await enter(h);
    await enter(h);
    await enter(h);
    await h.settle(100);
    assert.deepEqual(written(api)["fallback.workers"], []);
    assert.deepEqual(written(api)["fallback.cto"], []);
  });

  it("Esc goes back one page at a time and keeps the choices", async () => {
    const { h } = await wizard();
    await toStep(h, 6);
    await down(h);
    await space(h);
    await esc(h);
    assert.match(h.frame(), /setup 5\/6/);
    await enter(h);
    assert.match(h.frame(), /\(x\) Merge finished work automatically/);
    await esc(h);
    await esc(h);
    await esc(h);
    await esc(h);
    await esc(h);
    assert.match(h.frame(), /setup 1\/6/);
    assert.equal(events.cancelled, 0);
    await esc(h);
    assert.equal(events.cancelled, 1);
  });

  it("a failing save shows the reason, stays on the page and does not finish", async () => {
    const api = fakeWith(mixedTools());
    api.failSetting = { key: "workers.engines", message: "workers.engines must be a list of engines." };
    const { h } = await wizard({ api });
    await toStep(h, 7);
    await enter(h);
    await h.settle(100);
    assert.match(h.frame(), /Could not save: workers\.engines must be a list of engines\./);
    assert.match(h.frame(), /setup done/);
    assert.equal(events.finished, 0);
    assert.ok(!("setup.completedAt" in written(api)), "completedAt is only written when everything else was");
  });

  it("starts from the project's current settings when setup runs again", async () => {
    const api = fakeWith(mixedTools());
    api.ctoEngine = "codex";
    api.ctoModel = "gpt-5";
    api.workersEngines = ["claude"];
    api.fallback = { cto: [{ engine: "claude" }], workers: [{ engine: "codex" }] };
    api.authority = { ...api.authority, mergeToUserBranch: "auto" };
    const { h } = await wizard({ api });
    await toStep(h, 3);
    assert.match(h.frame(), /\(x\) Codex/);
    assert.match(h.frame(), /\(x\) gpt-5/);
    await enter(h);
    assert.match(h.frame(), /\[x\] Claude Code/);
    assert.match(h.frame(), /\[ \] Codex/);
    await enter(h);
    assert.match(h.frame(), /\(x\) Use backups in this order/);
    assert.match(h.frame(), /1\. Codex/);
    await enter(h);
    assert.match(h.frame(), /\(x\) Merge finished work automatically/);
  });
});

describe("setup wizard: skip and workspace creation", () => {
  it("Skip setup applies the recommended answer for every page and records completedAt", async () => {
    const { h, api } = await wizard({ api: fakeWith(mixedTools()) });
    await down(h);
    await enter(h);
    await h.settle(150);
    const w = written(api);
    assert.equal(w["ctoEngine"], "claude");
    assert.equal(w["ctoModel"], "opus");
    assert.deepEqual(w["workers.engines"], ["claude", "codex", "copilot"]);
    assert.deepEqual(w["fallback.workers"], []);
    assert.deepEqual(w["fallback.cto"], []);
    assert.equal(w["authority.mergeToUserBranch"], "ask");
    assert.ok(w["setup.completedAt"]);
    assert.equal(events.finished, 1);
  });

  it("Skip setup on page 2 does the same", async () => {
    const { h, api } = await wizard();
    await enter(h);
    await h.send("\x1b[B", 30);
    await esc(h); // back to 1
    await down(h);
    await enter(h);
    await h.settle(150);
    assert.ok(written(api)["setup.completedAt"]);
    assert.equal(events.finished, 1);
  });

  it("creating the workspace happens on Create, before any setting is written", async () => {
    const { h, api, createdIds } = await wizard({ create: true });
    assert.equal(createdIds.length, 0);
    await enter(h);
    await h.settle(100);
    assert.equal(createdIds.length, 1);
    assert.match(h.frame(), /setup 2\/6/);
    await toStep(h, 8);
    await h.settle(50);
    assert.ok(setCalls(api).length === 0 || setCalls(api).every((c) => c.projectId === "p1"));
  });

  it("Skip on a new folder creates the workspace and then saves the defaults", async () => {
    const { h, api, createdIds } = await wizard({ create: true });
    await down(h);
    await enter(h);
    await h.settle(200);
    assert.equal(createdIds.length, 1);
    assert.ok(written(api)["setup.completedAt"]);
    assert.equal(events.finished, 1);
  });

  it("Quit and ctrl+c on a new folder cancel without creating anything", async () => {
    const a = await wizard({ create: true });
    await down(a.h);
    await down(a.h);
    await enter(a.h);
    assert.equal(events.cancelled, 1);
    assert.equal(a.createdIds.length, 0);
    const b = await wizard({ create: true });
    await ctrl(b.h, "c");
    assert.equal(events.cancelled, 1);
    assert.equal(b.createdIds.length, 0);
  });
});

describe("setup wizard: sizes and ASCII", () => {
  const steps = [1, 2, 3, 4, 5, 6, 7];
  for (const [cols, rows] of [[100, 30], [80, 24], [40, 12]] as const) {
    it(`renders every page inside ${cols}x${rows}`, async () => {
      const { h } = await wizard({ cols, rows });
      for (const step of steps) {
        if (step > 1) await enter(h);
        const f = rowsOf(h);
        const shown = f.filter((l) => l.trim().length > 0);
        assert.ok(shown.length > 0, `page ${step} is empty`);
        assert.ok(f.length <= rows + 1, `page ${step} uses ${f.length} rows, budget ${rows}`);
        assert.ok(maxWidth(h) <= cols, `page ${step} is ${maxWidth(h)} wide, budget ${cols}`);
        assert.match(h.frame(), /Forewright/);
        assert.ok(hints(h).length > 0);
        assert.ok(hints(h).split(/\s{3,}/).length <= 6, `page ${step} has more than 6 hints`);
      }
    });
  }

  it("keeps the selected row in view on a tiny screen", async () => {
    const { h } = await wizard({ cols: 40, rows: 12 });
    await down(h);
    await down(h);
    assert.match(h.frame(), /Quit|Skip/);
    assert.ok(lines(h).some((l) => /^\s*[▸>]/.test(l)), "the pointer is on screen");
  });

  it("renders in ASCII mode without any fancy symbols", async () => {
    process.env["FOREWRIGHT_ASCII"] = "1";
    const { h } = await wizard();
    for (let i = 1; i <= 7; i++) {
      if (i > 1) await enter(h);
      assert.doesNotMatch(h.frame(), /[▸›━─●◉◐○✓⠋↑↓]/, `page ${i}`);
    }
    await esc(h);
    await esc(h);
    await esc(h);
    await esc(h);
    await esc(h);
    await enter(h);
    assert.match(h.frame(), /up\/down move/);
    delete process.env["FOREWRIGHT_ASCII"];
  });

  it("prints every page at 100x30 when FOREWRIGHT_TUI_FRAMES=1", async () => {
    const show = (title: string, frame: string) => {
      if (process.env["FOREWRIGHT_TUI_FRAMES"]) console.log(`\n===== ${title} =====\n${frame}`);
    };
    const nw = await wizard({ create: true });
    show("setup 1/6 Workspace, new folder (100x30)", nw.h.frame());
    release(nw.h);
    const { h } = await wizard();
    show("setup 1/6 Workspace, existing project (100x30)", h.frame());
    await enter(h);
    show("setup 2/6 Your tools (100x30)", h.frame());
    await enter(h);
    show("setup 3/6 Who leads? (100x30)", h.frame());
    await enter(h);
    show("setup 4/6 Who does the work? (100x30)", h.frame());
    await enter(h);
    show("setup 5/6 Usage limit, wait (100x30)", h.frame());
    await down(h);
    await space(h);
    show("setup 5/6 Usage limit, backups (100x30)", h.frame());
    await enter(h);
    show("setup 6/6 Your control (100x30)", h.frame());
    await enter(h);
    show("setup done, Ready (100x30)", h.frame());
    const blocked = await wizard({ api: fakeWith([provider("claude", false, { models: ["opus"] }), provider("codex", "missing")]) });
    await enter(blocked.h);
    show("setup 2/6 Your tools, nothing usable (100x30)", blocked.h.frame());
    assert.ok(true);
  });
});

describe("setup in the app", () => {
  const fresh = () => {
    const api = fakeWith(mixedTools());
    api.data.messages = [];
    api.proposedPrd = false;
    return api;
  };

  it("an existing project without setup shows a one-line offer, and Enter starts the wizard", async () => {
    const api = fresh();
    const { h } = await mount({ api, setupOffer: true, cols: 100, rows: 30 });
    assert.match(h.frame(), /Set up engines for this project\?\s+enter to start, esc to skip/);
    await enter(h);
    await h.settle(150);
    assert.match(h.frame(), /setup 1\/6\s+Workspace/);
    assert.doesNotMatch(h.frame(), /Set up engines for this project\?/);
    await toStep(h, 8);
    await h.settle(200);
    assert.ok(written(api)["setup.completedAt"], "saved through settings.set");
    assert.doesNotMatch(h.frame(), /setup done/);
    assert.match(h.frame(), /Tell the CTO what you want to build/, "back in the CTO view");
    assert.match(h.frame(), /to: CTO/);
  });

  it("Esc on the offer records skippedAt once and the view works afterwards", async () => {
    const api = fresh();
    const { h } = await mount({ api, setupOffer: true });
    await esc(h);
    const calls = setCalls(api);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.key, "setup.skippedAt");
    assert.match(String(calls[0]!.value), /^\d{4}-/);
    assert.doesNotMatch(h.frame(), /Set up engines for this project\?/);
    assert.deepEqual(api.setup.completedAt, null);
    assert.ok(api.setup.skippedAt);
  });

  it("bare letters do nothing while the offer is shown, and the message box is not typed into", async () => {
    const api = fresh();
    const { h } = await mount({ api, setupOffer: true, view: VIEW.cto });
    await h.send("hello");
    await h.send("?");
    assert.match(h.frame(), /Set up engines for this project\?/);
    assert.doesNotMatch(h.frame(), /hello/);
    await esc(h);
    await h.send("hi");
    assert.match(h.frame(), /hi/);
  });

  it("no offer when setup was already completed or skipped, or when the app was not asked to offer it", async () => {
    const { h } = await mount({ api: fresh() });
    assert.doesNotMatch(h.frame(), /Set up engines/);
  });

  it("/setup and the palette entry run the wizard again, and Esc on page 1 closes it", async () => {
    const api = fresh();
    const { h } = await mount({ api, view: VIEW.cto });
    await h.send("/setup");
    await enter(h);
    await h.settle(150);
    assert.match(h.frame(), /setup 1\/6\s+Workspace/);
    await esc(h);
    assert.doesNotMatch(h.frame(), /setup 1\/6/);
    await ctrl(h, "p");
    await h.send("setup");
    assert.match(h.frame(), /Run setup again/);
    await enter(h);
    await h.settle(150);
    assert.match(h.frame(), /setup 1\/6\s+Workspace/);
    assert.equal(setCalls(api).length, 0, "leaving changes nothing");
  });

  it("the wizard takes the whole screen: no top bar, no tabs", async () => {
    const { h } = await mount({ api: fresh() });
    await ctrl(h, "p");
    await h.send("setup");
    await enter(h);
    await h.settle(150);
    assert.match(h.frame(), /setup 1\/6/);
    assert.doesNotMatch(h.frame(), /1 Home|2 CTO/);
    await h.send("3");
    assert.doesNotMatch(h.frame(), /TASKS/);
  });

  it("keys inside the wizard do not leak to the app (no ? help, no view keys)", async () => {
    const { h } = await mount({ api: fresh(), view: VIEW.cto });
    await h.send("/setup");
    await enter(h);
    await h.settle(150);
    await h.send("?");
    await h.send("a");
    await h.send("d");
    assert.doesNotMatch(h.frame(), /Every key|Slash commands/);
    assert.match(h.frame(), /setup 1\/6/);
  });

  it("fits the 80x24 and 40x12 screens", async () => {
    for (const [cols, rows] of [[80, 24], [40, 12]] as const) {
      const { h } = await mount({ api: fresh(), setupOffer: true, cols, rows });
      assert.ok(lines(h).length <= rows + 1);
      await enter(h);
      await h.settle(150);
      for (let i = 0; i < 7; i++) {
        assert.ok(lines(h).length <= rows + 1, `${cols}x${rows} page ${i}`);
        await enter(h);
      }
      release(h);
    }
  });

  it("after setup the CTO view has the message box focused and the arrows and Enter pick an example brief", async () => {
    const api = fresh();
    const { h } = await mount({ api, cols: 120, rows: 36, view: VIEW.cto });
    assert.match(h.frame(), /Try one of these/);
    await down(h);
    await enter(h);
    assert.match(h.frame(), /Add tests and a README to this project/);
    assert.ok(lines(h).some((l) => /›.*Add tests and a README/.test(l) || />.*Add tests and a README/.test(l)), "the example is in the message box");
    await enter(h);
    assert.equal(api.callsTo("cto.send").length, 1);
    assert.deepEqual((api.callsTo("cto.send")[0]!.params as { body: string }).body, "Add tests and a README to this project");
  });

  it("typing in the message box never triggers shortcuts", async () => {
    const api = fresh();
    const { h } = await mount({ api, view: VIEW.cto });
    await h.send("r x a d ? / j k [ ]");
    assert.doesNotMatch(h.frame(), /setup 1\/6/);
    assert.match(h.frame(), /r x a d \? \/ j k \[ \]|r x a d/);
    assert.equal(setCalls(api).length, 0);
  });
});

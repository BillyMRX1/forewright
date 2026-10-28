// Engine routing, the pure parts: scoring, pins, exploration, local first, review independence, and the settings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PolicyDeniedError, ValidationError } from "../core/errors.js";
import { makeEnv } from "../core/test-helpers.js";
import { parsePinInput, pinWords } from "../tui/settings-model.js";
import {
  LOCAL_FIRST_MARGIN,
  MIN_SAMPLES,
  authorIdentity,
  candidateIdentity,
  chooseRoute,
  exploreBucket,
  independence,
  normModel,
  scoreCandidate,
  type Candidate,
  type RouteInput,
} from "./routing.js";

const HUMAN = { kind: "human" } as const;

function cand(engine: Candidate["engine"], over: Partial<Candidate> = {}): Candidate {
  return { engine, model: null, servedModel: null, local: engine === "hearthwork", excluded: null, localNotReady: null, firstPass: null, samples: 0, medianMinutes: null, limitHits: 0, notes: [], ...over };
}

const fp = (rate: number, n = 10) => ({ rate, n, scope: "model" as const });

function input(candidates: Candidate[], over: Partial<RouteInput> = {}): RouteInput {
  return { taskId: "tsk-a", taskType: "backend", own: { engine: "claude", model: null }, candidates, pin: null, localFirst: false, explore: 0, kept: null, escalated: false, ...over };
}

/** A task id whose exploration bucket is below (or not below) `pct`. */
function taskIdWith(pred: (bucket: number) => boolean): string {
  for (let i = 0; ; i++) if (pred(exploreBucket(`tsk-${i}`))) return `tsk-${i}`;
}

test("scoring: first-pass rate counts only with enough samples, and says so when it does not", () => {
  const known = scoreCandidate(cand("codex", { firstPass: fp(0.8), samples: 10 }));
  assert.equal(known.score, 0.8);
  assert.match(known.factors[0]!, /first pass 80% over 10 tasks/);
  const thin = scoreCandidate(cand("codex", { samples: MIN_SAMPLES - 1 }));
  assert.equal(thin.score, 0.5);
  assert.match(thin.factors[0]!, new RegExp(`not enough history \\(${MIN_SAMPLES - 1} of ${MIN_SAMPLES} finished tasks\\)`));
  assert.ok(thin.factors.includes("turnaround not known yet"));
});

test("scoring: recent usage-limit hits lower the score, so work moves away before the limit", () => {
  const hit = cand("claude", { firstPass: fp(0.9), limitHits: 2 });
  const calm = cand("codex", { firstPass: fp(0.7) });
  assert.equal(scoreCandidate(hit).score, 0.6);
  assert.match(scoreCandidate(hit).factors.join(" "), /hit its usage limit 2 times in the last 24 h/);
  const c = chooseRoute(input([hit, calm]));
  assert.equal(c.kind, "run");
  assert.equal(c.kind === "run" && c.engine, "codex");
  assert.equal(c.kind === "run" && c.reason.how, "scored");
  // Without the hits claude would win.
  const again = chooseRoute(input([{ ...hit, limitHits: 0 }, calm]));
  assert.equal(again.kind === "run" && again.engine, "claude");
});

test("scoring: the best score wins and the reason names both scores", () => {
  const c = chooseRoute(input([cand("claude", { firstPass: fp(0.6) }), cand("codex", { firstPass: fp(0.9), medianMinutes: 60 })]));
  assert.equal(c.kind, "run");
  if (c.kind !== "run") return;
  assert.equal(c.engine, "codex");
  assert.match(c.reason.summary, /best score for task type backend \(0\.85 vs 0\.6 for claude\)/);
  assert.equal(c.reason.taskType, "backend");
  assert.equal(c.reason.candidates.length, 2);
});

test("candidates excluded by billing, health or a budget never run, even with the best history", () => {
  const billed = cand("codex", { firstPass: fp(1), excluded: "Blocked by the API billing setting (codex): signed in with an API key" });
  const missing = cand("copilot", { firstPass: fp(1), excluded: "copilot was not found on this machine." });
  const c = chooseRoute(input([billed, missing, cand("claude", { firstPass: fp(0.4) })]));
  assert.equal(c.kind === "run" && c.engine, "claude");
  assert.equal(c.kind === "run" && c.reason.how, "only-choice");
  const none = chooseRoute(input([billed, missing]));
  assert.equal(none.kind, "block");
  assert.match(none.kind === "block" ? none.why : "", /No allowed engine can run this now \(codex: Blocked by the API billing/);
});

test("every allowed engine waiting for a usage limit means wait, not block", () => {
  const c = chooseRoute(input([cand("claude", { excluded: "waiting for a usage limit", quotaUntil: "2026-01-01T02:00:00.000Z" }), cand("codex", { excluded: "waiting for a usage limit", quotaUntil: "2026-01-01T01:00:00.000Z" })]));
  assert.deepEqual(c.kind === "wait-quota" && c.until, "2026-01-01T01:00:00.000Z");
});

test("pins: task over role over project; a pin wins over scores but not over health", () => {
  const cands = [cand("claude", { firstPass: fp(0.9) }), cand("codex", { firstPass: fp(0.2) }), cand("copilot")];
  const pinned = chooseRoute(input(cands, { pin: { entry: { engine: "codex", model: "gpt-5" }, source: "task" } }));
  assert.equal(pinned.kind, "run");
  if (pinned.kind === "run") {
    assert.equal(pinned.engine, "codex");
    assert.equal(pinned.model, "gpt-5");
    assert.equal(pinned.reason.how, "pinned");
    assert.match(pinned.reason.summary, /because the task is pinned to it/);
  }
  const notAllowed = chooseRoute(input(cands, { pin: { entry: { engine: "antigravity" }, source: "project" } }));
  assert.equal(notAllowed.kind, "block");
  assert.match(notAllowed.kind === "block" ? notAllowed.why : "", /pinned to antigravity for this project, but antigravity is not one of the allowed worker engines/);
  const unhealthy = chooseRoute(input([cand("claude"), cand("codex", { excluded: "codex is not signed in." })], { pin: { entry: { engine: "codex" }, source: "role" } }));
  assert.equal(unhealthy.kind, "block", "a pinned engine that cannot run is a plain block, never a silent swap");
  assert.match(unhealthy.kind === "block" ? unhealthy.why : "", /pinned to codex for this role, but it cannot run there: codex is not signed in/);
});

test("exploration: deterministic per task id, about the configured share, and marked explore", () => {
  const cands = [cand("claude", { firstPass: fp(0.9) }), cand("codex", { firstPass: fp(0.5) })];
  const inside = taskIdWith((b) => b < 10);
  const outside = taskIdWith((b) => b >= 10);
  const a = chooseRoute(input(cands, { taskId: inside, explore: 10 }));
  assert.equal(a.kind === "run" && a.engine, "codex");
  assert.equal(a.kind === "run" && a.explored, true);
  assert.equal(a.kind === "run" && a.reason.how, "explore");
  assert.deepEqual(chooseRoute(input(cands, { taskId: inside, explore: 10 })), a, "the same task explores the same way every time");
  const b = chooseRoute(input(cands, { taskId: outside, explore: 10 }));
  assert.equal(b.kind === "run" && b.engine, "claude");
  assert.equal(b.kind === "run" && b.explored, false);
  const off = chooseRoute(input(cands, { taskId: inside, explore: 0 }));
  assert.equal(off.kind === "run" && off.engine, "claude");
  let n = 0;
  for (let i = 0; i < 2000; i++) if (exploreBucket(`tsk-${i.toString(36)}-x`) < 10) n++;
  assert.ok(n > 140 && n < 260, `about 10% explore (${n} of 2000)`);
  // One candidate: nothing to explore.
  const single = chooseRoute(input([cands[0]!], { taskId: inside, explore: 30 }));
  assert.equal(single.kind === "run" && single.explored, false);
});

test("local first: a ready local engine wins unless its first-pass rate is clearly worse", () => {
  const cloud = cand("codex", { firstPass: fp(0.9) });
  const local = cand("hearthwork", { servedModel: "qwen3", firstPass: fp(0.9 - LOCAL_FIRST_MARGIN + 0.01) });
  const c = chooseRoute(input([cloud, local], { localFirst: true }));
  assert.equal(c.kind === "run" && c.engine, "hearthwork");
  assert.equal(c.kind === "run" && c.reason.how, "local-first");
  assert.match(c.kind === "run" ? c.reason.summary : "", /hearthwork \(qwen3\) because local first is on for task type backend; first pass 76% vs 90% on codex/);
  const worse = chooseRoute(input([cloud, { ...local, firstPass: fp(0.9 - LOCAL_FIRST_MARGIN - 0.05) }], { localFirst: true }));
  assert.equal(worse.kind === "run" && worse.engine, "codex", "clearly worse local loses");
  const noHistory = chooseRoute(input([cloud, { ...local, firstPass: null }], { localFirst: true }));
  assert.equal(noHistory.kind === "run" && noHistory.engine, "hearthwork", "no history is not clearly worse");
  // Off: the scores decide.
  const scored = chooseRoute(input([cloud, local]));
  assert.equal(scored.kind === "run" && scored.engine, "codex");
});

test("local first with the local engine offline waits instead of going to the cloud", () => {
  const c = chooseRoute(input([cand("codex", { firstPass: fp(0.9) }), cand("hearthwork", { localNotReady: "no local model is running" })], { localFirst: true }));
  assert.equal(c.kind, "wait-local");
  assert.equal(c.kind === "wait-local" && c.why, "no local model is running");
  // The agent's own engine is local: wait for it even without local first.
  const own = chooseRoute(input([cand("codex"), cand("hearthwork", { localNotReady: "the local model is busy" })], { own: { engine: "hearthwork", model: null } }));
  assert.equal(own.kind, "wait-local");
});

test("after an escalation a task never goes back to a local engine", () => {
  const c = chooseRoute(input([cand("hearthwork", { firstPass: fp(1) }), cand("codex", { firstPass: fp(0.1) })], { localFirst: true, escalated: true, kept: { engine: "hearthwork", model: null }, own: { engine: "hearthwork", model: null } }));
  assert.equal(c.kind === "run" && c.engine, "codex");
  const onlyLocal = chooseRoute(input([cand("hearthwork")], { escalated: true, own: { engine: "hearthwork", model: null } }));
  assert.equal(onlyLocal.kind, "block");
  const pinnedLocal = chooseRoute(input([cand("hearthwork"), cand("codex")], { escalated: true, pin: { entry: { engine: "hearthwork" }, source: "task" } }));
  assert.equal(pinnedLocal.kind, "block", "a local pin does not bring an escalated task back");
});

test("an earlier attempt's engine is kept while it can run", () => {
  const cands = [cand("claude", { firstPass: fp(0.9) }), cand("codex", { firstPass: fp(0.5) })];
  const kept = chooseRoute(input(cands, { kept: { engine: "codex", model: null } }));
  assert.equal(kept.kind === "run" && kept.engine, "codex");
  assert.equal(kept.kind === "run" && kept.reason.how, "kept");
  const gone = chooseRoute(input([cands[0]!, { ...cands[1]!, excluded: "codex is not signed in." }], { kept: { engine: "codex", model: null } }));
  assert.equal(gone.kind === "run" && gone.engine, "claude");
});

test("review independence: engine and inference model, with local models seen through the CLI", () => {
  assert.equal(normModel("ollama/Qwen3-Coder"), "qwen3-coder");
  assert.equal(normModel(null), null);
  const author = authorIdentity({ engine: "hearthwork", model: "qwen-test", execution: { harness: "codex", model: "qwen-test", host: "local", runtime: null, agentMs: 1, waitMs: 1, files: null } });
  assert.deepEqual(author, { engine: "hearthwork", model: "qwen-test", host: "local" });
  const sameModel = independence(author, candidateIdentity("opencode", "hearthwork/qwen-test", null));
  assert.equal(sameModel.independent, false);
  assert.match(sameModel.why, /same inference model \(qwen-test on local\) as the author, under a different CLI/);
  const localSame = independence(author, candidateIdentity("opencode", null, { harness: "opencode", running: true, model: "Qwen-Test", context: null, slots: null, active: null, queued: null, state: "ready", runtime: null }));
  assert.equal(localSame.independent, false, "two CLIs on one local model are not independent");
  assert.equal(independence(author, candidateIdentity("hearthwork", null, null)).independent, false, "the same engine never is");
  const cloud = independence(author, candidateIdentity("claude", "claude-sonnet-4", null));
  assert.equal(cloud.independent, true);
  const cloudAuthor = authorIdentity({ engine: "codex", model: "gpt-5", execution: null });
  assert.equal(independence(cloudAuthor, candidateIdentity("opencode", "openai/gpt-5", null)).independent, false, "the same cloud model under another CLI is not independent either");
  assert.equal(independence(cloudAuthor, candidateIdentity("claude", null, null)).independent, true);
});

test("routing settings: off by default, human only, validated, and pins are cleared with null", () => {
  const env = makeEnv();
  const s = env.store.getSettings().routing;
  assert.deepEqual(s, { mode: "off", localFirst: false, explore: 10, localRetries: 2, pins: { project: null, roles: {}, tasks: {} } });
  assert.throws(() => env.store.setSetting("routing.mode", "auto", { kind: "agent", agentId: "agt-x", role: "backend", permission: "workspace_write" }), PolicyDeniedError);
  assert.throws(() => env.store.setSetting("routing.mode", "on", HUMAN), ValidationError);
  assert.throws(() => env.store.setSetting("routing.explore", 31, HUMAN), /0 to 30/);
  assert.throws(() => env.store.setSetting("routing.localRetries", 0, HUMAN), ValidationError);
  assert.throws(() => env.store.setSetting("routing.pin.role.cto", { engine: "codex" }, HUMAN), /not a worker role/);
  assert.throws(() => env.store.setSetting("routing.pin.task.tsk-none", { engine: "codex" }, HUMAN), /no task with that id/);
  assert.throws(() => env.store.setSetting("routing.pin.project", { engine: "fake" }, HUMAN), ValidationError);
  assert.throws(() => env.store.setSetting("routing.whatever", 1, HUMAN), /Unknown setting/);
  env.store.setSetting("routing.mode", "auto", HUMAN);
  env.store.setSetting("routing.localFirst", true, HUMAN);
  env.store.setSetting("routing.explore", 0, HUMAN);
  env.store.setSetting("routing.pin.project", { engine: "hearthwork" }, HUMAN);
  env.store.setSetting("routing.pin.role.frontend", { engine: "codex", model: "gpt-5" }, HUMAN);
  const on = env.store.getSettings().routing;
  assert.equal(on.mode, "auto");
  assert.equal(on.localFirst, true);
  assert.equal(on.explore, 0);
  assert.deepEqual(on.pins, { project: { engine: "hearthwork" }, roles: { frontend: { engine: "codex", model: "gpt-5" } }, tasks: {} });
  env.store.setSetting("routing.pin.project", null, HUMAN);
  assert.equal(env.store.getSettings().routing.pins.project, null);
});

test("pin text: engine or engine/model, empty clears, unknown engines are refused", () => {
  assert.deepEqual(parsePinInput(""), { value: null });
  assert.deepEqual(parsePinInput(" none "), { value: null });
  assert.deepEqual(parsePinInput("Hearthwork"), { value: { engine: "hearthwork" } });
  assert.deepEqual(parsePinInput("opencode/ollama/qwen3"), { value: { engine: "opencode", model: "ollama/qwen3" } });
  assert.equal(parsePinInput("gpt"), null);
  assert.equal(pinWords({ engine: "codex", model: "gpt-5" }), "codex/gpt-5");
  assert.equal(pinWords(null), "none");
});

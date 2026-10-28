// Client-facing JSON-RPC methods (the contract is protocol.ts). Read models
// come straight from the Store; every action goes through the same domain
// rules the agents use, with the human as the actor.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ValidationError } from "../core/errors.js";
import { readRegistry } from "../core/identity.js";
import { forewrightHome, logsDir } from "../core/paths.js";
import { truncate } from "../core/safety.js";
import { NOTIFY_MUTE_KEY, parseMute } from "../core/notify-model.js";
import { budgetStatus } from "./budgets.js";
import { heartbeatStatus, runRoutineNow } from "./automation.js";
import { automationRows } from "./automation-rows.js";
import { loadPrices, readUsageRows, summarizeUsage, windowStart } from "../core/usage.js";
import type { Message, MessageChannel } from "../core/store.js";
import type { EngineId, PermissionProfile } from "../core/types.js";
import type { Daemon } from "./daemon.js";
import { RpcError } from "./errors.js";
import { gitTry, hasCommits } from "./git.js";
import type { ProjectRuntime } from "./project-runtime.js";
import type { ProviderStatus, TaskDetail } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { Connection } from "./server.js";
import { engineRoleProblem } from "./engine-roles.js";
import { fallbackStatus } from "./fallback.js";
import { INTEGRATION_BRANCH } from "./workspace.js";
import { MEMORY_CAP_BYTES, clearMemory, readMemory } from "./memory.js";
import { KICKOFF_SCALES, approveKickoffPack, exportKickoff, keepOwnerEdit, kickoffProposalView, kickoffView, nudgeKickoff, readKickoffDoc, readKickoffWireframe, startKickoffPack } from "./kickoff.js";
import type { KickoffScale } from "../core/store.js";
import { readGuiConfig, validateGuiPort } from "../core/gui-config.js";
import { NOTE_MAX, requestChange } from "./change-request.js";
import { taskCheckpoints, undoTaskTo } from "./checkpoints.js";
import { chatStatus, humanRecipients } from "./chat.js";

type P = Record<string, unknown>;
type Handler = (p: P, conn: Connection) => unknown | Promise<unknown>;

const HUMAN = { kind: "human" } as const;

function reqStr(p: P, key: string, max = 100_000): string {
  const v = p[key];
  if (typeof v !== "string" || v.trim() === "") throw new RpcError(-32602, "invalid_params", `"${key}" is required.`, { key });
  if (v.length > max) throw new ValidationError(`"${key}" is too long.`, { key, max });
  return v;
}
function optStr(p: P, key: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new RpcError(-32602, "invalid_params", `"${key}" must be text.`, { key });
  return v;
}
function reqInt(p: P, key: string): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new RpcError(-32602, "invalid_params", `"${key}" must be a whole number.`, { key });
  return v;
}

export class ClientApi {
  private readonly handlers: Record<string, Handler>;

  constructor(private readonly d: Daemon) {
    this.handlers = this.build();
  }

  /** Every client method name, for tests that check each one works through the GUI bridge. */
  methodNames(): string[] {
    return Object.keys(this.handlers);
  }

  async call(method: string, params: P, conn: Connection): Promise<unknown> {
    const h = this.handlers[method];
    if (!h) throw new RpcError(-32601, "method_not_found", `The service does not know the method "${method}".`, { method });
    try {
      return await h(params, conn);
    } finally {
      for (const rt of this.d.runtimes.values()) rt.publish();
    }
  }

  private async rt(p: P): Promise<ProjectRuntime> {
    return this.d.runtimeFor(reqStr(p, "projectId", 200));
  }

  private providerStatuses(rt: ProjectRuntime | null, refresh: boolean): Promise<ProviderStatus[]> {
    return this.d.health.get(refresh).then((list) =>
      list.map((health) => {
        const adapter = this.d.adapters.get(health.engine);
        const runtimes = rt ? [rt] : [...this.d.runtimes.values()];
        let quotaUntil: string | null = null;
        for (const r of runtimes) {
          if (!r.quotaActive(health.engine)) continue;
          const state = r.quotaState(health.engine);
          quotaUntil = state?.until ?? "unknown";
        }
        return { health, capabilities: adapter!.capabilities, quotaUntil };
      }),
    );
  }

  private build(): Record<string, Handler> {
    const d = this.d;
    return {
      subscribe: async (p, conn) => {
        const rt = await this.rt(p);
        const since = reqInt(p, "sinceSeq");
        // Replay only what the bus already published, then join live delivery, so nothing is missed or doubled.
        for (const ev of rt.bus.replay(since)) conn.notify("event", { projectId: rt.projectId, event: ev });
        rt.subscribers.add(conn);
        conn.subscriptions.set(rt.projectId, rt);
        return { lastSeq: rt.bus.lastPublished };
      },
      unsubscribe: async (p, conn) => {
        const rt = await this.rt(p);
        rt.subscribers.delete(conn);
        conn.subscriptions.delete(rt.projectId);
        return { ok: true };
      },

      "projects.open": (p) => d.openProject(reqStr(p, "cwd", 4096)),
      "projects.init": (p) => d.initProject(reqStr(p, "cwd", 4096), optStr(p, "name")),

      "projects.list": () => ({
        projects: Object.entries(readRegistry())
          .sort(([, a], [, b]) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
          .map(([projectId, e]) => ({ projectId, root: e.root, name: path.basename(e.root) })),
      }),

      "projects.initialCommit": async (p) => (await this.rt(p)).initialCommit(),

      "state.overview": async (p) => (await this.rt(p)).store.overview(),
      "state.runtime": async (p) => (await this.rt(p)).status(),
      "state.tasks": async (p) => ({ board: (await this.rt(p)).store.taskBoard() }),
      "state.task": async (p) => this.taskDetail(await this.rt(p), reqStr(p, "taskId", 200)),
      "state.team": async (p) => {
        const rt = await this.rt(p);
        return { agents: rt.store.teamView().map((a) => (a.retiredAt ? a : { ...a, engineUse: rt.engineUse(a) })) };
      },
      "state.inbox": async (p) => (await this.rt(p)).store.inbox(),
      "state.messages": async (p) => {
        const rt = await this.rt(p);
        const { store } = rt;
        const channel = optStr(p, "channel") as MessageChannel | undefined;
        const taskId = optStr(p, "taskId");
        const agentId = optStr(p, "agentId");
        const peerAgentId = optStr(p, "peerAgentId");
        const threadId = optStr(p, "threadId");
        const limit = typeof p["limit"] === "number" ? p["limit"] : 200;
        // A thread: its root and replies, oldest first. Otherwise top-level messages only, with their reply counts.
        if (threadId) return { messages: store.listMessages({ threadId, limit }) };
        let messages: Message[];
        if (agentId && (channel === "direct" || peerAgentId)) {
          messages = store.listDirectMessages(store.getAgent(agentId).id, peerAgentId ? store.getAgent(peerAgentId).id : null);
        } else if (agentId) {
          const taskDbId = taskId ? store.getTask(taskId).id : undefined;
          messages = store.listMessagesFor(agentId, 1000).filter((m) => (!channel || m.channel === channel) && (!taskDbId || m.taskId === taskDbId));
        } else {
          messages = store.listMessages({ ...(channel ? { channel } : {}), ...(taskId ? { taskId } : {}) });
        }
        return { messages: store.withReplyCounts(messages.filter((m) => m.threadId === null)).slice(-limit) };
      },
      "state.chat": async (p) => chatStatus(await this.rt(p)),
      "state.channels": async (p) => this.channels(await this.rt(p)),
      "state.prd": async (p) => {
        const rt = await this.rt(p);
        const docs = rt.store.listDocs();
        const rev = typeof p["revision"] === "number" ? p["revision"] : undefined;
        const doc = rev !== undefined ? rt.store.getDoc(rev) : (docs.at(-1) ?? null);
        return {
          doc,
          approved: rt.store.currentApprovedDoc(),
          all: docs.map((x) => ({ revision: x.revision, status: x.status, title: x.title, createdAt: x.createdAt })),
        };
      },
      "state.kickoff": async (p) => kickoffView((await this.rt(p)).store),
      "kickoff.doc": async (p) => {
        const rt = await this.rt(p);
        const key = reqStr(p, "key", 100);
        return { key, text: readKickoffDoc(rt.projectId, key) };
      },
      "kickoff.proposal": async (p) => kickoffProposalView(await this.rt(p), reqStr(p, "key", 100)),
      "kickoff.wireframe": async (p) => readKickoffWireframe((await this.rt(p)).projectId, reqStr(p, "name", 100)),
      "state.adrs": async (p) => ({ adrs: (await this.rt(p)).store.listAdrs() }),
      "state.evidence": async (p) => {
        const rt = await this.rt(p);
        const ev = rt.store.listEvidence(reqStr(p, "taskId", 200));
        return { task: ev.task, verifications: ev.verifications, artifacts: ev.artifacts, runs: ev.runs, routes: rt.store.listRouteDecisions(ev.task.id), deliveredMessages: rt.store.deliveredMessagesForTask(ev.task.id) };
      },
      "state.settings": async (p) => {
        const rt = await this.rt(p);
        const cto = rt.ctoAgent();
        const settings = rt.store.getSettings();
        return {
          settings,
          providers: await this.providerStatuses(rt, false),
          ctoEngine: cto.engine,
          ctoModel: cto.model,
          hasCommits: hasCommits(rt.root),
          projectChecks: rt.store.getSetting<string[]>("projectChecks") ?? [],
          agents: rt.store.listAgents().map((a) => ({ id: a.id, name: a.name })),
          fallbackStatus: { cto: fallbackStatus(rt, "cto", settings.fallback.cto), workers: fallbackStatus(rt, "workers", settings.fallback.workers) },
          notify: { mute: parseMute(rt.store.getSetting(NOTIFY_MUTE_KEY)) ?? [], phone: rt.notify.status() },
        };
      },
      "state.events": async (p) => {
        const rt = await this.rt(p);
        return { events: rt.store.recentEvents(reqInt(p, "sinceSeq"), typeof p["limit"] === "number" ? p["limit"] : 200) };
      },
      "state.usage": async (p) => {
        const rt = await this.rt(p);
        const days = typeof p["days"] === "number" && Number.isInteger(p["days"]) && p["days"] >= 1 && p["days"] <= 366 ? p["days"] : 7;
        const now = new Date();
        const rows = readUsageRows(rt.store.db, windowStart(now, days).toISOString()).filter((r) => r.projectId === rt.projectId);
        return summarizeUsage(rows, { now, days, prices: loadPrices(forewrightHome()) });
      },
      "state.budgets": async (p) => ({ scopes: budgetStatus(await this.rt(p)) }),

      // Automation (routines, heartbeat, GitHub triggers). Only Billy reaches these methods; agents have no tool for them.
      "routines.list": async (p) => {
        const rt = await this.rt(p);
        const view = { routines: rt.store.listRoutines(), heartbeat: heartbeatStatus(rt), triggers: rt.triggers.status() };
        return { ...view, rows: automationRows(view) };
      },
      "routines.save": async (p) => {
        const rt = await this.rt(p);
        if (typeof p["enabled"] !== "boolean") throw new RpcError(-32602, "invalid_params", '"enabled" must be true or false.', { key: "enabled" });
        const routine = rt.store.saveRoutine({ ...(optStr(p, "id") ? { id: optStr(p, "id")! } : {}), name: reqStr(p, "name", 200), schedule: reqStr(p, "schedule", 100), prompt: reqStr(p, "prompt", 8000), enabled: p["enabled"] }, HUMAN);
        rt.scheduler.wake("routine_saved");
        return { routine };
      },
      "routines.delete": async (p) => {
        (await this.rt(p)).store.deleteRoutine(reqStr(p, "routineId", 200), HUMAN);
        return { ok: true as const };
      },
      "routines.runNow": async (p) => ({ routine: runRoutineNow(await this.rt(p), reqStr(p, "routineId", 200)) }),
      "evidence.diff": async (p) => this.diff(await this.rt(p), reqStr(p, "taskId", 200)),
      "tasks.checkpoints": async (p) => taskCheckpoints(await this.rt(p), reqStr(p, "taskId", 200)),
      "tasks.undoTo": async (p) => {
        const rt = await this.rt(p);
        return undoTaskTo(rt, reqStr(p, "taskId", 200), reqStr(p, "sha", 100));
      },
      "runs.log": async (p) => {
        const rt = await this.rt(p);
        const runId = reqStr(p, "runId", 100);
        if (!/^run_[a-z0-9]+$/.test(runId)) throw new ValidationError("That is not a run id.", { runId });
        rt.store.getRun(runId);
        const file = path.join(logsDir(rt.projectId), `${runId}.jsonl`);
        const tail = typeof p["tailLines"] === "number" ? p["tailLines"] : 200;
        const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l !== "").slice(-tail) : [];
        return { lines, path: file };
      },
      "providers.health": async (p) => ({ providers: await this.providerStatuses(null, p["refresh"] === true) }),

      "cto.send": async (p) => {
        const rt = await this.rt(p);
        const cto = rt.ctoAgent();
        const r = rt.store.postMessage({ channel: "cto", sender: HUMAN, body: reqStr(p, "body", 20_000), recipients: [cto.id] });
        rt.scheduler.wake("human_message");
        return { messageId: r.id };
      },
      "chat.send": async (p) => {
        const rt = await this.rt(p);
        const channel = reqStr(p, "channel", 20) as Exclude<MessageChannel, "cto">;
        if (!["project", "task", "direct"].includes(channel)) throw new ValidationError(`Unknown channel "${channel}".`, { channel });
        const taskId = optStr(p, "taskId");
        const threadId = optStr(p, "threadId");
        const body = reqStr(p, "body", 20_000);
        const toAgentIds = Array.isArray(p["toAgentIds"]) ? (p["toAgentIds"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
        const recipients = humanRecipients(rt, { channel, ...(taskId ? { taskId } : {}), toAgentIds, ...(threadId ? { threadId } : {}), body });
        const r = rt.store.postMessage({
          channel,
          ...(taskId ? { taskId } : {}),
          ...(threadId ? { threadId } : {}),
          sender: HUMAN,
          body,
          recipients,
          changesProductBehavior: channel !== "project",
        });
        rt.scheduler.wake("human_message");
        return { messageId: r.id, woke: r.recipients };
      },
      "prd.approve": async (p) => {
        const rt = await this.rt(p);
        const { doc, affected } = rt.store.approveRequirementDoc(reqInt(p, "revision"), HUMAN);
        rt.store.invalidateDecisionsForRevision(doc.revision);
        rt.notifyCto(
          `prd-approved:${doc.revision}`,
          `Billy approved PRD revision ${doc.revision} ("${doc.title}").${affected.length > 0 ? ` Scope changed for: ${affected.map((a) => `${a.shortId} (${a.changedKeys.join(", ")})`).join("; ")}.` : ""} You can create tasks for its requirements now.`,
        );
        return { doc, affectedTaskIds: affected.map((a) => a.taskId) };
      },
      "kickoff.start": async (p) => {
        const rt = await this.rt(p);
        const scale = reqStr(p, "scale", 20);
        if (!(KICKOFF_SCALES as readonly string[]).includes(scale)) throw new ValidationError(`The pack size must be one of ${KICKOFF_SCALES.join(", ")}.`, { scale });
        // Planning only: nothing here touches the repository, so a folder without git works as it is.
        const r = startKickoffPack(rt.store, scale as KickoffScale);
        if (r.created) nudgeKickoff(rt, "start");
        else if (r.pack.status === "generating") nudgeKickoff(rt, "billy"); // Billy asks again for a pack that stalled
        return kickoffView(rt.store);
      },
      "kickoff.approve": async (p) => {
        const rt = await this.rt(p);
        approveKickoffPack(rt, reqInt(p, "revision"));
        return kickoffView(rt.store);
      },
      "kickoff.keepEdit": async (p) => {
        const rt = await this.rt(p);
        keepOwnerEdit(rt, reqStr(p, "key", 100));
        return kickoffView(rt.store);
      },
      "kickoff.export": async (p) => {
        const rt = await this.rt(p);
        const r = exportKickoff(rt, reqStr(p, "dir", 4096), p["overwrite"] === true);
        return r;
      },
      "decisions.resolve": async (p) => {
        const rt = await this.rt(p);
        const id = reqStr(p, "decisionId", 200);
        const decision = rt.store.resolveDecision(id, { option: reqStr(p, "option", 100), ...(optStr(p, "note") ? { note: optStr(p, "note")! } : {}), by: HUMAN });
        await rt.onDecisionResolved(decision);
        return { decision: rt.store.getDecision(id) };
      },
      "settings.set": async (p) => {
        const rt = await this.rt(p);
        const key = reqStr(p, "key", 100);
        if (key === "ctoEngine") {
          const adapter = d.adapters.get(p["value"] as EngineId);
          if (!adapter) throw new ValidationError(`The ${String(p["value"])} provider is not known to this service.`, { key });
          const problem = engineRoleProblem(adapter, "cto");
          if (problem) throw new ValidationError(problem, { key });
        }
        rt.store.setSetting(key, p["value"], HUMAN);
        if (key === "ctoEngine" || key === "ctoModel") {
          const cto = rt.ctoAgent();
          rt.store.updateAgent(cto.id, key === "ctoEngine" ? { engine: p["value"] as EngineId } : { model: (p["value"] as string | null) ?? null }, HUMAN);
        }
        rt.scheduler.wake("settings");
        return { settings: rt.store.getSettings() };
      },
      "agents.memory": async (p) => {
        const rt = await this.rt(p);
        const text = readMemory(rt.projectId, rt.store.getAgent(reqStr(p, "agentId", 200)).id);
        return { text, bytes: Buffer.byteLength(text), limit: MEMORY_CAP_BYTES };
      },
      "agents.clearMemory": async (p) => {
        const rt = await this.rt(p);
        const agent = rt.store.getAgent(reqStr(p, "agentId", 200));
        clearMemory(rt.projectId, agent.id);
        rt.store.recordEvent("memory.cleared", "agent", agent.id, HUMAN, { agentId: agent.id });
        return { ok: true };
      },
      "agents.update": async (p) => {
        const rt = await this.rt(p);
        const engine = optStr(p, "engine") as EngineId | undefined;
        if (engine) {
          const adapter = d.adapters.get(engine);
          if (!adapter) throw new ValidationError(`The ${engine} provider is not known to this service.`, { engine });
          const problem = engineRoleProblem(adapter, rt.store.getAgent(reqStr(p, "agentId", 200)).role);
          if (problem) throw new ValidationError(problem, { engine });
        }
        const name = "name" in p ? validAgentName(rt, reqStr(p, "agentId", 200), p["name"]) : undefined;
        const agent = rt.store.updateAgent(
          reqStr(p, "agentId", 200),
          {
            ...(name !== undefined ? { name } : {}),
            ...(engine ? { engine } : {}),
            ...("model" in p ? { model: (p["model"] as string | null) ?? null } : {}),
            ...(p["permission"] ? { permission: p["permission"] as PermissionProfile } : {}),
          },
          HUMAN,
        );
        return { agent };
      },
      "agents.retire": async (p) => {
        const rt = await this.rt(p);
        const agent = rt.store.getAgent(reqStr(p, "agentId", 200));
        rt.store.retireAgent(agent.id, HUMAN);
        rt.notifyCto(`retire:${agent.id}`, `Billy retired ${agent.name} (${agent.role}). It will not get new work.`);
        rt.publish();
        return { ok: true };
      },
      "tasks.reassign": async (p) => {
        const rt = await this.rt(p);
        const t = rt.store.getTask(reqStr(p, "taskId", 200));
        rt.store.reassignTask(t.id, reqStr(p, "agentId", 200), reqStr(p, "note", 4000), HUMAN);
        rt.stopTaskRuns(t.id, "reassign", "Task reassigned by Billy");
        rt.scheduler.wake("reassign");
        return { task: rt.store.getTask(t.id) };
      },
      "tasks.requestChange": async (p) => {
        const rt = await this.rt(p);
        const file = optStr(p, "file");
        const hunk = optStr(p, "hunk");
        return { task: await requestChange(rt, { taskId: reqStr(p, "taskId", 200), ...(file !== undefined ? { file } : {}), ...(hunk !== undefined ? { hunk } : {}), note: reqStr(p, "note", NOTE_MAX) }) };
      },
      "tasks.outcome": async (p) => {
        const rt = await this.rt(p);
        rt.store.recordTaskOutcome(reqStr(p, "taskId", 200), typeof p["fixMinutes"] === "number" ? { fixMinutes: p["fixMinutes"] } : {});
        return { ok: true };
      },
      "drafts.save": async (p) => {
        (await this.rt(p)).store.saveDraft(reqStr(p, "view", 100), reqStr(p, "key", 200), typeof p["body"] === "string" ? p["body"] : "");
        return { ok: true };
      },
      "drafts.get": async (p) => ({ body: (await this.rt(p)).store.getDraft(reqStr(p, "view", 100), reqStr(p, "key", 200)) }),

      "control.pauseAll": async (p) => (await this.rt(p)).pauseAll(),
      "control.resume": async (p) => (await this.rt(p)).resume(),
      "control.stopRun": async (p) => ({ run: await (await this.rt(p)).stopRunById(reqStr(p, "runId", 200)) }),
      "control.resumeTask": async (p) => ({ task: (await this.rt(p)).resumeTask(reqStr(p, "taskId", 200)) }),
      "control.cancelTask": async (p) => ({ task: await (await this.rt(p)).cancelTask(reqStr(p, "taskId", 200)) }),
      "control.terminateTeam": async (p) => (await this.rt(p)).terminateTeam(),

      "gui.settings": () => ({ editorSshHost: readGuiConfig().editorSshHost }),
      "gui.start": (p) => {
        const port = p["port"];
        return d.startGui(port === undefined || port === null ? undefined : validateGuiPort(port));
      },

      // Not part of protocol.ts: used by `forewright status`.
      "daemon.status": () => d.statusSummary(),
      "daemon.protocol": () => ({ protocolVersion: PROTOCOL_VERSION }),
    };
  }

  private taskDetail(rt: ProjectRuntime, taskRef: string): TaskDetail {
    const { store } = rt;
    const task = store.getTask(taskRef);
    const brief = (id: string) => {
      const t = store.getTask(id);
      return { id: t.id, shortId: t.shortId, title: t.title, state: t.state };
    };
    const doc = store.currentApprovedDoc();
    return {
      task,
      dependencies: task.dependsOn.map(brief),
      dependents: store.listTasks().filter((t) => t.dependsOn.includes(task.id)).map((t) => brief(t.id)),
      requirements: (doc?.requirements ?? []).filter((r) => task.requirementKeys.includes(r.key)),
      assignee: task.assigneeAgentId ? store.getAgent(task.assigneeAgentId) : null,
      runs: store.listRuns({ taskId: task.id }),
      verifications: store.listVerifications(task.id),
    };
  }

  private channels(rt: ProjectRuntime) {
    const { store } = rt;
    const all = store.listMessages();
    const last = (ms: Message[]) => ms.at(-1)?.createdAt ?? null;
    const out: Array<{ channel: MessageChannel; taskId: string | null; agentId: string | null; peerAgentId?: string | null; label: string; lastAt: string | null }> = [
      { channel: "cto", taskId: null, agentId: null, label: "CTO", lastAt: last(all.filter((m) => m.channel === "cto")) },
      { channel: "project", taskId: null, agentId: null, label: "Project", lastAt: last(all.filter((m) => m.channel === "project")) },
    ];
    for (const t of store.listTasks()) {
      const ms = all.filter((m) => m.taskId === t.id && m.channel === "task");
      if (ms.length > 0) out.push({ channel: "task", taskId: t.id, agentId: null, label: `${t.shortId} ${t.title}`, lastAt: last(ms) });
    }
    for (const a of store.listAgents()) {
      if (a.role === "cto") continue;
      out.push({ channel: "direct", taskId: null, agentId: a.id, label: a.name, lastAt: last(store.listDirectMessages(a.id, null)) });
    }
    // Direct messages between two agents (ask_teammate, chat replies), one entry per pair that has any, labeled "Ada and Bo".
    const pairs = new Map<string, { ids: string[]; lastAt: string }>();
    for (const m of all) {
      if (m.channel !== "direct") continue;
      const pair = store.directPair(m);
      if (pair.length !== 2 || pair.includes("billy")) continue;
      pairs.set(pair.join("+"), { ids: pair, lastAt: m.createdAt });
    }
    const name = (id: string) => store.getAgent(id).name;
    for (const { ids, lastAt } of pairs.values()) {
      const [x, y] = [...ids].sort((p1, p2) => name(p1).localeCompare(name(p2)));
      out.push({ channel: "direct", taskId: null, agentId: x!, peerAgentId: y!, label: `${name(x!)} and ${name(y!)}`, lastAt });
    }
    return { channels: out };
  }

  private diff(rt: ProjectRuntime, taskRef: string) {
    const t = rt.store.getTask(taskRef);
    const head = t.candidateCommit;
    if (!head || !t.worktreePath) return { base: null, head, diff: "", truncated: false };
    let base: string | null = null;
    if (t.state === "done") {
      // Once integrated, the branch tip contains the change; show what the integration added.
      const row = rt.store.db
        .prepare("SELECT payload FROM event WHERE project_id = ? AND type = 'integration.completed' AND entity_id = ? ORDER BY seq DESC LIMIT 1")
        .get(rt.projectId, t.id) as { payload: string } | undefined;
      const info = row ? (JSON.parse(row.payload) as { previousTip?: string }) : {};
      base = info.previousTip ?? null;
    } else {
      const r = gitTry(rt.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${INTEGRATION_BRANCH}^{commit}`]);
      base = r.code === 0 ? r.stdout.trim() : null;
    }
    if (!base) return { base, head, diff: "", truncated: false };
    const raw = gitTry(rt.root, ["diff", t.state === "done" ? `${base}..${head}` : `${base}...${head}`]).stdout;
    return { base, head, diff: truncate(raw, 200_000), truncated: raw.length > 200_000 };
  }
}

/** An agent's new name: trimmed, 1 to 40 characters of letters, digits, space, dot, dash and underscore, unique among the project's active agents. */
function validAgentName(rt: ProjectRuntime, agentId: string, value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("The name must be text.", { name: value });
  const name = value.trim();
  if (name.length === 0 || name.length > 40) throw new ValidationError("A name needs 1 to 40 characters.", { name });
  if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) throw new ValidationError("A name can use letters, digits, spaces, dots, dashes and underscores.", { name });
  const clash = rt.store.listAgents().find((a) => a.id !== agentId && a.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new ValidationError(`Another agent is already called ${clash.name}.`, { name });
  return name;
}

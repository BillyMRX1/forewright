// Client-facing JSON-RPC methods (the contract is protocol.ts). Read models
// come straight from the Store; every action goes through the same domain
// rules the agents use, with the human as the actor.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ValidationError } from "../core/errors.js";
import { logsDir } from "../core/paths.js";
import { truncate } from "../core/safety.js";
import type { Message, MessageChannel } from "../core/store.js";
import type { EngineId, PermissionProfile } from "../core/types.js";
import type { Daemon } from "./daemon.js";
import { RpcError } from "./errors.js";
import { gitTry } from "./git.js";
import type { ProjectRuntime } from "./project-runtime.js";
import type { ProviderStatus, TaskDetail } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { Connection } from "./server.js";
import { engineRoleProblem } from "./engine-roles.js";
import { INTEGRATION_BRANCH } from "./workspace.js";

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

      "state.overview": async (p) => (await this.rt(p)).store.overview(),
      "state.runtime": async (p) => (await this.rt(p)).status(),
      "state.tasks": async (p) => ({ board: (await this.rt(p)).store.taskBoard() }),
      "state.task": async (p) => this.taskDetail(await this.rt(p), reqStr(p, "taskId", 200)),
      "state.team": async (p) => ({ agents: (await this.rt(p)).store.teamView() }),
      "state.inbox": async (p) => (await this.rt(p)).store.inbox(),
      "state.messages": async (p) => {
        const rt = await this.rt(p);
        const channel = optStr(p, "channel") as MessageChannel | undefined;
        const taskId = optStr(p, "taskId");
        const agentId = optStr(p, "agentId");
        const limit = typeof p["limit"] === "number" ? p["limit"] : 200;
        let messages: Message[];
        if (agentId) {
          const taskDbId = taskId ? rt.store.getTask(taskId).id : undefined;
          messages = rt.store.listMessagesFor(agentId, 1000).filter((m) => (!channel || m.channel === channel) && (!taskDbId || m.taskId === taskDbId)).slice(-limit);
        } else {
          messages = rt.store.listMessages({ ...(channel ? { channel } : {}), ...(taskId ? { taskId } : {}), limit });
        }
        return { messages };
      },
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
      "state.adrs": async (p) => ({ adrs: (await this.rt(p)).store.listAdrs() }),
      "state.evidence": async (p) => {
        const rt = await this.rt(p);
        const ev = rt.store.listEvidence(reqStr(p, "taskId", 200));
        return { task: ev.task, verifications: ev.verifications, artifacts: ev.artifacts, runs: ev.runs };
      },
      "state.settings": async (p) => {
        const rt = await this.rt(p);
        const cto = rt.ctoAgent();
        return { settings: rt.store.getSettings(), providers: await this.providerStatuses(rt, false), ctoEngine: cto.engine, ctoModel: cto.model };
      },
      "state.events": async (p) => {
        const rt = await this.rt(p);
        return { events: rt.store.recentEvents(reqInt(p, "sinceSeq"), typeof p["limit"] === "number" ? p["limit"] : 200) };
      },
      "evidence.diff": async (p) => this.diff(await this.rt(p), reqStr(p, "taskId", 200)),
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
        let recipients = Array.isArray(p["toAgentIds"]) ? (p["toAgentIds"] as string[]) : [];
        if (recipients.length === 0) {
          if (channel === "task") {
            if (!taskId) throw new ValidationError("A task message needs a task.");
            const t = rt.store.getTask(taskId);
            recipients = t.assigneeAgentId ? [t.assigneeAgentId] : [];
          } else if (channel === "project") {
            recipients = rt.store.listAgents().map((a) => a.id);
          } else {
            throw new ValidationError("A direct message needs at least one recipient.");
          }
        }
        const r = rt.store.postMessage({
          channel,
          ...(taskId ? { taskId } : {}),
          sender: HUMAN,
          body: reqStr(p, "body", 20_000),
          recipients,
          changesProductBehavior: channel !== "project",
        });
        rt.scheduler.wake("human_message");
        return { messageId: r.id };
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
      "agents.update": async (p) => {
        const rt = await this.rt(p);
        const engine = optStr(p, "engine") as EngineId | undefined;
        if (engine) {
          const adapter = d.adapters.get(engine);
          if (!adapter) throw new ValidationError(`The ${engine} provider is not known to this service.`, { engine });
          const problem = engineRoleProblem(adapter, rt.store.getAgent(reqStr(p, "agentId", 200)).role);
          if (problem) throw new ValidationError(problem, { engine });
        }
        const agent = rt.store.updateAgent(
          reqStr(p, "agentId", 200),
          {
            ...(engine ? { engine } : {}),
            ...("model" in p ? { model: (p["model"] as string | null) ?? null } : {}),
            ...(p["permission"] ? { permission: p["permission"] as PermissionProfile } : {}),
          },
          HUMAN,
        );
        return { agent };
      },
      "tasks.reassign": async (p) => {
        const rt = await this.rt(p);
        const t = rt.store.getTask(reqStr(p, "taskId", 200));
        rt.store.reassignTask(t.id, reqStr(p, "agentId", 200), reqStr(p, "note", 4000), HUMAN);
        rt.stopTaskRuns(t.id, "reassign", "Task reassigned by Billy");
        rt.scheduler.wake("reassign");
        return { task: rt.store.getTask(t.id) };
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
    const out: Array<{ channel: MessageChannel; taskId: string | null; agentId: string | null; label: string; lastAt: string | null }> = [
      { channel: "cto", taskId: null, agentId: null, label: "CTO", lastAt: last(all.filter((m) => m.channel === "cto")) },
      { channel: "project", taskId: null, agentId: null, label: "Project", lastAt: last(all.filter((m) => m.channel === "project")) },
    ];
    for (const t of store.listTasks()) {
      const ms = all.filter((m) => m.taskId === t.id && m.channel === "task");
      if (ms.length > 0) out.push({ channel: "task", taskId: t.id, agentId: null, label: `${t.shortId} ${t.title}`, lastAt: last(ms) });
    }
    for (const a of store.listAgents()) {
      if (a.role === "cto") continue;
      const ms = store.listMessagesFor(a.id, 1000).filter((m) => m.channel === "direct");
      out.push({ channel: "direct", taskId: null, agentId: a.id, label: a.name, lastAt: last(ms) });
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

// Attached terminals (issue #11): Billy opens an agent's own engine CLI (Claude Code or Codex) inside a
// pseudo-terminal in the service, resuming the agent's session, and any number of clients view and type into it.
// While a terminal is open for an agent, no automatic run starts for it (see agentBusy and acquireLease): its
// messages stay pending and its tasks wait. When the last viewer leaves, or the CLI exits by itself, the CLI is
// ended (hangup, then the tree kill) and the agent's automatic runs resume from the same session.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { NotFoundError, ValidationError } from "../core/errors.js";
import type { Agent } from "../core/store.js";
import type { EngineId, InteractiveCommand, McpServerSpec, PermissionProfile } from "../core/types.js";
import { choosePty, type PtyProcess } from "../providers/pty.js";
import type { ProjectRuntime } from "./project-runtime.js";
import { TERMINAL_COLS, TERMINAL_REPLAY_BYTES, TERMINAL_ROWS, type TerminalInfo, type TerminalNotification } from "./protocol.js";
import { terminalSystemPrompt } from "./prompts.js";
import { adapterFor } from "./runs.js";
import { skillsForRun } from "./skills.js";
import type { TokenScope } from "./tokens.js";

/** Output is sent to viewers at most this often, so a chatty CLI does not become one notification per byte. */
export const TERMINAL_FLUSH_MS = 16;
/** The bridge token lives as long as the terminal (revoked at close); this only bounds a token nobody revoked. */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SYSTEM = { kind: "system" } as const;
const HUMAN = { kind: "human" } as const;

const ENGINE_LABEL: Record<EngineId, string> = {
  claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", opencode: "OpenCode", copilot: "Copilot", hearthwork: "Hearthwork", fake: "the test double",
};

/** A client that views terminals: a socket connection (the web bridge relays one per browser). */
export interface TerminalViewer {
  notify(method: "terminal", params: TerminalNotification): void;
}

interface Terminal {
  info: TerminalInfo;
  agentName: string;
  /** The run id the bridge token is bound to. No run row exists for it: a terminal is not a run. */
  tokenRunId: string;
  viewers: Set<TerminalViewer>;
  replay: string[];
  replayLength: number;
  pending: string;
  timer: NodeJS.Timeout | null;
  pty: PtyProcess | null;
  command: InteractiveCommand | null;
  /** Settles once the CLI was started (or failed to start, and the terminal was removed). */
  ready: Promise<void>;
  closing: Promise<void> | null;
  exitSent: boolean;
}

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m\r\n`;

function checkSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const ok = (v: unknown, r: { min: number; max: number }): v is number => typeof v === "number" && Number.isInteger(v) && v >= r.min && v <= r.max;
  if (!ok(cols, TERMINAL_COLS) || !ok(rows, TERMINAL_ROWS)) {
    throw new ValidationError(`A terminal is ${TERMINAL_COLS.min} to ${TERMINAL_COLS.max} columns wide and ${TERMINAL_ROWS.min} to ${TERMINAL_ROWS.max} rows high.`, { cols, rows });
  }
  return { cols, rows };
}

export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();

  constructor(private readonly rt: ProjectRuntime) {}

  private forAgent(agentId: string): Terminal | undefined {
    for (const t of this.terminals.values()) if (t.info.agentId === agentId) return t;
    return undefined;
  }

  /** A terminal is open for the agent, or its CLI is still being ended: automatic runs must wait. */
  isOpen(agentId: string): boolean {
    return this.forAgent(agentId) !== undefined;
  }

  /** The id of the agent's open terminal (not one that is closing), or null. */
  openFor(agentId: string): string | null {
    const t = this.forAgent(agentId);
    return t && !t.closing ? t.info.terminalId : null;
  }

  /** Whether a bridge token's run id belongs to an open terminal (its tools work while the terminal is open). */
  ownsRun(runId: string): boolean {
    for (const t of this.terminals.values()) if (t.tokenRunId === runId && !t.closing) return true;
    return false;
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].filter((t) => !t.closing && t.pty !== null).map((t) => ({ ...t.info }));
  }

  /** Why Billy cannot open a terminal for this agent at all, or null. A live run is checked at attach only. */
  attachProblem(agent: Agent): string | null {
    if (agent.retiredAt) return `${agent.name} has been retired.`;
    const adapter = this.rt.deps.adapters.get(agent.engine);
    if (!adapter) return `${agent.name} runs on ${ENGINE_LABEL[agent.engine]}, which is not available on this machine.`;
    if (!adapter.interactive) return `${agent.name} runs on ${ENGINE_LABEL[agent.engine]}, which Forewright cannot open interactively yet.`;
    return null;
  }

  /** Why the agent cannot be attached to right now because it is running something, or null. */
  private busyReason(agent: Agent): string | null {
    const then = "Stop the run or wait for it to finish, then attach.";
    const a = this.rt.activeForAgent(agent.id);
    if (a) {
      const task = a.taskId ? this.rt.store.getTask(a.taskId).shortId : null;
      const what =
        a.kind === "work" && task ? `is working on ${task}` : a.kind === "review" && task ? `is reviewing ${task}` : a.kind === "cto" ? "is in a CTO turn" : a.kind === "chat" ? "is answering a message" : "has a run in progress";
      return `${agent.name} ${what}. ${then}`;
    }
    if (this.rt.store.agentLeaseHeld(agent.id)) return `${agent.name} has a run in progress. ${then}`;
    return null;
  }

  async attach(agentId: string, cols: number, rows: number, viewer: TerminalViewer): Promise<{ terminal: TerminalInfo; replay: string }> {
    const size = checkSize(cols, rows);
    const rt = this.rt;
    for (;;) {
      if (rt.stopping || rt.closed) throw new ValidationError("The Forewright service is stopping, so no terminal can be opened.");
      const existing = this.forAgent(agentId);
      if (existing) {
        if (existing.closing) {
          await existing.closing; // the old CLI is still being ended: open a fresh one after it
          continue;
        }
        await existing.ready;
        if (this.terminals.get(existing.info.terminalId) !== existing || existing.closing) continue; // it failed to start or ended meanwhile
        return this.join(existing, viewer);
      }
      const agent = rt.store.getAgent(agentId);
      const problem = this.attachProblem(agent);
      if (problem) throw new ValidationError(problem, { agentId });
      const busy = this.busyReason(agent);
      if (busy) throw new ValidationError(busy, { agentId });
      const choice = await (rt.deps.pty ?? choosePty)();
      if (!choice.backend) throw new ValidationError(choice.problem ?? "No pseudo-terminal backend is available on this machine.", { agentId });
      // Things may have changed while the backend was chosen: look again before reserving.
      if (this.forAgent(agentId) || rt.stopping || rt.closed) continue;
      const busyNow = this.busyReason(agent);
      if (busyNow) throw new ValidationError(busyNow, { agentId });
      return this.open(agent, size, choice.backend, viewer);
    }
  }

  private join(t: Terminal, viewer: TerminalViewer): { terminal: TerminalInfo; replay: string } {
    this.flush(t); // pending output goes to the current viewers first, so the newcomer gets it once, inside the replay
    t.viewers.add(viewer);
    this.rt.store.recordEvent("terminal.attached", "agent", t.info.agentId, HUMAN, { terminalId: t.info.terminalId, joined: true, viewers: t.viewers.size });
    this.rt.publish();
    return { terminal: { ...t.info }, replay: t.replay.join("") };
  }

  /** Which session to resume: the CTO's own; a worker's task session (its current task first), else its chat session. */
  private sessionFor(agent: Agent): { sessionId: string | null; purpose: string | null } {
    const sessions = this.rt.store.agentSessions(agent.id, agent.engine);
    const pick = (s: { purpose: string; sessionId: string } | undefined) => (s ? { sessionId: s.sessionId, purpose: s.purpose } : null);
    if (agent.role === "cto") return pick(sessions.find((s) => s.purpose === "cto")) ?? { sessionId: null, purpose: null };
    const work = sessions.filter((s) => s.purpose !== "cto" && s.purpose !== "chat");
    return (
      pick(work.find((s) => s.purpose === agent.currentTaskId)) ?? pick(work[0]) ?? pick(sessions.find((s) => s.purpose === "chat")) ?? { sessionId: null, purpose: null }
    );
  }

  private async open(agent: Agent, size: { cols: number; rows: number }, backend: NonNullable<Awaited<ReturnType<typeof choosePty>>["backend"]>, viewer: TerminalViewer) {
    const rt = this.rt;
    const terminalId = `term_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    let markReady: () => void = () => {};
    const t: Terminal = {
      info: { terminalId, projectId: rt.projectId, agentId: agent.id, engine: agent.engine, sessionId: null, cols: size.cols, rows: size.rows, startedAt: rt.clock.now().toISOString(), exited: null },
      agentName: agent.name,
      tokenRunId: `terminal:${terminalId}`,
      viewers: new Set([viewer]),
      replay: [],
      replayLength: 0,
      pending: "",
      timer: null,
      pty: null,
      command: null,
      ready: new Promise<void>((r) => {
        markReady = r;
      }),
      closing: null,
      exitSent: false,
    };
    // Reserved before anything is awaited: from here on no automatic run of this agent can start.
    this.terminals.set(terminalId, t);
    try {
      const adapter = adapterFor(rt, agent); // the test-double and billing checks every run goes through
      const { sessionId, purpose } = this.sessionFor(agent);
      t.info.sessionId = sessionId;
      // The engine's own resume needs the folder the session was started in (a task worktree for work).
      const origin = sessionId ? rt.store.listRuns().filter((r) => r.agentId === agent.id && r.providerSessionId === sessionId && r.cwd !== null).at(-1) : undefined;
      let cwd = rt.root;
      let fellBack = false;
      if (origin?.cwd) {
        if (existsSync(origin.cwd)) cwd = origin.cwd;
        else fellBack = true;
      }
      if (fellBack) this.output(t, dim(`Forewright: the folder this session was started in (${origin?.cwd}) no longer exists, so the terminal opened in the project folder. ${agent.name} can only read here.`));
      // The same profile as the runs that made the session; never write access outside the agent's own worktree.
      const isCto = agent.role === "cto";
      const permission: PermissionProfile = isCto ? "coordinator" : fellBack || purpose === null || purpose === "chat" ? "read_only" : agent.permission;
      const scope: TokenScope = { kind: isCto ? "cto" : "chat" }; // a worker in a terminal cannot submit task work
      const token = rt.tokens.issue({ agentId: agent.id, runId: t.tokenRunId, generation: 0, scope, ttlMs: TOKEN_TTL_MS });
      const skills = skillsForRun(rt, agent, t.tokenRunId, permission, adapter);
      const mcpServers: McpServerSpec[] = [
        ...(adapter.capabilities.coordinationTools === "mcp"
          ? [{ name: "forewright", command: process.execPath, args: [rt.deps.bridgeEntry, "mcp-bridge"], env: { FOREWRIGHT_SOCKET: rt.deps.socketPath, FOREWRIGHT_AGENT_TOKEN: token } }]
          : []),
        ...skills.mcpServers,
      ];
      const systemPrompt = [terminalSystemPrompt(agent), skills.systemPromptSection].filter((x) => x !== "").join("\n\n");
      t.command = adapter.interactive!({
        cwd,
        ...(sessionId ? { resumeSessionId: sessionId } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        permission,
        mcpServers,
        systemPrompt,
      });
      const pty = await backend.spawn({ bin: t.command.bin, args: t.command.args, cwd, env: t.command.env, cols: size.cols, rows: size.rows });
      t.pty = pty;
      pty.onData((d) => this.output(t, d));
      pty.onExit((e) => this.onExit(t, e));
    } catch (err) {
      this.terminals.delete(terminalId);
      t.command?.cleanup();
      if (!rt.closed) {
        rt.tokens.revokeForRun(t.tokenRunId);
        rt.scheduler.wake("terminal_failed");
      }
      markReady();
      throw err;
    }
    markReady();
    rt.store.recordEvent("terminal.attached", "agent", agent.id, HUMAN, { terminalId, joined: false, engine: agent.engine, sessionId: t.info.sessionId, backend: backend.name });
    rt.publish();
    rt.emitRuntime();
    return { terminal: { ...t.info }, replay: t.replay.join("") };
  }

  private get(terminalId: string): Terminal {
    const t = this.terminals.get(terminalId);
    if (!t) throw new NotFoundError("That terminal", { terminalId });
    return t;
  }

  private live(terminalId: string, viewer: TerminalViewer): Terminal & { pty: PtyProcess } {
    const t = this.get(terminalId);
    if (!t.viewers.has(viewer)) throw new ValidationError("Attach to that terminal first.", { terminalId });
    if (t.closing || t.info.exited || !t.pty) throw new ValidationError("That terminal has ended.", { terminalId });
    return t as Terminal & { pty: PtyProcess };
  }

  input(terminalId: string, data: string, viewer: TerminalViewer): void {
    this.live(terminalId, viewer).pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number, viewer: TerminalViewer): void {
    const size = checkSize(cols, rows);
    const t = this.live(terminalId, viewer);
    t.info.cols = size.cols;
    t.info.rows = size.rows;
    t.pty.resize(size.cols, size.rows);
  }

  /** This viewer stops watching. The last one leaving ends the CLI. Detaching twice, or from a closed terminal, is fine. */
  async detach(terminalId: string, viewer: TerminalViewer): Promise<void> {
    const t = this.terminals.get(terminalId);
    if (!t || !t.viewers.delete(viewer)) return;
    if (!this.rt.closed) {
      this.rt.store.recordEvent("terminal.detached", "agent", t.info.agentId, HUMAN, { terminalId, viewers: t.viewers.size });
      this.rt.publish();
    }
    if (t.viewers.size === 0) {
      await t.ready;
      if (t.viewers.size === 0) await this.close(t); // nobody joined while it was still starting
    }
  }

  /** Ends every terminal (service shutdown). */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.terminals.values()].map(async (t) => {
        await t.ready;
        if (this.terminals.get(t.info.terminalId) === t) await this.close(t);
      }),
    );
  }

  // ------------------------------------------------------------ output and ending

  private output(t: Terminal, data: string): void {
    t.replay.push(data);
    t.replayLength += data.length;
    while (t.replayLength > TERMINAL_REPLAY_BYTES && t.replay.length > 1) t.replayLength -= t.replay.shift()!.length;
    if (t.replayLength > TERMINAL_REPLAY_BYTES) {
      t.replay[0] = t.replay[0]!.slice(-TERMINAL_REPLAY_BYTES);
      t.replayLength = t.replay[0].length;
    }
    t.pending += data;
    t.timer ??= setTimeout(() => this.flush(t), TERMINAL_FLUSH_MS);
  }

  private flush(t: Terminal): void {
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    if (t.pending === "") return;
    const data = t.pending;
    t.pending = "";
    for (const v of t.viewers) v.notify("terminal", { terminalId: t.info.terminalId, data });
  }

  private sendExit(t: Terminal): void {
    if (t.exitSent) return;
    t.exitSent = true;
    this.flush(t);
    const exited = t.info.exited ?? { code: null, signal: null };
    for (const v of t.viewers) v.notify("terminal", { terminalId: t.info.terminalId, exited });
  }

  private onExit(t: Terminal, e: { code: number | null; signal: string | null }): void {
    t.info.exited = e;
    if (t.closing) return; // ended by Forewright (last viewer left, shutdown): not an exit of its own
    this.sendExit(t);
    if (!this.rt.closed) this.rt.store.recordEvent("terminal.exited", "agent", t.info.agentId, SYSTEM, { terminalId: t.info.terminalId, code: e.code, signal: e.signal });
    void this.close(t).catch((err: unknown) => this.rt.reportInternalError(`closing terminal ${t.info.terminalId}`, err));
  }

  private close(t: Terminal): Promise<void> {
    t.closing ??= (async () => {
      const rt = this.rt;
      try {
        if (t.pty) await t.pty.kill();
      } finally {
        this.sendExit(t);
        t.viewers.clear();
        t.command?.cleanup();
        this.terminals.delete(t.info.terminalId);
        if (!rt.closed) {
          rt.tokens.revokeForRun(t.tokenRunId);
          rt.publish();
          rt.emitRuntime();
          rt.scheduler.wake("terminal_closed"); // the agent's pending messages and ready tasks can run now
        }
      }
    })();
    return t.closing;
  }
}

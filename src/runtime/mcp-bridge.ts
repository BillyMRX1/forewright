// `dept mcp-bridge`: a hand-written stdio MCP server that forwards tool calls
// to the daemon with the run's scoped token. Only JSON-RPC goes to stdout;
// diagnostics go to stderr.
import net from "node:net";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CALL_TIMEOUT_MS = 120_000;

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

class BridgeError extends Error {}

/** One request/response exchange with the daemon: connect, agent.hello, method, close. */
export function daemonRequest(socketPath: string, token: string, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    let stage: "hello" | "call" = "hello";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new BridgeError("The dept service did not answer in time."));
    }, CALL_TIMEOUT_MS);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent.hello", params: { token } })}\n`));
    socket.on("error", (err) => finish(() => reject(new BridgeError(`Cannot reach the dept service at ${socketPath}: ${err.message}`))));
    socket.on("close", () => {
      clearTimeout(timer);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim() === "") continue;
        const msg = JSON.parse(line) as { error?: { message?: string; data?: { plain?: string } }; result?: unknown };
        if (msg.error) {
          finish(() => reject(new BridgeError(msg.error?.data?.plain ?? msg.error?.message ?? "The dept service refused the request.")));
          return;
        }
        if (stage === "hello") {
          stage = "call";
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method, params })}\n`);
        } else {
          finish(() => resolve(msg.result));
          return;
        }
      }
    });
  });
}

export interface BridgeIO {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
}

export function runBridge(io: BridgeIO): Promise<void> {
  const socketPath = io.env["DEPT_SOCKET"];
  const token = io.env["DEPT_AGENT_TOKEN"];
  if (!socketPath || !token) {
    io.stderr.write("dept mcp-bridge: DEPT_SOCKET and DEPT_AGENT_TOKEN must be set.\n");
    return Promise.reject(new BridgeError("DEPT_SOCKET and DEPT_AGENT_TOKEN must be set."));
  }
  const send = (obj: unknown) => io.stdout.write(`${JSON.stringify(obj)}\n`);
  const reply = (id: Rpc["id"], result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: Rpc["id"], code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

  const handle = async (msg: Rpc): Promise<void> => {
    const id = msg.id;
    if (id === undefined || id === null) return; // notifications (initialized, cancelled) need no reply
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.["protocolVersion"];
        const version = typeof asked === "string" && SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
        reply(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "dept", version: "0.1.0" } });
        return;
      }
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        try {
          reply(id, await daemonRequest(socketPath, token, "agent.tools.list", {}));
        } catch (err) {
          io.stderr.write(`dept mcp-bridge: tools/list failed: ${String(err)}\n`);
          reply(id, { tools: [] });
        }
        return;
      case "tools/call":
        try {
          const result = await daemonRequest(socketPath, token, "agent.tools.call", { name: msg.params?.["name"], arguments: msg.params?.["arguments"] ?? {} });
          reply(id, result);
        } catch (err) {
          // The model needs a plain reason it can adapt to, not a protocol error.
          const text = err instanceof Error ? err.message : String(err);
          io.stderr.write(`dept mcp-bridge: tools/call failed: ${text}\n`);
          reply(id, { content: [{ type: "text", text }], isError: true });
        }
        return;
      default:
        fail(id, -32601, `Method not found: ${String(msg.method)}`);
    }
  };

  return new Promise((resolve) => {
    let buffer = "";
    const pending = new Set<Promise<void>>();
    io.stdin.setEncoding?.("utf8");
    io.stdin.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim() === "") continue;
        let msg: Rpc;
        try {
          msg = JSON.parse(line) as Rpc;
        } catch {
          fail(null, -32700, "Parse error");
          continue;
        }
        const p = handle(msg).catch((err: unknown) => {
          io.stderr.write(`dept mcp-bridge: internal error: ${String(err)}\n`);
          if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, "Internal error");
        });
        pending.add(p);
        void p.finally(() => pending.delete(p));
      }
    });
    io.stdin.on("end", () => {
      void Promise.all(pending).then(() => resolve());
    });
  });
}

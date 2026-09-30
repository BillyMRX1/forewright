import { ForewrightError } from "../core/errors.js";

export class GitError extends ForewrightError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("git_failed", message, details);
  }
}

/** The project folder cannot host isolated workspaces (not a git repo, no commits, worktree missing). */
export class WorkspaceError extends ForewrightError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("workspace", message, details);
  }
}

export class ProviderUnavailableError extends ForewrightError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("provider_unavailable", message, details);
  }
}

export class RpcError extends ForewrightError {
  readonly rpcCode: number;
  constructor(rpcCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.rpcCode = rpcCode;
  }
}

export class DaemonLockError extends ForewrightError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("daemon_lock", message, details);
  }
}

export class ToolError extends ForewrightError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("tool_error", message, details);
  }
}

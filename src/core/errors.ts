// Every failure the core raises is a DeptError with a stable code, a plain
// language message, and technical specifics in `details`.

export class DeptError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class NotFoundError extends DeptError {
  constructor(what: string, details?: Record<string, unknown>) {
    super("not_found", `${what} was not found.`, details);
  }
}

export class InvalidTransitionError extends DeptError {
  constructor(from: string, to: string, details?: Record<string, unknown>) {
    super("invalid_transition", `A task cannot move from ${from} to ${to}.`, { from, to, ...details });
  }
}

export class DependencyCycleError extends DeptError {
  constructor(path: string[]) {
    super("dependency_cycle", `These tasks depend on each other in a loop: ${path.join(" -> ")}.`, { path });
  }
}

export class LeaseConflictError extends DeptError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("lease_conflict", message, details);
  }
}

export class StaleGenerationError extends DeptError {
  constructor(taskId: string, given: number, current: number) {
    super("stale_generation", "This result came from an older attempt at the task and was rejected.", {
      taskId,
      given,
      current,
    });
  }
}

export class PolicyDeniedError extends DeptError {
  constructor(reason: string, details?: Record<string, unknown>) {
    super("policy_denied", reason, details);
  }
}

export class StaleApprovalError extends DeptError {
  constructor(reason: string, details?: Record<string, unknown>) {
    super("stale_approval", reason, details);
  }
}

export class DuplicateProjectIdError extends DeptError {
  constructor(projectId: string, knownPath: string, otherPath: string) {
    super(
      "duplicate_project_id",
      `Two folders carry the same project marker (${knownPath} and ${otherPath}). One looks like a copy; remove or re-initialize the marker in the copy.`,
      { projectId, knownPath, otherPath },
    );
  }
}

export class ValidationError extends DeptError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation", message, details);
  }
}

export class MigrationError extends DeptError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("migration", message, details);
  }
}

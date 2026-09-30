// Provider-layer errors. Kept local to src/providers so this module does not
// depend on src/core; they carry context so failures are debuggable.

export class ProviderError extends Error {
  readonly context: Record<string, unknown>;
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.context = context;
  }
}

export class SpawnError extends ProviderError {}
export class TerminationError extends ProviderError {}
export class EnvPolicyError extends ProviderError {}
export class IsolationError extends ProviderError {}
export class BinaryNotFoundError extends ProviderError {}

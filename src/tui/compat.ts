// hasCommits read defensively from results that may not carry it (projects.open has no such field).

/** `hasCommits` from a service result (state.settings or projects.open), or undefined when the service does not say. */
export function hasCommitsOf(result: unknown): boolean | undefined {
  if (typeof result === "object" && result !== null && "hasCommits" in result) {
    const v = (result as { hasCommits: unknown }).hasCommits;
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

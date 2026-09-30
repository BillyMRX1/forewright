import { DependencyCycleError } from "./errors.js";

/** Returns a cycle as a closed path (first node repeated at the end), or null. */
export function findCycle(edges: ReadonlyMap<string, readonly string[]>): string[] | null {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (n: string): string[] | null => {
    color.set(n, GREY);
    stack.push(n);
    for (const next of edges.get(n) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GREY) return [...stack.slice(stack.indexOf(next)), next];
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(n, BLACK);
    return null;
  };

  for (const n of edges.keys()) {
    if ((color.get(n) ?? WHITE) === WHITE) {
      const found = visit(n);
      if (found) return found;
    }
  }
  return null;
}

/** `startAt`, when it is on the cycle, becomes the first node of the reported path. */
export function assertAcyclic(edges: ReadonlyMap<string, readonly string[]>, label: (id: string) => string, startAt?: string): void {
  let cycle = findCycle(edges);
  if (cycle && startAt !== undefined) {
    const i = cycle.indexOf(startAt);
    if (i > 0) {
      const ring = cycle.slice(0, -1);
      cycle = [...ring.slice(i), ...ring.slice(0, i), startAt];
    }
  }
  if (cycle) throw new DependencyCycleError(cycle.map(label));
}

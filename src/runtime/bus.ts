// Per-project event publisher. The runtime calls publishNew() after mutations;
// it reads event rows the bus has not published yet and hands them to
// subscribers and internal listeners. There is no polling loop.
import type { ForewrightEvent, Store } from "../core/store.js";

export type EventListener = (event: ForewrightEvent) => void;

export class EventBus {
  private last: number;
  private readonly listeners = new Set<EventListener>();

  constructor(private readonly store: Store) {
    const recent = store.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM event WHERE project_id = ?").get(store.projectId) as { m: number };
    this.last = recent.m;
  }

  get lastPublished(): number {
    return this.last;
  }

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Events with seq <= lastPublished that a reconnecting client has not seen. */
  replay(sinceSeq: number): ForewrightEvent[] {
    const out: ForewrightEvent[] = [];
    let cursor = sinceSeq;
    while (cursor < this.last) {
      const batch = this.store.recentEvents(cursor, 500).filter((e) => e.seq <= this.last);
      if (batch.length === 0) break;
      out.push(...batch);
      cursor = batch[batch.length - 1]!.seq;
    }
    return out;
  }

  publishNew(): ForewrightEvent[] {
    const fresh: ForewrightEvent[] = [];
    for (;;) {
      const batch = this.store.recentEvents(this.last, 500);
      if (batch.length === 0) break;
      fresh.push(...batch);
      this.last = batch[batch.length - 1]!.seq;
    }
    for (const ev of fresh) {
      for (const l of this.listeners) l(ev);
    }
    return fresh;
  }
}

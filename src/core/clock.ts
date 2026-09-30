export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests; time only moves when told to. */
export class TestClock implements Clock {
  private ms: number;
  constructor(start: Date | string = "2026-01-01T00:00:00.000Z") {
    this.ms = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

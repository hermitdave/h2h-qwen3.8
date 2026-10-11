/**
 * Deterministic clock abstraction.
 *
 * Production runs with `SystemClock` (wall clock). Tests and
 * load/throughput scenarios inject a `FakeClock` so that time, timestamps,
 * and "execution-time" eligibility are fully deterministic. The scheduler
 * never calls `Date.now()` directly — it always asks the clock — which makes
 * the time-sensitive parts of the system unit-testable and replayable.
 */
export interface Clock {
  /** Current time in Unix epoch milliseconds. */
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * A controllable clock used in tests and load generation. `advance(ms)` moves
 * the simulated time forward, which can "unlock" tasks whose `executeAt` was
 * in the future. `freeze(ms)` sets an absolute simulated time.
 */
export class FakeClock implements Clock {
  private t: number;

  constructor(start: number = 1000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  /** Advance simulated time by `ms` (may be negative). Returns the new time. */
  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }

  /** Set simulated time to an absolute value. Returns the new time. */
  freeze(ms: number): number {
    this.t = ms;
    return this.t;
  }
}

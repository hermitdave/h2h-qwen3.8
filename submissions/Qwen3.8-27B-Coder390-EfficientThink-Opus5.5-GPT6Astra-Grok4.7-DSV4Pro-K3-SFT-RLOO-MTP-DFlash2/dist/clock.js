"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FakeClock = exports.SystemClock = void 0;
class SystemClock {
    now() {
        return Date.now();
    }
}
exports.SystemClock = SystemClock;
/**
 * A controllable clock used in tests and load generation. `advance(ms)` moves
 * the simulated time forward, which can "unlock" tasks whose `executeAt` was
 * in the future. `freeze(ms)` sets an absolute simulated time.
 */
class FakeClock {
    t;
    constructor(start = 1000) {
        this.t = start;
    }
    now() {
        return this.t;
    }
    /** Advance simulated time by `ms` (may be negative). Returns the new time. */
    advance(ms) {
        this.t += ms;
        return this.t;
    }
    /** Set simulated time to an absolute value. Returns the new time. */
    freeze(ms) {
        this.t = ms;
        return this.t;
    }
}
exports.FakeClock = FakeClock;
//# sourceMappingURL=clock.js.map
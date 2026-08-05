/**
 * The one place the runner is allowed to read the time or arm a timer.
 *
 * The runner enforces two different ceilings — a per-check one and a budget for the whole run —
 * and until this seam existed it measured them with two different clocks. `Date.now()` reads the
 * system wall clock; `setTimeout` fires off the event loop's own monotonic timer. A timer armed
 * for the exact remaining budget can therefore come due at a `Date.now()` reading that has not yet
 * crossed the deadline it was sized against, and the runner then starts the next check inside a
 * budget the run has really already spent.
 *
 * In production that costs one doomed check on a night the harness was already out of time. In
 * `tests/reconciliation-harness.test.ts` it was a flake: the test asserts that the check behind an
 * exhausted budget is reported as unanswered, and under machine load it saw that check run and
 * report `holds` instead.
 *
 * Routing both readings through one injected object lets a test drive a run on a clock it advances
 * by hand, so the budget rule is asserted rather than raced. Production pays nothing for it — the
 * default below is the same wall clock and the same timer the runner already used.
 */

/** The handle returned when a timer is armed. `cancel` must be safe to call more than once. */
export type ReconciliationTimer = {
  cancel: () => void;
};

export type ReconciliationClock = {
  /** Milliseconds on this clock's timeline. The system clock reports epoch milliseconds. */
  now: () => number;
  /** Arms `onDue` to run once, `delayMs` further along this clock's timeline. */
  setTimeout: (onDue: () => void, delayMs: number) => ReconciliationTimer;
};

/** The production clock: real wall time, real timers. What every caller gets unless it says otherwise. */
export const systemClock: ReconciliationClock = {
  now: () => Date.now(),
  setTimeout: (onDue, delayMs) => {
    const handle = setTimeout(onDue, delayMs);
    return {
      cancel: () => {
        clearTimeout(handle);
      },
    };
  },
};

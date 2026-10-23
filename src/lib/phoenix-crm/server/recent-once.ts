/**
 * Run an idempotent side effect at most once per key within a freshness window — in process, per web
 * replica, with concurrent callers on one key sharing a single run.
 *
 * WHY (2026-10-23, every page change under 1 second). Opening the monthly planner or a week's plan
 * minted the territory's carried-over customers (`phoenix_crm_ensure_reference_customers`) on EVERY
 * open, and the customer read waited on it: one whole database hop in front of the page, on a mint
 * that finds nothing new on all but the first open after an iReports360 change. Now a key minted
 * successfully inside the window answers at once, so the reads start without it.
 *
 * The rules this holds, pinned by tests/phoenix-crm-reference-mint-throttle.test.ts:
 *   • no stamp, or an expired one → the work runs, and the caller waits on it exactly as before;
 *   • a stamp inside the window → an already-settled promise, the work does not run;
 *   • a run in flight → the caller joins it rather than starting a second one;
 *   • only a run that SUCCEEDED stamps — a failure is never remembered as done, so the next call runs;
 *   • `stamp` records a run made elsewhere (the List's own unthrottled mint), `forget` drops a key so
 *     an app write that changes what the work would find is seen on the next open;
 *   • bounded: past `maxKeys` the oldest stamp goes first, which only ever means one extra run.
 *
 * Holds no database client of its own, so it loads under the plain-Node test runner.
 */

export type RecentOnce = {
  /** Run `work` for `key` unless it succeeded inside the window; concurrent callers share one run. */
  run(key: string, work: () => Promise<unknown>): Promise<void>;
  /**
   * Record that the work for `key` has just succeeded (a run made outside `run`). Pass the
   * `generation()` read when that run STARTED: a `forget` since then means it may have read the world
   * from before the write, and the stamp is not taken.
   */
  stamp(key: string, startedAt?: number): void;
  /** A counter `forget` moves on; read it before starting a run you will `stamp` yourself. */
  generation(): number;
  /** Drop every key `matches` accepts, so the next `run` for it does the work again. */
  forget(matches: (key: string) => boolean): void;
  /** Whether `key` holds a stamp inside the window right now. */
  isFresh(key: string): boolean;
  /** Test-only: drop every stamp and in-flight run. */
  reset(): void;
};

export function createRecentOnce(options: { freshMs: number; maxKeys: number; now?: () => number }): RecentOnce {
  const { freshMs, maxKeys } = options;
  const now = options.now ?? Date.now;
  // Insertion order is stamp order: `stamp` re-inserts, so the first key is always the oldest.
  const stamps = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();
  let forgets = 0;

  function isFresh(key: string): boolean {
    const stampedAt = stamps.get(key);
    if (stampedAt === undefined) return false;
    if (now() - stampedAt < freshMs) return true;
    stamps.delete(key);
    return false;
  }

  function stamp(key: string, startedAt?: number): void {
    if (startedAt !== undefined && startedAt !== forgets) return;
    stamps.delete(key);
    stamps.set(key, now());
    while (stamps.size > maxKeys) {
      const oldest = stamps.keys().next().value;
      if (oldest === undefined) break;
      stamps.delete(oldest);
    }
  }

  function run(key: string, work: () => Promise<unknown>): Promise<void> {
    if (isFresh(key)) return Promise.resolve();
    const joined = inFlight.get(key);
    if (joined) return joined;
    const startedAt = forgets;
    let started: Promise<unknown>;
    try {
      started = work();
    } catch (error) {
      started = Promise.reject(error);
    }
    // A `forget` that lands while this run is in flight means its success is not stamped: the run may
    // have read the world from before the write that caused the forget.
    const pending = started.then(() => {
      stamp(key, startedAt);
    });
    inFlight.set(key, pending);
    const settle = () => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    };
    pending.then(settle, settle);
    return pending;
  }

  function forget(matches: (key: string) => boolean): void {
    forgets += 1;
    for (const key of [...stamps.keys()]) if (matches(key)) stamps.delete(key);
    for (const key of [...inFlight.keys()]) if (matches(key)) inFlight.delete(key);
  }

  function reset(): void {
    stamps.clear();
    inFlight.clear();
    forgets = 0;
  }

  return { run, stamp, generation: () => forgets, forget, isFresh, reset };
}

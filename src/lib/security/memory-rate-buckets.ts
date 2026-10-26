/**
 * A FIXED-WINDOW COUNTER HELD IN THIS PROCESS, WITH A HARD CAP ON HOW MANY KEYS IT KEEPS
 * (audit, 2026-10-26, points 21, 22 and 23).
 *
 * Two shapes went wrong before this existed. The API limiter's in-process fallback was a plain Map
 * that only ever grew, so a caller rotating its key could grow it for as long as the process lived.
 * The page-timing beacon capped its own Map, but answered a FULL map by refusing every caller, so
 * 5,000 rotating addresses switched the beacon off for everybody until the next restart.
 *
 * Here a full map makes room instead: windows that have already ended go first, then the oldest
 * window still running. Keys are kept in the order their window started (a new window re-inserts its
 * key at the back), so "oldest" is the front of the Map and eviction never scans the whole thing.
 * Evicting a live window forgets that key's count, which is the price of a bounded map: a key that
 * is evicted starts again from one, so the cap trades a little precision under a flood for never
 * locking anyone out and never growing.
 *
 * Deliberately dependency-free, so the unit tests import it directly.
 */

export type MemoryRateBuckets = {
  /**
   * Counts one hit for `key`. Answers 0 when the hit is allowed, or the whole seconds to wait
   * (at least 1) when `key` has already had `limit` hits in its current window.
   */
  consume(key: string, limit: number, windowMs: number, now?: number): number;
  /** How many keys are held right now — never more than the cap. */
  readonly size: number;
};

export function createMemoryRateBuckets(maxKeys: number): MemoryRateBuckets {
  const cap = Math.max(1, Math.floor(maxKeys));
  const buckets = new Map<string, { count: number; resetAt: number }>();

  function makeRoom(now: number) {
    // Ended windows first, from the front, stopping at the first one still running.
    for (const [key, bucket] of buckets) {
      if (buckets.size < cap || bucket.resetAt > now) break;
      buckets.delete(key);
    }
    // Then the oldest running window, so a full map evicts rather than refusing.
    while (buckets.size >= cap) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
  }

  return {
    consume(key, limit, windowMs, now = Date.now()) {
      const existing = buckets.get(key);
      if (existing && existing.resetAt > now) {
        if (existing.count >= limit) return Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
        existing.count += 1;
        return 0;
      }
      if (existing) buckets.delete(key);
      if (buckets.size >= cap) makeRoom(now);
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return 0;
    },
    get size() {
      return buckets.size;
    },
  };
}

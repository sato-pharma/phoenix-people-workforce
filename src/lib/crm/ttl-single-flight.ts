/**
 * A short-TTL memo that is also SINGLE-FLIGHT: callers that arrive while a value is being computed
 * share that one computation instead of each starting their own.
 *
 * WHY. CRM Master's two whole-mirror scans (the double-visit triples and the vacation periods) were
 * memoised by storing the VALUE after it resolved. Until the first computation finished the cache was
 * empty, so a page render that fans out — or two managers opening the tab in the same second — each
 * ran the full multi-page scan in parallel, the exact load the memo exists to prevent. Storing the
 * PROMISE closes that window.
 *
 * The rules, each pinned by `tests/crm-ttl-single-flight.test.ts`:
 *   - an entry still in flight (`at === null`) is always shared;
 *   - a finished entry is served while `now() - at < ttlMs`, and recomputed from `ttlMs` on — the
 *     TTL runs from COMPLETION, as the value memo it replaces measured it;
 *   - a computation that REJECTS is never cached: every caller sharing it sees the rejection, the
 *     entry is removed (only if it is still the same entry — a newer one is left alone), and the
 *     next call computes afresh;
 *   - the map is bounded: reaching `max` clears it before a new entry goes in.
 *
 * `now` is injectable so the test can drive the clock.
 */

export type SingleFlightEntry<T> = { at: number | null; promise: Promise<T> };

export function memoInFlight<T>(
  cache: Map<string, SingleFlightEntry<T>>,
  key: string,
  ttlMs: number,
  max: number,
  compute: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const existing = cache.get(key);
  if (existing !== undefined && (existing.at === null || now() - existing.at < ttlMs)) return existing.promise;

  // Bounded: distinct keys are few in practice, but never let this grow without limit.
  if (cache.size >= max) cache.clear();

  // The entry exists before its promise so the settle callbacks can compare against it; the
  // placeholder is replaced on the next line, before anything can read it.
  const entry: SingleFlightEntry<T> = { at: null, promise: undefined as unknown as Promise<T> };
  // An async wrapper turns a compute that throws SYNCHRONOUSLY into a rejection, so it takes the same
  // not-cached path as one that rejects later.
  entry.promise = (async () => compute())().then(
    (value) => {
      entry.at = now();
      return value;
    },
    (error: unknown) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    },
  );
  cache.set(key, entry);
  return entry.promise;
}

/**
 * Collapse concurrent calls into ONE run of `load`.
 *
 * While a run is in flight, every further call gets that same promise instead of starting its own.
 * The moment it settles — resolved OR rejected — the slot clears, so the next call starts a fresh
 * run. It holds nothing after settling, which makes it a stampede guard and never a cache: it cannot
 * serve a stale value, and a failure is never remembered past the callers that were already waiting
 * on it.
 *
 * Why it exists: `unstable_cache` does not dedupe a MISS. When its entry is absent or expired, every
 * caller that arrives before the first one has written the entry runs the callback itself — so a
 * list that resolves one cached read per row turns one expiry into one database read per row. The
 * same shape as `inFlight` in auth/module-locks.ts and `inFlightDirectory` in employee-directory.ts,
 * lifted out so it can be tested without a database.
 *
 * `load` is invoked synchronously on the first call, and a synchronous throw becomes a rejection of
 * the shared promise rather than escaping to whichever caller happened to arrive first.
 */
export function singleFlight<T>(load: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = new Promise<T>((resolve) => resolve(load())).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

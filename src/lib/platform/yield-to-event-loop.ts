/**
 * Let the event loop run before the next stretch of synchronous work.
 *
 * The web process answers every page and every button on ONE thread. An `await` on a value that is
 * already there (a cache hit, a promise that settled earlier) resumes as a microtask, and microtasks
 * run back to back without the event loop ever reaching I/O — so several requests whose heavy work
 * follows a cache hit run as one unbroken block, and everyone else waits for all of them.
 *
 * 🔴 WHY (12 Nov 2026, 14:33 Cairo, read from production's logs on 14 Nov): nine Medical Reps opened
 * Weekly Stock within six seconds. The weekly rows were already in the in-process cache, so each
 * rep's build — re-price, de-cumulate and narrow 66,526 rows — followed with no real wait, and the
 * nine ran end to end: the server froze for 3.1 s, and every page in flight (Weekly Sales, Source of
 * Sales, the CRM plan) finished in the same millisecond as the nine, after 3 to 10.6 s.
 *
 * `setImmediate` queues the rest of the work behind the I/O that is ready, so a slow build is paused
 * between its heavy steps instead of holding the thread through all of them. It changes no result.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

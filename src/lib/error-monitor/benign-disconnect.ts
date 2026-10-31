/**
 * Did the CLIENT hang up, or did WE fail? — the ONE implementation.
 *
 * `instrumentation.ts`'s `onRequestError` sits under every route handler and server component, so
 * it sees aborted requests as well as real faults. An aborted request is not a defect: the browser
 * navigated away, closed the tab, or cancelled a prefetch, and the half-written response died with
 * it. Recording those as errors does not merely add rows — it buries the real ones, which is the
 * only reason the error table is read at all.
 *
 * The code-based half of this has been here since the beginning (ECONNRESET and friends). The
 * MESSAGE-based half was added on 2026-09-09 after Next 16.3.3 landed, and it is the interesting
 * one, because that upgrade turned a previously silent abort into a thrown Error carrying NO
 * `code` at all — so the existing filter could not see it and every one went to the table.
 *
 * Measured on production that morning: zero such rows in the preceding 13 days, then 15 in the
 * first eight hours of the new build, against a platform baseline of roughly 3 to 7 events A DAY
 * across everything. Fourteen were the hourly synthetic-journeys smoke test, whose Playwright page
 * close cancels the admin sidebar's own link prefetches. Nobody was broken; the monitor was simply
 * on its way to being unreadable.
 *
 * WHY THE MATCH IS EXACT AND NOT A SUBSTRING. These strings are Next's own, and a loose
 * `includes("closed")` would also swallow "Connection closed." — which this repo has seen as a
 * REAL Supabase failure, not an abort. A filter that hides a genuine fault is strictly worse than
 * the noise it removes, so the set is exact, small, and every addition has to earn its place by
 * being provably client-initiated.
 *
 * ZERO IMPORTS, DELIBERATELY — same rule as describe-thrown.ts, and for the same reason:
 * `instrumentation.ts` is bundled for the Edge Runtime as well as Node, so everything reachable
 * from it must be edge-safe. Do not add an import to this file.
 */

/**
 * Benign client-initiated disconnect codes. The server is not at fault for any of them.
 */
const BENIGN_DISCONNECT_CODES = new Set(["ECONNRESET", "ECONNABORTED", "EPIPE"]);

/**
 * Exact messages Next.js throws when the receiving stream went away mid-render.
 *
 * "The destination stream closed early." is Next 16.3.3's wording for an aborted RSC/page render.
 * "Aborted" and "The user aborted a request." are the undici/fetch spellings of the same event,
 * included because the same upgrade moves streaming failures between these layers and a filter
 * that only knows one of them regrows the problem on the next bump.
 *
 * "Fetch is aborted" is WebKit's wording for a fetch its own page cancelled. Safari on iOS 16 also
 * raises that cancelled read as an unhandled rejection, and the browser reporter filed it as a crash:
 * 108 rows from two reps in 30 days, every stack the Phoenix CRM screen's own abort() as it closed
 * (System Audit, 31 Oct 2026). It is listed here so the audit drops the rows an old tab still sends.
 */
const BENIGN_DISCONNECT_MESSAGES = new Set([
  "Aborted",
  "Fetch is aborted",
  "The destination stream closed early.",
  "The user aborted a request.",
]);

/**
 * True when the throw represents the client going away rather than the application failing.
 *
 * Accepts `unknown` because that is what `onRequestError` is handed, and because not every throw
 * in this codebase is an Error (see describe-thrown.ts).
 */
export function isBenignClientDisconnect(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && BENIGN_DISCONNECT_CODES.has(code)) return true;

  // `name` is checked alongside the message because a fetch AbortError carries the identity in the
  // name and an implementation-defined string in the message.
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError") return true;

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && BENIGN_DISCONNECT_MESSAGES.has(message);
}

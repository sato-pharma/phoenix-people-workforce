/**
 * The last session bundle that led to an ACCEPTED session, kept for ten minutes so a slow database
 * does not throw a signed-in person off every page.
 *
 * Why this exists. On 18 Oct 2026 production timed out between 10:30 and 11:55 Cairo. At 10:57 the
 * Talent Acquisition seat opened Recruitment four times and each time met "Session verification is
 * temporarily unavailable" -- the check that runs before any page code. `phx_auth_session_bundle` is
 * the most-called function Phoenix has (about 2 a second), it has no cache, and when its one retry
 * also timed out the whole render threw. The employee directory already lives with this problem and
 * solves it the same way: a copy that may stand in for a load that FAILED, for a bounded time
 * (`mayServeStaleDirectory`, `src/lib/employees/employee-directory.ts`).
 *
 * The rules, each of which is pinned by `tests/session-bundle-cache.test.ts`:
 *   - LIVE IS ALWAYS TRIED FIRST. A copy is consulted only after the live call and its one retry both
 *     failed for an infrastructure reason; it is never a fast path, so a revocation is felt on the very
 *     next request that reaches the database.
 *   - ONLY AN ACCEPTED SESSION IS REMEMBERED. A live answer first forgets whatever was held for that
 *     session, and the bundle is stored again only after every check passed -- so a rejection can never
 *     be undone by an outage.
 *   - A COPY IS NOT A FRESH ANSWER. It goes through exactly the same checks as a live bundle (expiry,
 *     revocation, role, version, active, the employee lifecycle gate against TODAY'S date), and serving
 *     it never stores it again, so its age never resets and ten minutes is the most it can ever cover.
 *   - The exposure is stated and accepted (owner, 18 Oct 2026): someone whose access was removed could
 *     keep opening pages for up to ten minutes, and only while the live check is failing.
 *
 * Process-local, bounded, and held on `globalThis` so the page renderer and the route handlers -- which
 * Next may bundle separately -- see the same copy.
 */

export const SESSION_BUNDLE_STALE_MAX_AGE_MS = 10 * 60 * 1000;

/** More than the sessions one process will see in ten minutes; the oldest entry goes first. */
export const SESSION_BUNDLE_CACHE_MAX_ENTRIES = 500;

type Remembered = { data: Record<string, unknown>; storedAt: number };

const STORE_KEY = Symbol.for("phoenix.sessionBundleCache");

function store(): Map<string, Remembered> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Remembered> | undefined>;
  const existing = holder[STORE_KEY];
  if (existing) return existing;
  const created = new Map<string, Remembered>();
  holder[STORE_KEY] = created;
  return created;
}

export function sessionBundleCacheKey(input: { sid: string; loginId: string }): string {
  return `${input.sid}\u0000${input.loginId}`;
}

/**
 * The age rule on its own, so it can be tested without a clock. A copy stored in the FUTURE (a clock
 * step backwards) is refused, unlike the directory's rule: for a roster a skewed clock only risks an
 * old roster, for a login check it would stretch ten minutes into an unknown length.
 */
export function mayServeRememberedBundle(storedAt: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(storedAt) || !Number.isFinite(now)) return false;
  const ageMs = now - storedAt;
  return ageMs >= 0 && ageMs <= SESSION_BUNDLE_STALE_MAX_AGE_MS;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Stores the raw bundle of a session every check has just accepted. Anything that is not an object is ignored. */
export function rememberAcceptedBundle(key: string, data: unknown, now: number = Date.now()): void {
  const record = asRecord(data);
  if (!record) return;
  const entries = store();
  entries.delete(key); // re-inserting moves it to the newest end of the Map's order
  entries.set(key, { data: structuredClone(record), storedAt: now });
  while (entries.size > SESSION_BUNDLE_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/** The remembered bundle if it is young enough to stand in for a failed read, else null. An old entry is dropped. */
export function recallRememberedBundle(key: string, now: number = Date.now()): Record<string, unknown> | null {
  const entries = store();
  const entry = entries.get(key);
  if (!entry) return null;
  if (!mayServeRememberedBundle(entry.storedAt, now)) {
    entries.delete(key);
    return null;
  }
  // A copy, so nothing a caller does to the returned rows can reach the next outage's answer.
  return structuredClone(entry.data);
}

export function forgetRememberedBundle(key: string): void {
  store().delete(key);
}

/**
 * The bundle with its session row's expiry replaced by what the idle refresh just wrote. A copy kept
 * with the OLD idle expiry would be more pessimistic than the database and could reject, during an
 * outage, a session the database itself would still accept.
 */
export function withRefreshedSessionExpiry(
  data: unknown,
  refreshed: { idleExpiresAt: string; absoluteExpiresAt: string },
): unknown {
  const record = asRecord(data);
  const session = asRecord(record?.app_session);
  if (!record || !session) return data;
  return {
    ...record,
    app_session: {
      ...session,
      idle_expires_at: refreshed.idleExpiresAt,
      absolute_expires_at: refreshed.absoluteExpiresAt,
    },
  };
}

/** Test seams. */
export function clearSessionBundleCache(): void {
  store().clear();
}

export function sessionBundleCacheSize(): number {
  return store().size;
}

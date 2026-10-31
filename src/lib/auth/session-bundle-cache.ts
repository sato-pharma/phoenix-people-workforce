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
 *   - A COPY NEVER BINDS A CREDENTIAL AND NEVER AUTHORISES A WRITE. The passkey and password routes ask for
 *     `allowRecentCopy: false`, an API request that is not a GET or HEAD does the same (server.ts), and so
 *     does a server action (`pageRequestMayUseRecentCopy`), so what a copy can do is read pages and
 *     read-only API calls -- never leave lasting access behind.
 *   - A LOGOUT OR FORCED LOGOUT IN THIS PROCESS FORGETS THE COPY at once, and a read that began BEFORE that
 *     moment can no longer store itself afterwards (`forgetRememberedBundlesForSessions`), so a slow older
 *     answer cannot bring a revoked session back.
 *   - The exposure is stated and accepted (owner, 18 Oct 2026): someone whose access was removed by a
 *     change made elsewhere (a role change, a deactivation) could keep reading pages for up to ten
 *     minutes, and only while the live check is failing.
 *
 * Process-local, bounded, and held on `globalThis` so the page renderer and the route handlers -- which
 * Next may bundle separately -- see the same copy.
 *
 * ONE LIVE READ FOR REQUESTS THAT ARRIVE TOGETHER (31 Oct 2026, `shareLiveBundleRead` below). This is
 * not the copy and changes none of its rules. Opening a portal page makes the sidebar prefetch about
 * fifteen pages at once, down to their loading screens, and each prefetch renders the portal layout,
 * whose first line is this session check. Production, 31 Oct 14:51-15:00 Cairo: 861 bundle calls in
 * under nine minutes, 18% of every Supabase request, and about a quarter of them started while the same
 * person's previous check was still running. A read-only request that arrives while a LIVE read for the
 * same session is in flight now waits for that read instead of starting its own:
 *   - IT IS ONLY EVER A LIVE ANSWER IN FLIGHT. Nothing is kept once the read settles; the next request
 *     after it starts a new one. A read is joined only while it is under SESSION_BUNDLE_JOIN_MAX_AGE_MS
 *     old, so the oldest answer a request can receive began at most one second before it arrived.
 *   - ONLY A READ-ONLY REQUEST SHARES. The callers pass `shareLiveRead` from the same two tests that
 *     decide the copy -- a GET or HEAD API call, a page render that is not a server action -- so a
 *     write, a heartbeat, a passkey or a password change always runs its own read.
 *   - EVERY CHECK STILL RUNS PER REQUEST, on its own deep copy of the rows: expiry, revocation, role,
 *     version, active and the lifecycle gate are decided against each request's own signed token.
 *   - A LOGOUT OR FORCED LOGOUT IN THIS PROCESS ENDS THE SHARING at once
 *     (`forgetRememberedBundlesForSessions`): a request that arrives after it starts a fresh read.
 */

export const SESSION_BUNDLE_STALE_MAX_AGE_MS = 10 * 60 * 1000;

/** More than the sessions one process will see in ten minutes; the oldest entry goes first. */
export const SESSION_BUNDLE_CACHE_MAX_ENTRIES = 500;

type Remembered = { data: Record<string, unknown>; storedAt: number };

/** The oldest live read a request may still join -- longer than any healthy read, far shorter than a timeout and its retry. */
export const SESSION_BUNDLE_JOIN_MAX_AGE_MS = 1_000;

type LiveRead = { promise: Promise<unknown>; startedAt: number };

const STORE_KEY = Symbol.for("phoenix.sessionBundleCache");
const BARRIER_KEY = Symbol.for("phoenix.sessionBundleCacheBarrier");
const LIVE_READS_KEY = Symbol.for("phoenix.sessionBundleLiveReads");

function store(): Map<string, Remembered> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Remembered> | undefined>;
  const existing = holder[STORE_KEY];
  if (existing) return existing;
  const created = new Map<string, Remembered>();
  holder[STORE_KEY] = created;
  return created;
}

/**
 * Per session id: the start time of the newest read that has already been answered live (or the moment
 * a revocation was made here). A read that STARTED earlier may not store its bundle afterwards -- it is a
 * picture taken before the answer we already have.
 */
function barriers(): Map<string, number> {
  const holder = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  const existing = holder[BARRIER_KEY];
  if (existing) return existing;
  const created = new Map<string, number>();
  holder[BARRIER_KEY] = created;
  return created;
}

function liveReads(): Map<string, LiveRead> {
  const holder = globalThis as unknown as Record<symbol, Map<string, LiveRead> | undefined>;
  const existing = holder[LIVE_READS_KEY];
  if (existing) return existing;
  const created = new Map<string, LiveRead>();
  holder[LIVE_READS_KEY] = created;
  return created;
}

function sessionIdOf(key: string): string {
  const cut = key.indexOf("\u0000");
  return cut < 0 ? key : key.slice(0, cut);
}

function raiseBarrier(sessionId: string, observedAt: number): void {
  if (!Number.isFinite(observedAt)) return;
  const map = barriers();
  const current = map.get(sessionId);
  map.delete(sessionId); // re-inserting moves it to the newest end of the Map's order
  map.set(sessionId, current === undefined ? observedAt : Math.max(current, observedAt));
  while (map.size > SESSION_BUNDLE_CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

export function sessionBundleCacheKey(input: { sid: string; loginId: string }): string {
  return `${input.sid}\u0000${input.loginId}`;
}

/**
 * The page-side twin of the API rule (a copy only for a GET or HEAD). A server action is a POST to a
 * PAGE, so it reaches resolveAccessContextFromPage and never the API resolver. Next marks one with the
 * `next-action` header; a form submitted before the page's JavaScript loaded carries no such header but
 * does carry a body. A page render -- a navigation, an RSC fetch, a prefetch -- carries neither, so
 * either one means the request can write, and it never runs on a copy.
 */
export function pageRequestMayUseRecentCopy(headerStore: Pick<Headers, "get">): boolean {
  return !headerStore.get("next-action") && !headerStore.get("content-type");
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

/**
 * Stores the raw bundle of a session every check has just accepted. Anything that is not an object is
 * ignored, and so is a bundle whose READ began before a newer live answer or a revocation for the same
 * session (`readStartedAt`, which defaults to `now` for a caller that has no slow read to speak of).
 */
export function rememberAcceptedBundle(
  key: string,
  data: unknown,
  now: number = Date.now(),
  readStartedAt: number = now,
): void {
  const record = asRecord(data);
  if (!record) return;
  const barrier = barriers().get(sessionIdOf(key));
  if (barrier !== undefined && barrier > readStartedAt) return;
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

/**
 * Drops the copy. `observedAt` is the START of the read whose live answer replaced it: any read that began
 * earlier is stale from now on and may not store itself. Left out, nothing but the copy is dropped.
 */
export function forgetRememberedBundle(key: string, observedAt?: number): void {
  store().delete(key);
  if (observedAt !== undefined) raiseBarrier(sessionIdOf(key), observedAt);
}

/**
 * Runs `read` -- the live session read with its one retry -- or, when a read for the same key began under
 * SESSION_BUNDLE_JOIN_MAX_AGE_MS ago and has not settled, waits for that one instead. `startedAt` is when
 * the read that answered BEGAN, so the copy's barrier rules see the true age of the answer, and `joined`
 * says whether this caller shared another's read (the caller then works on its own deep copy). Nothing
 * outlives the read: the entry is removed the moment it settles, whatever the outcome.
 */
export async function shareLiveBundleRead<T>(
  key: string,
  read: () => Promise<T>,
  now: () => number = Date.now,
): Promise<{ value: T; startedAt: number; joined: boolean }> {
  const reads = liveReads();
  const running = reads.get(key);
  if (running && now() - running.startedAt <= SESSION_BUNDLE_JOIN_MAX_AGE_MS) {
    return { value: (await running.promise) as T, startedAt: running.startedAt, joined: true };
  }
  const startedAt = now();
  const promise = read();
  const entry: LiveRead = { promise, startedAt };
  reads.set(key, entry);
  try {
    return { value: await promise, startedAt, joined: false };
  } finally {
    // Only the read that is still registered is removed -- never a newer one for the same session.
    if (reads.get(key) === entry) reads.delete(key);
  }
}

/**
 * A session was revoked in THIS process (logout, forced logout): its copy goes now, a read that began
 * before this moment can no longer put it back, and a request arriving from now on starts its own live
 * read instead of joining one already running. Cheap -- at most 500 entries are ever held.
 */
export function forgetRememberedBundlesForSessions(sessionIds: ReadonlyArray<string>, now: number = Date.now()): void {
  const wanted = new Set(sessionIds.map((id) => String(id ?? "").trim()).filter(Boolean));
  if (wanted.size === 0) return;
  const entries = store();
  for (const key of [...entries.keys()]) {
    if (wanted.has(sessionIdOf(key))) entries.delete(key);
  }
  const reads = liveReads();
  for (const key of [...reads.keys()]) {
    if (wanted.has(sessionIdOf(key))) reads.delete(key);
  }
  for (const id of wanted) raiseBarrier(id, now);
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
  barriers().clear();
  liveReads().clear();
}

export function sessionBundleLiveReadCount(): number {
  return liveReads().size;
}

export function sessionBundleCacheSize(): number {
  return store().size;
}

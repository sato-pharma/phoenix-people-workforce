// NOTE (2026-08-09): `import "server-only"` belongs at the top of this file and CANNOT be added
// yet. It was tried and it fails the build, which is the tripwire working — this module is
// already reachable from the browser bundle graph:
//
//   src/lib/supabase/server.ts
//     <- src/lib/auth/permissions.ts          (imports getSupabaseAdmin for the matrix cache)
//       <- src/lib/employees/job-function.ts
//         <- src/lib/weekly-planning/plan-v1.ts
//           <- src/components/employee-portal/plans-workspace.tsx   ("use client")
//   ...and again via src/config/system-navigation.ts <- sidebar.tsx / topbar.tsx
//
// The SERVICE-ROLE KEY ITSELF DOES NOT LEAK: it is read inside getSupabaseAdmin() at call time,
// never at module scope, and SUPABASE_SERVICE_ROLE_KEY is not a NEXT_PUBLIC_ var, so the bundler
// replaces it with undefined in browser output and the function is never called there. What is
// wrong is the graph, not the key — and a graph like this is the precondition for the leak, not
// the leak.
//
// The fix is to split src/lib/auth/permissions.ts: the pure role/scope logic that client
// components legitimately need (canAccess tables, role lists, scopeForRole) into a client-safe
// module, leaving the DB-backed matrix cache here on the server. That is a focused refactor with
// its own blast radius, not a line to sneak into a security PR. Do it, then add the import.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getRequiredEnv, getOptionalEnv } from "@/lib/env";
import { logWarning } from "@/lib/observability/log";
import { scrubSentryPath } from "@/lib/observability/sentry-policy";
import { recordTiming } from "@/lib/observability/timings";
import { rowCapFinding, shouldNoteRowCap } from "@/lib/supabase/row-cap-watch";
import { requestActorHeaders, withActorHeaders } from "@/lib/supabase/request-actor";

const supabaseRequestTimeoutMs = 15000;

/**
 * PostgREST error codes that indicate a transient schema-cache failure.
 * PGRST002: PostgREST could not reach PostgreSQL to build/refresh its schema
 * cache. The message itself says "Retrying." — we honour that hint here.
 */
const RETRYABLE_PGRST_CODES = new Set(["PGRST002"]);
const PGRST_RETRY_DELAYS_MS = [200, 400, 800];

/**
 * Gateway statuses that mean the request never reached PostgREST at all. The hosted Supabase
 * endpoint sits behind Cloudflare, and when it stops answering the edge serves its OWN HTML error
 * page: 521 "Web server is down", 520 "unknown error", 525 "SSL handshake failed".
 *
 * WHY THIS EXISTS (2026-10-10). The retry below only ever fired on a PGRST002 body, and it looked
 * for that body behind a `content-type: application/json` check — so a Cloudflare page, which is
 * `text/html`, fell straight past the check to `break` and was handed to the caller as a hard
 * failure. A blip of a few hundred milliseconds therefore surfaced as a broken page.
 *
 * Measured the same day: 15 "Web server is down" and 6 "unknown error" pages on 10-07 across nine
 * unrelated routes, and 2 more plus an SSL handshake failure inside the 11:03–11:17 Cairo window,
 * while the Railway container sat at 1% of 24 vCPU and the database at 3 active connections — so
 * neither end was busy; the path between them was simply not answering.
 *
 * An edge page comes back FAST (the edge answers, it does not hang), so retrying it costs the
 * backoff and nothing more. A TIMEOUT is deliberately NOT retried here: it has already cost the
 * whole `supabaseRequestTimeoutMs`, and retrying would multiply the very freeze this exists to
 * remove (see the AbortError note in `fetchWithTimeout`).
 *
 * 🔴 520 AND 503 ARE DELIBERATELY ABSENT, AND ADDING THEM WOULD COMPOUND THE WAIT. postgrest-js
 * retries those two itself — `RETRYABLE_STATUS_CODES = [520, 503]` in its `executeWithRetry`, for
 * GET/HEAD/OPTIONS, 3 attempts at 1s/2s/4s. Our wrapper sits INSIDE that loop, so a status handled
 * in both places is retried 3 times here and then 3 times again outside, each of those re-entering
 * this wrapper: 16 attempts for one read. This set therefore holds only what the SDK leaves
 * unretried — and 521 and 525, the two production actually served, are exactly in that gap.
 */
const RETRYABLE_TRANSPORT_STATUSES = new Set([502, 504, 521, 522, 523, 524, 525, 526, 530]);

/**
 * Only a READ is retried on a gateway failure. A gateway 5xx carries NO evidence about whether the
 * request was applied before the edge dropped the answer, so retrying a write could apply it twice.
 * PGRST002 is the opposite case and keeps its existing all-method retry: it means PostgREST could
 * not reach Postgres, so nothing ran.
 */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

/** The HTTP method of a fetch call, however supabase-js phrased it. Defaults to GET, as fetch does. */
function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const fromInit = init?.method;
  if (typeof fromInit === "string" && fromInit.length > 0) return fromInit.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

/**
 * A database write carries the signed-in person of the request being served (./request-actor.ts), so
 * the history triggers name who changed the row whichever code path wrote it. Only a /rest/v1 write that
 * named no actor of its own takes it; reads, storage, auth and edge functions are sent untouched.
 */
async function withRequestActor(input: RequestInfo | URL, init: RequestInit | undefined): Promise<RequestInit | undefined> {
  if (typeof input !== "string" && !(input instanceof URL)) return init;
  return withActorHeaders(
    init,
    await requestActorHeaders({ method: init?.method, url: String(input), headers: init?.headers }),
  );
}

/**
 * Which call timed out, for the log only: the method and the SCRUBBED path (`/rest/v1/<table>`), never the query string,
 * which is where every filter value and id rides. Never throws; an unreadable input is simply described as unknown.
 */
function describeSupabaseCall(input: RequestInfo | URL, init: RequestInit | undefined): { method: string; path: string } {
  const method = requestMethod(input, init);
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return { method, path: scrubSentryPath(new URL(raw).pathname) };
  } catch {
    return { method, path: "unknown" };
  }
}

/**
 * Reports a read that came back cut at PostgREST's 1,000-row ceiling (see row-cap-watch.ts). Reads the
 * response headers only and logs the relation name, never a filter value. Never throws: a watch must
 * not be able to fail the read it is watching.
 */
function watchRowCap(input: RequestInfo | URL, init: RequestInit | undefined, response: Response): void {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const requestHeaders = new Headers(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
    const finding = rowCapFinding(
      { method: requestMethod(input, init), url, hasRange: requestHeaders.has("range") },
      { status: response.status, contentRange: response.headers.get("content-range") },
    );
    if (finding && shouldNoteRowCap(finding.table)) {
      logWarning("PostgREST read ended at the 1,000-row ceiling", {
        labels: { event: "supabase_row_ceiling" },
        context: { table: finding.table, returned: finding.returned, total: finding.total, proven: finding.proven },
      });
    }
  } catch {
    // Deliberately empty: see the docstring.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true when the parsed JSON body of a PostgREST response signals a
 * transient schema-cache error that is safe to retry.
 */
function isRetryablePostgrestError(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" && RETRYABLE_PGRST_CODES.has(code);
}

/**
 * Executes a single fetch attempt with its own AbortController-based timeout.
 * Throws a user-friendly error on abort; re-throws all other fetch errors.
 *
 * EVERY ATTEMPT IS TIMED, because until this existed nothing in Phoenix measured the one thing
 * that actually dominates a page: the round trip itself. The database's own view
 * (pg_stat_statements) said 5.0 ms mean per statement and 49 ms of execution per request, against
 * a 647 ms median page — so ~93% of a request was happening somewhere no number covered.
 *
 * The three buckets reach the once-a-minute process-health line (src/lib/observability/
 * process-health.ts), and each answers a question that was previously guesswork:
 *   supabase.fetch          count = round trips per minute; p50/p95 = what one costs
 *   supabase.fetch.failed   a transport error, as opposed to a slow answer
 *   supabase.fetch.timeout  an attempt that burned the whole 15s budget
 *
 * p50 against p95 on `supabase.fetch` is also the connection-reuse readout: a reused socket is
 * ~1 RTT, a fresh one ~3.2 RTT (measured 2026-10-10 — 70-82 ms reused vs 212-290 ms fresh, from
 * Egypt). A p95 near three times the p50 means sockets are being re-handshaken, which is what
 * the keep-alive dispatcher in instrumentation.ts is there to stop.
 */
async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  requestTimeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    recordTiming("supabase.fetch", Date.now() - startedAt);
    return response;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const isTimeout = error instanceof Error && error.name === "AbortError";
    recordTiming("supabase.fetch", elapsedMs);
    recordTiming(isTimeout ? "supabase.fetch.timeout" : "supabase.fetch.failed", elapsedMs);
    if (isTimeout) {
      // The MESSAGE is what every caller reads (`isSupabaseTimeout` in supabase/errors.ts
      // matches the words "timed out", and the heartbeat's 503 branch depends on it), so it is
      // kept exactly as it was.
      //
      // 🔴 THE NAME MUST STAY "AbortError", AND REWRITING IT COST UP TO A MINUTE PER HANG.
      // postgrest-js wraps every request in its own `executeWithRetry`, whose first guard is
      // `if (fetchError?.name === "AbortError") throw` — a deliberate refusal to retry a request
      // that already spent its whole budget. This line used to throw a plain `new Error(...)`,
      // whose name is "Error", so that guard missed and the SDK fell through to its NETWORK-error
      // path instead: 3 further attempts for a GET, each paying the full `requestTimeoutMs`, with
      // 1s/2s/4s of backoff between them. One stalled read therefore cost 4 × 15s + 7s ≈ 67
      // seconds — measured here on 2026-10-10 as four fetch attempts for a single
      // `.select()` — which is the page that "hangs" rather than merely being slow.
      //
      // A burst of these (11 timeouts across four routes inside ten seconds, 2026-10-17 12:00 Cairo) could not be attributed
      // afterwards: the error says only that a request timed out. This line names the table and says how old the process is,
      // so the next burst shows whether one table is slow or a fresh container is still warming. WARNING severity, so it
      // never writes an error row of its own.
      const call = describeSupabaseCall(input, init);
      logWarning("Supabase request timed out", {
        labels: { event: "supabase_timeout" },
        context: { ...call, elapsedMs, uptimeS: Math.round(process.uptime()) },
      });
      const timedOut = new Error("Supabase request timed out.");
      timedOut.name = "AbortError";
      throw timedOut;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function createSupabaseClient(apiKey: string, requestTimeoutMs = supabaseRequestTimeoutMs): SupabaseClient {
  return createClient(
    getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    apiKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        fetch: async (input, init) => {
          // A gateway failure is retried only for a read — see IDEMPOTENT_METHODS.
          const mayRetryTransport = IDEMPOTENT_METHODS.has(requestMethod(input, init));
          if (!mayRetryTransport) init = await withRequestActor(input, init);

          // First attempt — no delay.
          let response = await fetchWithTimeout(input, init, requestTimeoutMs);

          // Retry on transient PostgREST schema-cache errors (e.g. PGRST002).
          // We must clone before reading the body so the SDK can still consume
          // the response normally on a successful retry or on final failure.
          for (const delayMs of PGRST_RETRY_DELAYS_MS) {
            if (!response.ok) {
              // The request never reached PostgREST — Cloudflare answered for it. This is checked
              // BEFORE the JSON branch below, because an edge error page is text/html and so can
              // never satisfy it; that is exactly how a 521 used to escape every retry.
              if (mayRetryTransport && RETRYABLE_TRANSPORT_STATUSES.has(response.status)) {
                await sleep(delayMs);
                response = await fetchWithTimeout(input, init, requestTimeoutMs);
                continue;
              }

              // Only attempt to parse JSON error bodies (PostgREST always sends
              // application/json for errors; avoid consuming binary responses).
              const contentType = response.headers.get("content-type") ?? "";
              if (contentType.includes("application/json")) {
                const cloned = response.clone();
                let body: unknown;
                try {
                  body = await cloned.json();
                } catch {
                  break;
                }
                if (isRetryablePostgrestError(body)) {
                  await sleep(delayMs);
                  response = await fetchWithTimeout(input, init, requestTimeoutMs);
                  continue;
                }
              }
            }
            // Non-retryable response (success or a different error) — stop.
            break;
          }

          watchRowCap(input, init, response);
          return response;
        },
      },
    },
  );
}

// The admin client is a stateless REST (postgrest-js/fetch) wrapper keyed on the fixed
// service-role key — no per-caller session is ever set on it, so one instance can safely
// be shared across concurrent requests on the same Cloud Run instance. Memoizing it avoids
// reconstructing the client (and its auth/storage/functions sub-clients) on every one of
// the dozens of getSupabaseAdmin() calls a single request can make (e.g. the employee
// directory service). A custom requestTimeoutMs is deliberately rare (heavy admin-only
// reads) so that path still builds a fresh, uncached client.
//
// getSupabaseUserClient()/getSupabaseAuthBridgeClient() must NOT be memoized the same way:
// both are used specifically so a caller can hydrate a per-request session onto the
// returned client (see getSupabaseRlsClient() in rls-server.ts, which calls
// `.auth.setSession(...)`, and signInWithLoginId() in supabase-identity.ts, which calls
// `.auth.signInWithPassword(...)`). Sharing one instance across concurrent requests would
// let one user's session overwrite another's mid-flight — always construct those fresh.
//
// THE MEMO IS KEYED ON THE URL AND KEY IT WAS BUILT FROM, which the paragraph above always
// claimed ("keyed on the fixed service-role key") and did not do. In production neither value
// ever changes, so this is identical behaviour there; it matters in the test suite, where all
// 2,200 tests share ONE node process. A test that points the environment at a stand-in project,
// builds the client, then restores `process.env` in a `finally` could not undo the client: the
// memo already held the stand-in URL, so from that moment every getSupabaseAdmin() caller in
// the process talked to it. Measured 2026-10-06, after
// tests/phoenix-crm-refused-readings-board.test.ts set `https://example.supabase.co`: each
// canAccess() then spent a whole request abort failing against that host instead of throwing
// instantly on the absent key — 14.2s locally, ~7s on the runner — and because
// resolvePermissionMatrix() deliberately does NOT cache a failed load (fail-observable, see
// auth/permissions.ts), every call paid it again. Three permission-heavy tests downstream paid
// it ~36 times: the suite went from 145s to 419s on 4 October. Pinned by
// tests/supabase-admin-client-env-cache.test.ts.
let cachedAdminClient: SupabaseClient | null = null;
let cachedAdminClientFor: string | null = null;

/**
 * Admin client using service role key.
 * Bypasses RLS. Use ONLY for system jobs, background tasks, or admin-only logic.
 *
 * `requestTimeoutMs` overrides the default 15s per-request abort. Raise it only for
 * deliberately heavy admin reads (e.g. the company-wide Source-of-Sales aggregates) whose
 * server-side compute legitimately exceeds 15s; leave it at the default everywhere else.
 */
export function getSupabaseAdmin(options?: { requestTimeoutMs?: number }): SupabaseClient {
  if (options?.requestTimeoutMs) {
    return createSupabaseClient(getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"), options.requestTimeoutMs);
  }
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const url = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const builtFor = `${url}\u0000${serviceRoleKey}`;
  if (!cachedAdminClient || cachedAdminClientFor !== builtFor) {
    cachedAdminClient = createSupabaseClient(serviceRoleKey);
    cachedAdminClientFor = builtFor;
  }
  return cachedAdminClient;
}

/**
 * User-scoped client using the anonymous key.
 * Respects RLS. Use for client-facing operations where a user session might be present.
 *
 * Always constructs a fresh client — callers (e.g. getSupabaseRlsClient()) hydrate a
 * per-request session onto the result via `.auth.setSession(...)`, so this must never be
 * shared across concurrent requests.
 */
export function getSupabaseUserClient(): SupabaseClient {
  return createSupabaseClient(getRequiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"));
}

/**
 * Reads EVERY row from a set-returning RPC in a SINGLE function execution.
 *
 * These RPCs aggregate (GROUP BY) over large fact tables, so the function body is
 * expensive. Postgres CANNOT push a Range offset into a set-returning function, so the
 * old "page with .range() until a short page" loop re-ran the ENTIRE aggregation for
 * every 1000-row page — e.g. a 12.8k-row per-customer aggregate paged 13×, re-running a
 * ~7.7s aggregation each time (~100s total) and tripping statement timeouts under load.
 *
 * Instead we issue ONE unbounded request with an exact row count. PostgREST runs the
 * function once and streams every row. We only page if the deployment actually caps the
 * response (PostgREST `db-max-rows`): when the returned rows are fewer than the reported
 * total, we fetch the remainder with explicit ranges. So correctness is preserved under a
 * cap, while the common (uncapped) path is a single execution.
 *
 * Pass a stable `orderBy` (a unique key) so any fallback pages don't overlap or skip.
 */
// supabase-js reports network-level query failures (timeouts, aborts, DNS errors) as a
// plain { message, details, hint, code } object rather than a PostgrestError instance,
// so an `error instanceof Error` check downstream silently discards the real message and
// falls back to a generic one. Normalize before throwing so callers always get a real Error.
export function toQueryError(error: unknown): Error {
  if (error instanceof Error) return error;
  const shape = error as { code?: string; details?: string; hint?: string; message?: string } | null;
  const normalized = new Error(shape?.message || "Unknown Supabase query error");
  if (shape?.code) Object.assign(normalized, { code: shape.code });
  if (shape?.details) Object.assign(normalized, { details: shape.details });
  if (shape?.hint) Object.assign(normalized, { hint: shape.hint });
  return normalized;
}

export async function rpcAll<T = Record<string, unknown>>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  orderBy: string[],
): Promise<T[]> {
  let head = client.rpc(fn, args, { count: "exact" });
  for (const column of orderBy) head = head.order(column, { ascending: true });
  const first = await head;
  if (first.error) throw toQueryError(first.error);
  const rows = (first.data ?? []) as T[];
  const total = typeof first.count === "number" ? first.count : rows.length;
  // Uncapped: a single execution returned everything.
  if (rows.length >= total) return rows;

  // Capped by db-max-rows — page the remainder (each page re-runs the function, so this
  // path is only taken when a cap genuinely forces it).
  const all: T[] = [...rows];
  const pageSize = rows.length > 0 ? rows.length : 1000;
  for (let from = all.length; from < total; from += pageSize) {
    let page = client.rpc(fn, args).range(from, from + pageSize - 1);
    for (const column of orderBy) page = page.order(column, { ascending: true });
    const next = await page;
    if (next.error) throw toQueryError(next.error);
    const pageRows = (next.data ?? []) as T[];
    all.push(...pageRows);
    if (pageRows.length === 0) break;
  }
  return all;
}

/**
 * Server-only Auth bridge client. Prefer anon key, but allow service-role fallback
 * on previews where the public anon env was not configured. The service key never
 * leaves the server; the returned session is still a real user JWT.
 *
 * Always constructs a fresh client — callers (see signInWithLoginId() in
 * supabase-identity.ts) call `.auth.signInWithPassword(...)` on the result, so this must
 * never be shared/memoized across concurrent requests.
 */
export function getSupabaseAuthBridgeClient(): SupabaseClient {
  return createSupabaseClient(
    getOptionalEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY") ?? getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
}

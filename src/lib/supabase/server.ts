import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getRequiredEnv, getOptionalEnv } from "@/lib/env";

const supabaseRequestTimeoutMs = 15000;

/**
 * PostgREST error codes that indicate a transient schema-cache failure.
 * PGRST002: PostgREST could not reach PostgreSQL to build/refresh its schema
 * cache. The message itself says "Retrying." — we honour that hint here.
 */
const RETRYABLE_PGRST_CODES = new Set(["PGRST002"]);
const PGRST_RETRY_DELAYS_MS = [200, 400, 800];

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
 */
async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  requestTimeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Supabase request timed out.");
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
          // First attempt — no delay.
          let response = await fetchWithTimeout(input, init, requestTimeoutMs);

          // Retry on transient PostgREST schema-cache errors (e.g. PGRST002).
          // We must clone before reading the body so the SDK can still consume
          // the response normally on a successful retry or on final failure.
          for (const delayMs of PGRST_RETRY_DELAYS_MS) {
            if (!response.ok) {
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

          return response;
        },
      },
    },
  );
}

/**
 * Admin client using service role key.
 * Bypasses RLS. Use ONLY for system jobs, background tasks, or admin-only logic.
 *
 * `requestTimeoutMs` overrides the default 15s per-request abort. Raise it only for
 * deliberately heavy admin reads (e.g. the company-wide Source-of-Sales aggregates) whose
 * server-side compute legitimately exceeds 15s; leave it at the default everywhere else.
 */
export function getSupabaseAdmin(options?: { requestTimeoutMs?: number }): SupabaseClient {
  return createSupabaseClient(getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"), options?.requestTimeoutMs);
}

/**
 * User-scoped client using the anonymous key.
 * Respects RLS. Use for client-facing operations where a user session might be present.
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
 */
export function getSupabaseAuthBridgeClient(): SupabaseClient {
  return createSupabaseClient(
    getOptionalEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY") ?? getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
}

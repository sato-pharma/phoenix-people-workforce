import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseRequestTimeoutMs = 15000;

function getRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function createSupabaseClient(apiKey: string): SupabaseClient {
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
          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(),
            supabaseRequestTimeoutMs,
          );

          try {
            return await fetch(input, {
              ...init,
              signal: controller.signal,
            });
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              throw new Error("Supabase request timed out.");
            }

            throw error;
          } finally {
            clearTimeout(timeout);
          }
        },
      },
    },
  );
}

function getOptionalEnv(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value : null;
}

/**
 * Admin client using service role key.
 * Bypasses RLS. Use ONLY for system jobs, background tasks, or admin-only logic.
 */
export function getSupabaseAdmin(): SupabaseClient {
  return createSupabaseClient(getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
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
export async function rpcAll<T = Record<string, unknown>>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  orderBy: string[],
): Promise<T[]> {
  let head = client.rpc(fn, args, { count: "exact" });
  for (const column of orderBy) head = head.order(column, { ascending: true });
  const first = await head;
  if (first.error) throw first.error;
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
    if (next.error) throw next.error;
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

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
 * Reads EVERY row from a set-returning RPC, paging past PostgREST's max-rows cap (1000 on
 * this project). Pass a stable `orderBy` (a unique key) so the pages don't overlap or skip.
 * Without this, large RPCs (e.g. per-customer aggregates) silently truncate to 1000 rows.
 */
export async function rpcAll<T = Record<string, unknown>>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  orderBy: string[],
): Promise<T[]> {
  const pageSize = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    let query = client.rpc(fn, args).range(from, from + pageSize - 1);
    for (const column of orderBy) query = query.order(column, { ascending: true });
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < pageSize) break;
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

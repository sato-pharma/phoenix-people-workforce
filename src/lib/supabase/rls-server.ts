import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  phoenixSupabaseAccessTokenCookieName,
  phoenixSupabaseRefreshTokenCookieName,
} from "@/lib/auth/supabase-identity";
import { logInfo } from "@/lib/observability/log";
import { getSupabaseAdmin, getSupabaseUserClient } from "@/lib/supabase/server";

/**
 * Request-scoped user client hydrated from the Supabase auth cookies.
 * Throws when the Supabase user session is missing or invalid.
 */
export async function getSupabaseRlsClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const accessToken =
    cookieStore.get(phoenixSupabaseAccessTokenCookieName)?.value ?? null;
  const refreshToken =
    cookieStore.get(phoenixSupabaseRefreshTokenCookieName)?.value ?? null;

  if (!accessToken || !refreshToken) {
    throw new Error("Supabase user session is missing.");
  }

  const supabase = getSupabaseUserClient();
  const { data, error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  if (error || !data.session) {
    throw error ?? new Error("Supabase user session is invalid.");
  }

  return supabase;
}

/**
 * Best-effort request-scoped user client hydrated from the Supabase auth cookies.
 * Returns null when the Supabase user session is missing or invalid.
 */
export async function getSupabaseRlsClientIfAvailable(): Promise<SupabaseClient | null> {
  try {
    return await getSupabaseRlsClient();
  } catch {
    return null;
  }
}

const FALLBACK_LOG_INTERVAL_MS = 60_000;
const fallbackLastLoggedAt = new Map<string, number>();

/**
 * THE ONE DOOR for a payroll or outstation read that prefers row security (audit 2026-10-26, L10).
 *
 * Hands back the person's row-security client when their Supabase session is on the request, and
 * the service-role client otherwise. It does NOT fail closed, deliberately: a biometric or
 * skip-bridge sign-in carries no Supabase session, and refusing would lock those people out of
 * their own payslips and expense screens.
 *
 * What makes the fall-back safe is the reader, not this door: every reader behind it narrows its
 * rows to the viewer's resolved access filter TWICE — in the query, and again on the rows that come
 * back (`filterPayrollRowsByAccess`, `keepExpenseRowsInScope`) — so a regression in the query's
 * filter no longer hands a scoped viewer somebody else's rows on the service-role path.
 *
 * And it is never silent: `rls_fallback_to_admin` is logged with the reader's name, at most once
 * a minute per reader per process, so a fall-back storm is visible in the logs without flooding them.
 * `tests/rls-fallback-door.test.ts` refuses a second, hand-rolled `?? getSupabaseAdmin()`.
 */
export async function rowSecurityClientFor(reader: string): Promise<SupabaseClient> {
  const client = await getSupabaseRlsClientIfAvailable();
  if (client) return client;

  const now = Date.now();
  const last = fallbackLastLoggedAt.get(reader) ?? 0;
  if (now - last >= FALLBACK_LOG_INTERVAL_MS) {
    fallbackLastLoggedAt.set(reader, now);
    logInfo("rls_fallback_to_admin", { labels: { event: "rls_fallback_to_admin", reader } });
  }
  return getSupabaseAdmin();
}

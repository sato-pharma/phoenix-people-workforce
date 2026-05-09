import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  phoenixSupabaseAccessTokenCookieName,
  phoenixSupabaseRefreshTokenCookieName,
} from "@/lib/auth/supabase-identity";
import { getSupabaseUserClient } from "@/lib/supabase/server";

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

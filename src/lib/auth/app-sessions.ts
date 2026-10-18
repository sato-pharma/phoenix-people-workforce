import type { PhoenixRole } from "@/lib/auth/permissions";
import { forgetRememberedBundlesForSessions } from "@/lib/auth/session-bundle-cache";
import type { SessionPayload } from "@/lib/auth/session";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const defaultAbsoluteTimeoutSeconds = 12 * 60 * 60;

export const privilegedSupabaseBridgeRoles = new Set<PhoenixRole>([
  "Super Admin",
  "CEO",
  "Finance Manager",
  "SFE Manager",
  "National Sales Manager",
]);

export type AppSessionRow = {
  absolute_expires_at: string;
  created_at: string;
  hr_id: string | null;
  id: string;
  idle_expires_at: string;
  last_seen_at: string;
  login_id: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  role: string;
  session_version: number | null;
  supabase_session_available: boolean | null;
  supabase_session_required: boolean | null;
};

export type AppSessionRejectionReason =
  | "absolute_expired"
  | "idle_expired"
  | "login_id_mismatch"
  | "missing_app_session"
  | "revoked"
  | "role_changed"
  | "session_version_mismatch";

export type AppSessionValidationResult =
  | { ok: true; row: AppSessionRow }
  | { ok: false; reason: AppSessionRejectionReason; row?: AppSessionRow | null };

export function isSupabaseBridgeRequiredForRole(role: PhoenixRole) {
  return privilegedSupabaseBridgeRoles.has(role);
}

export function shouldBlockLoginWhenSupabaseBridgeUnavailable(role: PhoenixRole) {
  if (!isSupabaseBridgeRequiredForRole(role)) return false;
  // Strict enforcement is OPT-IN only. The Supabase auth bridge (GoTrue sign-in) is
  // best-effort on Cloud Run and currently fails there, so blocking privileged logins
  // when it is unavailable would lock out Super Admin/CEO/Finance/SFE/NSM. Login already
  // falls back to a fully-functional Phoenix-only session. A previous attempt gated this
  // on the production runtime, which locked those roles out (incident 2026-07-11) — do
  // NOT reintroduce that. Set PHOENIX_STRICT_SUPABASE_BRIDGE=true only once the bridge is
  // confirmed working in the target environment.
  return process.env.PHOENIX_STRICT_SUPABASE_BRIDGE === "true";
}

export function sessionAbsoluteTimeoutSecondsForRole(role: PhoenixRole) {
  void role;
  const configured = Number(process.env.PHOENIX_SESSION_ABSOLUTE_TIMEOUT_SECONDS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(15 * 60, Math.floor(configured));
  }

  return defaultAbsoluteTimeoutSeconds;
}

export function appSessionExpiryTimes(input: {
  absoluteTimeoutSeconds: number;
  idleTimeoutSeconds: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return {
    absoluteExpiresAt: new Date(now.getTime() + input.absoluteTimeoutSeconds * 1000).toISOString(),
    idleExpiresAt: new Date(now.getTime() + input.idleTimeoutSeconds * 1000).toISOString(),
    nowIso: now.toISOString(),
  };
}

export async function createAppSession(input: {
  absoluteTimeoutSeconds: number;
  hrId: string | null;
  idleTimeoutSeconds: number;
  ip: string | null;
  loginId: string;
  role: PhoenixRole;
  sessionId: string;
  sessionVersion: number;
  supabaseSessionAvailable: boolean;
  supabaseSessionRequired: boolean;
  userAgent: string | null;
}) {
  const { absoluteExpiresAt, idleExpiresAt, nowIso } = appSessionExpiryTimes({
    absoluteTimeoutSeconds: input.absoluteTimeoutSeconds,
    idleTimeoutSeconds: input.idleTimeoutSeconds,
  });

  const { error } = await getSupabaseAdmin()
    .from("app_sessions")
    .insert({
      absolute_expires_at: absoluteExpiresAt,
      created_at: nowIso,
      hr_id: input.hrId,
      id: input.sessionId,
      idle_expires_at: idleExpiresAt,
      ip: input.ip,
      last_seen_at: nowIso,
      login_id: input.loginId,
      role: input.role,
      session_version: input.sessionVersion,
      supabase_session_available: input.supabaseSessionAvailable,
      supabase_session_required: input.supabaseSessionRequired,
      user_agent: input.userAgent,
    });

  if (error) throw error;

  return {
    absoluteExpiresAt,
    idleExpiresAt,
  };
}

/**
 * The app_sessions columns the session rules need.
 *
 * `phx_auth_session_bundle` (supabase/migrations/20261010140000_phx_auth_session_bundle.sql)
 * selects this same list, so a column added here must be added there too — otherwise the
 * bundled row arrives without it and the rule reading it silently sees undefined.
 */
export const APP_SESSION_COLUMNS =
  "id,login_id,hr_id,role,session_version,created_at,last_seen_at,idle_expires_at,absolute_expires_at,revoked_at,revoked_reason,supabase_session_required,supabase_session_available";

/**
 * Every app_sessions rejection rule, applied to a row that has already been read.
 *
 * Split out of validateAppSession() so resolveSessionState() can apply the identical rules in
 * the identical order to the row that arrives inside the phx_auth_session_bundle RPC — the one
 * call that replaced the auth trio's three separate round trips. These rules must exist in
 * exactly ONE place; a second copy is what would let the two paths drift apart.
 */
export function evaluateAppSessionRow(
  row: AppSessionRow | null,
  payload: SessionPayload,
): AppSessionValidationResult {
  if (!row) return { ok: false, reason: "missing_app_session" };
  if (row.revoked_at) return { ok: false, reason: "revoked", row };
  if (row.login_id !== payload.loginId) return { ok: false, reason: "login_id_mismatch", row };
  if (row.role !== payload.role) return { ok: false, reason: "role_changed", row };
  if (Number(row.session_version ?? 1) !== payload.ver) {
    return { ok: false, reason: "session_version_mismatch", row };
  }

  const now = Date.now();
  if (new Date(row.absolute_expires_at).getTime() <= now) {
    return { ok: false, reason: "absolute_expired", row };
  }
  if (new Date(row.idle_expires_at).getTime() <= now) {
    return { ok: false, reason: "idle_expired", row };
  }

  return { ok: true, row };
}

/**
 * Reads the session row and applies the rules above.
 *
 * resolveSessionState() no longer calls this — it gets the same row from
 * phx_auth_session_bundle and calls evaluateAppSessionRow() directly, saving two round trips.
 * This stays the single-read entry point for every other caller.
 */
export async function validateAppSession(payload: SessionPayload): Promise<AppSessionValidationResult> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_sessions")
    .select(APP_SESSION_COLUMNS)
    .eq("id", payload.sid)
    .maybeSingle();

  if (error) throw error;
  return evaluateAppSessionRow((data as AppSessionRow | null) ?? null, payload);
}

export async function refreshAppSessionIdle(input: {
  idleTimeoutSeconds: number;
  sessionId: string;
}) {
  const now = new Date();
  const idleExpiresAt = new Date(now.getTime() + input.idleTimeoutSeconds * 1000).toISOString();
  const nowIso = now.toISOString();

  const { data, error } = await getSupabaseAdmin()
    .from("app_sessions")
    .update({
      idle_expires_at: idleExpiresAt,
      last_seen_at: nowIso,
    })
    .eq("id", input.sessionId)
    .is("revoked_at", null)
    .gt("absolute_expires_at", nowIso)
    .gt("idle_expires_at", nowIso)
    .select("idle_expires_at,absolute_expires_at")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as Pick<AppSessionRow, "absolute_expires_at" | "idle_expires_at">;
  return {
    absoluteExpiresAt: row.absolute_expires_at,
    idleExpiresAt: row.idle_expires_at,
  };
}

export async function updateAppSessionVersion(
  sessionId: string,
  newVersion: number,
): Promise<{ absoluteExpiresAt: string | null; updated: boolean }> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_sessions")
    .update({ session_version: newVersion })
    .eq("id", sessionId)
    .is("revoked_at", null)
    .select("absolute_expires_at")
    .maybeSingle();

  if (error) throw error;

  const row = data as { absolute_expires_at: string } | null;
  return { absoluteExpiresAt: row?.absolute_expires_at ?? null, updated: row !== null };
}

export async function revokeAppSession(sessionId: string | null | undefined, reason: string) {
  const normalizedSessionId = String(sessionId ?? "").trim();
  if (!normalizedSessionId) return;

  // Before the database is asked, so a logout during an outage still drops this process's copy of the
  // session (session-bundle-cache.ts): a revoked session must never be readable from memory afterwards.
  forgetRememberedBundlesForSessions([normalizedSessionId]);

  const { error } = await getSupabaseAdmin()
    .from("app_sessions")
    .update({
      revoked_at: new Date().toISOString(),
      revoked_reason: reason,
    })
    .eq("id", normalizedSessionId)
    .is("revoked_at", null);

  if (error) throw error;
}

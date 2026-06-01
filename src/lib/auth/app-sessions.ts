import type { PhoenixRole } from "@/lib/auth/permissions";
import type { SessionPayload } from "@/lib/auth/session";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const defaultAbsoluteTimeoutSeconds = 12 * 60 * 60;

export const privilegedSupabaseBridgeRoles = new Set<PhoenixRole>([
  "Super Admin",
  "CEO",
  "Finance Manager",
  "HR Specialist",
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

export async function validateAppSession(payload: SessionPayload): Promise<AppSessionValidationResult> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_sessions")
    .select(
      "id,login_id,hr_id,role,session_version,created_at,last_seen_at,idle_expires_at,absolute_expires_at,revoked_at,revoked_reason,supabase_session_required,supabase_session_available",
    )
    .eq("id", payload.sid)
    .maybeSingle();

  if (error) throw error;
  const row = (data as AppSessionRow | null) ?? null;
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

export async function revokeAppSession(sessionId: string | null | undefined, reason: string) {
  const normalizedSessionId = String(sessionId ?? "").trim();
  if (!normalizedSessionId) return;

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

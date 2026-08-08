
import { writeAuditLog } from "@/lib/admin/audit";
import { normalizeLoginId, resolveStoredLoginId } from "@/lib/auth/credentials";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const loginThrottleWindowMinutes = 15;
const loginThrottleMaxFailures = 10;
const loginIpThrottleMaxFailures = 15;
const loginLockoutMinutes = 30;

export function getRequestIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const [firstIp] = forwardedFor.split(",");
    const ip = firstIp?.trim();
    if (ip) return ip;
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  return realIp || null;
}

export async function writeAuthAudit(input: {
  actorLoginId?: string | null;
  entityId?: string | null;
  newValues?: Record<string, unknown> | null;
  oldValues?: Record<string, unknown> | null;
  summary: string;
}) {
  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: input.entityId ?? input.actorLoginId ?? null,
    entityType: "auth_session",
    newValues: input.newValues,
    oldValues: input.oldValues,
    summary: input.summary,
  });
}

export async function recordLoginAttempt(input: {
  ip: string | null;
  loginId: string;
  success: boolean;
}) {
  const supabase = getSupabaseAdmin();
  await supabase.from("auth_login_attempts").insert({
    attempted_at: new Date().toISOString(),
    ip: input.ip,
    login_id: input.loginId,
    success: input.success,
  });
}

type AppAuthSecurityRow = {
  failed_login_attempts?: number | null;
  last_failed_login_at?: string | null;
  locked_until?: string | null;
  login_id: string;
};

export async function registerFailedLoginAttempt(input: {
  ip: string | null;
  loginId: string;
}) {
  const attemptedIdentifier = normalizeLoginId(input.loginId);
  if (!attemptedIdentifier) return;
  const canonicalLoginId = await resolveStoredLoginId(attemptedIdentifier).catch(() => null);
  const loginId = canonicalLoginId ?? attemptedIdentifier;

  await recordLoginAttempt({
    ip: input.ip,
    loginId,
    success: false,
  }).catch((error: unknown) => {
    logError("recordLoginAttempt failed to record a failed login", { labels: { event: "record_login_attempt_failed", component: "auth", context: "recordLoginAttempt.failed" }, error });
  });

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("login_id, failed_login_attempts, last_failed_login_at, locked_until")
    .ilike("login_id", loginId)
    .maybeSingle();

  if (error || !data) {
    return;
  }

  const row = data as AppAuthSecurityRow;
  const now = new Date();
  const threshold = new Date(now.getTime() - loginThrottleWindowMinutes * 60 * 1000);
  const lastFailedAt = row.last_failed_login_at ? new Date(row.last_failed_login_at) : null;
  const currentFailures =
    lastFailedAt && lastFailedAt >= threshold
      ? Number(row.failed_login_attempts ?? 0)
      : 0;
  const nextFailures = currentFailures + 1;

  await supabase
    .from("app_auth_users")
    .update({
      failed_login_attempts: nextFailures,
      last_failed_login_at: now.toISOString(),
      locked_until:
        nextFailures >= loginThrottleMaxFailures
          ? new Date(now.getTime() + loginLockoutMinutes * 60 * 1000).toISOString()
          : row.locked_until ?? null,
    })
    .ilike("login_id", loginId);
}

export async function clearFailedLoginState(input: {
  ip: string | null;
  loginId: string;
}) {
  const attemptedIdentifier = normalizeLoginId(input.loginId);
  if (!attemptedIdentifier) return;
  const canonicalLoginId = await resolveStoredLoginId(attemptedIdentifier).catch(() => null);
  const loginId = canonicalLoginId ?? attemptedIdentifier;

  await recordLoginAttempt({
    ip: input.ip,
    loginId,
    success: true,
  }).catch((error: unknown) => {
    logError("recordLoginAttempt failed to record a successful login", { labels: { event: "record_login_attempt_failed", component: "auth", context: "recordLoginAttempt.success" }, error });
  });

  const supabase = getSupabaseAdmin();
  await supabase
    .from("app_auth_users")
    .update({
      failed_login_attempts: 0,
      last_failed_login_at: null,
      locked_until: null,
    })
    .ilike("login_id", loginId);
}

export async function isLoginRateLimited(loginId: string, ip: string | null) {
  const attemptedIdentifier = normalizeLoginId(loginId);
  if (!attemptedIdentifier) return false;
  const canonicalLoginId = await resolveStoredLoginId(attemptedIdentifier).catch(() => null);
  const rateLimitKey = canonicalLoginId ?? attemptedIdentifier;

  const supabase = getSupabaseAdmin();
  const threshold = new Date(Date.now() - loginThrottleWindowMinutes * 60 * 1000).toISOString();
  const [lockResult, loginAttemptsResult, ipAttemptsResult] = await Promise.all([
    supabase
      .from("app_auth_users")
      .select("locked_until")
      .ilike("login_id", rateLimitKey)
      .maybeSingle(),
    supabase
      .from("auth_login_attempts")
      .select("*", { count: "exact", head: true })
      .eq("login_id", rateLimitKey)
      .eq("success", false)
      .gte("attempted_at", threshold),
    ip
      ? supabase
          .from("auth_login_attempts")
          .select("*", { count: "exact", head: true })
          .eq("ip", ip)
          .eq("success", false)
          .gte("attempted_at", threshold)
      : Promise.resolve({ count: 0, error: null }),
  ]);

  const lockedUntil = (lockResult.data as { locked_until?: string | null } | null)?.locked_until ?? null;
  if (lockedUntil && new Date(lockedUntil).getTime() > Date.now()) {
    return true;
  }

  if (!loginAttemptsResult.error && (loginAttemptsResult.count ?? 0) >= loginThrottleMaxFailures) {
    return true;
  }

  if (!ipAttemptsResult.error && (ipAttemptsResult.count ?? 0) >= loginIpThrottleMaxFailures) {
    return true;
  }

  return false;
}


import { writeAuditLog } from "@/lib/admin/audit";
import { normalizeLoginId, resolveStoredLoginId } from "@/lib/auth/credentials";
import {
  loginIpFailureLimit,
  loginIpThrottleMaxFailures,
  loginLockoutMinutes,
  loginSharedNetworkLookbackHours,
  loginThrottleMaxFailures,
  loginThrottleWindowMinutes,
} from "@/lib/auth/login-throttle-policy";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { clientAddress } from "@/lib/security/client-address";

/** The address Railway's edge saw (client-address.ts) — the caller writes the left of X-Forwarded-For. */
export function getRequestIp(request: Request) {
  return clientAddress(request);
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

  // The network gate: strict for an unknown address, roomier for a shared office network that has
  // already let colleagues in (see login-throttle-policy.ts). The extra read only runs once the
  // strict limit is reached, so an ordinary sign-in costs nothing more.
  const ipFailures = ipAttemptsResult.error ? 0 : ipAttemptsResult.count ?? 0;
  if (ip && ipFailures >= loginIpThrottleMaxFailures) {
    const accountsSignedInFromIp = await countAccountsSignedInFromIp(ip);
    if (ipFailures >= loginIpFailureLimit(accountsSignedInFromIp)) {
      return true;
    }
  }

  return false;
}

// Different accounts that signed in SUCCESSFULLY from this address in the lookback — the evidence
// that it is a shared office network rather than one attacker. A failed read counts as zero, which
// keeps the strict limit: the extra room has to be earned, never assumed.
async function countAccountsSignedInFromIp(ip: string) {
  const since = new Date(Date.now() - loginSharedNetworkLookbackHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("auth_login_attempts")
    .select("login_id")
    .eq("ip", ip)
    .eq("success", true)
    .gte("attempted_at", since)
    .limit(1000);

  if (error) {
    logError("Could not count the accounts signed in from a throttled address (keeping the strict limit)", { labels: { event: "login_shared_network_lookup_failed", component: "auth", ip }, error });
    return 0;
  }

  const accounts = new Set<string>();
  for (const row of (data ?? []) as { login_id?: string | null }[]) {
    const key = normalizeLoginId(row.login_id).toUpperCase();
    if (key) accounts.add(key);
  }
  return accounts.size;
}

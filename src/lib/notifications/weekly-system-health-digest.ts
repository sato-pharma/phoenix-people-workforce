import { writeAuditLog } from "@/lib/admin/audit";
import {
  getLoginSecuritySignals,
  getWeeklyHealthSummary,
  type LoginSecuritySignals,
  type WeeklyHealthSummary,
} from "@/lib/error-monitor/service";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import { createSystemNotification, type SystemNotificationResult } from "@/lib/notifications/system";
import { resolveNotificationRoleRecipients } from "@/lib/notifications/role-recipients";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Weekly System Health digest — a once-a-week Telegram/in-app push of the /admin/system-issues
// headline numbers (top errors, new signatures, resolved vs active, failed-login hotspots) so
// nobody has to remember to open the tab. Piggybacks on the daily notifications cron and
// self-gates to one weekday, mirroring runTelegramDailyHrDigest's recipient + delivery pattern.

// Sunday (start of the Egyptian work week) in Africa/Cairo. 0=Sun … 6=Sat.
const DIGEST_WEEKDAY = 0;
const WINDOW_DAYS = 7;
const TOP_BRUTE_FORCE_IPS = 3;

const DAY_MAP: Record<string, number> = { Fri: 5, Mon: 1, Sat: 6, Sun: 0, Thu: 4, Tue: 2, Wed: 3 };

type HealthRecipient = { hrId: string; userId: string | null };

/** Weekday (0=Sun … 6=Sat) in Africa/Cairo — matches the cron's business timezone. */
function cairoWeekday(now: Date): number {
  const label =
    new Intl.DateTimeFormat("en-US", { timeZone: PHOENIX_BUSINESS_TIME_ZONE, weekday: "short" })
      .formatToParts(now)
      .find((p) => p.type === "weekday")?.value ?? "Sun";
  return DAY_MAP[label] ?? 0;
}

/** Cairo YYYY-MM-DD, used for the once-per-week idempotency key. */
function cairoDateKey(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  }).format(now);
  return parts; // en-CA already yields YYYY-MM-DD
}

function cairoDateLabel(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  }).format(now);
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

async function resolveHealthRecipients(): Promise<{ recipients: HealthRecipient[]; warnings: string[] }> {
  const warnings: string[] = [];
  const recipients: HealthRecipient[] = [];
  try {
    const roles = await resolveNotificationRoleRecipients("weekly_system_health_digest");
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id,hr_id,is_active")
      .in("role", roles)
      .eq("is_active", true);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ hr_id?: string | null; login_id?: string | null }>) {
      const hrId = cleanText(row.hr_id).toUpperCase();
      if (!hrId) continue;
      recipients.push({ hrId, userId: cleanText(row.login_id) || null });
    }
  } catch (error) {
    warnings.push(`Digest recipients unavailable: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 160));
  }
  return { recipients, warnings };
}

function routeLabel(route: string | null): string {
  return route && route.trim() ? route : "(global)";
}

export function buildWeeklyHealthDigestMessage(
  summary: WeeklyHealthSummary,
  security: LoginSecuritySignals,
  dateLabel: string,
): string {
  const lines: string[] = [];
  lines.push(`🩺 Weekly System Health — ${dateLabel}`);
  lines.push(`Last ${summary.windowDays} days`);
  lines.push("");

  lines.push(`Errors: ${summary.totalErrors} total across ${summary.distinctSignatures} type(s)`);
  lines.push(`✅ Resolved on live build: ${summary.resolvedSignatures}`);
  lines.push(`🔴 Still active: ${summary.activeSignatures}`);
  lines.push(`🆕 New error type(s) this week: ${summary.newSignatures}`);
  lines.push("");

  if (summary.topErrors.length === 0) {
    lines.push("Top errors: none captured this week 🎉");
  } else {
    lines.push("Top errors:");
    summary.topErrors.forEach((e, i) => {
      const badge = e.status === "active" ? "🔴 active" : "✅ resolved";
      lines.push(`${i + 1}. ${e.count}× ${e.label} ${routeLabel(e.route)} — ${badge}`);
    });
  }
  lines.push("");

  const bruteForce = security.bruteForceIps.slice(0, TOP_BRUTE_FORCE_IPS);
  const anySignal = bruteForce.length > 0 || security.lockedAccounts.length > 0 || security.blockedIps.length > 0;
  lines.push(`Login security (${security.windowDays}d):`);
  if (!anySignal) {
    lines.push("No suspicious login activity ✅");
  } else {
    lines.push(`🚩 Brute-force IPs: ${security.bruteForceIps.length}`);
    for (const ip of bruteForce) {
      const flags = [ip.credentialStuffing ? "credential-stuffing" : null, ip.blocked ? "⛔ blocked" : null]
        .filter(Boolean)
        .join(", ");
      lines.push(`   • ${ip.ip} — ${ip.failCount} fails / ${ip.distinctAccounts} account(s)${flags ? ` (${flags})` : ""}`);
    }
    lines.push(`🔒 Locked accounts now: ${security.lockedAccounts.length}`);
    lines.push(`⛔ Blocked IPs: ${security.blockedIps.length}`);
  }
  lines.push("");
  lines.push("Full dashboard → /admin/system-issues");

  return lines.join("\n");
}

export type WeeklyHealthDigestResult = {
  delivered: number;
  skipped: boolean;
  reason?: string;
  sourceWarnings: string[];
};

/**
 * Called unconditionally by the daily cron; self-gates so it only actually sends once a week
 * (Cairo Sunday). Pass `{ force: true }` to bypass the weekday gate for manual/testing runs.
 * Best-effort and non-throwing at the source-data layer (both getters return safe empties on
 * failure); the daily cron additionally wraps this in its own .catch().
 */
export async function runWeeklySystemHealthDigest(options?: { force?: boolean; now?: Date }): Promise<WeeklyHealthDigestResult> {
  const now = options?.now ?? new Date();
  if (!options?.force && cairoWeekday(now) !== DIGEST_WEEKDAY) {
    return { delivered: 0, reason: "not the weekly digest day", skipped: true, sourceWarnings: [] };
  }

  const dateKey = cairoDateKey(now);
  const [{ recipients, warnings }, summary, security] = await Promise.all([
    resolveHealthRecipients(),
    getWeeklyHealthSummary(WINDOW_DAYS),
    getLoginSecuritySignals(WINDOW_DAYS),
  ]);

  const message = buildWeeklyHealthDigestMessage(summary, security, cairoDateLabel(now));

  if (recipients.length === 0) {
    await writeAuditLog({
      actorLoginId: "daily-dispatcher",
      entityId: "telegram.weekly_system_health_digest",
      entityType: "notification",
      newValues: { failClosed: true, warnings },
      summary: "Weekly system health digest skipped — no Super Admin recipient resolved.",
    });
    return { delivered: 0, reason: "no recipients", skipped: true, sourceWarnings: warnings };
  }

  const priority = summary.activeSignatures > 0 || security.bruteForceIps.length > 0 ? "high" : "normal";
  const deliveries: Array<{ hrId: string; result: SystemNotificationResult }> = [];
  await Promise.all(
    recipients.map(async (recipient) => {
      const result = await createSystemNotification({
        actionUrl: "/admin/system-issues",
        actorId: "daily-dispatcher",
        channels: ["in_app", "telegram"],
        eventType: "weekly_system_health_digest",
        message,
        metadata: {
          activeSignatures: summary.activeSignatures,
          bruteForceIpCount: security.bruteForceIps.length,
          digestDate: dateKey,
          idempotencyKey: `weekly-system-health:${recipient.hrId}:${dateKey}`,
          lockedAccounts: security.lockedAccounts.length,
          newSignatures: summary.newSignatures,
          resolvedSignatures: summary.resolvedSignatures,
          safeSummaryOnly: true,
          sourceWarnings: warnings,
          totalErrors: summary.totalErrors,
        },
        module: "system",
        priority,
        recipientHrId: recipient.hrId,
        recipientUserId: recipient.userId,
        title: "Weekly System Health Digest",
      });
      deliveries.push({ hrId: recipient.hrId, result });
    }),
  );

  await writeAuditLog({
    actorLoginId: "daily-dispatcher",
    entityId: "telegram.weekly_system_health_digest",
    entityType: "notification",
    newValues: {
      activeSignatures: summary.activeSignatures,
      delivered: deliveries.length,
      newSignatures: summary.newSignatures,
      totalErrors: summary.totalErrors,
      warnings,
    },
    summary: "Weekly system health digest processed.",
  });

  return { delivered: deliveries.length, skipped: false, sourceWarnings: warnings };
}

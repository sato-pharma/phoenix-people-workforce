// Admin-editable "which roles receive this notification" resolver for the 12 cron-triggered
// system notifications that previously had zero admin control — hardcoded role arrays
// scattered across 10 domain files. Mirrors email.ts's defaultEmailNotificationPolicies
// fallback pattern, but with a STRONGER guarantee: resolveNotificationRoleRecipients() is
// called from inside 10+ existing cron functions that don't guard against a new failure mode,
// so it must never throw — any DB error (missing table, transient network issue, malformed
// row) silently falls back to the exact hardcoded default, reproducing today's behavior
// rather than newly breaking an unrelated daily notification.

import { phoenixRoles, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const notificationRoleKeys = [
  "holiday_confirmation_reminder",
  "vacation_sla_hr_escalation",
  "telegram_daily_hr_digest",
  "weekly_system_health_digest",
  "probation_weekly_dv_digest",
  "field_workforce_compliance_digest",
  "outstation_sla_reminder",
  "resignation_sla_reminder",
  "weekly_plans_drift_alert",
  "excuse_drift_alert",
  "ireports360_sync_notify",
  "attendance_ingestion_alert",
] as const;

export type NotificationRoleKey = (typeof notificationRoleKeys)[number];

export type NotificationRolePolicy = {
  key: NotificationRoleKey;
  label: string;
  description: string;
  roles: PhoenixRole[];
};

// Code-level source of truth for TODAY's production behavior — byte-exact to the 12 confirmed
// hardcoded arrays this feature replaces. Doubles as: (a) the fallback when the DB row is
// missing, (b) the seed data mirrored in the migration, (c) the regression-guard test's
// expected values. Keep all three in sync if a default ever changes.
export const DEFAULT_NOTIFICATION_ROLE_POLICIES: Record<NotificationRoleKey, NotificationRolePolicy> = {
  holiday_confirmation_reminder: {
    key: "holiday_confirmation_reminder",
    label: "Holiday confirmation reminder",
    description: "Reminds admins to confirm an upcoming national holiday's observed date before it publishes to calendars, plans, vacation, and attendance.",
    roles: ["Super Admin"],
  },
  vacation_sla_hr_escalation: {
    key: "vacation_sla_hr_escalation",
    label: "Vacation SLA — HR stage",
    description: "HR-stage recipients for overdue vacation requests. The manager-stage recipient is always the specific request's manager-of-manager and is not configurable here.",
    roles: ["Super Admin"],
  },
  telegram_daily_hr_digest: {
    key: "telegram_daily_hr_digest",
    label: "Telegram daily HR digest",
    description: "Daily Telegram + in-app HR operations digest.",
    // The pre-existing hardcoded array also listed "HR Manager" — that's a phoenixCompanyJobTitle,
    // not a real PhoenixRole, and zero live app_auth_users rows have that role value (verified via
    // direct query), so it has always silently matched nobody. Preserved here as the REAL effective
    // default, not the literal (partly-dead) string; the discrepancy is flagged separately.
    roles: ["Super Admin"],
  },
  weekly_system_health_digest: {
    key: "weekly_system_health_digest",
    label: "Weekly system health digest",
    description: "Once-a-week technical/security summary of the System Issues dashboard.",
    roles: ["Super Admin"],
  },
  probation_weekly_dv_digest: {
    key: "probation_weekly_dv_digest",
    label: "Probation weekly DV digest",
    description: "Weekly per-probationer Double-Visit broadcast list. The probationer's own manager, NSM chain, and line-matched PM/GPM are always included and are not configurable here.",
    // Same "HR Manager" job-title-not-a-role artifact as telegram_daily_hr_digest above — dropped
    // here too; the effective default has always been just these 4 roles.
    roles: ["CEO", "Super Admin", "SFE Manager", "Training Manager"],
  },
  field_workforce_compliance_digest: {
    key: "field_workforce_compliance_digest",
    label: "Field workforce compliance digest",
    description: "Proactive monthly HR/compliance digest, fires on the 1st of the month.",
    roles: ["Super Admin"],
  },
  outstation_sla_reminder: {
    key: "outstation_sla_reminder",
    label: "Outstation SLA reminder",
    description: "Reminds approvers of outstation expense requests pending more than 3 days.",
    roles: ["Super Admin", "Finance Manager", "CEO"],
  },
  resignation_sla_reminder: {
    key: "resignation_sla_reminder",
    label: "Resignation SLA reminder",
    description: "Reminds approvers of resignations pending a final decision for more than 5 days.",
    roles: ["Super Admin"],
  },
  weekly_plans_drift_alert: {
    key: "weekly_plans_drift_alert",
    label: "Weekly plans drift alert",
    description: "Data-integrity alert when the weekly planning drift-check finds anomalies.",
    // Same "HR Manager" job-title-not-a-role artifact — dropped, see telegram_daily_hr_digest above.
    roles: ["Super Admin"],
  },
  excuse_drift_alert: {
    key: "excuse_drift_alert",
    label: "Excuse drift alert",
    description: "Alert when excuse requests are stuck on a resigned or missing manager.",
    // Same artifact — dropped, see telegram_daily_hr_digest above.
    roles: ["Super Admin"],
  },
  ireports360_sync_notify: {
    key: "ireports360_sync_notify",
    label: "iReports360 sync notify",
    description: "Notifies after every iReports360 CRM sync/reconcile run, success or failure.",
    roles: ["Super Admin"],
  },
  attendance_ingestion_alert: {
    key: "attendance_ingestion_alert",
    label: "Attendance ingestion alert",
    description: "Alerts when the fingerprint attendance pipeline appears stalled. Fires from the 5-minute notification outbox processor, not the daily cron.",
    roles: ["Super Admin"],
  },
};

function sanitizeRoles(value: unknown): PhoenixRole[] | null {
  if (!Array.isArray(value)) return null;
  const roles = value.filter((role): role is PhoenixRole => (phoenixRoles as readonly string[]).includes(role));
  return roles.length > 0 || value.length === 0 ? roles : null; // every entry was garbage — treat as corrupt, not "intentionally empty"
}

export async function getNotificationRolePolicies(): Promise<NotificationRolePolicy[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_role_policies")
      .select("notification_key,label,description,roles");
    if (error) throw error;
    const rowsByKey = new Map((data ?? []).map((row) => [row.notification_key as string, row]));
    return notificationRoleKeys.map((key) => {
      const fallback = DEFAULT_NOTIFICATION_ROLE_POLICIES[key];
      const row = rowsByKey.get(key) as { label?: string; description?: string; roles?: unknown } | undefined;
      if (!row) return fallback;
      const sanitized = sanitizeRoles(row.roles);
      return {
        key,
        label: row.label ?? fallback.label,
        description: row.description ?? fallback.description,
        roles: sanitized ?? fallback.roles,
      };
    });
  } catch (error) {
    logError("Notification role policies read failed", {
      labels: { event: "notification_role_policies_read_failed" },
      error,
    });
    return notificationRoleKeys.map((key) => DEFAULT_NOTIFICATION_ROLE_POLICIES[key]);
  }
}

export async function resolveNotificationRoleRecipients(key: NotificationRoleKey): Promise<PhoenixRole[]> {
  const policies = await getNotificationRolePolicies();
  return policies.find((policy) => policy.key === key)?.roles ?? DEFAULT_NOTIFICATION_ROLE_POLICIES[key].roles;
}

export async function updateNotificationRolePolicy(
  key: NotificationRoleKey,
  roles: PhoenixRole[],
  actor: AccessContext,
): Promise<NotificationRolePolicy> {
  const before = await resolveNotificationRoleRecipients(key);
  const { data, error } = await getSupabaseAdmin()
    .from("notification_role_policies")
    .update({ roles, updated_at: new Date().toISOString(), updated_by: actor.hrId ?? actor.loginId ?? "system" })
    .eq("notification_key", key)
    .select("notification_key,label,description,roles")
    .single();
  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: actor.loginId ?? actor.hrId ?? null,
    entityId: key,
    entityType: "notification",
    newValues: { roles },
    oldValues: { roles: before },
    summary: `${actor.hrId ?? "admin"} changed recipients for notification "${key}".`,
  });

  const fallback = DEFAULT_NOTIFICATION_ROLE_POLICIES[key];
  return {
    key,
    label: data.label ?? fallback.label,
    description: data.description ?? fallback.description,
    roles: sanitizeRoles(data.roles) ?? roles,
  };
}

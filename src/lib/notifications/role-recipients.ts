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
  "marketing_sla_reminder",
] as const;

export type NotificationRoleKey = (typeof notificationRoleKeys)[number];

export type NotificationRolePolicy = {
  key: NotificationRoleKey;
  label: string;
  description: string;
  roles: PhoenixRole[];
  enabled: boolean;
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
    enabled: true,
  },
  vacation_sla_hr_escalation: {
    key: "vacation_sla_hr_escalation",
    label: "Vacation SLA — HR stage",
    description: "HR-stage recipients for overdue vacation requests. The manager-stage recipient is always the specific request's manager-of-manager and is not configurable here.",
    roles: ["Super Admin"],
    enabled: true,
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
    enabled: true,
  },
  weekly_system_health_digest: {
    key: "weekly_system_health_digest",
    label: "Weekly system health digest",
    description: "Once-a-week technical/security summary of the System Issues dashboard.",
    roles: ["Super Admin"],
    enabled: true,
  },
  probation_weekly_dv_digest: {
    key: "probation_weekly_dv_digest",
    label: "Probation weekly DV digest",
    description: "Weekly per-probationer Double-Visit broadcast list. The probationer's own manager, NSM chain, and line-matched PM/GPM are always included and are not configurable here.",
    // Same "HR Manager" job-title-not-a-role artifact as telegram_daily_hr_digest above — dropped
    // here too; the effective default has always been just these 4 roles.
    roles: ["CEO", "Super Admin", "SFE Manager", "Training Manager"],
    // Disabled 2026-07-22 at owner request (335437cc) — restored behind this real toggle.
    enabled: false,
  },
  field_workforce_compliance_digest: {
    key: "field_workforce_compliance_digest",
    label: "Field workforce compliance digest",
    description: "Proactive monthly HR/compliance digest, fires on the 1st of the month.",
    roles: ["Super Admin"],
    enabled: true,
  },
  outstation_sla_reminder: {
    key: "outstation_sla_reminder",
    label: "Outstation SLA reminder",
    description: "Reminds approvers of outstation expense requests pending more than 3 days.",
    roles: ["Super Admin", "Finance Manager", "CEO"],
    // Disabled 2026-07-22 at owner request (335437cc) — restored behind this real toggle.
    enabled: false,
  },
  resignation_sla_reminder: {
    key: "resignation_sla_reminder",
    label: "Resignation SLA reminder",
    description: "Reminds approvers of resignations pending a final decision for more than 5 days.",
    roles: ["Super Admin"],
    enabled: true,
  },
  weekly_plans_drift_alert: {
    key: "weekly_plans_drift_alert",
    label: "Weekly plans drift alert",
    description: "Data-integrity alert when the weekly planning drift-check finds anomalies.",
    // Same "HR Manager" job-title-not-a-role artifact — dropped, see telegram_daily_hr_digest above.
    roles: ["Super Admin"],
    enabled: true,
  },
  excuse_drift_alert: {
    key: "excuse_drift_alert",
    label: "Excuse drift alert",
    description: "Alert when excuse requests are stuck on a resigned or missing manager.",
    // Same artifact — dropped, see telegram_daily_hr_digest above.
    roles: ["Super Admin"],
    enabled: true,
  },
  ireports360_sync_notify: {
    key: "ireports360_sync_notify",
    label: "iReports360 sync notify",
    description: "Notifies after every iReports360 CRM sync/reconcile run, success or failure.",
    roles: ["Super Admin"],
    enabled: true,
  },
  attendance_ingestion_alert: {
    key: "attendance_ingestion_alert",
    label: "Attendance ingestion alert",
    description: "Alerts when the fingerprint attendance pipeline appears stalled. Fires from the 5-minute notification outbox processor, not the daily cron.",
    roles: ["Super Admin"],
    enabled: true,
  },
  marketing_sla_reminder: {
    key: "marketing_sla_reminder",
    label: "Marketing request SLA reminder",
    description: "Reminds the assigned approver and requester about overdue marketing request due dates, and escalates critical overdue requests. Recipients are always the specific request's assigned approver and requester — not role-configurable here; roles is intentionally always empty and this policy only carries the master on/off switch.",
    roles: [],
    // Disabled 2026-07-22 at owner request (335437cc) — restored behind this real toggle.
    enabled: false,
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
      .select("notification_key,label,description,roles,enabled");
    if (error) throw error;
    const rowsByKey = new Map((data ?? []).map((row) => [row.notification_key as string, row]));
    return notificationRoleKeys.map((key) => {
      const fallback = DEFAULT_NOTIFICATION_ROLE_POLICIES[key];
      const row = rowsByKey.get(key) as { label?: string; description?: string; roles?: unknown; enabled?: boolean | null } | undefined;
      if (!row) return fallback;
      const sanitized = sanitizeRoles(row.roles);
      return {
        key,
        label: row.label ?? fallback.label,
        description: row.description ?? fallback.description,
        roles: sanitized ?? fallback.roles,
        enabled: typeof row.enabled === "boolean" ? row.enabled : fallback.enabled,
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
  const policy = policies.find((p) => p.key === key) ?? DEFAULT_NOTIFICATION_ROLE_POLICIES[key];
  return policy.enabled ? policy.roles : [];
}

// Lets a digest function short-circuit BEFORE it scans any data, for the hybrid keys below
// whose recipient list always includes a mandatory recipient (manager-of-manager; DM/NSM/PM-GPM
// chain) regardless of `roles` — for those, an empty roles array alone would NOT achieve a true
// master-off, so callers must check this instead of (or in addition to) an empty roles array.
export async function resolveNotificationRoleEnabled(key: NotificationRoleKey): Promise<boolean> {
  const policies = await getNotificationRolePolicies();
  return policies.find((p) => p.key === key)?.enabled ?? DEFAULT_NOTIFICATION_ROLE_POLICIES[key].enabled;
}

export async function updateNotificationRolePolicy(
  key: NotificationRoleKey,
  input: { roles?: PhoenixRole[]; enabled?: boolean },
  actor: AccessContext,
): Promise<NotificationRolePolicy> {
  const policies = await getNotificationRolePolicies();
  const before = policies.find((p) => p.key === key) ?? DEFAULT_NOTIFICATION_ROLE_POLICIES[key];
  const roles = input.roles ?? before.roles;
  const enabled = input.enabled ?? before.enabled;

  const { data, error } = await getSupabaseAdmin()
    .from("notification_role_policies")
    .update({ roles, enabled, updated_at: new Date().toISOString(), updated_by: actor.hrId ?? actor.loginId ?? "system" })
    .eq("notification_key", key)
    .select("notification_key,label,description,roles,enabled")
    .single();
  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: actor.loginId ?? actor.hrId ?? null,
    entityId: key,
    entityType: "notification",
    newValues: { roles, enabled },
    oldValues: { roles: before.roles, enabled: before.enabled },
    summary: `${actor.hrId ?? "admin"} changed recipients for notification "${key}".`,
  });

  const fallback = DEFAULT_NOTIFICATION_ROLE_POLICIES[key];
  return {
    key,
    label: data.label ?? fallback.label,
    description: data.description ?? fallback.description,
    roles: sanitizeRoles(data.roles) ?? roles,
    enabled: typeof data.enabled === "boolean" ? data.enabled : enabled,
  };
}

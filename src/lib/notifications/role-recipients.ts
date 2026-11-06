// Admin-editable "which roles receive this notification" resolver for the 12 cron-triggered
// system notifications that previously had zero admin control — hardcoded role arrays
// scattered across 10 domain files. Mirrors email.ts's defaultEmailNotificationPolicies
// fallback pattern, but with a STRONGER guarantee: resolveNotificationRoleRecipients() is
// called from inside 10+ existing cron functions that don't guard against a new failure mode,
// so it must never throw — any DB error (missing table, transient network issue, malformed
// row) silently falls back to the exact hardcoded default, reproducing today's behavior
// rather than newly breaking an unrelated daily notification.

import { canonicalPersonHrId, sharedIdentityGroups } from "@/lib/auth/identity-aliases";
import { phoenixRoles, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { canonicalHrIdForDisplay, canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { logError, logWarning } from "@/lib/observability/log";
import { withVacantSeatStandIns } from "@/lib/notifications/vacant-seat";
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
  "attendance_ingestion_alert",
  "marketing_sla_reminder",
  "resignation_workflow_alert",
  "employee_import_alert",
  "payroll_workflow_alert",
  "marketing_invoice_overdue_alert",
  "distributor_upload_overdue_alert",
  "retention_risk_alert",
  // `crm_account_setup_alert` (the new-hire iReports360 account notice and its daily reminder) was
  // RETIRED 2026-11-07 with the vendor CRM — nobody can be given an iReports360 account any more.
  "new_hire_mailbox_alert",
  "service_milestone_notice",
  "activity_inactivity_digest",
  "accepted_offer_alert",
  "approval_whatsapp_reminder",
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
    // The key keeps its old name on purpose: a dozen technical alerts and saved admin settings use
    // it. The weekly digest it was named after retired with the System Issues page on 23 Oct 2026.
    label: "System health alerts",
    description: "System Audit daily message (new, newly shared or reopened issues) and urgent platform alarms — outbox drain, stranded job, database restart, AI credit.",
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
    // Finance Manager removed 2026-08-10 (owner: "exclude him 100% from outstation or expenses").
    // The reminder is disabled today, so this changes nothing live — but leaving him on the list
    // would silently email him about a module he can no longer open the moment it is switched on.
    roles: ["Super Admin", "CEO"],
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
  employee_import_alert: {
    key: "employee_import_alert",
    label: "Employee import alert",
    description:
      "Oversight audience for a completed employee import. The admin who ran the import is always notified in addition to these roles — they are told the outcome of their own action, so removing every role here does not silence them.",
    roles: ["Super Admin"],
    enabled: true,
  },
  resignation_workflow_alert: {
    key: "resignation_workflow_alert",
    label: "Resignation workflow alert",
    description:
      "Who is told when a resignation is submitted or changes state. Owner-set 2026-08-09 (the Talent Acquisition seat, retired 2026-08-28, now HR Generalist): Super Admin and HR Generalist, and since 2026-10-20 the HR Operations Specialist, who follows each resignation through until the leaver completes the cycle at the office. Deliberately NOT the CEO and NOT the leaver's manager chain. While the HR Generalist seat is empty its copy is the Super Admin's. Editable here rather than in code.",
    // "HR Administration" is the HR Operations Specialist seat (owner, 2026-10-20: once a resignation
    // is submitted she is told, and follows it up until the leaver comes to the office). The stored
    // notification_role_policies row WINS over this default, so the same change is in that seat's
    // migration — this line alone would change nothing in production.
    roles: ["Super Admin", "HR Operations", "HR Administration"],
    enabled: true,
  },
  attendance_ingestion_alert: {
    key: "attendance_ingestion_alert",
    label: "Attendance ingestion alert",
    description: "Alerts when the fingerprint attendance pipeline appears stalled. Fires from the 5-minute notification outbox processor, not the daily cron.",
    roles: ["Super Admin"],
    enabled: true,
  },
  payroll_workflow_alert: {
    key: "payroll_workflow_alert",
    label: "Payroll workflow alert",
    description:
      "Who is told when a payroll batch changes state (approve/reject/lock/etc.) or a salary upload is imported. Both are ops events about a batch, not a specific employee, so there is no subject to infer an audience from — recipients are exactly this role list.",
    roles: ["Super Admin", "CEO", "Finance Manager"],
    enabled: true,
  },
  marketing_invoice_overdue_alert: {
    key: "marketing_invoice_overdue_alert",
    label: "Marketing invoice overdue alert",
    description:
      "Who is told when an approved marketing request's invoice passes its deadline. The REQUESTER is always notified about their own request and is not configurable here — this list is the finance-side audience, defaulting to the Finance Manager, who holds the finance_execution rung on the marketing approval chain and is the person chasing the invoice.",
    roles: ["Finance Manager"],
    enabled: true,
  },
  distributor_upload_overdue_alert: {
    key: "distributor_upload_overdue_alert",
    label: "Distributor upload overdue alert",
    description:
      "Who is told when a distributor's file for the month just closed is later than that same distributor's file was last month. Defaults to Super Admin and SFE Manager — the two roles holding sales:import, which is what /sales/upload requires, so every recipient can actually perform the upload the message is asking for rather than landing on a redirect.",
    roles: ["Super Admin", "SFE Manager"],
    enabled: true,
  },
  retention_risk_alert: {
    key: "retention_risk_alert",
    label: "Retention risk alert",
    description:
      "Who is told when a MEDICAL REP reaches three consecutive working days of recorded leave, or three consecutive working days with no CRM entry of any kind, and has not been seen since (owner, 2026-09-07: medical reps only, three days, still away). Defaults to HR Operations, Super Admin and SFE Manager — the owner picked these with the HR Business Partner on 2026-09-06, and that seat was retired on 2026-10-08. The person's own line manager is added per alert by the sweep itself and is deliberately NOT a role here: it is one named manager per subject, not everyone holding a manager role.",
    roles: ["HR Operations", "Super Admin", "SFE Manager"],
    enabled: true,
  },
  new_hire_mailbox_alert: {
    key: "new_hire_mailbox_alert",
    label: "New hire mailbox",
    description:
      "Who is told, in-app and on Telegram, when an employee is added, so that person's Turbify mailbox can be created and its app password handed to Phoenix. The notice carries the new hire's name, job title and the address Phoenix proposes, and links to the New Hire Mailboxes page. Never email: the mailbox it is about does not exist yet. Defaults to Super Admin alone — the owner's instruction, 2026-09-18.",
    roles: ["Super Admin"],
    enabled: true,
  },
  marketing_sla_reminder: {
    key: "marketing_sla_reminder",
    label: "Marketing request SLA reminder",
    description: "Reminds the assigned approver and requester about overdue marketing request due dates. Recipients are always the specific request's assigned approver and requester — not role-configurable here; roles is intentionally always empty and this policy only carries the master on/off switch.",
    roles: [],
    // Disabled 2026-07-22 at owner request (335437cc) — restored behind this real toggle.
    enabled: false,
  },
  service_milestone_notice: {
    key: "service_milestone_notice",
    label: "Service milestone notice",
    description:
      "Who is reminded, in-app and on Telegram, that someone is coming up on a service milestone or a birthday at Sato Pharma, so a card can be printed in time. It keeps reminding, once a day, until a recipient opens the Milestones page — the owner's chosen acknowledgement (2026-09-23: \"when I open it and the system confirm I see it, this pumping stops\"). Defaults to Super Admin alone, since the owner narrowed the whole module to Super Admin the same day.",
    roles: ["Super Admin"],
    enabled: true,
  },
  activity_inactivity_digest: {
    key: "activity_inactivity_digest",
    label: "Inactive-colleague digest",
    description:
      "Who is told, once a day in-app and on Telegram, which colleagues have not signed in to Phoenix for a week or more. Deliberately never email (the owner's standing rule for this kind of internal notice). Defaults to Super Admin alone, which is who asked for it (2026-09-26).",
    roles: ["Super Admin"],
    enabled: true,
  },
  accepted_offer_alert: {
    key: "accepted_offer_alert",
    label: "Offer accepted — ready to hire",
    description:
      "Who is told, in-app, by push and on Telegram, the moment a job offer is marked accepted, so the new hire can be seated. The notice carries the candidate's name, the agreed start date and the seat the offer named, and links to the organogram where an accepted offer is now one press to hire. Defaults to Super Admin, HR Operations and Talent Acquisition — the owner's choice, 2026-10-02, with Talent Acquisition added 2026-10-16.",
    roles: ["Super Admin", "HR Operations", "HR Resourcing"],
    enabled: true,
  },
  // Owner, 3 Nov 2026. A master switch only: the recipients are whoever holds an approval past three days, so `roles` is
  // empty. Off until he turns it on, and the third number and Meta's approval must also be in place
  // (src/lib/approvals/urgent-whatsapp.ts).
  approval_whatsapp_reminder: {
    key: "approval_whatsapp_reminder",
    label: "WhatsApp reminder for waiting approvals",
    description:
      "Once a working day, each approver holding a leave, excuse, marketing or direct-order request for more than three days gets one WhatsApp message with the count.",
    roles: [],
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

/**
 * The roles a notification goes to right now: the policy's own list, empty when it is switched off,
 * plus the stand-in for any listed seat nobody holds (owner, 2026-10-20: every notice addressed to
 * the empty HR Generalist seat goes to the Super Admin until the hire — vacant-seat.ts). This is the
 * one door every role-addressed delivery passes through, so the rule reaches all of them at once.
 * Still never throws; a seat that could not be read keeps today's list and adds to `warnings`.
 */
export async function resolveNotificationRoleRecipients(
  key: NotificationRoleKey,
  warnings?: string[],
): Promise<PhoenixRole[]> {
  const policies = await getNotificationRolePolicies();
  const policy = policies.find((p) => p.key === key) ?? DEFAULT_NOTIFICATION_ROLE_POLICIES[key];
  if (!policy.enabled) return [];
  return withVacantSeatStandIns(policy.roles, `Notification "${key}" recipients`, warnings);
}

// Lets a digest function short-circuit BEFORE it scans any data, for the hybrid keys below
// whose recipient list always includes a mandatory recipient (manager-of-manager; DM/NSM/PM-GPM
// chain) regardless of `roles` — for those, an empty roles array alone would NOT achieve a true
// master-off, so callers must check this instead of (or in addition to) an empty roles array.
export async function resolveNotificationRoleEnabled(key: NotificationRoleKey): Promise<boolean> {
  const policies = await getNotificationRolePolicies();
  return policies.find((p) => p.key === key)?.enabled ?? DEFAULT_NOTIFICATION_ROLE_POLICIES[key].enabled;
}

// ── Person-level recipient resolution ────────────────────────────────────────────────────────────
//
// One human can hold more than one auth account: the HR Manager also operates the
// system-administrator console (see @/lib/auth/identity-aliases for the declared groups). Resolving
// role recipients one-entry-per-AUTH-ACCOUNT therefore delivered every role-addressed system
// notification to that person TWICE — two mails, two bell rows, two pushes, for the sync digest,
// weekly health digest, background-jobs digest, held-notification alert and probation alerts alike.
// Resolve to one entry per PERSON instead, and keep the account that can actually reach them.

export type NotificationRoleRecipient = {
  hrId: string;
  userId: string | null;
};

/** An auth account plus the channel bindings that decide whether it can reach the human behind it. */
export type NotificationRoleRecipientAccount = NotificationRoleRecipient & {
  hasEmail: boolean;
  hasPush: boolean;
  hasTelegram: boolean;
};

type DeliveryBindings = { email: Set<string>; push: Set<string>; telegram: Set<string> };

function personKeyOf(hrId: string): string | null {
  return canonicalHrIdKey(canonicalPersonHrId(hrId) ?? hrId);
}

/** True when this account's own HR_ID is the one the person is really known by, not an alias console. */
function isCanonicalPersonAccount(hrId: string): boolean {
  const person = personKeyOf(hrId);
  return Boolean(person && person === canonicalHrIdKey(hrId));
}

function deliveryReach(account: NotificationRoleRecipientAccount): number {
  return (account.hasEmail ? 1 : 0) + (account.hasPush ? 1 : 0) + (account.hasTelegram ? 1 : 0);
}

/**
 * Which of one person's accounts survives the merge. Reach comes first because the bindings are not
 * evenly spread: in production the alias console is the ONLY account holding the Telegram chat and
 * the push subscription, so preferring the "real" employee account would fix the duplicate by
 * silencing two channels. The remaining comparisons exist purely to make the pick deterministic —
 * an account that changes between runs re-delivers the same digest under a fresh idempotency key.
 */
function outranks(
  candidate: NotificationRoleRecipientAccount,
  held: NotificationRoleRecipientAccount,
): boolean {
  const reachGap = deliveryReach(candidate) - deliveryReach(held);
  if (reachGap !== 0) return reachGap > 0;

  const candidateIsCanonical = isCanonicalPersonAccount(candidate.hrId);
  if (candidateIsCanonical !== isCanonicalPersonAccount(held.hrId)) return candidateIsCanonical;

  const candidateHasUserId = Boolean(candidate.userId);
  if (candidateHasUserId !== Boolean(held.userId)) return candidateHasUserId;

  return candidate.hrId.localeCompare(held.hrId) < 0;
}

/**
 * Collapse auth accounts down to one entry per physical person. Pure — the caller supplies the
 * bindings — so the routing rule is testable without a database.
 */
export function dedupeRecipientsByPerson(
  accounts: readonly NotificationRoleRecipientAccount[],
): NotificationRoleRecipient[] {
  const bestByPerson = new Map<string, NotificationRoleRecipientAccount>();
  for (const account of accounts) {
    const personKey = personKeyOf(account.hrId);
    if (!personKey) continue;
    const held = bestByPerson.get(personKey);
    if (!held || outranks(account, held)) bestByPerson.set(personKey, account);
  }
  return Array.from(bestByPerson.values())
    .sort((left, right) => left.hrId.localeCompare(right.hrId))
    .map((account) => ({ hrId: account.hrId, userId: account.userId }));
}

/**
 * Which channels each candidate account is actually bound to. Every binding table is read behind
 * its own guard: a read that fails reads as "no binding", which can flip the merge to the weaker
 * account, so it has to leave a warning in the caller's audit trail rather than look deliberate.
 */
async function loadDeliveryBindings(hrIds: string[], warnings: string[]): Promise<DeliveryBindings> {
  const bindings: DeliveryBindings = { email: new Set(), push: new Set(), telegram: new Set() };
  // Casing drifts per table — employees stores "PHX-1", telegram_connections stores "phx-1" — so
  // filter on every stored spelling instead of one and silently matching nothing.
  const lookupKeys = Array.from(new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId))));
  if (lookupKeys.length === 0) return bindings;

  const supabase = getSupabaseAdmin();
  const collect = async (
    channel: keyof DeliveryBindings,
    load: () => Promise<Array<{ hr_id?: string | null }>>,
  ) => {
    try {
      for (const row of await load()) {
        const key = canonicalHrIdKey(row.hr_id);
        if (key) bindings[channel].add(key);
      }
    } catch (error) {
      warnings.push(
        `${channel} bindings unavailable: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 160),
      );
    }
  };

  await Promise.all([
    collect("email", async () => {
      const { data, error } = await supabase.from("employees").select("hr_id,work_email").in("hr_id", lookupKeys);
      if (error) throw error;
      return ((data ?? []) as Array<{ hr_id?: string | null; work_email?: string | null }>).filter(
        (row) => String(row.work_email ?? "").trim().length > 0,
      );
    }),
    collect("push", async () => {
      const { data, error } = await supabase
        .from("push_subscriptions")
        .select("hr_id")
        .eq("status", "subscribed")
        .in("hr_id", lookupKeys);
      if (error) throw error;
      return (data ?? []) as Array<{ hr_id?: string | null }>;
    }),
    collect("telegram", async () => {
      const { data, error } = await supabase
        .from("telegram_connections")
        .select("hr_id,telegram_chat_id")
        .eq("status", "connected")
        .in("hr_id", lookupKeys);
      if (error) throw error;
      return ((data ?? []) as Array<{ hr_id?: string | null; telegram_chat_id?: string | number | null }>).filter(
        (row) => String(row.telegram_chat_id ?? "").trim().length > 0,
      );
    }),
  ]);

  return bindings;
}

/**
 * The recipients for a role-addressed system notification: active accounts holding one of the
 * configured roles, merged to one entry per person. Never throws — the digests that call it have no
 * guard of their own — and reports why a list came back short through `warnings`, which every caller
 * writes into its audit log.
 */
/**
 * Everyone holding one app role right now, as HR ids in display form.
 *
 * Added 2026-09-09 for the retention-risk CEO exclusion, which has to name an OFFICE rather than a
 * person: hard-coding an HR id would pin whoever sits in the chair today. Kept here beside the
 * other resolvers because `app_auth_users` is this module's table, not the calling domain's.
 *
 * FAILS OPEN, like every resolver in this file, and that direction is deliberate even though this
 * one feeds an EXCLUSION: an empty list means the exclusion does nothing and the alert still
 * reaches its audience. The opposite choice - treating an unreadable table as "exclude everybody" -
 * would silence a retention alert on a transient database error, which is the failure nobody sees.
 * The caller is handed the warning so the run says what it could not read.
 *
 * 🔴 IT IS NOT ENOUGH TO ASK `app_auth_users.is_active` (added 2026-10-02). That column lags
 * `employees.employment_status` - a CSV termination or a contract non-renewal flips the employee
 * record and leaves the login active - so a departed role-holder kept receiving role-addressed
 * notices, the Phoenix CRM plan-edit emails among them. The SAME filter
 * `resolveNotificationPersonRecipients` has carried all along is applied here, with its fail-open
 * rule intact: an account with no employee row (a system or service login) is KEPT, and an
 * unreadable `employees` read drops nobody. Measured on production the day it was added: the one
 * active SFE Manager (A-2) is `active`, so nothing was being misdirected yet.
 *
 * An EMPTY answer is logged, not swallowed: every caller addresses an office, so "nobody holds this
 * role" means a notice reached no one, and that reads exactly like a notice nobody sent.
 */
export async function resolveHrIdsForRole(
  role: PhoenixRole,
  warningLabel: string,
): Promise<{ hrIds: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("hr_id")
      .eq("role", role)
      .eq("is_active", true);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ hr_id?: string | null }>;
    const hrIds = Array.from(new Set(rows.map((row) => String(row.hr_id ?? "").trim().toUpperCase()).filter(Boolean)));
    const current = hrIds.length > 0 ? await withoutDepartedHrIds(hrIds, warningLabel, warnings) : hrIds;
    if (current.length === 0) {
      logWarning(`${warningLabel}: no current holder of the ${role} role`, {
        labels: { event: "role_recipients_empty", role },
      });
    }
    return { hrIds: current, warnings };
  } catch (error) {
    warnings.push(
      `${warningLabel} unavailable: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 160),
    );
    logWarning(`${warningLabel}: the ${role} role could not be read`, {
      error,
      labels: { event: "role_recipients_failed", role },
    });
    return { hrIds: [], warnings };
  }
}

/**
 * The given HR ids minus anyone whose employee record is terminal.
 *
 * FAILS OPEN on purpose, the same direction as every resolver here: an unreadable `employees` read
 * drops nobody and adds a warning, because silencing an office's whole notice stream on a transient
 * error is the failure nobody sees. An id with no employee row is kept - that is a system or service
 * login, matching `isTerminalEmploymentStatus`'s own rule.
 */
export async function withoutDepartedHrIds(hrIds: string[], warningLabel: string, warnings: string[]): Promise<string[]> {
  try {
    const { data, error } = await getSupabaseAdmin().from("employees").select("hr_id,employment_status").in("hr_id", hrIds);
    if (error) throw error;
    const departed = new Set<string>();
    for (const employee of (data ?? []) as Array<{ hr_id?: string | null; employment_status?: string | null }>) {
      if (isTerminalEmploymentStatus(employee.employment_status)) departed.add(String(employee.hr_id ?? "").trim().toUpperCase());
    }
    return hrIds.filter((hrId) => !departed.has(hrId));
  } catch (error) {
    warnings.push(
      `${warningLabel} employment check unavailable: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 160),
    );
    return hrIds;
  }
}

export async function resolveNotificationPersonRecipients(
  key: NotificationRoleKey,
  warningLabel: string,
): Promise<{ recipients: NotificationRoleRecipient[]; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    const roles = await resolveNotificationRoleRecipients(key, warnings);
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id,hr_id,is_active")
      .in("role", roles)
      .eq("is_active", true);
    if (error) throw error;

    const rows = (data ?? []) as Array<{ hr_id?: string | null; login_id?: string | null }>;
    const hrIds = rows.map((row) => String(row.hr_id ?? "").trim().toUpperCase()).filter(Boolean);

    // app_auth_users.is_active can lag employees.employment_status — a CSV termination or a
    // contract non-renewal flips the employee record without deactivating the login. A
    // role-addressed system notification must not reach someone who has left, so drop any
    // account whose linked employee is terminal. Accounts with no matching employee row
    // (system/service logins) are KEPT, matching isTerminalEmploymentStatus's fail-open rule.
    const terminalHrIds = new Set<string>();
    if (hrIds.length > 0) {
      const { data: employeeRows, error: employeeError } = await getSupabaseAdmin()
        .from("employees")
        .select("hr_id,employment_status")
        .in("hr_id", hrIds);
      if (employeeError) throw employeeError;
      for (const employee of (employeeRows ?? []) as Array<{ hr_id?: string | null; employment_status?: string | null }>) {
        if (isTerminalEmploymentStatus(employee.employment_status)) {
          terminalHrIds.add(String(employee.hr_id ?? "").trim().toUpperCase());
        }
      }
    }

    const activeHrIds = hrIds.filter((hrId) => !terminalHrIds.has(hrId));
    const bindings = await loadDeliveryBindings(activeHrIds, warnings);

    const accounts: NotificationRoleRecipientAccount[] = [];
    for (const row of rows) {
      const hrId = String(row.hr_id ?? "").trim().toUpperCase();
      if (!hrId) continue;
      if (terminalHrIds.has(hrId)) continue;
      const bindingKey = canonicalHrIdKey(hrId);
      accounts.push({
        hasEmail: Boolean(bindingKey && bindings.email.has(bindingKey)),
        hasPush: Boolean(bindingKey && bindings.push.has(bindingKey)),
        hasTelegram: Boolean(bindingKey && bindings.telegram.has(bindingKey)),
        hrId,
        userId: String(row.login_id ?? "").trim() || null,
      });
    }

    return { recipients: dedupeRecipientsByPerson(accounts), warnings };
  } catch (error) {
    warnings.push(
      `${warningLabel} unavailable: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 160),
    );
    return { recipients: [], warnings };
  }
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

/**
 * The HR_IDs to notify for a role-based notification — resolved, filtered and deduped by person.
 *
 * WHY THIS EXISTS, rather than each caller querying `app_auth_users` itself. Two callers did, with
 * the same line:
 *
 *   const hrHrIds = (hrApprovers ?? []).map((a) => String(a.hr_id)).filter(Boolean);
 *
 * `String(null)` is `"null"`, which is truthy, so `.filter(Boolean)` keeps it. `cleanHrId` in
 * notifications/system.ts then upper-cases it to the four-character string `"NULL"`, which is
 * written to `notification_events.employee_hr_id` and rejected by its foreign key to
 * `employees(hr_id)`. Production has exactly one such row — the `admin-HR` console login, whose
 * `hr_id` column is NULL — so `{resignation_sla_reminder_failed}` fired once per overdue
 * resignation, every day at 06:36 Cairo, with SQLSTATE 23503.
 *
 * 🔴 The FK is MATCH SIMPLE and the column is already nullable (2,604 rows hold a genuine NULL), so
 * a real NULL inserts fine. Making the column nullable, or the FK laxer, fixes nothing: the value
 * being written was never null. This is the `marketing-approver-hrid-casing-fk` class — a non-stored
 * spelling written into one of the 84 FK columns across 52 tables that reference `employees(hr_id)` —
 * and it has now broken five features.
 *
 * WHAT IT DOES with a login that has no `hr_id`: resolves it through the shared-identity groups by
 * its `login_id` first. `admin-HR` is a declared alias of `B-10` (one person, owner-confirmed), so
 * it canonicalises to `B-10` and then dedupes against the real `B-10` row — one notification to one
 * human, which is what was already happening by accident, now by construction. Anything that still
 * has no usable id is dropped and logged once, because a recipient nobody can resolve is a
 * configuration problem to see, not a row to force into a foreign key.
 */
export async function resolveRoleRecipientHrIds(key: NotificationRoleKey): Promise<string[]> {
  // Already carries the vacant-seat stand-in (see resolveNotificationRoleRecipients). It never names
  // a role twice, and pickRecipientHrIds below merges one person's accounts, so a stand-in who is
  // already a recipient is still told once.
  const notifyRoles = await resolveNotificationRoleRecipients(key);
  if (notifyRoles.length === 0) return [];

  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id, login_id")
    .in("role", notifyRoles)
    .eq("is_active", true);
  if (error) {
    logError("Could not read the role recipients for a notification; sending to nobody this run", {
      labels: { event: "role_recipient_lookup_failed", notification: key },
      error,
    });
    return [];
  }

  const { hrIds, unresolved } = pickRecipientHrIds(data ?? []);

  if (unresolved.length > 0) {
    logWarning("Skipped notification recipients whose login resolves to no HR id", {
      labels: { event: "role_recipient_unresolved", notification: key, count: unresolved.length },
      context: { logins: unresolved },
    });
  }

  return hrIds;
}

/**
 * The canonical HR_ID a login is a DECLARED alias of, or null.
 *
 * Deliberately not `canonicalPersonHrId`, which answers "what is the canonical form of this id" and
 * hands an unknown id straight back. This answers the narrower question the recipient list needs:
 * "is this login a known second console for a real person?" — and null for everything else.
 */
function declaredAliasCanonicalHrId(login: string | null): string | null {
  const key = canonicalHrIdKey(login);
  if (!key) return null;
  const group = sharedIdentityGroups.find((candidate) =>
    candidate.aliasHrIds.some((alias) => canonicalHrIdKey(alias) === key),
  );
  return group ? canonicalHrIdForDisplay(group.canonicalHrId) : null;
}

/**
 * The pure half of `resolveRoleRecipientHrIds` — rows in, HR_IDs out.
 *
 * Split out so it can be tested without a database, because the defect it fixes was entirely in
 * this mapping and nothing to do with the query. That is the only reason it is exported.
 */
export function pickRecipientHrIds(
  rows: readonly { hr_id?: unknown; login_id?: unknown }[],
): { hrIds: string[]; unresolved: string[] } {
  const byPerson = new Map<string, string>();
  const unresolved: string[] = [];
  for (const row of rows) {
    // The stored spelling when there is one, the person behind the login when there is not.
    // NEVER String(row.hr_id) — that is where the four-character "NULL" came from.
    const stored = typeof row.hr_id === "string" && row.hr_id.trim() ? row.hr_id.trim() : null;
    const login = typeof row.login_id === "string" ? row.login_id : null;
    // 🔴 `canonicalPersonHrId` is NOT usable here. For an id it does not recognise it returns that
    // id back, display-canonicalised — so `canonicalPersonHrId("ops-console")` is `"OPS-CONSOLE"`,
    // and taking it would write a LOGIN NAME into a column that FKs `employees(hr_id)`. That is the
    // same defect as the "NULL" string, one step further along, and a test caught it here before it
    // shipped. Only a DECLARED alias may stand in for a missing hr_id.
    const resolved = stored ?? declaredAliasCanonicalHrId(login);
    if (!resolved) {
      unresolved.push(login ?? "(no login id)");
      continue;
    }
    // Dedupe by PERSON, not by string: B-10 and its admin-HR console are one human, so they get one
    // notification between them rather than two identical ones.
    const personKey = canonicalHrIdKey(canonicalPersonHrId(resolved) ?? resolved) ?? resolved;
    if (!byPerson.has(personKey)) byPerson.set(personKey, resolved);
  }
  return { hrIds: [...byPerson.values()], unresolved };
}

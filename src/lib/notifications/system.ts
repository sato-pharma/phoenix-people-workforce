import crypto from "crypto";


import { writeAuditLog } from "@/lib/admin/audit";
import {
  safeSendNotificationEmail,
  type EmailNotificationType,
  type EmailRecipientMode,
  type NotificationEmailIdentityGuard,
  type NotificationEmailIdentitySource,
  type NotificationEmailInput,
  validateNotificationEmailIdentity,
} from "@/lib/notifications/email";
import {
  resolveNotificationPolicy,
  resolveNotificationRecipientsWithGovernance,
  type NotificationRecipient,
  type NotificationRecipientGovernanceWarning,
} from "@/lib/notifications/policy";
import { persistNotificationWrite } from "@/lib/notifications/notification-outbox";
import { OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS, OUTBOX_RETRY_TIMEOUT_MS } from "@/lib/platform/write-outbox";
import { renderNotificationTemplate } from "@/lib/notifications/templates";
import { notificationHrefForViewerRole } from "@/lib/notifications/hrefs";
import { sendTelegramNotification } from "@/lib/notifications/telegram";
import { isPermanentTelegramDeliveryError } from "@/lib/notifications/telegram-delivery-errors";
import { sendPushNotification } from "@/lib/notifications/push";
import { enforcePayslipEmailBlock } from "@/lib/notifications/payslip-channel-guard";
import { enforceAttendanceAlertEmailBlock } from "@/lib/notifications/attendance-alert-channel-guard";
import { enforceEarlyBirdsEmailBlock } from "@/lib/notifications/early-birds-channel-guard";
import { isAttendanceDigestModule, telegramKeepsParagraphs } from "@/lib/notifications/attendance-digest-channels";
import {
  enforcePhoenixCrmEmailBlock,
  enforcePhoenixCrmPushBlock,
  phoenixCrmBlocksTelegramFallback,
} from "@/lib/notifications/phoenix-crm-channel-guard";
import { closingPublishBlocksTelegramFallback } from "@/lib/notifications/closing-publish-channel-guard";
import { operatorWatchBlocksTelegramFallback } from "@/lib/notifications/operator-watch-channel-guard";
import { enforceNeedsYouOwnerOnlyEmail } from "@/lib/notifications/needs-you-recipient-guard";
import { enforceMarketingSlaEmailBlock } from "@/lib/notifications/marketing-sla-channel-guard";
import { enforceOpsSuccessTelegramBlock } from "@/lib/notifications/ops-success-digest-channel-guard";
import { enforceRecruitmentCvEmailBlock } from "@/lib/notifications/recruitment-cv-channel-guard";
import { enforceCandidateAssignedEmailBlock } from "@/lib/notifications/recruitment-candidate-assigned-channel-guard";
import { enforceOutstationRejectionEmailBlock } from "@/lib/notifications/outstation-rejection-channel-guard";
import { resolveTelegramGovernance } from "@/lib/notifications/telegram-governance";
import { GENERIC_NOTIFICATION_TITLE, GENERIC_PAYSLIP_MESSAGE, TelegramTemplateError } from "@/lib/notifications/telegram-template-types";
import { currentCairoMinutesOfDay } from "@/lib/i18n/format";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { noticeAlreadyReached, REACHED_DELIVERY_STATUSES } from "@/lib/notifications/stored-notice";
import { logError, logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type SystemNotificationChannel = "in_app" | "email" | "telegram" | "push";
export type SystemNotificationPriority = "low" | "normal" | "high" | "critical";

export type CreateSystemNotificationInput = {
  actionUrl?: string | null;
  actorId?: string | null;
  category?: string | null;
  channels?: SystemNotificationChannel[];
  email?: Partial<NotificationEmailInput> & {
    notificationType?: EmailNotificationType;
    recipientMode?: EmailRecipientMode;
  };
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
  module: string;
  priority?: SystemNotificationPriority;
  recordId?: string | null;
  recipientHrId?: string | null;
  recipientUserId?: string | null;
  subjectHrId?: string | null;
  /**
   * Phoenix CRM's test world only: the `TEST-` login that may SEE this notice.
   *
   * The notice is still addressed to the real person it mirrors, because that is what the bell's
   * `employee_hr_id` / `recipients` query looks for — so the marker, not the address, is what keeps
   * it away from her. Setting it also forces the notice to in-app alone: a Telegram chat id, a push
   * subscription and an email address all belong to the REAL person, and a test entry must never
   * reach any of them. Null on every real notification.
   */
  testLoginId?: string | null;
  telegram?: {
    buttons?: Array<{ label: string; url: string }> | null;
    ctaLabel?: string | null;
    ctaUrl?: string | null;
  };
  title: string;
};

export type SystemNotificationDeliveryResult = {
  channel: SystemNotificationChannel;
  error?: string;
  idempotencyKey: string;
  /**
   * An email recorded "sent" that did not go out yet: it was handed to the outbox to retry. That
   * covers blocks the outbox cannot tell from a passing fault, so it is no proof the person was told.
   */
  queuedForRetry?: boolean;
  reason?: string;
  status: "pending" | "sent" | "failed" | "skipped" | "retrying";
};

export type SystemNotificationResult = {
  deliveries: SystemNotificationDeliveryResult[];
  eventId: string | null;
  eventKey: string;
};

/** Shared delivery-status shape for best-effort notification fan-outs. */
export type NotificationDeliveryStatus = {
  errored: boolean;
  fellBackToSuperAdmin: boolean;
  recipientCount: number;
};

type RecipientProfile = {
  email: string | null;
  hrId: string | null;
  name: string | null;
  role: string | null;
  userId: string | null;
};

type NotificationPreferenceRow = {
  email_enabled?: boolean | null;
  in_app_enabled?: boolean | null;
  module_preferences?: Record<string, unknown> | null;
  preferred_channel?: SystemNotificationChannel | null;
  push_enabled?: boolean | null;
  quiet_hours_end?: string | null;
  quiet_hours_start?: string | null;
  telegram_enabled?: boolean | null;
};

type TelegramConnectionRow = {
  telegram_chat_id?: string | number | null;
  status?: "pending" | "connected" | "disabled" | "failed" | null;
};

type LoadedPreferences = {
  email_enabled: boolean;
  in_app_enabled: boolean;
  module_preferences: Record<string, unknown>;
  preferred_channel: SystemNotificationChannel;
  push_enabled: boolean;
  quiet_hours_end: string | null;
  quiet_hours_start: string | null;
  telegram_enabled: boolean;
};

const sensitivePayrollModules = new Set(["payroll", "payslip", "payslips"]);
const criticalWorkflowModules = new Set([
  "contracts",
  "contract_renewal",
  "direct_orders",
  "excuse",
  "excuses",
  "offers",
  "payroll",
  "payslip",
  "payslips",
  "probation",
  "resignations",
  "vacation",
  "leave",
]);
const systemAnnouncementEvents = new Set(["announcement", "system_announcement"]);
const employeeSubjectWorkflowModules = new Set([
  "contract_renewal",
  "deductions",
  "direct_orders",
  "excuse",
  "excuses",
  "leave",
  "marketing_requests",
  "outstation",
  "probation",
  "resignations",
  "support_requests",
  "vacation",
  "weekly_plans",
]);

// Aggregate digests (many employees rolled into one email) live in a
// per-employee workflow module but have no single subject by design — exempt
// them by event type so the module-level identity guard doesn't fail them.
// drift_alert is one of these. BOTH emitters — the weekly-plans drift check and the excuse
// approver-gap check — roll every affected employee into ONE operational message addressed to
// admin role recipients, so there is no single data subject to name and inventing one would put
// an arbitrary employee at the head of a report that is not about them. The weekly-plans half
// lost 25 emails this way between 2026-08-16 and 2026-09-06, zero sent. Exempting the event type
// is the deliberate choice here over supplying a fake subject: the guard stays fully armed for
// every per-employee mail these two modules send.
const aggregateDigestEventTypes = new Set(["drift_alert", "high_risk_digest"]);

/**
 * Retry budget for a `notification_deliveries` row, and the value the retry drains filter on in
 * SQL so exhausted rows never consume a batch slot.
 *
 * This mirrors the column: `max_attempts` is `NOT NULL DEFAULT 5` and nothing in this app writes
 * it explicitly, so every row carries 5 (measured 2026-08-27: 5 on all 20,340 production rows).
 * The per-row `Number(row.max_attempts ?? notificationDeliveryMaxAttempts)` checks in the drain loops stay as the authority —
 * this constant only keeps dead rows out of the query window, it does not decide eligibility.
 *
 * Why it matters: a terminally-failed row keeps `status: "failed"` and `next_attempt_at: null`,
 * both of which the drains' own filters match, so it never leaves the window. Once `limit` of
 * them collect at the head of the queue, every run fetches the same corpses, discards them all in
 * JS, and returns an empty batch — forever, with a green cron and no error anywhere. That is not
 * hypothetical: it silently killed every email retry for 13 days (#2462), and on 2026-08-27 the
 * telegram window already held 25 such rows against a limit of 50, push 16.
 */
export const notificationDeliveryMaxAttempts = 5;

/**
 * A delivery CLAIM is the empty `pending` row `claimDelivery` writes before a send, filled in
 * (payload, then `sent` / `skipped` / `failed`) only when that send ends. A process killed in between
 * - a deploy replacing the container mid-run - leaves the row bare for good: no payload to re-send,
 * so the retry drain steps over it without counting an attempt, and `assessDrainHealth` then reads
 * "work was due and nothing was attempted" on every tick, for ever. That is exactly how one Telegram
 * row written at 06:37:04 on 2026-10-16, while a deploy swapped the container, kept
 * `phoenix-process-notifications` red from 06:40 on.
 *
 * Within this window a bare claim may simply be a send still in flight, so the drain leaves it alone
 * AND the drain-health probe ignores it (same constant, drain-health.ts) - the worker and the alarm
 * must agree, or a killed send would spend the day's one drain alert before the worker closed it.
 */
export const DELIVERY_CLAIM_GRACE_MS = 5 * 60 * 1000;

export const ORPHANED_DELIVERY_CLAIM_REASON =
  "The send was interrupted (a restart or deploy) before this delivery was filled in - nothing to re-send.";

/** Pure: has nothing touched this row for longer than a send can plausibly take? Unknown age = no. */
export function isOrphanedDeliveryClaim(
  row: { created_at?: string | null; updated_at?: string | null },
  nowMs: number,
): boolean {
  const touchedMs = Date.parse(String(row.updated_at ?? row.created_at ?? ""));
  if (!Number.isFinite(touchedMs)) return false;
  return nowMs - touchedMs >= DELIVERY_CLAIM_GRACE_MS;
}

/**
 * Closes a due row the drain can never send because it carries no payload. Returns whether it was
 * closed. The write is conditional on the row STILL being open and untouched since the grace cutoff,
 * so a send that fills the row in between the read and this write is never overwritten. Never throws:
 * a failed close just leaves the row for the next tick.
 */
export async function closeOrphanedDeliveryClaim(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  row: { attempts?: number | null; created_at?: string | null; id: string; updated_at?: string | null },
  nowMs: number,
): Promise<boolean> {
  if (!isOrphanedDeliveryClaim(row, nowMs)) return false;
  const { data, error } = await supabase
    .from("notification_deliveries")
    .update({
      attempts: Number(row.attempts ?? 0),
      last_error: ORPHANED_DELIVERY_CLAIM_REASON,
      next_attempt_at: null,
      status: "skipped",
      updated_at: new Date(nowMs).toISOString(),
    })
    .eq("id", row.id)
    .in("status", ["failed", "pending", "retrying"])
    .lte("updated_at", new Date(nowMs - DELIVERY_CLAIM_GRACE_MS).toISOString())
    .select("id");
  if (error) {
    logWarning("Could not close an orphaned delivery claim (non-fatal - retried next tick)", {
      error,
      labels: { event: "orphaned_delivery_claim_close_failed" },
    });
    return false;
  }
  return (data ?? []).length > 0;
}

/**
 * How long a claimed retry stays out of the drain window. A send that finishes writes its own outcome
 * well inside this; one whose process died is retried once the lease runs out, with its attempt
 * already counted, so a send that kills the process every time still reaches its attempt limit.
 */
export const DELIVERY_RETRY_LEASE_MS = 10 * 60 * 1000;

/** The open statuses a retry drain reads; a claim from a drain must find the row still in one of them. */
export const DELIVERY_RETRY_OPEN_STATUSES = ["failed", "pending", "retrying"] as const;

/**
 * Claim one Telegram or push delivery row for a retry send, BEFORE the send.
 *
 * WHY (23 Oct 2026 audit, Pass 5): the Telegram and push retry drains read due rows, sent, and only
 * then wrote the outcome. Two drains overlapping — a cron fire that outlives cron-job.org's 30-second
 * cut and the next fire, or the deploy overlap — read the same row and BOTH sent it. The claim is a
 * compare-and-set on `attempts`: it spends the attempt and pushes `next_attempt_at` a lease ahead, and
 * only the run whose write matched the attempt count it READ owns the send. Every later write of that
 * run (`attempts + 1`) lands on the same count, so nothing else about the row's lifecycle changes.
 *
 * `openStatuses: null` is the admin's manual retry, which may resend anything that is not `sent`.
 * Never throws: a failed claim is a skipped row this tick, never a send without one.
 */
export async function claimDeliveryRetry(
  supabase: Pick<ReturnType<typeof getSupabaseAdmin>, "from">,
  row: { attempts?: number | null; id: string },
  options: { nowMs?: number; openStatuses?: readonly string[] | null } = {},
): Promise<boolean> {
  const nowMs = options.nowMs ?? Date.now();
  const openStatuses = options.openStatuses === undefined ? DELIVERY_RETRY_OPEN_STATUSES : options.openStatuses;
  try {
    let query = supabase
      .from("notification_deliveries")
      .update({
        attempts: Number(row.attempts ?? 0) + 1,
        next_attempt_at: new Date(nowMs + DELIVERY_RETRY_LEASE_MS).toISOString(),
        status: "retrying",
        updated_at: new Date(nowMs).toISOString(),
      })
      .eq("id", row.id);
    query = row.attempts === null || row.attempts === undefined ? query.is("attempts", null) : query.eq("attempts", row.attempts);
    query = openStatuses ? query.in("status", [...openStatuses]) : query.neq("status", "sent");
    const { data, error } = await query.select("id");
    if (error) {
      logWarning("Could not claim a delivery retry (skipped this tick, retried on the next)", {
        error,
        labels: { event: "delivery_retry_claim_failed" },
      });
      return false;
    }
    return (data ?? []).length > 0;
  } catch (error) {
    logWarning("Could not claim a delivery retry (skipped this tick, retried on the next)", {
      error,
      labels: { event: "delivery_retry_claim_failed" },
    });
    return false;
  }
}

function cleanText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function cleanHrId(value: string | null | undefined) {
  return cleanText(value).toUpperCase();
}

function metadataHrId(metadata: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value !== "string") continue;
    const hrId = cleanHrId(value);
    if (hrId) return hrId;
  }
  return "";
}

function employeeMetricHrId(metrics: NotificationEmailInput["metrics"]) {
  const employee = metrics?.find((metric) => metric.label.trim().toLowerCase() === "employee");
  const match = String(employee?.value ?? "").match(/\(([^)]+)\)\s*$/);
  return cleanHrId(match?.[1]);
}

function emailSubjectIdentityRequired(input: CreateSystemNotificationInput, hasSubjectCandidate: boolean) {
  if (hasSubjectCandidate) return true;
  if (aggregateDigestEventTypes.has(cleanText(input.eventType).toLowerCase())) return false;
  return employeeSubjectWorkflowModules.has(cleanText(input.module).toLowerCase());
}

function resolvedEmailIdentity(input: CreateSystemNotificationInput, recipient: RecipientProfile): {
  employeeHrId: string | undefined;
  error: string | null;
  guard: NotificationEmailIdentityGuard;
  source: NotificationEmailIdentitySource | null;
  status: "failed" | "not_required" | "verified";
} {
  const rawCandidates: Array<{ hrId: string; source: NotificationEmailIdentitySource }> = [
    { hrId: cleanHrId(input.email?.employeeHrId), source: "email.employeeHrId" },
    { hrId: cleanHrId(input.subjectHrId), source: "subjectHrId" },
    { hrId: metadataHrId(input.metadata, ["employeeHrId"]), source: "metadata.employeeHrId" },
    { hrId: metadataHrId(input.metadata, ["subjectHrId"]), source: "metadata.subjectHrId" },
    { hrId: metadataHrId(input.metadata, ["requestOwnerHrId"]), source: "metadata.requestOwnerHrId" },
    { hrId: employeeMetricHrId(input.email?.metrics), source: "metrics.Employee" },
  ];
  const candidates = rawCandidates.filter((candidate) => candidate.hrId);
  const required = emailSubjectIdentityRequired(input, candidates.length > 0);
  const guard: NotificationEmailIdentityGuard = required ? "subject_required" : "none";
  const unique = Array.from(new Set(candidates.map((candidate) => candidate.hrId)));

  if (unique.length > 1) {
    return {
      employeeHrId: unique[0],
      error: `Conflicting subject HR IDs were provided for email identity: ${unique.join(", ")}.`,
      guard,
      source: candidates[0]?.source ?? null,
      status: "failed",
    };
  }

  const subjectHrId = unique[0] ?? "";
  if (required && !subjectHrId) {
    return {
      employeeHrId: undefined,
      error: "Subject employee HR ID is missing for an official workflow email.",
      guard,
      source: null,
      status: "failed",
    };
  }

  if (!subjectHrId && input.metadata?.identityScope === "self") {
    const recipientHrId = cleanHrId(recipient.hrId);
    return {
      employeeHrId: recipientHrId || undefined,
      error: null,
      guard: recipientHrId ? "self" : "none",
      source: recipientHrId ? "recipient.self" : null,
      status: recipientHrId ? "verified" : "not_required",
    };
  }

  return {
    employeeHrId: subjectHrId || undefined,
    error: null,
    guard,
    source: candidates[0]?.source ?? null,
    status: subjectHrId ? "verified" : "not_required",
  };
}

function schemaMissing(error: unknown, table: string) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return (
    text.includes(table.toLowerCase()) ||
    text.includes("could not find the table") ||
    text.includes("schema cache") ||
    text.includes("column") && text.includes("does not exist") ||
    text.includes("42703") ||
    (text.includes("relation") && text.includes("does not exist"))
  );
}

function categoryFor(input: CreateSystemNotificationInput) {
  const explicit = cleanText(input.category).toLowerCase();
  if (explicit) return explicit;

  const moduleName = cleanText(input.module).toLowerCase();
  if (moduleName === "vacation" || moduleName === "leave") return "vacation_request";
  if (moduleName === "excuse" || moduleName === "excuses") return "excuse";
  if (moduleName === "coaching") return "coaching_report";
  if (moduleName === "internal_message" || moduleName === "internal_messages") return "internal_message";
  if (moduleName === "probation") return "probation";
  if (moduleName === "recruitment") return "recruitment";
  if (moduleName === "marketing_requests") return "general";
  return "general";
}

function notificationTypeFor(moduleName: string): EmailNotificationType {
  const moduleKey = moduleName.toLowerCase();
  if (moduleKey.includes("probation")) return "probation";
  if (moduleKey.includes("contract")) return "contract_renewal";
  if (moduleKey.includes("birthday")) return "birthday";
  if (moduleKey.includes("offer")) return "offer";
  if (moduleKey.includes("resignation")) return "resignation";
  if (moduleKey.includes("payroll")) return "general";
  if (moduleKey.includes("password_reset")) return "password_reset";
  if (moduleKey.includes("user_created") || moduleKey.includes("password_setup")) return "user_created";
  return "general";
}

function isSensitivePayroll(input: CreateSystemNotificationInput) {
  const moduleName = cleanText(input.module).toLowerCase();
  const eventType = cleanText(input.eventType).toLowerCase();
  return sensitivePayrollModules.has(moduleName) || eventType.includes("payslip") || input.metadata?.sensitivity === "payroll";
}

// Modules whose full content is sensitive enough that an EXPLICIT recipient (one the
// caller passed directly, bypassing governed recipient resolution) must be the data
// subject themselves — unless the trusted server caller explicitly opts in via
// metadata.authorizedRecipient. This closes the "explicit path skips governance" gap
// without breaking self-notifications (module "system") or governed sends.
const explicitSensitiveModules = new Set(["payroll", "payslip", "payslips", "deductions"]);

function explicitRecipientAllowed(input: CreateSystemNotificationInput): boolean {
  const moduleName = cleanText(input.module).toLowerCase();
  if (!explicitSensitiveModules.has(moduleName) && !isSensitivePayroll(input)) return true;
  if (input.metadata?.authorizedRecipient === true) return true;
  const recipientHr = cleanHrId(input.recipientHrId);
  const subjectHr = cleanHrId(input.subjectHrId);
  // Only allow sensitive content on the explicit path when it targets the subject.
  return Boolean(recipientHr && subjectHr && recipientHr === subjectHr);
}

function isCriticalWorkflow(input: CreateSystemNotificationInput) {
  if (input.priority === "critical" || input.priority === "high") return true;
  return criticalWorkflowModules.has(cleanText(input.module).toLowerCase());
}

function dedupeChannels(channels: SystemNotificationChannel[]) {
  return Array.from(new Set(channels));
}

function basePolicyChannels(input: CreateSystemNotificationInput, preferred: SystemNotificationChannel) {
  // Hard, fallback-proof guarantee: a payslip notification is NEVER emailed, whatever the policy,
  // explicit channels, or Telegram-failure fallbacks resolve to. See payslip-channel-guard.ts.
  const resolved = enforcePayslipEmailBlock(resolveBasePolicyChannels(input, preferred), input.eventType);
  // Same hard guarantee for marketing-request SLA reminders/escalations (owner request
  // 2026-07-25, after this exact notification type produced a real incident) -- see
  // marketing-sla-channel-guard.ts. The other marketing_requests lifecycle notifications
  // (submitted/assigned/approved/rejected/returned/completed) are untouched.
  const withoutMarketingSlaEmail = enforceMarketingSlaEmailBlock(resolved, input.module, input.eventType);
  // Same hard guarantee for the whole Early Birds module (owner request 2026-08-09): in-app and
  // Telegram only, never email. Nothing downstream of the policy table can restore it --
  // including the Telegram-failure fallback, which matters here because Telegram failing is the
  // expected case while managers are still unlinked. See early-birds-channel-guard.ts.
  const withoutEarlyBirdsEmail = enforceEarlyBirdsEmailBlock(withoutMarketingSlaEmail, input.module);
  // Same hard guarantee for the attendance ingestion stall alert (owner rule, restated
  // 2026-08-09): in-app + push only, never email. Two co-operating config values (the call
  // site's `channels` and the policy.ts entry) were already set that way, and two values that
  // must agree are exactly what drifts — see attendance-alert-channel-guard.ts.
  //
  // MERGE NOTE (2026-08-09): this block and the Early Birds one above arrived from two branches
  // on the same day, each written as "applied last". They guard disjoint event sets — Early Birds
  // keys on module alone, this one on module + attendance_agent_ingestion_stalled — so chaining
  // them preserves both guarantees. Dropping either to keep "last" literally true would silently
  // restore email for that module.
  const withoutAttendanceAlertEmail = enforceAttendanceAlertEmailBlock(withoutEarlyBirdsEmail, input.module, input.eventType);
  // Same hard guarantee for the "new CV received" notice (owner request 2026-08-15): in-app and
  // Telegram only, never email — see recruitment-cv-channel-guard.ts. Scoped to the single
  // recruitment_inbound_cv eventType; every other recruitment notification keeps its email.
  const withoutRecruitmentCvEmail = enforceRecruitmentCvEmailBlock(withoutAttendanceAlertEmail, input.module, input.eventType);
  // Same hard guarantee for a candidate pushed to a hiring manager (owner rule 2026-08-24): in-app
  // and push only, never email — see recruitment-candidate-assigned-channel-guard.ts. Scoped to the
  // single candidate_assigned eventType, so offers, interviews and the rest of recruitment keep
  // theirs. Chained after the CV block rather than replacing it: the two guard disjoint event sets,
  // and collapsing them would silently restore email for whichever one lost.
  const withoutCandidateAssignedEmail = enforceCandidateAssignedEmailBlock(withoutRecruitmentCvEmail, input.module, input.eventType);
  // The weekly attendance review is deliberately NOT blocked here any more (owner rule 2026-09-17,
  // replacing 2026-09-15's "never email"): its notices go by email, Telegram and in-app — see
  // attendance-digest-channels.ts.
  // Same hard guarantee for an expense rejection (owner rule 2026-09-19): the employee is told
  // in-app, never by email — see outstation-rejection-channel-guard.ts. Scoped to the single
  // outstation request_rejected eventType; the submit notice and the reminders keep their email.
  // Placed BEFORE the Phoenix CRM block, not after: phoenix-crm-email-block.test.ts pins that block
  // as the chain's last line, and the two guard disjoint sets, so the order changes nothing.
  const withoutOutstationRejectionEmail = enforceOutstationRejectionEmailBlock(withoutCandidateAssignedEmail, input.module, input.eventType);
  // "What needs you" keeps its email but restricts WHO gets it: the owner's own board reaches B-10
  // and nobody else. A different axis from the blocks above — they ask whether a module may email at
  // all — so it cannot be folded into one of them. It FAILS CLOSED: an unresolved recipient strips
  // email rather than allowing it, because a misdirected copy of his decision queue cannot be
  // recalled while a missing digest costs a morning. See needs-you-recipient-guard.ts.
  // Placed BEFORE the Phoenix CRM block for the reason stated two comments up — that block is pinned
  // as the chain's last line, and these two guard disjoint modules, so the order changes nothing.
  const needsYouOwnerOnly = enforceNeedsYouOwnerOnlyEmail(withoutOutstationRejectionEmail, input.module, input.recipientHrId);
  // The TELEGRAM axis on the two routine "it worked" ops confirmations (owner rule 2026-10-15:
  // "stop the routine sync-success alerts reaching my Telegram"). Keyed on the SUCCESS event types
  // alone, so `ireports360_sync_failed` and `background_jobs_run_failed` keep every channel they
  // had — a guard on the module or on the job would have silenced the failures along with the
  // noise, which is the one outcome worse than the noise. Placed BEFORE the Phoenix CRM blocks for
  // the reason stated two comments up: that push block is pinned as the chain's last line, and
  // these guard disjoint sets, so the order changes nothing. See ops-success-digest-channel-guard.ts.
  const withoutOpsSuccessTelegram = enforceOpsSuccessTelegramBlock(needsYouOwnerOnly, input.eventType);
  // Same hard guarantee for Phoenix CRM (owner rule 2026-09-16): in-app and Telegram only, never
  // email — see phoenix-crm-channel-guard.ts. Keyed on its own module string; chained, never
  // replacing a block above, because each guards a disjoint set. The event type rides along for the
  // one exception the owner ordered on 2026-10-01: the five steps of a request to edit a sent week.
  const withoutPhoenixCrmEmail = enforcePhoenixCrmEmailBlock(withoutOpsSuccessTelegram, input.module, input.eventType);
  // And the same for the PUSH axis on the Phoenix CRM 06:55 digest (owner rule 2026-09-28: "in app or
  // telegram only"). It has to be here rather than at the call site, which already asks for exactly
  // in-app and Telegram: the Telegram-failure fallback re-sends as ["email", "in_app", "push"], the
  // line above took the email and nothing took the push. Last in the chain, as the email block was.
  return enforcePhoenixCrmPushBlock(withoutPhoenixCrmEmail, input.module, input.eventType);
}

function resolveBasePolicyChannels(input: CreateSystemNotificationInput, preferred: SystemNotificationChannel) {
  if (input.channels?.length) return dedupeChannels(input.channels);
  const policy = resolveNotificationPolicy(input);
  if (policy.channels.length > 0) {
    // Owner override 2026-07-25: push is now explicitly authorized for payroll/payslip
    // notifications (policy.ts's payroll.* and payroll.payslip_available rows include it),
    // accepting the lock-screen-exposure tradeoff. Telegram stays stripped here for any
    // isSensitivePayroll() event that isn't payslip-named and isn't generic-only.
    const channels = isSensitivePayroll(input) && !policy.telegramGenericOnly
      ? policy.channels.filter((channel) => channel !== "telegram")
      : policy.channels;
    return dedupeChannels(channels.length > 0 ? channels : ["in_app", preferred]);
  }

  if (isSensitivePayroll(input)) {
    return input.metadata?.telegramGenericAllowed === true
      ? ["in_app", "email", "telegram"] satisfies SystemNotificationChannel[]
      : ["in_app", "email"] satisfies SystemNotificationChannel[];
  }

  if (isCriticalWorkflow(input)) return ["in_app", "email", "telegram"] satisfies SystemNotificationChannel[];

  if (systemAnnouncementEvents.has(cleanText(input.eventType).toLowerCase())) {
    return input.metadata?.telegramOptional === true
      ? ["in_app", "email", "telegram"] satisfies SystemNotificationChannel[]
      : ["in_app", "email"] satisfies SystemNotificationChannel[];
  }

  return dedupeChannels(["in_app", preferred]);
}

function requestedChannelsForEnvelope(input: CreateSystemNotificationInput) {
  if (input.channels?.length) return dedupeChannels(input.channels);
  const policy = resolveNotificationPolicy(input);
  return dedupeChannels(policy.channels.length > 0 ? policy.channels : ["in_app", "email"]);
}

/**
 * Whether a multi-recipient event should collapse to ONE email (primary To, everyone
 * else Cc) instead of one independent send per governed recipient.
 *
 * Bug (owner report, 2026-07-22): createSystemNotification fans out per governed
 * recipient, and several notification types (module "general") re-resolve a static
 * HR-inbox address list on EVERY one of those per-recipient sends — so a 3-recipient
 * event (e.g. outstation submission notifying a manager + CEO + Super Admin) put the
 * shared inbox addresses in 3 separate emails instead of 1, and anyone who is both a
 * governed recipient AND in that static list got the same notification 2-4x. This used
 * to be gated to an allowlist of modules AND require a resolvable subject employee HR ID
 * — narrow enough that most duplicate-prone modules (attendance digests, etc.) fell
 * through to the buggy per-recipient path. Collapsing to an envelope whenever there is
 * more than one recipient closes that gap everywhere at once. The identity guard is
 * still enforced downstream in buildChannelEmailInput/validateNotificationEmailIdentity
 * for modules that require a subject — dropping the pre-check here only changes WHERE
 * that guard runs (once for the envelope instead of once per recipient), not whether it
 * runs.
 */
function shouldUseWorkflowEmailEnvelope(input: CreateSystemNotificationInput, recipients: NotificationRecipient[]) {
  if (recipients.length <= 1) return false;
  if (!requestedChannelsForEnvelope(input).includes("email")) return false;
  if (isSensitivePayroll(input)) return false;
  return true;
}

function recipientKey(recipient: Pick<NotificationRecipient, "email" | "hrId" | "userId">) {
  return cleanText(recipient.userId ?? recipient.hrId ?? recipient.email ?? null).toLowerCase();
}

function deliverableAddresses(recipients: NotificationRecipient[]) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const recipient of recipients) {
    const email = pickDeliverableEmail(recipient.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    output.push(email);
  }
  return output;
}

function emailDeliveryMetadata(
  identity: ReturnType<typeof validateNotificationEmailIdentity>,
  emailInput: NotificationEmailInput,
) {
  const envelope = {
    bcc: emailInput.bcc ?? [],
    cc: emailInput.cc ?? [],
    recipientHrId: emailInput.recipientHrId ?? null,
    to: emailInput.recipients ?? [],
  };
  return {
    emailEnvelope: envelope,
    emailIdentity: identity.metadata,
  };
}

/** Stored on the delivery row too, so the audit trail says WHY nothing was shown, not just that nothing was. */
const NO_HR_ID_IN_APP_REASON = "Recipient has no HR ID, and the in-app bell is keyed on one — nothing could be shown.";

/**
 * The fallback `event_key` for a notification whose caller supplied no `idempotencyKey`.
 *
 * `notification_events` is upserted `onConflict: "event_key"`, so two notifications that hash to
 * the same key are ONE row and the second write overwrites the first. The hash therefore has to
 * carry everything that makes two notices genuinely different events.
 *
 * 🔴 **The ACTOR is part of that identity.** Until 2026-10-23 it was not in the hash, so when two
 * different senders produced the same notice for the same recipient — the same `eventType`,
 * `module`, `title` and `actionUrl`, which is exactly what a templated title does, since the
 * sender's name usually lives in the MESSAGE and not the title — the second sender's write landed
 * on the first sender's row. The recipient was left holding one notification where two people had
 * acted, and the one that survived was whichever happened to be written last. Suffixing per
 * recipient (see `createSystemNotificationForRecipients`) never covered this: the collision is
 * between senders to ONE recipient, not between recipients.
 *
 * `recordId` and `subjectHrId` are deliberately still out. They identify what the notice is ABOUT
 * rather than who raised it, and folding them in would split notices that are meant to collapse
 * onto one row — the dedup these keys exist to provide.
 */
function eventKeyFor(input: CreateSystemNotificationInput) {
  const metadataKey = typeof input.metadata?.idempotencyKey === "string" ? cleanText(input.metadata.idempotencyKey) : "";
  if (metadataKey) return metadataKey;

  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      actionUrl: input.actionUrl ?? null,
      actorId: cleanText(input.actorId),
      eventType: input.eventType,
      module: input.module,
      recipientHrId: cleanHrId(input.recipientHrId),
      recipientUserId: cleanText(input.recipientUserId),
      title: input.title,
    }))
    .digest("hex");
}

/**
 * The same key, exported for the regression test that pins the actor into it.
 * Not for production callers — they go through {@link createSystemNotification}.
 */
export function systemNotificationEventKeyForTest(input: CreateSystemNotificationInput) {
  return eventKeyFor(input);
}

async function loadRecipientProfile(input: CreateSystemNotificationInput): Promise<RecipientProfile> {
  const userId = cleanText(input.recipientUserId);
  const hrId = cleanHrId(input.recipientHrId);

  try {
    const supabase = getSupabaseAdmin();
    const query = supabase
      .from("app_auth_users")
      .select("login_id,hr_id,name,auth_email,role")
      .limit(1);
    const { data, error } = userId
      ? await query.ilike("login_id", userId).maybeSingle()
      : hrId
        ? await query.eq("hr_id", hrId).maybeSingle()
        : { data: null, error: null };

    if (error) throw error;
    const row = data as { auth_email?: string | null; hr_id?: string | null; login_id?: string | null; name?: string | null; role?: string | null } | null;
    const resolvedHrId = cleanHrId(row?.hr_id) || hrId || null;

    // app_auth_users.auth_email is the synthetic Supabase-auth login key
    // (phx-<hex>@auth.phoenix.local), never a real mailbox. The deliverable address lives on
    // employees.work_email. Resolve it; degrade to in-app only (null) when there is none.
    let workEmail: string | null = null;
    let employeeName: string | null = null;
    if (resolvedHrId) {
      try {
        // `error` MUST be destructured and thrown. Ignoring it is what made PR #1872 invisible:
        // it selected `name_en`, a column that does not exist on `employees`, so PostgREST
        // returned an error with data = null. Nothing threw, the catch below never ran, and
        // work_email silently became null for EVERY recipient — which then redirected their mail
        // to the shared HR inbox for ~13h with no log line anywhere. A failed lookup must be loud.
        const { data: employee, error: employeeQueryError } = await supabase
          .from("employees")
          .select("work_email, name:full_name")
          .eq("hr_id", resolvedHrId)
          .maybeSingle();
        if (employeeQueryError) throw employeeQueryError;
        workEmail = (employee as { work_email?: string | null } | null)?.work_email ?? null;
        employeeName = (employee as { name?: string | null } | null)?.name ?? null;
      } catch (employeeError) {
        if (!schemaMissing(employeeError, "employees")) {
          logError("Notification recipient work email lookup failed", {
            labels: { event: "notification_recipient_work_email_lookup_failed", hr_id: resolvedHrId },
            error: employeeError,
          });
        }
      }
    }

    return {
      email: pickDeliverableEmail(workEmail, row?.auth_email),
      hrId: resolvedHrId,
      name: row?.name ?? employeeName ?? null,
      role: row?.role ?? null,
      userId: row?.login_id ?? (userId || null),
    };
  } catch (error) {
    if (!schemaMissing(error, "app_auth_users")) {
      logError("Notification recipient profile lookup failed", {
        labels: { event: "notification_recipient_profile_lookup_failed", hr_id: hrId || null, user_id: userId || null },
        error,
      });
    }
    return { email: null, hrId: hrId || null, name: null, role: null, userId: userId || null };
  }
}

/**
 * "Dr. " for managerial/professional roles; "" for Medical Rep and Employee.
 * Also "" when the recipient's stored name already carries a "Dr" title, so the
 * "Dear {{honorific}}{{recipientName}}" greeting never doubles up into "Dear Dr. Dr Name".
 */
function managerHonorific(role: string | null, name: string | null): string {
  if (!role) return "";
  if (role === "Employee" || role === "Medical Rep") return "";
  if (/^dr\.?\s/i.test(cleanText(name))) return "";
  return "Dr. ";
}

async function loadPreferences(input: CreateSystemNotificationInput): Promise<LoadedPreferences> {
  const userId = cleanText(input.recipientUserId);
  const hrId = cleanHrId(input.recipientHrId);
  const defaults = {
    email_enabled: true,
    in_app_enabled: true,
    module_preferences: {} as Record<string, unknown>,
    preferred_channel: "email" as SystemNotificationChannel,
    push_enabled: true,
    quiet_hours_end: null,
    quiet_hours_start: null,
    telegram_enabled: false,
  };

  try {
    let query = getSupabaseAdmin()
      .from("notification_preferences")
      .select("email_enabled,in_app_enabled,telegram_enabled,push_enabled,preferred_channel,module_preferences,quiet_hours_start,quiet_hours_end")
      .limit(1);
    if (userId) query = query.ilike("user_id", userId);
    else if (hrId) query = query.eq("hr_id", hrId);
    else return defaults;

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    const row = data as NotificationPreferenceRow | null;
    return {
      email_enabled: row?.email_enabled ?? defaults.email_enabled,
      in_app_enabled: row?.in_app_enabled ?? defaults.in_app_enabled,
      module_preferences: row?.module_preferences && typeof row.module_preferences === "object" && !Array.isArray(row.module_preferences)
        ? row.module_preferences
        : defaults.module_preferences,
      preferred_channel: row?.preferred_channel ?? defaults.preferred_channel,
      push_enabled: row?.push_enabled ?? defaults.push_enabled,
      quiet_hours_end: row?.quiet_hours_end ?? defaults.quiet_hours_end,
      quiet_hours_start: row?.quiet_hours_start ?? defaults.quiet_hours_start,
      telegram_enabled: row?.telegram_enabled ?? defaults.telegram_enabled,
    };
  } catch (error) {
    if (!schemaMissing(error, "notification_preferences")) throw error;
    return defaults;
  }
}

// A recipient's push "connection" is simply: does at least one browser/device currently
// report an active OneSignal subscription for them? Unlike Telegram there is no bot-link
// dance — the browser subscribes itself once permission is granted — so this is a read-only
// existence check, not a stateful connection record.
async function hasActivePushSubscription(input: CreateSystemNotificationInput): Promise<boolean> {
  const hrId = cleanHrId(input.recipientHrId);
  if (!hrId) return false;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("push_subscriptions")
      .select("id")
      .eq("hr_id", hrId)
      .eq("status", "subscribed")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  } catch (error) {
    if (!schemaMissing(error, "push_subscriptions")) throw error;
    return false;
  }
}

async function loadTelegramConnection(input: CreateSystemNotificationInput) {
  const userId = cleanText(input.recipientUserId);
  const hrId = cleanHrId(input.recipientHrId);
  try {
    let query = getSupabaseAdmin()
      .from("telegram_connections")
      .select("telegram_chat_id,status")
      .order("created_at", { ascending: false })
      .limit(1);
    if (userId) query = query.ilike("user_id", userId);
    else if (hrId) query = query.eq("hr_id", hrId);
    else return null;

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data as TelegramConnectionRow | null;
  } catch (error) {
    if (!schemaMissing(error, "telegram_connections")) throw error;
    return null;
  }
}

/**
 * The id of the stored notice for this key when it already reached somebody, else null.
 * A read that fails answers null, and the write below runs as before: its own error handling (an
 * old schema, a real outage) is unchanged, and the delivery claim still stops a second send.
 *
 * ONE call (performance phase 1, 2026-10-23): the event and its reached deliveries come back together
 * through the `notification_deliveries_notification_event_id_fkey` embed — the old event-then-deliveries
 * pair was two sequential round trips in front of every notification write. The embed is a plain
 * (non-inner) one, so an event with no reached delivery still returns, with an empty list, as before.
 */
async function reachedNoticeId(eventKey: string): Promise<string | null> {
  try {
    const { data: event, error } = await getSupabaseAdmin()
      .from("notification_events")
      .select("id, notification_deliveries(status)")
      .eq("event_key", eventKey)
      .in("notification_deliveries.status", [...REACHED_DELIVERY_STATUSES])
      .limit(1, { referencedTable: "notification_deliveries" })
      .maybeSingle();
    if (error || !event) return null;
    const row = event as { id?: string | number; notification_deliveries?: Array<{ status?: string | null }> | null };
    const eventId = String(row.id ?? "");
    if (!eventId) return null;
    const statuses = (row.notification_deliveries ?? []).map((delivery) => delivery.status);
    return noticeAlreadyReached(statuses) ? eventId : null;
  } catch {
    return null;
  }
}

async function createNotificationEvent(input: CreateSystemNotificationInput, eventKey: string, recipient: RecipientProfile) {
  // A notice that already reached somebody is never rewritten (stored-notice.ts): a repeat send with
  // the same key is refused delivery below, and must not change what the bell shows either.
  const reachedId = await reachedNoticeId(eventKey);
  if (reachedId) return reachedId;

  const now = new Date().toISOString();
  const category = categoryFor(input);
  const inAppContent = await renderChannelContent(input, "in_app");
  const testLoginId = cleanText(input.testLoginId).toUpperCase() || null;
  const metadata = {
    ...(input.metadata ?? {}),
    href: input.actionUrl ?? null,
    message: inAppContent.message,
    title: inAppContent.title,
    // Written into the metadata as well as the column ON PURPOSE. The fallback upsert below runs
    // when the column is missing (an old schema), and it carries metadata but not the column — so a
    // marker kept only in the column would write a TEST notice as a REAL one, visible to the person
    // it mirrors. Two carriers, and the reader trusts either, keeps that path fail-CLOSED.
    ...(testLoginId ? { testLoginId } : {}),
  };
  const row = {
    action_url: input.actionUrl ?? null,
    actor_id: input.actorId ?? null,
    category,
    employee_hr_id: recipient.hrId,
    event_key: eventKey,
    event_type: input.eventType,
    metadata,
    module: input.module,
    priority: input.priority ?? "normal",
    recipient_user_id: recipient.userId,
    recipients: recipient.hrId ? [recipient.hrId] : [],
    scheduled_for: now.slice(0, 10),
    sent_at: now,
    status: "sent",
    subject: inAppContent.title,
    test_login_id: testLoginId,
    updated_at: now,
  };

  // 🔴 RETRIED, BUT DELIBERATELY NOT QUEUED. This row is a PRECONDITION of the send: its id is
  // what the delivery claim anchors to, so a caller that gets no id does not send. Parking it for
  // a later drain would write a `status: 'sent'` notification row hours afterwards asserting a
  // send that never happened — the opposite of what the outbox is for. One patient retry is the
  // right amount of resilience here; the outbox protects the write that records the OUTCOME
  // (`upsertDelivery`), where a replay is harmless and a loss costs a duplicate message.
  const writeEvent = async (timeoutMs: number) => {
    const { data, error } = await getSupabaseAdmin({ requestTimeoutMs: timeoutMs })
      .from("notification_events")
      .upsert(row, { onConflict: "event_key" })
      .select("id")
      .single();
    if (error) throw error;
    return String((data as { id?: string | number } | null)?.id ?? "");
  };

  try {
    try {
      return await writeEvent(OUTBOX_FIRST_ATTEMPT_TIMEOUT_MS);
    } catch (firstError) {
      if (schemaMissing(firstError, "notification_events")) throw firstError;
      return await writeEvent(OUTBOX_RETRY_TIMEOUT_MS);
    }
  } catch (error) {
    if (!schemaMissing(error, "notification_events")) throw error;

    const { data, error: fallbackError } = await getSupabaseAdmin()
      .from("notification_events")
      .upsert({
        category,
        employee_hr_id: recipient.hrId,
        event_key: eventKey,
        metadata,
        recipients: recipient.hrId ? [recipient.hrId] : [],
        scheduled_for: now.slice(0, 10),
        sent_at: now,
        status: "sent",
        subject: inAppContent.title,
        updated_at: now,
      }, { onConflict: "event_key" })
      .select("id")
      .single();
    if (fallbackError) throw fallbackError;
    return String((data as { id?: string | number } | null)?.id ?? "");
  }
}

async function upsertDelivery(input: {
  channel: SystemNotificationChannel;
  eventId: string | null;
  idempotencyKey: string;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
  nextAttemptAt?: string | null;
  provider?: string | null;
  providerMessageId?: string | null;
  recipient: RecipientProfile;
  recipientAddress?: string | null;
  status: SystemNotificationDeliveryResult["status"];
}) {
  if (!input.eventId) return;
  const now = new Date().toISOString();
  // 🔴 THIS WRITE IS WHY THE NOTIFICATION OUTBOX EXISTS, AND LOSING IT IS WORSE THAN LOSING AN
  // AUDIT ROW. It is the record that a send happened. Until 23 Oct 2026 a failure here was a log
  // line and nothing else — so when production Postgres restarted four times on 22 October, the
  // row stayed open at whatever `claimDelivery` had left it, and the retry drain's job is to send
  // open rows again. A lost status write did not just lose bookkeeping; it armed a SECOND real
  // email or Telegram message to a real person. The upsert is keyed on `idempotency_key`, so
  // replaying it from the queue is harmless.
  const error = await persistNotificationWrite({
    idempotencyKey: input.idempotencyKey,
    kind: "notification_delivery",
    row: {
      channel: input.channel,
      idempotency_key: input.idempotencyKey,
      last_error: input.lastError ?? null,
      metadata: input.metadata ?? {},
      next_attempt_at: input.nextAttemptAt ?? null,
      notification_event_id: input.eventId,
      provider: input.provider ?? input.channel,
      provider_message_id: input.providerMessageId ?? null,
      recipient_address: input.recipientAddress ?? null,
      recipient_hr_id: input.recipient.hrId,
      recipient_user_id: input.recipient.userId,
      sent_at: input.status === "sent" ? now : null,
      status: input.status,
      updated_at: now,
    },
  });
  if (error && !schemaMissing(error, "notification_deliveries")) {
    logError("Notification delivery audit failed", {
      labels: { event: "notification_delivery_audit_failed", channel: input.channel, hr_id: input.recipient.hrId },
      error,
    });
  }
}

function isUniqueViolation(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") return true;
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return text.includes("duplicate key") || text.includes("unique constraint") || text.includes("already exists");
}

// Atomically claim an idempotency key by INSERTing a pending delivery row. The
// notification_deliveries_idempotency_uniq unique constraint makes this race-free: if
// two concurrent fan-out sends target the same key, exactly one INSERT lands a row and
// the other is ignored. This replaces the old read-then-write check (TOCTOU) so a key
// can never be double-sent. Returns whether THIS call claimed the key.
//
// The insert is conflict-tolerant at the DB level: idempotency_key is a simple
// (non-partial) unique, so ON CONFLICT DO NOTHING can target it directly via
// .upsert({ onConflict, ignoreDuplicates }). A duplicate is silently ignored by Postgres
// with NO 23505 ERROR logged — the previous plain INSERT logged one duplicate-key ERROR
// per re-fanned delivery, flooding the production logs and burying real errors.
async function claimDelivery(input: {
  channel: SystemNotificationChannel;
  eventId: string | null;
  idempotencyKey: string;
  recipient: RecipientProfile;
}): Promise<{ alreadySent: boolean; claimed: boolean }> {
  // No event row to anchor against (e.g. schema missing) — nothing durable to dedupe on.
  if (!input.eventId) return { alreadySent: false, claimed: true };
  const now = new Date().toISOString();
  try {
    // ON CONFLICT DO NOTHING returns the row only when THIS call inserted it, so a row
    // coming back means we won the race and own the claim.
    const { data, error } = await getSupabaseAdmin()
      .from("notification_deliveries")
      .upsert({
        channel: input.channel,
        idempotency_key: input.idempotencyKey,
        notification_event_id: input.eventId,
        provider: input.channel,
        recipient_hr_id: input.recipient.hrId,
        recipient_user_id: input.recipient.userId,
        status: "pending",
        updated_at: now,
      }, { ignoreDuplicates: true, onConflict: "idempotency_key" })
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (data) return { alreadySent: false, claimed: true };
    // No row returned → the key already existed and the insert was a no-op. Read the
    // existing status so the caller can report whether it was already sent or in progress.
    const existing = await getSupabaseAdmin()
      .from("notification_deliveries")
      .select("status")
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    return { alreadySent: (existing.data as { status?: string } | null)?.status === "sent", claimed: false };
  } catch (error) {
    // Defensive: ON CONFLICT DO NOTHING should no longer surface a unique violation, but
    // if one ever does, treat it as a lost race (not claimed) rather than a hard failure.
    if (isUniqueViolation(error)) return { alreadySent: false, claimed: false };
    if (schemaMissing(error, "notification_deliveries")) return { alreadySent: false, claimed: true };
    // Fail-open on unexpected errors so a legitimate notification isn't silently dropped.
    logError("Notification delivery claim failed", {
      labels: { event: "notification_delivery_claim_failed", channel: input.channel, hr_id: input.recipient.hrId },
      error,
    });
    return { alreadySent: false, claimed: true };
  }
}

// Flip a live `connected` Telegram link to `failed` (recording the reason) when the bot can no
// longer deliver to it. Only touches a currently-`connected` row — never a pending/failed one —
// and keeps the stored chat_id so a later reconnect simply overwrites it. Best-effort: a
// bookkeeping failure here must never break the notification send that triggered it.
async function markTelegramConnectionNeedsRelink(recipient: RecipientProfile, reason: string): Promise<void> {
  const userId = cleanText(recipient.userId);
  const hrId = cleanHrId(recipient.hrId);
  if (!userId && !hrId) return;
  try {
    const now = new Date().toISOString();
    let query = getSupabaseAdmin()
      .from("telegram_connections")
      .update({ failure_reason: reason, status: "failed", updated_at: now })
      .eq("status", "connected");
    query = userId ? query.ilike("user_id", userId) : query.eq("hr_id", hrId);
    const { error } = await query;
    if (error) throw error;
  } catch (error) {
    if (!schemaMissing(error, "telegram_connections")) {
      logError("Failed to flag Telegram connection for re-link", {
        labels: { event: "telegram_connection_relink_flag_failed", hr_id: hrId || null, user_id: userId || null },
        error,
      });
    }
  }
}

function telegramMessageFor(input: CreateSystemNotificationInput) {
  if (isSensitivePayroll(input)) return GENERIC_PAYSLIP_MESSAGE;
  // The weekly attendance review's notice is a short letter to the employee (owner, 2026-09-17): no
  // "Module:" line in front of it.
  if (isAttendanceDigestModule(input.module)) return input.message;
  const moduleLabel = cleanText(input.module).replace(/_/g, " ");
  return [
    `Module: ${moduleLabel.charAt(0).toUpperCase()}${moduleLabel.slice(1)}`,
    input.message,
  ].filter(Boolean).join("\n");
}

function timeMinutes(value: string | null | undefined) {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function isWithinQuietHours(preferences: LoadedPreferences, now = new Date()) {
  const start = timeMinutes(preferences.quiet_hours_start);
  const end = timeMinutes(preferences.quiet_hours_end);
  if (start === null || end === null || start === end) return false;
  // Quiet hours are the user's LOCAL window. The server runs in UTC (GCP Cloud Run), so
  // compare against Africa/Cairo wall-clock minutes, not the server clock.
  const current = currentCairoMinutesOfDay(now);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function modulePreferenceDisabled(preferences: LoadedPreferences, input: CreateSystemNotificationInput, channel: SystemNotificationChannel) {
  const modulePrefs = preferences.module_preferences?.[input.module];
  if (!modulePrefs || typeof modulePrefs !== "object" || Array.isArray(modulePrefs)) return false;
  const value = (modulePrefs as Record<string, unknown>)[channel];
  return value === false;
}

async function renderChannelContent(input: CreateSystemNotificationInput, channel: SystemNotificationChannel) {
  return renderNotificationTemplate({
    actionUrl: input.actionUrl,
    channel,
    eventType: input.eventType,
    fallbackMessage: channel === "telegram" ? telegramMessageFor(input) : input.message,
    fallbackTitle: input.title,
    metadata: input.metadata,
    module: input.module,
  });
}

async function audit(summary: string, input: CreateSystemNotificationInput, eventId: string | null, values?: Record<string, unknown>) {
  await writeAuditLog({
    actorLoginId: input.actorId ?? "system",
    entityId: eventId ?? undefined,
    entityType: "notification",
    newValues: values ?? null,
    summary,
  });
}

async function createGovernanceSkippedNotification(
  input: CreateSystemNotificationInput,
  warnings: NotificationRecipientGovernanceWarning[],
): Promise<SystemNotificationResult> {
  const policy = resolveNotificationPolicy(input);
  const eventKey = eventKeyFor({
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      governanceSkip: true,
    },
  });
  const recipient: RecipientProfile = { email: null, hrId: null, name: null, role: null, userId: null };
  const eventId = await createNotificationEvent({
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      governance: {
        failClosed: true,
        warnings,
      },
    },
  }, eventKey, recipient);
  const warningPayload = {
    event: "notification_governance_fail_closed",
    eventId,
    eventType: input.eventType,
    module: input.module,
    recordId: input.recordId ?? null,
    warnings,
  };
  console.warn(JSON.stringify(warningPayload));
  await audit("notification governance fail-closed", input, eventId, warningPayload);

  const channels = dedupeChannels(policy.channels.length > 0 ? policy.channels : ["in_app", "email"]);
  const deliveries: SystemNotificationDeliveryResult[] = [];
  for (const channel of channels) {
    const idempotencyKey = `${eventKey}:${channel}:governance-skip`;
    await upsertDelivery({
      channel,
      eventId,
      idempotencyKey,
      lastError: "Notification skipped because no exact authorized recipient was resolved.",
      metadata: { governance: warningPayload },
      recipient,
      status: "skipped",
    });
    deliveries.push({
      channel,
      idempotencyKey,
      reason: "Notification skipped because no exact authorized recipient was resolved.",
      status: "skipped",
    });
  }

  return { deliveries, eventId, eventKey };
}

function telegramRetryDelayMinutes(attempt: number) {
  const delays = [5, 15, 60, 240];
  return delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)];
}

function nextTelegramRetryAt(attempt: number) {
  // ±20% jitter so a provider outage with many queued messages doesn't create a
  // thundering herd that all retry at the same instant.
  const base = telegramRetryDelayMinutes(attempt);
  const jittered = base * (0.8 + Math.random() * 0.4);
  const next = new Date();
  next.setMinutes(next.getMinutes() + Math.max(1, Math.round(jittered)));
  return next.toISOString();
}

function nextPushRetryAt(attempt: number) {
  const base = telegramRetryDelayMinutes(attempt);
  const jittered = base * (0.8 + Math.random() * 0.4);
  const next = new Date();
  next.setMinutes(next.getMinutes() + Math.max(1, Math.round(jittered)));
  return next.toISOString();
}

/**
 * Drain quiet-hours-deferred EMAIL deliveries from notification_deliveries. These rows
 * are written `pending` when a recipient is inside their quiet-hours window; before this
 * existed, only telegram had a drainer, so deferred email was silently lost. Each row
 * carries metadata.emailInput (the exact payload). We re-dispatch via the email outbox
 * (idempotent on dedupe_key) and re-defer while the recipient is still in quiet hours.
 * (in_app is never deferred — line `channel !== "in_app"` — so this only handles email.)
 */
export async function processDeferredDeliveryRetries(limit = 10) {
  const nowIso = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("notification_deliveries")
    .select("id,metadata,recipient_hr_id,recipient_user_id")
    .eq("channel", "email")
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 50)));

  if (error) {
    if (schemaMissing(error, "notification_deliveries")) return { attempted: 0, deferred: 0, sent: 0, skipped: 0 };
    throw error;
  }

  let attempted = 0;
  let sent = 0;
  let skipped = 0;
  let deferred = 0;

  for (const row of (data ?? []) as Array<{
    id: string;
    metadata?: Record<string, unknown> | null;
    recipient_hr_id?: string | null;
    recipient_user_id?: string | null;
  }>) {
    const storedEmailInput = row.metadata?.emailInput as NotificationEmailInput | undefined;
    const emailInput = storedEmailInput
      ? { ...storedEmailInput, recipientHrId: storedEmailInput.recipientHrId ?? row.recipient_hr_id ?? null }
      : undefined;
    if (!emailInput) {
      // No stored payload (legacy deferred row) — close it terminally so it never loops.
      await supabase
        .from("notification_deliveries")
        .update({ last_error: "Deferred email had no stored payload to re-dispatch.", next_attempt_at: null, status: "skipped", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      console.log("Deferred email delivery had no stored payload", {
        level: "warning",
        tags: { component: "email", cron: "deferred-drain" },
        extra: { id: row.id },
      });
      skipped += 1;
      continue;
    }

    // Respect quiet hours: if the recipient is still inside their window, re-defer +1h.
    const preferences = await loadPreferences({
      eventType: "deferred_email",
      message: "",
      module: "system",
      recipientHrId: row.recipient_hr_id ?? null,
      recipientUserId: row.recipient_user_id ?? null,
      title: "",
    });
    if (isWithinQuietHours(preferences)) {
      await supabase
        .from("notification_deliveries")
        .update({ next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), updated_at: new Date().toISOString() })
        .eq("id", row.id);
      deferred += 1;
      continue;
    }

    attempted += 1;
    const identity = validateNotificationEmailIdentity(emailInput);
    if (!identity.ok) {
      await supabase
        .from("notification_deliveries")
        .update({
          last_error: identity.reason,
          metadata: { ...(row.metadata ?? {}), emailIdentity: identity.metadata },
          next_attempt_at: null,
          status: "skipped",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      console.log("Deferred email delivery blocked by identity guard", {
        level: "error",
        tags: { component: "email", cron: "deferred-drain" },
        extra: { id: row.id, ...identity.metadata },
      });
      skipped += 1;
      continue;
    }
    const result = await safeSendNotificationEmail(emailInput);
    if (!result.skipped) {
      await supabase
        .from("notification_deliveries")
        .update({ last_error: null, next_attempt_at: null, provider_message_id: result.id ?? null, sent_at: new Date().toISOString(), status: "sent", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      sent += 1;
    } else if (result.reason.startsWith("Queued for retry:")) {
      // Handed off to the email outbox, which now owns retry + delivery (it tracks the
      // real outcome and emits its own terminal-failure alert). Mark this row done.
      await supabase
        .from("notification_deliveries")
        .update({ last_error: null, metadata: { ...(row.metadata ?? {}), handedOffToOutbox: true }, next_attempt_at: null, sent_at: new Date().toISOString(), status: "sent", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      sent += 1;
    } else {
      // Deterministic skip (policy disabled, no recipients, …) — will not send.
      await supabase
        .from("notification_deliveries")
        .update({ last_error: result.reason, next_attempt_at: null, status: "skipped", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      skipped += 1;
    }
  }

  return { attempted, deferred, sent, skipped };
}

export async function processTelegramDeliveryRetries(limit = 10) {
  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("notification_deliveries")
    .select("id,attempts,max_attempts,metadata,status,provider_message_id,recipient_hr_id,recipient_user_id,created_at,updated_at")
    .eq("channel", "telegram")
    .in("status", ["failed", "pending", "retrying"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
    // See notificationDeliveryMaxAttempts: a terminally-failed row keeps `status: "failed"` and
    // `next_attempt_at: null`, both of which this query MATCHES, so it stays in the window forever
    // and the `attempts >= maxAttempts` guard in the loop below discards it only AFTER the limit
    // has already counted it. Without this filter one full batch of exhausted rows starves every
    // retryable row behind it, silently and permanently - which is exactly what happened to the
    // email outbox (#2462).
    .lt("attempts", notificationDeliveryMaxAttempts)
    .order("created_at", { ascending: true })
    // Total order, so the limit window is stable when `created_at` ties.
    .order("id", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 50)));

  if (error) {
    if (schemaMissing(error, "notification_deliveries")) return { attempted: 0, failed: 0, sent: 0 };
    throw error;
  }

  let attempted = 0;
  let claimLost = 0;
  let closedOrphans = 0;
  let failed = 0;
  let sent = 0;
  const nowMs = Date.now();

  for (const row of (data ?? []) as Array<{ attempts?: number | null; created_at?: string | null; id: string; max_attempts?: number | null; metadata?: Record<string, unknown> | null; recipient_hr_id?: string | null; recipient_user_id?: string | null; updated_at?: string | null }>) {
    const attempts = Number(row.attempts ?? 0);
    const maxAttempts = Number(row.max_attempts ?? notificationDeliveryMaxAttempts);
    if (attempts >= maxAttempts) continue;
    const telegram = row.metadata?.telegram as Partial<TelegramRetryPayload> | undefined;
    if (!isResendableTelegramPayload(telegram)) {
      // Nothing to send. A bare claim left by a killed send is closed once it is clearly not in
      // flight; stepping over it for ever is what kept the drain-health alarm red (see
      // DELIVERY_CLAIM_GRACE_MS).
      if (await closeOrphanedDeliveryClaim(supabase, row, nowMs)) closedOrphans += 1;
      continue;
    }

    const recipientContext = {
      eventType: telegram.eventType ?? "telegram_retry",
      message: String(telegram.message),
      module: telegram.module ?? "system",
      recipientHrId: row.recipient_hr_id ?? null,
      recipientUserId: row.recipient_user_id ?? null,
      title: String(telegram.title),
    };

    attempted += 1;
    try {
      const governance = await resolveTelegramGovernance({
        eventType: telegram.eventType ?? null,
        module: telegram.module ?? "system",
      });
      if (!governance.enabled) {
        await supabase
          .from("notification_deliveries")
          .update({
            attempts,
            last_error: governance.reason ?? "Telegram is not allowed by current policy.",
            next_attempt_at: null,
            status: "skipped",
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        continue;
      }

      // Re-check user preference + live connection (mirrors retryTelegramDeliveryById):
      // a user who disabled Telegram or disconnected after the failure must not receive
      // the retry, and we send to the CURRENT chat id, never a stale one from metadata.
      const preferences = await loadPreferences(recipientContext);
      if (!preferences.telegram_enabled) {
        await supabase
          .from("notification_deliveries")
          .update({ attempts, last_error: "Telegram disabled by user preference.", next_attempt_at: null, status: "skipped", updated_at: new Date().toISOString() })
          .eq("id", row.id);
        continue;
      }
      const connection = await loadTelegramConnection(recipientContext);
      if (connection?.status !== "connected" || !connection.telegram_chat_id) {
        await supabase
          .from("notification_deliveries")
          .update({ attempts, last_error: "Telegram is not connected.", next_attempt_at: null, status: "skipped", updated_at: new Date().toISOString() })
          .eq("id", row.id);
        continue;
      }

      // Claim BEFORE the send: a concurrent drain that read the same row loses here and sends nothing.
      if (!(await claimDeliveryRetry(supabase, row))) {
        claimLost += 1;
        continue;
      }

      const result = await sendTelegramNotification({
        actionUrl: telegram.actionUrl ?? null,
        buttons: governance.genericOnly ? null : telegram.buttons ?? null,
        chatId: String(connection.telegram_chat_id),
        ctaLabel: governance.genericOnly ? null : telegram.ctaLabel ?? null,
        ctaUrl: governance.genericOnly ? null : telegram.ctaUrl ?? null,
        keepParagraphs: !governance.genericOnly && telegramKeepsParagraphs(telegram.module),
        message: governance.genericOnly ? GENERIC_PAYSLIP_MESSAGE : String(telegram.message),
        title: governance.genericOnly ? GENERIC_NOTIFICATION_TITLE : String(telegram.title),
      });
      if (result.skipped) throw new Error(result.reason);
      await supabase
        .from("notification_deliveries")
        .update({
          attempts: attempts + 1,
          last_error: null,
          next_attempt_at: null,
          provider_message_id: result.providerMessageId ?? null,
          sent_at: new Date().toISOString(),
          status: "sent",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      sent += 1;
    } catch (retryError) {
      const nextAttempts = attempts + 1;
      const terminal = nextAttempts >= maxAttempts;
      await supabase
        .from("notification_deliveries")
        .update({
          attempts: nextAttempts,
          last_error: retryError instanceof Error ? retryError.message : "Telegram retry failed.",
          next_attempt_at: terminal ? null : nextTelegramRetryAt(nextAttempts),
          status: terminal ? "failed" : "retrying",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (terminal) {
        await triggerTelegramRetryExhaustionFallback({
          deliveryId: row.id,
          recipientHrId: row.recipient_hr_id ?? null,
          recipientUserId: row.recipient_user_id ?? null,
          telegram,
        });
      }
      failed += 1;
    }
  }

  return { attempted, claimLost, closedOrphans, failed, sent };
}

// Mirrors processTelegramDeliveryRetries: drains both genuine send failures AND
// quiet-hours-deferred push rows (both are written with channel="push",
// status in (pending/failed/retrying) — see the deferred branch above). Unlike
// Telegram there is no "connection" to flag for re-link on permanent failure — a
// push with zero matching subscribers is a terminal skip (sendPushNotification
// already returns skipped:true for that case, never throws), so every thrown
// error here is a genuine transient failure worth retrying.
export async function processPushDeliveryRetries(limit = 10) {
  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("notification_deliveries")
    .select("id,attempts,max_attempts,metadata,recipient_hr_id,recipient_user_id,created_at,updated_at")
    .eq("channel", "push")
    .in("status", ["failed", "pending", "retrying"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
    // Same head-of-line starvation as the telegram drain above - see notificationDeliveryMaxAttempts.
    .lt("attempts", notificationDeliveryMaxAttempts)
    .order("created_at", { ascending: true })
    // Total order, so the limit window is stable when `created_at` ties.
    .order("id", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 50)));

  if (error) {
    if (schemaMissing(error, "notification_deliveries")) return { attempted: 0, failed: 0, sent: 0 };
    throw error;
  }

  let attempted = 0;
  let claimLost = 0;
  let closedOrphans = 0;
  let failed = 0;
  let sent = 0;
  const nowMs = Date.now();

  for (const row of (data ?? []) as Array<{ attempts?: number | null; created_at?: string | null; id: string; max_attempts?: number | null; metadata?: Record<string, unknown> | null; recipient_hr_id?: string | null; recipient_user_id?: string | null; updated_at?: string | null }>) {
    const attempts = Number(row.attempts ?? 0);
    const maxAttempts = Number(row.max_attempts ?? notificationDeliveryMaxAttempts);
    if (attempts >= maxAttempts) continue;
    const push = row.metadata?.push as Partial<PushRetryPayload> | undefined;
    if (!push?.externalId || !push?.title || !push?.message) {
      // Same bare claim as the Telegram drain - see DELIVERY_CLAIM_GRACE_MS.
      if (await closeOrphanedDeliveryClaim(supabase, row, nowMs)) closedOrphans += 1;
      continue;
    }

    attempted += 1;
    try {
      // Re-check the live preference + subscription (mirrors Telegram's re-check): a user
      // who disabled push or unsubscribed after the original failure must not receive it.
      const preferences = await loadPreferences({
        eventType: push.eventType ?? "push_retry",
        message: String(push.message),
        module: push.module ?? "system",
        recipientHrId: row.recipient_hr_id ?? null,
        recipientUserId: row.recipient_user_id ?? null,
        title: String(push.title),
      });
      if (!preferences.push_enabled) {
        await supabase
          .from("notification_deliveries")
          .update({ attempts, last_error: "Push disabled by user preference.", next_attempt_at: null, status: "skipped", updated_at: new Date().toISOString() })
          .eq("id", row.id);
        continue;
      }

      // Claim BEFORE the send - see claimDeliveryRetry.
      if (!(await claimDeliveryRetry(supabase, row))) {
        claimLost += 1;
        continue;
      }

      const result = await sendPushNotification({
        actionUrl: push.actionUrl ?? null,
        externalId: push.externalId,
        message: String(push.message),
        title: String(push.title),
      });
      if (result.skipped) {
        // A terminal "not subscribed"/"not configured" outcome is a normal skip, not a
        // failure — throwing here would count it as a failed attempt and retry it up to
        // maxAttempts times for a state that will never change on its own.
        await supabase
          .from("notification_deliveries")
          .update({ attempts, last_error: result.reason, next_attempt_at: null, status: "skipped", updated_at: new Date().toISOString() })
          .eq("id", row.id);
        continue;
      }
      await supabase
        .from("notification_deliveries")
        .update({
          attempts: attempts + 1,
          last_error: null,
          next_attempt_at: null,
          provider_message_id: result.providerMessageId ?? null,
          sent_at: new Date().toISOString(),
          status: "sent",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      sent += 1;
    } catch (retryError) {
      const nextAttempts = attempts + 1;
      const terminal = nextAttempts >= maxAttempts;
      await supabase
        .from("notification_deliveries")
        .update({
          attempts: nextAttempts,
          last_error: retryError instanceof Error ? retryError.message : "Push retry failed.",
          next_attempt_at: terminal ? null : nextPushRetryAt(nextAttempts),
          status: terminal ? "failed" : "retrying",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      failed += 1;
    }
  }

  return { attempted, claimLost, closedOrphans, failed, sent };
}

export async function retryTelegramDeliveryById(id: string): Promise<SystemNotificationDeliveryResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("notification_deliveries")
    .select("id,attempts,channel,idempotency_key,max_attempts,metadata,recipient_hr_id,recipient_user_id,status")
    .eq("id", id)
    .eq("channel", "telegram")
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    attempts?: number | null;
    id: string;
    idempotency_key?: string | null;
    max_attempts?: number | null;
    metadata?: Record<string, unknown> | null;
    recipient_hr_id?: string | null;
    recipient_user_id?: string | null;
    status?: string | null;
  } | null;
  const idempotencyKey = row?.idempotency_key ?? `telegram-retry:${id}`;
  if (!row) return { channel: "telegram", idempotencyKey, reason: "Delivery was not found.", status: "skipped" };
  if (row.status === "sent") return { channel: "telegram", idempotencyKey, reason: "Delivery already sent.", status: "skipped" };

  const telegram = row.metadata?.telegram as Partial<TelegramRetryPayload> | undefined;
  if (!telegram?.title || !telegram?.message) {
    return { channel: "telegram", idempotencyKey, reason: "Delivery does not contain a retry-safe Telegram payload.", status: "skipped" };
  }

  const governance = await resolveTelegramGovernance({
    eventType: telegram.eventType ?? null,
    module: telegram.module ?? "system",
  });
  if (!governance.enabled) {
    await supabase
      .from("notification_deliveries")
      .update({
        last_error: governance.reason ?? "Telegram is not allowed by current policy.",
        next_attempt_at: null,
        status: "skipped",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { channel: "telegram", idempotencyKey, reason: governance.reason, status: "skipped" };
  }

  const preferences = await loadPreferences({
    eventType: telegram.eventType ?? "telegram_retry",
    message: String(telegram.message),
    module: telegram.module ?? "system",
    recipientHrId: row.recipient_hr_id ?? null,
    recipientUserId: row.recipient_user_id ?? null,
    title: String(telegram.title),
  });
  if (!preferences.telegram_enabled) {
    await supabase
      .from("notification_deliveries")
      .update({
        last_error: "Telegram disabled by user preference.",
        next_attempt_at: null,
        status: "skipped",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { channel: "telegram", idempotencyKey, reason: "Telegram disabled by user preference.", status: "skipped" };
  }

  const connection = await loadTelegramConnection({
    eventType: telegram.eventType ?? "telegram_retry",
    message: String(telegram.message),
    module: telegram.module ?? "system",
    recipientHrId: row.recipient_hr_id ?? null,
    recipientUserId: row.recipient_user_id ?? null,
    title: String(telegram.title),
  });
  if (connection?.status !== "connected" || !connection.telegram_chat_id) {
    await supabase
      .from("notification_deliveries")
      .update({
        last_error: "Telegram is not connected.",
        next_attempt_at: null,
        status: "skipped",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { channel: "telegram", idempotencyKey, reason: "Telegram is not connected.", status: "skipped" };
  }

  const attempts = Number(row.attempts ?? 0);
  const maxAttempts = Number(row.max_attempts ?? notificationDeliveryMaxAttempts);
  if (attempts >= maxAttempts) return { channel: "telegram", idempotencyKey, reason: "Maximum retry attempts reached.", status: "skipped" };
  // Claim BEFORE the send, so a drain running at the same moment cannot send it too. A manual retry may
  // resend anything that is not already sent, so the claim checks only that.
  if (!(await claimDeliveryRetry(supabase, row, { openStatuses: null }))) {
    return { channel: "telegram", idempotencyKey, reason: "Delivery is already being retried.", status: "skipped" };
  }

  try {
      const result = await sendTelegramNotification({
        actionUrl: telegram.actionUrl ?? null,
        buttons: governance.genericOnly ? null : telegram.buttons ?? null,
        chatId: String(connection.telegram_chat_id),
        ctaLabel: governance.genericOnly ? null : telegram.ctaLabel ?? null,
        ctaUrl: governance.genericOnly ? null : telegram.ctaUrl ?? null,
      keepParagraphs: !governance.genericOnly && telegramKeepsParagraphs(telegram.module),
      message: governance.genericOnly ? GENERIC_PAYSLIP_MESSAGE : String(telegram.message),
      title: governance.genericOnly ? GENERIC_NOTIFICATION_TITLE : String(telegram.title),
    });
    if (result.skipped) throw new Error(result.reason);
    await supabase
      .from("notification_deliveries")
      .update({
        attempts: attempts + 1,
        last_error: null,
        next_attempt_at: null,
        provider_message_id: result.providerMessageId ?? null,
        sent_at: new Date().toISOString(),
        status: "sent",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { channel: "telegram", idempotencyKey, status: "sent" };
  } catch (retryError) {
    const nextAttempts = attempts + 1;
    const terminal = nextAttempts >= maxAttempts;
    const message = retryError instanceof Error ? retryError.message : "Telegram retry failed.";
    await supabase
      .from("notification_deliveries")
      .update({
        attempts: nextAttempts,
        last_error: message,
        next_attempt_at: terminal ? null : nextTelegramRetryAt(nextAttempts),
        status: terminal ? "failed" : "retrying",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (terminal) {
      await triggerTelegramRetryExhaustionFallback({
        deliveryId: row.id,
        recipientHrId: row.recipient_hr_id ?? null,
        recipientUserId: row.recipient_user_id ?? null,
        telegram,
      });
    }
    return { channel: "telegram", error: message, idempotencyKey, status: terminal ? "failed" : "retrying" };
  }
}

type TelegramRetryPayload = {
  actionUrl?: string | null;
  buttons?: Array<{ label: string; url: string }> | null;
  chatId: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  emailAttempted?: boolean;
  eventType?: string | null;
  message: string;
  module?: string | null;
  title: string;
};

/**
 * What processTelegramDeliveryRetries needs before it will send a row: a chat, a title and a
 * message. The worker passes over a row without them WITHOUT closing it, so that row stays
 * `pending` for ever and takes a place in the worker's due window on every run.
 */
export function isResendableTelegramPayload(
  telegram: Partial<TelegramRetryPayload> | null | undefined,
): telegram is Partial<TelegramRetryPayload> & Pick<TelegramRetryPayload, "chatId" | "message" | "title"> {
  return Boolean(telegram?.chatId && telegram.title && telegram.message);
}

export const DEFERRED_TELEGRAM_UNDELIVERABLE_REASON =
  "Telegram is not deliverable for this recipient (disabled or not connected).";

/**
 * Quiet hours hold Telegram back by writing a `pending` row for the retry worker to send later. A
 * payload that worker cannot send must be skipped at once instead — returns the skip reason, or
 * null when the payload can safely wait. buildDeferredTelegramPayload returns null when Telegram
 * is off by governance or preference, or the recipient has no connected chat.
 */
export function deferredTelegramSkipReason(payload: TelegramRetryPayload | null): string | null {
  if (!payload) return DEFERRED_TELEGRAM_UNDELIVERABLE_REASON;
  if (!isResendableTelegramPayload(payload)) {
    return "Telegram payload is missing its chat, title or message, so nothing can be sent after quiet hours.";
  }
  return null;
}

type PushRetryPayload = {
  actionUrl?: string | null;
  eventType?: string | null;
  externalId: string;
  message: string;
  module?: string | null;
  title: string;
};

// Shared logger for best-effort/fire-and-forget notification sends that must never
// throw into their caller. Structured console logging so a swallowed failure still leaves a trace.
export function logNotificationSendFailure(context: string, error: unknown) {
  logError(`[notifications] ${context} failed`, {
    labels: { event: "notification_send_failed", context },
    error,
  });
  logError(`Notification send failure: ${context}`, {
    labels: { event: "notification_send_failed_detail", context },
    error,
  });
}

// Email/in-app fallback for a Telegram delivery that has exhausted its retries (cron
// worker or manual retry). Only fires when email wasn't already attempted in the
// original send, so a recipient is never double-emailed. Best-effort.
async function triggerTelegramRetryExhaustionFallback(input: {
  deliveryId: string;
  recipientHrId: string | null;
  recipientUserId: string | null;
  telegram: Partial<TelegramRetryPayload>;
}) {
  if (input.telegram.emailAttempted) return;
  if (!input.recipientHrId && !input.recipientUserId) return;
  // A notice whose email AND push are both banned has nothing left for this re-send to add, so it
  // would only duplicate the in-app copy of the original send — the Phoenix CRM 06:55 digest.
  if (phoenixCrmBlocksTelegramFallback(input.telegram.module, input.telegram.eventType)) return;
  // The closing-published notice is already emailed to the whole line as one shared message.
  if (closingPublishBlocksTelegramFallback(input.telegram.module, input.telegram.eventType)) return;
  // The watches built for the owner add no outbound email, on any path.
  if (operatorWatchBlocksTelegramFallback(input.telegram.eventType)) return;
  try {
    await createSystemNotification({
      actionUrl: input.telegram.actionUrl ?? null,
      channels: ["email", "in_app", "push"],
      eventType: input.telegram.eventType ?? "telegram_retry",
      message: String(input.telegram.message ?? ""),
      metadata: { fallbackFrom: "telegram_exhausted", idempotencyKey: `telegram-exhausted-fallback:${input.deliveryId}` },
      module: input.telegram.module ?? "system",
      recipientHrId: input.recipientHrId,
      recipientUserId: input.recipientUserId,
      title: String(input.telegram.title ?? "Phoenix notification"),
    });
  } catch (error) {
    logNotificationSendFailure("system.telegramRetryExhaustionFallback", error);
  }
}

/**
 * Build the email NotificationEmailInput for a single recipient. Extracted so the
 * quiet-hours deferral can persist the EXACT payload (metadata.emailInput) and the
 * deferred-delivery drain can re-dispatch it later without reconstructing context.
 */
async function buildChannelEmailInput(
  input: CreateSystemNotificationInput,
  recipient: RecipientProfile,
  resolvedPriority: string,
): Promise<NotificationEmailInput> {
  const ctaHref = notificationHrefForViewerRole({
    fallbackHref: input.actionUrl ?? input.email?.ctaHref ?? null,
    metadata: input.metadata,
    role: recipient.role,
  });
  const emailContent = await renderChannelContent({ ...input, actionUrl: ctaHref || input.actionUrl }, "email");
  const identity = resolvedEmailIdentity(input, recipient);
  return {
    bcc: input.email?.bcc,
    candidateEmail: input.email?.candidateEmail ?? null,
    cc: input.email?.cc,
    chosenMailbox: input.email?.chosenMailbox ?? null,
    // The credential stamp (reset code / set-your-password link) rides through untouched.
    credentialEmail: input.email?.credentialEmail ?? null,
    ctaHref,
    ctaLabel: input.email?.ctaLabel ?? "Open in Phoenix",
    // Passed straight through, NOT run through notificationHrefForViewerRole like the primary
    // above. That helper rewrites a CTA to the surface a given ROLE should land on; a secondary
    // action is a direct link to one thing (today: a file download) and has no per-role variant.
    secondaryCtaHref: input.email?.secondaryCtaHref ?? null,
    secondaryCtaLabel: input.email?.secondaryCtaLabel ?? null,
    employeeHrId: identity.employeeHrId,
    eventType: input.eventType,
    includeHrInbox: input.email?.includeHrInbox,
    identityError: identity.error,
    identityGuard: identity.guard,
    identityStatus: identity.status,
    metrics: input.email?.metrics,
    module: input.module,
    notificationType: input.email?.notificationType ?? notificationTypeFor(input.module),
    planTableHtml: input.email?.planTableHtml,
    planTableText: input.email?.planTableText,
    templateContext: input.email?.templateContext,
    // The notification recipient's own name, so templated greetings address the person
    // receiving the email rather than the employee the notification is about.
    recipientHonorific: managerHonorific(recipient.role, recipient.name),
    recipientName: input.email?.recipientName ?? recipient.name ?? undefined,
    recipientHrId: recipient.hrId ?? undefined,
    recipients: (input.email?.recipients && input.email.recipients.length > 0)
      ? input.email.recipients
      : (recipient.email ? [recipient.email] : []),
    // This email is addressed to ONE person (`recipient`). When their address is missing there is
    // nobody to deliver to, and the empty `recipients` below used to fall through to the stored
    // policy — whose "general" entry routes to hr_notifications — so the shared inbox stood in for
    // the person and the send was recorded as successful. State the failure explicitly instead;
    // resolveNotificationDelivery skips and logs on it. See its GUARD 1.
    recipientAddressUnresolved:
      !(input.email?.recipients && input.email.recipients.length > 0) && !recipient.email,
    recipientMode: input.email?.recipientMode ?? (
      ((input.email?.recipients && input.email.recipients.length > 0) || recipient.email)
        ? "candidate"
        : undefined
    ),
    subject: input.email?.subject ?? emailContent.title,
    summary: input.email?.summary ?? emailContent.message,
    // Lets a domain pin the exact /admin/email-templates key that frames this event.
    subjectHrIdSource: identity.source,
    templateKey: input.email?.templateKey,
    title: input.email?.title ?? emailContent.title,
    tone: input.email?.tone ?? (resolvedPriority === "critical" ? "danger" : "neutral"),
  };
}

/**
 * Build the telegram retry payload for a quiet-hours-deferred telegram delivery, so the
 * existing processTelegramDeliveryRetries worker (which requires metadata.telegram with
 * chatId/title/message) can drain it after quiet hours. Returns null when telegram is
 * not deliverable for this recipient (disabled/not connected) — i.e. nothing to defer.
 */
async function buildDeferredTelegramPayload(
  input: CreateSystemNotificationInput,
  recipient: RecipientProfile,
  preferences: LoadedPreferences,
  emailAttempted: boolean,
): Promise<TelegramRetryPayload | null> {
  const governance = await resolveTelegramGovernance({ eventType: input.eventType, module: input.module });
  if (!governance.enabled || !preferences.telegram_enabled) return null;
  const connection = await loadTelegramConnection({ ...input, recipientHrId: recipient.hrId, recipientUserId: recipient.userId });
  if (connection?.status !== "connected" || !connection.telegram_chat_id) return null;
  const content = await renderChannelContent(input, "telegram");
  const generic = isSensitivePayroll(input) || governance.genericOnly;
  return {
    actionUrl: input.actionUrl ?? null,
    buttons: generic ? null : input.telegram?.buttons ?? content.buttons ?? null,
    chatId: String(connection.telegram_chat_id),
    ctaLabel: generic ? null : input.telegram?.ctaLabel ?? content.ctaLabel ?? null,
    ctaUrl: generic ? null : input.telegram?.ctaUrl ?? content.ctaUrl ?? null,
    emailAttempted,
    eventType: input.eventType,
    message: generic ? GENERIC_PAYSLIP_MESSAGE : content.message,
    module: input.module,
    title: generic ? GENERIC_NOTIFICATION_TITLE : content.title,
  };
}

async function buildDeferredPushPayload(
  input: CreateSystemNotificationInput,
  recipient: RecipientProfile,
  preferences: LoadedPreferences,
): Promise<PushRetryPayload | null> {
  if (!preferences.push_enabled || !recipient.hrId) return null;
  if (!(await hasActivePushSubscription({ ...input, recipientHrId: recipient.hrId, recipientUserId: recipient.userId }))) return null;
  const content = await renderChannelContent(input, "push");
  return {
    actionUrl: input.actionUrl ?? null,
    eventType: input.eventType,
    externalId: recipient.hrId,
    message: content.message,
    module: input.module,
    title: content.title,
  };
}

async function createSystemNotificationForRecipient(input: CreateSystemNotificationInput): Promise<SystemNotificationResult> {
  const eventKey = eventKeyFor(input);
  const policy = resolveNotificationPolicy(input);
  const recipient = await loadRecipientProfile(input);
  const preferences = await loadPreferences({ ...input, recipientHrId: recipient.hrId, recipientUserId: recipient.userId });
  const eventId = await createNotificationEvent(input, eventKey, recipient);
  await audit("notification created", input, eventId, {
    channelPolicy: "unified",
    eventType: input.eventType,
    module: input.module,
    priority: input.priority ?? "normal",
  });

  // `recipientHrId: recipient.hrId` mirrors what loadPreferences is handed six lines up, and it is
  // load-bearing rather than tidy. A bare `...input` passes the CALLER's `recipientHrId`, which is
  // optional and is absent whenever a caller identified the person by user id or email instead — so
  // a guard that reads it saw `undefined` for a real, resolved recipient. Every guard in
  // basePolicyChannels before today keyed on module and eventType only, so nothing noticed; the
  // needs-you guard is the first to key on WHO, and it fails closed, which would have stripped email
  // from the owner's own digest on exactly those calls.
  const channels = basePolicyChannels(
    { ...input, priority: input.priority ?? policy.priority, recipientHrId: recipient.hrId ?? input.recipientHrId ?? null },
    preferences.preferred_channel,
  );
  // A test-world notice is in-app and nothing else, whatever the policy resolved. Every other
  // channel addresses the MIRRORED person: the Telegram chat id, the push subscription and the
  // email are hers, and a test entry reaching any of them is the one thing test accounts exist to
  // prevent. Applied here, after the policy, so no caller and no preference can widen it.
  const deliveryChannels = cleanText(input.testLoginId) ? channels.filter((channel) => channel === "in_app") : channels;
  const deliveries: SystemNotificationDeliveryResult[] = [];
  let emailAttempted = false;
  const quietHoursActive = isWithinQuietHours(preferences);

  for (const channel of deliveryChannels) {
    const idempotencyKey = `${eventKey}:${channel}:${recipient.userId ?? recipient.hrId ?? "unknown"}`;
    const claim = await claimDelivery({ channel, eventId, idempotencyKey, recipient });
    if (!claim.claimed) {
      deliveries.push({ channel, idempotencyKey, reason: claim.alreadySent ? "Delivery already sent." : "Delivery already in progress.", status: "skipped" });
      continue;
    }

    if (modulePreferenceDisabled(preferences, input, channel)) {
      await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Channel disabled by module preference.", recipient, status: "skipped" });
      deliveries.push({ channel, idempotencyKey, reason: "Channel disabled by module preference.", status: "skipped" });
      continue;
    }

    if (quietHoursActive && !policy.bypassQuietHours && channel !== "in_app") {
      // Persist the channel payload so the deferred-delivery drain (email) and the
      // telegram retry worker (telegram) can re-dispatch this row after quiet hours.
      // Previously a deferred row was written `pending` with no payload and NEVER
      // drained — the notification was silently lost.
      const deferredMetadata: Record<string, unknown> = { quietHours: true };
      if (channel === "email" && preferences.email_enabled) {
        const emailInput = await buildChannelEmailInput(input, recipient, input.priority ?? policy.priority);
        const identity = validateNotificationEmailIdentity(emailInput);
        Object.assign(deferredMetadata, emailDeliveryMetadata(identity, emailInput));
        if (!identity.ok) {
          await upsertDelivery({
            channel,
            eventId,
            idempotencyKey,
            lastError: identity.reason,
            metadata: deferredMetadata,
            recipient,
            status: "skipped",
          });
          await audit("delivery skipped", input, eventId, { channel, emailIdentity: identity.metadata, error: identity.reason, reason: "email_identity_guard" });
          deliveries.push({ channel, idempotencyKey, reason: identity.reason, status: "skipped" });
          continue;
        }
        // Deliberately still `pending` when emailInput.recipientAddressUnresolved is set, unlike
        // Telegram and push. That flag alone is not GUARD 1 in resolveNotificationDelivery: GUARD 1
        // also needs the stored policy's person modes (and candidateEmail, which the auth emails
        // rely on) to resolve nobody, and it reads them when the email is sent. When quiet hours
        // end, processDeferredDeliveryRetries sends this payload through safeSendNotificationEmail,
        // which runs that guard before queueing and closes the row `skipped` — not pending for ever.
        deferredMetadata.emailInput = emailInput;
        // The held email is sent when quiet hours end. Without this the held Telegram message
        // carries emailAttempted = false, and if its retries run out the fallback emails the
        // person a second time.
        emailAttempted = true;
      } else if (channel === "email") {
        // Email is disabled for this recipient — skip immediately rather than writing a
        // payload-less pending row that the deferred-drain cron can never re-dispatch.
        // Set emailAttempted so downstream Telegram fallback logic treats email as handled.
        emailAttempted = true;
        await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Email disabled by preference.", recipient, status: "skipped" });
        deliveries.push({ channel, idempotencyKey, reason: "Email notifications are disabled for this user.", status: "skipped" });
        continue;
      }
      if (channel === "telegram") {
        // Mirror the live branch: a broken saved template must degrade to a skipped
        // delivery, never reject the whole notification after the domain DB write.
        let telegramPayload: TelegramRetryPayload | null;
        try {
          telegramPayload = await buildDeferredTelegramPayload(input, recipient, preferences, emailAttempted);
        } catch (error) {
          if (!(error instanceof TelegramTemplateError)) throw error;
          const message = error.message;
          await upsertDelivery({ channel, eventId, idempotencyKey, lastError: message, metadata: { skippedBy: "telegram_template_governance", templateErrorCode: error.code }, recipient, status: "skipped" });
          await audit("delivery skipped", input, eventId, { channel, error: message, reason: "telegram_template_governance" });
          deliveries.push({ channel, idempotencyKey, reason: message, status: "skipped" });
          continue;
        }
        // Same reasoning as push below: Telegram off (governance or preference) or not connected
        // leaves nothing to send, and processTelegramDeliveryRetries passes over a row with no
        // payload without closing it. Written `pending`, it never drained, and callers that
        // count `pending` as reached (releaseNoticeReached) believed someone had been told.
        const telegramSkipReason = deferredTelegramSkipReason(telegramPayload);
        if (telegramSkipReason) {
          await upsertDelivery({ channel, eventId, idempotencyKey, lastError: telegramSkipReason, recipient, status: "skipped" });
          deliveries.push({ channel, idempotencyKey, reason: telegramSkipReason, status: "skipped" });
          continue;
        }
        deferredMetadata.telegram = telegramPayload;
        deferredMetadata.retry = true;
      }
      if (channel === "push") {
        const pushPayload = await buildDeferredPushPayload(input, recipient, preferences);
        if (pushPayload) {
          deferredMetadata.push = pushPayload;
          deferredMetadata.retry = true;
        } else {
          // No active subscription (or push disabled) — skip terminally rather than
          // writing a payload-less "pending" row. processPushDeliveryRetries can never
          // resend a row with no push payload, so it would otherwise sit in the queue
          // forever, re-selected on every cron run (and, once numerous, crowd out
          // genuinely retryable rows under the drain's row limit).
          await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "No active push subscription for recipient.", recipient, status: "skipped" });
          deliveries.push({ channel, idempotencyKey, reason: "No active push subscription for recipient.", status: "skipped" });
          continue;
        }
      }
      await upsertDelivery({
        channel,
        eventId,
        idempotencyKey,
        lastError: "Deferred by quiet hours.",
        metadata: deferredMetadata,
        nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        recipient,
        status: "pending",
      });
      deliveries.push({ channel, idempotencyKey, reason: "Deferred by quiet hours.", status: "pending" });
      continue;
    }

    if (channel === "in_app") {
      // The bell is keyed on an HR ID (listInAppNotificationsForViewer returns nothing without one),
      // so a recipient known only by a login — the admin-HR service account — can never open this.
      // Recording it "sent" is the lie the in-app-sent-recipient-must-be-able-to-see-it reconciliation
      // check exists to catch: 385 rows of it by 2026-10-23.
      const noBell = !recipient.hrId;
      const status = preferences.in_app_enabled && !noBell ? "sent" : "skipped";
      const reason = noBell
        ? NO_HR_ID_IN_APP_REASON
        : preferences.in_app_enabled
          ? undefined
          : "In-app notifications are disabled for this user.";
      await upsertDelivery({ channel, eventId, idempotencyKey, lastError: status === "skipped" ? reason : undefined, recipient, status });
      deliveries.push({ channel, idempotencyKey, reason, status });
      continue;
    }

    if (channel === "email") {
      emailAttempted = true;
      if (!preferences.email_enabled) {
        await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Email disabled by preference.", recipient, status: "skipped" });
        deliveries.push({ channel, idempotencyKey, reason: "Email notifications are disabled for this user.", status: "skipped" });
        continue;
      }

      const emailInput = await buildChannelEmailInput(input, recipient, input.priority ?? policy.priority);
      const identity = validateNotificationEmailIdentity(emailInput);
      if (!identity.ok) {
        await upsertDelivery({
          channel,
          eventId,
          idempotencyKey,
          lastError: identity.reason,
          metadata: emailDeliveryMetadata(identity, emailInput),
          provider: "email",
          recipient,
          recipientAddress: recipient.email,
          status: "skipped",
        });
        await audit("delivery skipped", input, eventId, { channel, emailIdentity: identity.metadata, error: identity.reason, reason: "email_identity_guard" });
        deliveries.push({ channel, idempotencyKey, reason: identity.reason, status: "skipped" });
        continue;
      }
      const result = await safeSendNotificationEmail(emailInput);
      // "skipped" here bundles genuine policy/guard skips together with a handoff to the
      // outbox for retry — mirror processDeferredDeliveryRetries' handling of the exact
      // same union (system.ts, "Deterministic skip (policy disabled, no recipients, …)"
      // vs. "handed off to outbox... mark this row done"): a retry handoff is delegated
      // delivery, not a failure, so it counts as sent; everything else is a deterministic
      // skip, never a "failed" (there is no send attempt to have failed here).
      const handedOffToOutbox = result.skipped && result.reason.startsWith("Queued for retry:");
      const status = !result.skipped || handedOffToOutbox ? "sent" : "skipped";
      const error = result.skipped && !handedOffToOutbox ? result.reason : undefined;
      await upsertDelivery({
        channel,
        eventId,
        idempotencyKey,
        lastError: error ?? null,
        metadata: emailDeliveryMetadata(identity, emailInput),
        provider: "email",
        providerMessageId: result.skipped ? null : result.id,
        recipient,
        recipientAddress: recipient.email,
        status,
      });
      await audit(status === "sent" ? "delivery sent" : "delivery skipped", input, eventId, { channel, error });
      deliveries.push({ channel, error, idempotencyKey, ...(handedOffToOutbox ? { queuedForRetry: true } : {}), status });
      continue;
    }

    if (channel === "telegram") {
      const telegramGovernance = await resolveTelegramGovernance({
        eventType: input.eventType,
        module: input.module,
      });
      if (!telegramGovernance.enabled) {
        await upsertDelivery({
          channel,
          eventId,
          idempotencyKey,
          lastError: telegramGovernance.reason ?? "Telegram is not allowed by current policy.",
          metadata: {
            globalEnabled: telegramGovernance.globalEnabled,
            modulePolicy: telegramGovernance.modulePolicy,
          },
          recipient,
          status: "skipped",
        });
        deliveries.push({
          channel,
          idempotencyKey,
          reason: telegramGovernance.reason ?? "Telegram is not allowed by current policy.",
          status: "skipped",
        });
        continue;
      }

      if (!preferences.telegram_enabled) {
        await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Telegram disabled by preference.", recipient, status: "skipped" });
        deliveries.push({ channel, idempotencyKey, reason: "Telegram notifications are disabled for this user.", status: "skipped" });
        continue;
      }

      const connection = await loadTelegramConnection({ ...input, recipientHrId: recipient.hrId, recipientUserId: recipient.userId });
      if (connection?.status !== "connected" || !connection.telegram_chat_id) {
        await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Telegram is not connected.", recipient, status: "skipped" });
        deliveries.push({ channel, idempotencyKey, reason: "Telegram is not connected.", status: "skipped" });
        continue;
      }

      let telegramContent: Awaited<ReturnType<typeof renderChannelContent>> | null = null;
      try {
        telegramContent = await renderChannelContent(input, "telegram");
        const genericTelegram = isSensitivePayroll(input) || telegramGovernance.genericOnly;
        const result = await sendTelegramNotification({
          actionUrl: input.actionUrl ?? null,
          buttons: genericTelegram ? null : input.telegram?.buttons ?? telegramContent.buttons ?? null,
          chatId: String(connection.telegram_chat_id),
          ctaLabel: genericTelegram ? null : input.telegram?.ctaLabel ?? telegramContent.ctaLabel ?? null,
          ctaUrl: genericTelegram ? null : input.telegram?.ctaUrl ?? telegramContent.ctaUrl ?? null,
          keepParagraphs: !genericTelegram && telegramKeepsParagraphs(input.module),
          message: genericTelegram ? GENERIC_PAYSLIP_MESSAGE : telegramContent.message,
          title: genericTelegram ? GENERIC_NOTIFICATION_TITLE : telegramContent.title,
        });
        const status = result.skipped ? "skipped" : "sent";
        const reason = result.skipped ? result.reason : undefined;
        await upsertDelivery({
          channel,
          eventId,
          idempotencyKey,
          lastError: reason ?? null,
          provider: "telegram",
          providerMessageId: result.skipped ? null : result.providerMessageId,
          recipient,
          recipientAddress: String(connection.telegram_chat_id),
          status,
        });
        await audit(status === "sent" ? "delivery sent" : "test notification sent/skipped", input, eventId, { channel, reason });
        deliveries.push({ channel, idempotencyKey, reason, status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Telegram delivery failed.";
        if (error instanceof TelegramTemplateError) {
          await upsertDelivery({
            channel,
            eventId,
            idempotencyKey,
            lastError: message,
            metadata: { skippedBy: "telegram_template_governance", templateErrorCode: error.code },
            provider: "telegram",
            recipient,
            recipientAddress: String(connection.telegram_chat_id),
            status: "skipped",
          });
          await audit("delivery skipped", input, eventId, { channel, error: message, reason: "telegram_template_governance" });
          deliveries.push({ channel, idempotencyKey, reason: message, status: "skipped" });
          continue;
        }
        // Permanent unreachable error (chat not found / bot blocked / user deactivated): retrying
        // will never succeed and the connection would otherwise stay `connected` and keep failing
        // silently. Flag it for re-link, record a terminal skipped delivery (no retry churn), and
        // still fall through to the email/in-app fallback so the recipient is not left uncovered.
        if (isPermanentTelegramDeliveryError(message)) {
          await markTelegramConnectionNeedsRelink(recipient, message);
          await upsertDelivery({
            channel,
            eventId,
            idempotencyKey,
            lastError: message,
            metadata: { needsRelink: true, permanent: true },
            provider: "telegram",
            recipient,
            recipientAddress: String(connection.telegram_chat_id),
            status: "skipped",
          });
          await audit("delivery skipped", input, eventId, { channel, error: message, reason: "telegram_permanent_needs_relink" });
          deliveries.push({ channel, idempotencyKey, reason: message, status: "skipped" });
          // Both of the channels this re-send adds are banned for some notices (the Phoenix CRM 06:55
          // digest), so for those it can only duplicate the in-app copy already delivered — skip it.
          if (!emailAttempted && preferences.email_enabled && !phoenixCrmBlocksTelegramFallback(input.module, input.eventType) && !closingPublishBlocksTelegramFallback(input.module, input.eventType) && !operatorWatchBlocksTelegramFallback(input.eventType)) {
            const fallback = await createSystemNotification({
              ...input,
              channels: ["email", "in_app", "push"],
              metadata: { ...(input.metadata ?? {}), fallbackFrom: "telegram", idempotencyKey: `${eventKey}:telegram-fallback` },
            });
            deliveries.push(...fallback.deliveries);
          }
          continue;
        }
        await upsertDelivery({
          channel,
          eventId,
          idempotencyKey,
          lastError: message,
          metadata: {
            fallback: "email_or_in_app",
            retry: true,
            telegram: {
              actionUrl: input.actionUrl ?? null,
              buttons: input.telegram?.buttons ?? telegramContent?.buttons ?? null,
              chatId: String(connection.telegram_chat_id),
              ctaLabel: input.telegram?.ctaLabel ?? telegramContent?.ctaLabel ?? null,
              ctaUrl: input.telegram?.ctaUrl ?? telegramContent?.ctaUrl ?? null,
              // Whether email was already attempted in the original send, so the retry
              // worker's exhaustion-fallback doesn't double-email this recipient.
              emailAttempted,
              eventType: input.eventType,
              message: isSensitivePayroll(input) || telegramGovernance.genericOnly ? GENERIC_PAYSLIP_MESSAGE : telegramContent?.message ?? telegramMessageFor(input),
              module: input.module,
              title: isSensitivePayroll(input) || telegramGovernance.genericOnly ? GENERIC_NOTIFICATION_TITLE : telegramContent?.title ?? input.title,
            },
          },
          provider: "telegram",
          recipient,
          recipientAddress: String(connection.telegram_chat_id),
          nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          status: "failed",
        });
        await audit("delivery failed", input, eventId, { channel, error: message, fallback: "email_or_in_app" });
        deliveries.push({ channel, error: message, idempotencyKey, status: "failed" });

        // Same skip as the permanent-failure branch above: nothing for this re-send to add.
        if (!emailAttempted && preferences.email_enabled && !phoenixCrmBlocksTelegramFallback(input.module, input.eventType) && !closingPublishBlocksTelegramFallback(input.module, input.eventType) && !operatorWatchBlocksTelegramFallback(input.eventType)) {
          const fallback = await createSystemNotification({
            ...input,
            channels: ["email", "in_app", "push"],
            metadata: { ...(input.metadata ?? {}), fallbackFrom: "telegram", idempotencyKey: `${eventKey}:telegram-fallback` },
          });
          deliveries.push(...fallback.deliveries);
        }
      }
    }

    if (channel === "push") {
      const externalId = recipient.hrId;
      if (!preferences.push_enabled) {
        await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "Push disabled by preference.", recipient, status: "skipped" });
        deliveries.push({ channel, idempotencyKey, reason: "Push notifications are disabled for this user.", status: "skipped" });
        continue;
      }
      if (!externalId || !(await hasActivePushSubscription({ ...input, recipientHrId: externalId, recipientUserId: recipient.userId }))) {
        await upsertDelivery({ channel, eventId, idempotencyKey, lastError: "No active push subscription for recipient.", recipient, status: "skipped" });
        deliveries.push({ channel, idempotencyKey, reason: "No active push subscription for recipient.", status: "skipped" });
        continue;
      }

      let pushContent: Awaited<ReturnType<typeof renderChannelContent>> | null = null;
      try {
        pushContent = await renderChannelContent(input, "push");
        const result = await sendPushNotification({
          actionUrl: input.actionUrl ?? null,
          externalId,
          message: pushContent.message,
          title: pushContent.title,
        });
        const status = result.skipped ? "skipped" : "sent";
        const reason = result.skipped ? result.reason : undefined;
        await upsertDelivery({
          channel,
          eventId,
          idempotencyKey,
          lastError: reason ?? null,
          provider: "onesignal",
          providerMessageId: result.skipped ? null : result.providerMessageId,
          recipient,
          recipientAddress: externalId,
          status,
        });
        await audit(status === "sent" ? "delivery sent" : "delivery skipped", input, eventId, { channel, reason });
        deliveries.push({ channel, idempotencyKey, reason, status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Push delivery failed.";
        await upsertDelivery({
          channel,
          eventId,
          idempotencyKey,
          lastError: message,
          metadata: {
            push: {
              actionUrl: input.actionUrl ?? null,
              eventType: input.eventType,
              externalId,
              message: pushContent?.message ?? input.message,
              module: input.module,
              title: pushContent?.title ?? input.title,
            },
            retry: true,
          },
          provider: "onesignal",
          recipient,
          recipientAddress: externalId,
          nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          status: "failed",
        });
        await audit("delivery failed", input, eventId, { channel, error: message });
        deliveries.push({ channel, error: message, idempotencyKey, status: "failed" });
      }
    }
  }

  return { deliveries, eventId, eventKey };
}

async function createWorkflowEmailEnvelopeNotification(
  input: CreateSystemNotificationInput,
  recipients: NotificationRecipient[],
  baseIdempotencyKey: string,
): Promise<SystemNotificationResult | null> {
  if (recipients.length === 0) return null;

  // Prefer the first recipient who actually has a deliverable email as "primary" — a
  // synthetic account (e.g. PHX-1, which has no work_email) landing first in the list
  // must not silently swallow the whole envelope email, cc'd real addresses included.
  const primaryIndex = Math.max(0, recipients.findIndex((recipient) => Boolean(pickDeliverableEmail(recipient.email))));
  const primary = recipients[primaryIndex];

  const ccRecipients = recipients.filter((_, index) => index !== primaryIndex);
  const primaryEmail = pickDeliverableEmail(primary.email);
  // MERGED, not overwritten. A caller-supplied `email.cc` used to be dropped here — and only here,
  // so the same call kept its cc when it resolved to ONE recipient and silently lost it at two.
  // That is the worst shape a bug can take: it works while you are testing it with one approver and
  // stops the moment a real request has two. The derived addresses come first so the people the
  // event is actually addressed to stay at the head of the line, then whoever the domain asked to
  // be copied; `deliverableAddresses`/`pickDeliverableEmail` drop anything undeliverable and the Set
  // removes a person who is both a recipient and on the caller's list.
  const cc = Array.from(
    new Set([
      ...deliverableAddresses(ccRecipients),
      ...(input.email?.cc ?? [])
        .map((address) => pickDeliverableEmail(address))
        .filter((address): address is string => Boolean(address)),
    ]),
  ).filter((address) => address !== primaryEmail);
  const primaryKey = recipientKey(primary);

  return createSystemNotificationForRecipient({
    ...input,
    channels: ["email"],
    email: {
      ...(input.email ?? {}),
      cc,
      recipients: primaryEmail ? [primaryEmail] : input.email?.recipients,
    },
    metadata: {
      ...(input.metadata ?? {}),
      emailEnvelope: {
        ccRecipientHrIds: ccRecipients.map((recipient) => recipient.hrId ?? null).filter(Boolean),
        primaryRecipientHrId: primary.hrId ?? null,
        routing: "primary_to_cc",
      },
      ...(baseIdempotencyKey ? { idempotencyKey: `${baseIdempotencyKey}:email-envelope:${primaryKey || "primary"}` } : {}),
    },
    recipientHrId: primary.hrId ?? null,
    recipientUserId: primary.userId ?? null,
  });
}

/**
 * Notify a fixed, caller-supplied list of HR IDs — e.g. "every active Super Admin and the
 * CEO" — instead of a governance-resolved recipient set. Mirrors createSystemNotification's
 * governance branch (per-recipient in-app/telegram, ONE consolidated To/Cc email) for
 * callers that pick their own recipient list rather than using
 * resolveNotificationRecipientsWithGovernance.
 *
 * Bug fixed here (owner report, 2026-07-22): callers like notifyOutstationSubmitted looped
 * createSystemNotification once per recipientHrId. Each of those calls hits the "explicit
 * recipient" branch below, which bypasses the governance branch's email-envelope
 * consolidation entirely — every recipient got their OWN independent email, so a
 * 3-recipient event fired 3 separate emails instead of 1. Callers with a fixed recipient
 * list should use this helper instead of looping createSystemNotification themselves.
 */
export async function createSystemNotificationForRecipients(
  input: Omit<CreateSystemNotificationInput, "recipientHrId" | "recipientUserId">,
  recipientHrIds: Array<string | null | undefined>,
): Promise<SystemNotificationResult> {
  const uniqueHrIds = Array.from(new Set(recipientHrIds.map((hrId) => cleanHrId(hrId)).filter(Boolean)));
  if (uniqueHrIds.length === 0) return { deliveries: [], eventId: null, eventKey: "" };

  for (const hrId of uniqueHrIds) {
    if (!explicitRecipientAllowed({ ...input, recipientHrId: hrId })) {
      return createGovernanceSkippedNotification(input, []);
    }
  }

  if (uniqueHrIds.length === 1) {
    return createSystemNotificationForRecipient({ ...input, recipientHrId: uniqueHrIds[0] });
  }

  // A shared eventKey (from a caller-supplied idempotencyKey with no per-recipient
  // suffix) would make every recipient's notification_events upsert collide on the same
  // row (onConflict: "event_key"), so the last write wins and earlier recipients' in-app
  // notification ends up attributed to the wrong recipient. Suffix per recipient, exactly
  // like the governance branch below does.
  const baseIdempotencyKey = typeof input.metadata?.idempotencyKey === "string" ? cleanText(input.metadata.idempotencyKey) : "";
  const useEmailEnvelope = requestedChannelsForEnvelope(input).includes("email") && !isSensitivePayroll(input);
  const nonEmailChannels = requestedChannelsForEnvelope(input).filter((channel) => channel !== "email");

  const results = await Promise.all(
    uniqueHrIds.flatMap((hrId) => {
      if (useEmailEnvelope && nonEmailChannels.length === 0) return [];
      return [
        createSystemNotificationForRecipient({
          ...input,
          ...(useEmailEnvelope ? { channels: nonEmailChannels } : {}),
          metadata: {
            ...(input.metadata ?? {}),
            ...(baseIdempotencyKey ? { idempotencyKey: `${baseIdempotencyKey}:${hrId}` } : {}),
          },
          recipientHrId: hrId,
        }),
      ];
    }),
  );

  if (useEmailEnvelope) {
    const profiles = await Promise.all(
      uniqueHrIds.map((hrId) => loadRecipientProfile({ ...input, recipientHrId: hrId, recipientUserId: null })),
    );
    const recipients: NotificationRecipient[] = profiles.map((profile) => ({
      email: profile.email,
      hrId: profile.hrId,
      name: profile.name,
      userId: profile.userId,
    }));
    const envelope = await createWorkflowEmailEnvelopeNotification(input, recipients, baseIdempotencyKey);
    if (envelope) results.push(envelope);
  }

  return {
    deliveries: results.flatMap((result) => result.deliveries),
    eventId: results[0]?.eventId ?? null,
    eventKey: results[0]?.eventKey ?? "",
  };
}

export async function createSystemNotification(input: CreateSystemNotificationInput): Promise<SystemNotificationResult> {
  const explicitRecipient = cleanText(input.recipientUserId) || cleanHrId(input.recipientHrId);
  if (explicitRecipient) {
    // Fail-closed: a sensitive module targeting a non-subject explicit recipient is
    // skipped (and audited) instead of leaking full content — use the governed path.
    if (!explicitRecipientAllowed(input)) {
      return createGovernanceSkippedNotification(input, []);
    }
    return createSystemNotificationForRecipient(input);
  }

  const resolution = await resolveNotificationRecipientsWithGovernance({
    actorId: input.actorId,
    eventType: input.eventType,
    metadata: input.metadata,
    module: input.module,
    recordId: input.recordId,
    subjectHrId: input.subjectHrId,
  });
  const recipients = resolution.recipients;

  if (recipients.length === 0) return createGovernanceSkippedNotification(input, resolution.warnings);

  const baseIdempotencyKey = typeof input.metadata?.idempotencyKey === "string" ? cleanText(input.metadata.idempotencyKey) : "";
  const useEmailEnvelope = shouldUseWorkflowEmailEnvelope(input, recipients);
  const nonEmailChannels = requestedChannelsForEnvelope(input).filter((channel) => channel !== "email");
  const results = await Promise.all(
    recipients.flatMap((recipient) => {
      if (useEmailEnvelope && nonEmailChannels.length === 0) return [];
      return [
        createSystemNotificationForRecipient({
          ...input,
          ...(useEmailEnvelope ? { channels: nonEmailChannels } : {}),
          metadata: {
            ...(input.metadata ?? {}),
            ...(baseIdempotencyKey ? { idempotencyKey: `${baseIdempotencyKey}:${recipient.userId ?? recipient.hrId ?? recipient.email}` } : {}),
          },
          recipientHrId: recipient.hrId ?? null,
          recipientUserId: recipient.userId ?? null,
        }),
      ];
    }),
  );
  if (useEmailEnvelope) {
    const emailEnvelope = await createWorkflowEmailEnvelopeNotification(input, recipients, baseIdempotencyKey);
    if (emailEnvelope) results.push(emailEnvelope);
  }

  return {
    deliveries: results.flatMap((result) => result.deliveries),
    eventId: results[0]?.eventId ?? null,
    eventKey: results[0]?.eventKey ?? "",
  };
}

import type { AccessContext } from "@/lib/auth/permissions";
import { conflictError } from "@/lib/http/api-errors";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { logError, logInfo } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Notification Confidence Gate — every automated email in Phoenix passes through
// evaluateAndRecordNotificationSend() from send-phoenix-email.ts (the single choke point
// every automated email goes through, confirmed by tracing every call site — see PR
// description). Built after a 2026-07-23 incident: a newly-deployed "No Activity Recorded"
// notice mass-flagged 92 of 115 active employees off one thin day of attendance data, with
// no safeguard catching it before it fired. A failing check here HOLDS the send outright —
// it is never sent, and a Super Admin must approve or discard it from
// /admin/notification-confidence. A majority of passing checks never outvotes one failing
// one: this class of incident (mass false-positive) is exactly what must never slip through
// on points.

export type NotificationOrigin = {
  employeeHrId?: string | null;
  eventType?: string | null;
  identityStatus?: string | null;
  module?: string | null;
  notificationType?: string | null;
  recipientHrId?: string | null;
  templateKey?: string | null;
};

export type ConfidenceCheck = {
  detail: string;
  name: string;
  // null = not applicable to this send (no penalty, no credit) — e.g. the fan-out check
  // when the caller didn't supply a module/eventType to group by.
  passed: boolean | null;
};

export type ConfidenceGateInput = {
  bcc?: string[];
  cc?: string[];
  html: string;
  idempotencyKey: string;
  origin?: NotificationOrigin | null;
  subject: string;
  text: string;
  to: string[];
};

export type ConfidenceGateResult = {
  checks: ConfidenceCheck[];
  confidencePercent: number;
  decision: "auto_send" | "hold";
  reviewId: string | null;
};

export type NotificationSendReview = {
  bccAddresses: string[];
  ccAddresses: string[];
  checks: ConfidenceCheck[];
  confidencePercent: number;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decision: "auto_send" | "hold";
  decisionNote: string | null;
  employeeHrId: string | null;
  eventType: string | null;
  gateBypassed: boolean;
  id: string;
  idempotencyKey: string;
  module: string | null;
  notificationType: string | null;
  providerMessageId: string | null;
  recipientHrId: string | null;
  renderedHtml: string;
  renderedText: string;
  status: "approved" | "auto_sent" | "discarded" | "held";
  subject: string;
  templateKey: string | null;
  toAddresses: string[];
};

type ReviewRow = {
  bcc_addresses: string[] | null;
  cc_addresses: string[] | null;
  checks: ConfidenceCheck[] | null;
  confidence_percent: number;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision: "auto_send" | "hold";
  decision_note: string | null;
  employee_hr_id: string | null;
  event_type: string | null;
  gate_bypassed: boolean;
  id: string;
  idempotency_key: string;
  module: string | null;
  notification_type: string | null;
  provider_message_id: string | null;
  recipient_hr_id: string | null;
  rendered_html: string;
  rendered_text: string;
  status: "approved" | "auto_sent" | "discarded" | "held";
  subject: string;
  template_key: string | null;
  to_addresses: string[] | null;
};

const REVIEW_COLUMNS =
  "id,idempotency_key,module,event_type,notification_type,template_key,recipient_hr_id,employee_hr_id,to_addresses,cc_addresses,bcc_addresses,subject,rendered_html,rendered_text,checks,confidence_percent,decision,status,gate_bypassed,provider_message_id,decided_by,decided_at,decision_note,created_at";

function mapReviewRow(row: ReviewRow): NotificationSendReview {
  return {
    bccAddresses: row.bcc_addresses ?? [],
    ccAddresses: row.cc_addresses ?? [],
    checks: row.checks ?? [],
    confidencePercent: row.confidence_percent,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decision: row.decision,
    decisionNote: row.decision_note,
    employeeHrId: row.employee_hr_id,
    eventType: row.event_type,
    gateBypassed: row.gate_bypassed,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    module: row.module,
    notificationType: row.notification_type,
    providerMessageId: row.provider_message_id,
    recipientHrId: row.recipient_hr_id,
    renderedHtml: row.rendered_html,
    renderedText: row.rendered_text,
    status: row.status,
    subject: row.subject,
    templateKey: row.template_key,
    toAddresses: row.to_addresses ?? [],
  };
}

function gateEnabled() {
  // Emergency bypass: set NOTIFICATION_CONFIDENCE_GATE_ENABLED=false to stop the gate from
  // ever holding a send (e.g. if the gate itself misbehaves). Sends are still recorded for
  // audit — this only disables the "hold" decision, never the logging.
  const raw = String(process.env.NOTIFICATION_CONFIDENCE_GATE_ENABLED ?? "true").trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

const UNRESOLVED_TOKEN_PATTERN = /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Exported for direct unit coverage (tests/notification-confidence-gate.test.ts) — these are
// pure, no I/O, unlike checkFanoutAnomaly which needs Supabase and evaluateAndRecordNotificationSend.
export function checkContentIntegrity(input: ConfidenceGateInput): ConfidenceCheck {
  const empty = !input.subject.trim() || !input.html.trim() || !input.text.trim();
  const brokenToken = UNRESOLVED_TOKEN_PATTERN.test(input.subject) || UNRESOLVED_TOKEN_PATTERN.test(input.html) || UNRESOLVED_TOKEN_PATTERN.test(input.text);
  const passed = !empty && !brokenToken;
  return {
    detail: passed
      ? "Subject/body fully rendered — no unresolved {{token}}, no empty field."
      : empty
        ? "Subject, HTML body, or text body is empty."
        : "An unresolved {{token}} remains in the rendered content (the template render map is missing this field).",
    name: "content_integrity",
    passed,
  };
}

export function checkRecipientValidity(input: ConfidenceGateInput): ConfidenceCheck {
  const to = input.to.filter(Boolean);
  const passed = to.length > 0 && to.every((address) => EMAIL_PATTERN.test(address));
  return {
    detail: passed ? `${to.length} valid recipient address(es).` : "No recipient, or a recipient address failed basic format validation.",
    name: "recipient_validity",
    passed,
  };
}

// Only a genuine identity FAILURE may hold a send. resolvedEmailIdentity (system.ts) emits
// exactly three statuses: "failed" when the subject HR ID conflicts or is missing on a workflow
// email that requires one (it also sets a non-null identityError); "verified" when a subject HR
// ID resolved; and "not_required" when there simply is no subject employee and none is needed —
// the normal, healthy state for recruitment notices, digests and other non-employee-scoped mail.
//
// Treating "not_required" as a failure (the original `status === "verified"` test) held every one
// of those legitimate sends: confirmed in production, where the only two held rows scored 3/4 with
// the fan-out check PASSING and were blocked solely on `identity_resolved: not_required`. Because
// an omitted status already yields `passed: null`, that logic also punished callers for honestly
// reporting "not_required" while letting silent ones through — backwards. "not_required" is now
// not-applicable (no penalty, no credit), matching how this file treats every other inapplicable
// check.
export function checkIdentityResolved(input: ConfidenceGateInput): ConfidenceCheck {
  const status = input.origin?.identityStatus ?? null;
  if (!status) {
    return { detail: "No identity status supplied by the caller.", name: "identity_resolved", passed: null };
  }
  if (status === "not_required") {
    return {
      detail: "Recipient identity status: not_required (no subject employee is needed for this notification).",
      name: "identity_resolved",
      passed: null,
    };
  }
  return { detail: `Recipient identity status: ${status}.`, name: "identity_resolved", passed: status === "verified" };
}

// How far back "current burst" looks, and how many days of history make a (module, eventType)
// pair "established" enough to trust a statistical baseline over the flat first-run ceiling.
const FANOUT_WINDOW_MINUTES = 15;
const BASELINE_MIN_HISTORY_DAYS = 5;
const BASELINE_STDDEV_MULTIPLIER = 3;
const FIRST_RUN_MAX_ABSOLUTE = 10;
const FIRST_RUN_MAX_HEADCOUNT_FRACTION = 0.25;

/**
 * The check that would have caught the 2026-07-23 incident. Two modes:
 *  - Established (module,eventType) pairs (≥5 distinct days of prior history): flag only a
 *    genuine statistical outlier vs that pair's own baseline — so a routinely-large batch
 *    (e.g. a payroll run touching 100+ employees) never trips this once it has a track record.
 *  - Brand-new/rare pairs (no track record yet — exactly the incident's shape: a newly
 *    deployed notification firing for the first time): fall back to a flat ceiling, capped at
 *    both an absolute number and a fraction of the current active headcount, so a first-ever
 *    run cannot silently flood most of the company before anyone notices.
 * Infra failures here fail OPEN (pass), matching this file's existing philosophy — a
 * transient DB hiccup must never become a second, self-inflicted email outage.
 */
async function checkFanoutAnomaly(origin: NotificationOrigin | null | undefined): Promise<ConfidenceCheck> {
  const moduleName = origin?.module ?? null;
  const eventType = origin?.eventType ?? null;
  if (!moduleName || !eventType) {
    return { detail: "No module/eventType supplied by the caller.", name: "fanout_anomaly", passed: null };
  }
  try {
    const supabase = getSupabaseAdmin();
    const { count: recentCount, error: recentError } = await supabase
      .from("notification_send_reviews")
      .select("id", { count: "exact", head: true })
      .eq("module", moduleName)
      .eq("event_type", eventType)
      .gte("created_at", new Date(Date.now() - FANOUT_WINDOW_MINUTES * 60_000).toISOString());
    if (recentError) throw recentError;
    const currentBurst = (recentCount ?? 0) + 1; // +1: this send itself hasn't been recorded yet

    const { data: dailyRows, error: dailyError } = await supabase
      .from("notification_send_reviews")
      .select("created_at")
      .eq("module", moduleName)
      .eq("event_type", eventType)
      .lt("created_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
      .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString())
      .limit(5000);
    if (dailyError) throw dailyError;

    const byDay = new Map<string, number>();
    for (const row of (dailyRows ?? []) as Array<{ created_at: string }>) {
      const day = row.created_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    const dailyCounts = Array.from(byDay.values());

    if (dailyCounts.length >= BASELINE_MIN_HISTORY_DAYS) {
      const mean = dailyCounts.reduce((sum, value) => sum + value, 0) / dailyCounts.length;
      const variance = dailyCounts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / dailyCounts.length;
      const stddev = Math.sqrt(variance);
      const ceiling = Math.max(mean + BASELINE_STDDEV_MULTIPLIER * stddev, mean * 2, 3);
      const passed = currentBurst <= ceiling;
      return {
        detail: `${currentBurst} in the last ${FANOUT_WINDOW_MINUTES}m vs an established baseline of ~${mean.toFixed(1)}/day (±${stddev.toFixed(1)} stddev) over ${dailyCounts.length} prior days.`,
        name: "fanout_anomaly",
        passed,
      };
    }

    const employees = await getEmployeeDirectoryRows().catch(() => []);
    const headcount = employees.length || 1;
    const ceiling = Math.max(3, Math.min(FIRST_RUN_MAX_ABSOLUTE, Math.round(headcount * FIRST_RUN_MAX_HEADCOUNT_FRACTION)));
    const passed = currentBurst <= ceiling;
    return {
      detail: `${currentBurst} in the last ${FANOUT_WINDOW_MINUTES}m for "${moduleName}/${eventType}", which has no established history yet — capped at ${ceiling} while it's new.`,
      name: "fanout_anomaly",
      passed,
    };
  } catch (error) {
    logError("Confidence gate fan-out check failed — defaulting to pass (fail-open on infra error)", {
      error,
      labels: { event: "confidence_gate_fanout_check_failed", eventType, module: moduleName },
    });
    return { detail: "Fan-out check could not run (infra error) — defaulted to pass.", name: "fanout_anomaly", passed: true };
  }
}

// Minimum number of PRIOR SENDS (not days — a recipient-count distribution is a per-send metric,
// unlike fanout's per-day event frequency) of this (module,eventType) pair needed to trust a
// statistical baseline over the flat first-run ceiling.
const RECIPIENT_VOLUME_MIN_HISTORY_SENDS = 5;

/**
 * Pure decision math for checkRecipientVolume, split out so it is unit-testable without Supabase
 * (checkFanoutAnomaly's equivalent logic is not, hence this file's docs noting that one needs I/O
 * — this function deliberately does not).
 */
export function computeRecipientVolumeCeiling(
  priorCounts: number[],
  headcount: number,
): { basis: "established" | "first_run"; ceiling: number; mean?: number; stddev?: number } {
  if (priorCounts.length >= RECIPIENT_VOLUME_MIN_HISTORY_SENDS) {
    const mean = priorCounts.reduce((sum, value) => sum + value, 0) / priorCounts.length;
    const variance = priorCounts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / priorCounts.length;
    const stddev = Math.sqrt(variance);
    return { basis: "established", ceiling: Math.max(mean + BASELINE_STDDEV_MULTIPLIER * stddev, mean * 2, 3), mean, stddev };
  }
  const ceiling = Math.max(3, Math.min(FIRST_RUN_MAX_ABSOLUTE, Math.round(headcount * FIRST_RUN_MAX_HEADCOUNT_FRACTION)));
  return { basis: "first_run", ceiling };
}

/**
 * Catches what checkFanoutAnomaly cannot: a SINGLE send with an unusually large recipient list.
 * fanoutToBcc (send-phoenix-email.ts) deliberately collapses many recipients into one email (all
 * but the primary go to BCC) so a burst of individually-small notifications reads as one send to
 * the fan-out check — but that same collapsing means a single mis-scoped notification policy
 * (e.g. "general" recipientMode "selected_titles_all_lines" with targetTitles: ["Medical
 * Representative"], loadEmployeesByTitlesAndLines returning every matching employee unbounded)
 * can reach hundreds of people in ONE send. checkFanoutAnomaly's event-per-15-minute counter sees
 * that as a burst of exactly 1 and waves it through; checkRecipientValidity only inspects `to`
 * (length 1, since the rest are BCC'd), so it passes too. Before this check, that path was
 * "Company-wide email, no cap, no hold, no confirmation" — found auditing the gate, not from a
 * live incident, but it is the same shape as the 2026-07-23 incident this gate exists to catch.
 *
 * Same two-mode shape as checkFanoutAnomaly, over recipient COUNT PER SEND instead of send COUNT
 * PER WINDOW: an established (module,eventType) pair is judged against its own historical per-send
 * recipient-count baseline (so a routinely-large distribution list, e.g. a company-wide holiday
 * announcement, never trips this once it has a track record); a brand-new/rare pair gets the same
 * flat first-run ceiling as checkFanoutAnomaly. Fails OPEN on infra error, matching this file's
 * existing philosophy — a transient DB hiccup must never become a second, self-inflicted outage.
 */
async function checkRecipientVolume(input: ConfidenceGateInput): Promise<ConfidenceCheck> {
  const moduleName = input.origin?.module ?? null;
  const eventType = input.origin?.eventType ?? null;
  if (!moduleName || !eventType) {
    return { detail: "No module/eventType supplied by the caller.", name: "recipient_volume", passed: null };
  }
  const currentRecipientCount =
    input.to.filter(Boolean).length + (input.cc ?? []).filter(Boolean).length + (input.bcc ?? []).filter(Boolean).length;
  try {
    const supabase = getSupabaseAdmin();
    const { data: priorRows, error: priorError } = await supabase
      .from("notification_send_reviews")
      .select("to_addresses, cc_addresses, bcc_addresses")
      .eq("module", moduleName)
      .eq("event_type", eventType)
      .lt("created_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
      .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString())
      .limit(500);
    if (priorError) throw priorError;

    const priorCounts = ((priorRows ?? []) as Array<{
      bcc_addresses: string[] | null;
      cc_addresses: string[] | null;
      to_addresses: string[] | null;
    }>).map((row) => (row.to_addresses?.length ?? 0) + (row.cc_addresses?.length ?? 0) + (row.bcc_addresses?.length ?? 0));

    const employees = await getEmployeeDirectoryRows().catch(() => []);
    const headcount = employees.length || 1;
    const { basis, ceiling, mean, stddev } = computeRecipientVolumeCeiling(priorCounts, headcount);
    const passed = currentRecipientCount <= ceiling;
    const detail =
      basis === "established"
        ? `${currentRecipientCount} recipient(s) on this send vs an established baseline of ~${(mean ?? 0).toFixed(1)} (±${(stddev ?? 0).toFixed(1)} stddev) over ${priorCounts.length} prior sends of "${moduleName}/${eventType}".`
        : `${currentRecipientCount} recipient(s) on this send for "${moduleName}/${eventType}", which has no established history yet — capped at ${ceiling} while it's new.`;
    return { detail, name: "recipient_volume", passed };
  } catch (error) {
    logError("Confidence gate recipient-volume check failed — defaulting to pass (fail-open on infra error)", {
      error,
      labels: { event: "confidence_gate_recipient_volume_check_failed", eventType, module: moduleName },
    });
    return { detail: "Recipient-volume check could not run (infra error) — defaulted to pass.", name: "recipient_volume", passed: true };
  }
}

export function computeDecision(checks: ConfidenceCheck[]): { confidencePercent: number; decision: "auto_send" | "hold" } {
  const applicable = checks.filter((check) => check.passed !== null);
  const failed = applicable.filter((check) => check.passed === false);
  const confidencePercent = applicable.length === 0
    ? 100
    : Math.round((applicable.filter((check) => check.passed === true).length / applicable.length) * 100);
  // One failing check holds the send outright — a majority of green checks never outvotes a
  // single red one. Averaging-to-a-threshold would have let this exact incident's fan-out
  // failure get diluted by three unrelated passing checks.
  return { confidencePercent, decision: failed.length > 0 ? "hold" : "auto_send" };
}

/** Called from send-phoenix-email.ts immediately before every real dispatch attempt. */
export async function evaluateAndRecordNotificationSend(input: ConfidenceGateInput): Promise<ConfidenceGateResult> {
  const enabled = gateEnabled();
  const checks: ConfidenceCheck[] = [
    checkContentIntegrity(input),
    checkRecipientValidity(input),
    checkIdentityResolved(input),
    await checkFanoutAnomaly(input.origin),
    await checkRecipientVolume(input),
  ];
  const computed = computeDecision(checks);
  let decision = computed.decision;
  const confidencePercent = computed.confidencePercent;
  if (!enabled && decision === "hold") {
    checks.push({ detail: "NOTIFICATION_CONFIDENCE_GATE_ENABLED=false — gate bypassed, this would otherwise have been held.", name: "gate_enabled", passed: null });
    decision = "auto_send";
  }

  let reviewId: string | null = null;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_send_reviews")
      .insert({
        bcc_addresses: input.bcc ?? [],
        cc_addresses: input.cc ?? [],
        checks,
        confidence_percent: confidencePercent,
        decision,
        employee_hr_id: input.origin?.employeeHrId ?? null,
        event_type: input.origin?.eventType ?? null,
        gate_bypassed: !enabled,
        idempotency_key: input.idempotencyKey,
        module: input.origin?.module ?? null,
        notification_type: input.origin?.notificationType ?? null,
        recipient_hr_id: input.origin?.recipientHrId ?? null,
        rendered_html: input.html,
        rendered_text: input.text,
        status: decision === "hold" ? "held" : "auto_sent",
        subject: input.subject,
        template_key: input.origin?.templateKey ?? null,
        to_addresses: input.to,
      })
      .select("id")
      .single();
    if (error) throw error;
    reviewId = (data as { id: string }).id;
  } catch (error) {
    // Never let an audit-logging failure block or hold an otherwise-legitimate send.
    logError("Confidence gate failed to persist send review — proceeding without a durable record", {
      error,
      labels: { event: "confidence_gate_persist_failed" },
    });
    decision = "auto_send";
  }

  if (decision === "hold") {
    logInfo(`Notification held for review: ${input.origin?.module ?? "unknown"}/${input.origin?.eventType ?? "unknown"} (${confidencePercent}% confidence)`, {
      labels: { event: "confidence_gate_held", eventType: input.origin?.eventType ?? "", module: input.origin?.module ?? "", reviewId: reviewId ?? "" },
    });
    // Tell a Super Admin the mail is sitting undelivered. A log line alone left two real
    // recruitment emails unnoticed for ~22 hours on 2026-07-24. In-app + Telegram only (never
    // email — that would re-enter this gate); throttled to one alert per module/eventType per hour
    // so a mass-hold burst cannot bury the signal. Lazy import: this module is imported BY
    // send-phoenix-email.ts at module scope, and the alert reaches system.ts → email.ts →
    // send-phoenix-email.ts, so a top-level import here would close that cycle (same reason
    // approveHeldNotification imports sendPhoenixEmail lazily below). Awaited but never throwing.
    try {
      const { notifyNotificationHeld } = await import("@/lib/notifications/held-notification-alert");
      await notifyNotificationHeld({
        confidencePercent,
        eventType: input.origin?.eventType ?? null,
        failedCheckNames: checks.filter((check) => check.passed === false).map((check) => check.name),
        module: input.origin?.module ?? null,
        reviewId,
        subject: input.subject,
      });
    } catch (error) {
      logError("Held-notification alert could not be dispatched — the hold itself still stands", {
        error,
        labels: { event: "confidence_gate_held_alert_failed", reviewId: reviewId ?? "" },
      });
    }
  }

  return { checks, confidencePercent, decision, reviewId };
}

/** Best-effort: attach the provider's message id to the review row once a send succeeds. */
export async function markNotificationSendDelivered(reviewId: string | null, providerMessageId: string | undefined) {
  if (!reviewId) return;
  try {
    await getSupabaseAdmin()
      .from("notification_send_reviews")
      .update({ provider_message_id: providerMessageId ?? null, updated_at: new Date().toISOString() })
      .eq("id", reviewId);
  } catch (error) {
    logError("Confidence gate failed to record delivered provider id", { error, labels: { event: "confidence_gate_mark_delivered_failed", reviewId } });
  }
}

function assertConfidenceGateActor(access: Pick<AccessContext, "role">) {
  if (access.role !== "Super Admin") {
    throw new Error("Forbidden: only Super Admin can review held notifications.");
  }
}

export async function listRecentNotificationSends(access: AccessContext, input: { limit?: number } = {}): Promise<NotificationSendReview[]> {
  assertConfidenceGateActor(access);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const { data, error } = await getSupabaseAdmin()
    .from("notification_send_reviews")
    .select(REVIEW_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as ReviewRow[]).map(mapReviewRow);
}

export async function listPendingNotificationReviews(access: AccessContext): Promise<NotificationSendReview[]> {
  assertConfidenceGateActor(access);
  const { data, error } = await getSupabaseAdmin()
    .from("notification_send_reviews")
    .select(REVIEW_COLUMNS)
    .eq("status", "held")
    .order("created_at", { ascending: true })
    .limit(300);
  if (error) throw error;
  return ((data ?? []) as ReviewRow[]).map(mapReviewRow);
}

export async function discardHeldNotification(access: AccessContext, reviewId: string, note?: string) {
  assertConfidenceGateActor(access);
  const decidedBy = access.hrId ?? access.loginId ?? "system";
  const { data, error } = await getSupabaseAdmin()
    .from("notification_send_reviews")
    .update({
      decided_at: new Date().toISOString(),
      decided_by: decidedBy,
      decision_note: note?.trim() || null,
      status: "discarded",
      updated_at: new Date().toISOString(),
    })
    .eq("id", reviewId)
    .eq("status", "held")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw conflictError("This item is no longer pending review (already decided, or not found).");
}

/**
 * A Super Admin manually approving a held item — sends the EXACT content that was rendered
 * at hold time (never re-rendered, so what the admin reviewed is what goes out), bypassing
 * the gate for this one already-reviewed send. Dynamic import: confidence-gate.ts is imported
 * BY send-phoenix-email.ts at module scope, so this side stays a lazy, function-scoped import
 * to keep the cycle safe (same pattern already used elsewhere in this codebase for a
 * table-builder cycle between email-templates/service.ts and a domain module).
 */
export async function approveHeldNotification(access: AccessContext, reviewId: string, note?: string) {
  assertConfidenceGateActor(access);
  const decidedBy = access.hrId ?? access.loginId ?? "system";
  const { data: row, error: fetchError } = await getSupabaseAdmin()
    .from("notification_send_reviews")
    .select(REVIEW_COLUMNS)
    .eq("id", reviewId)
    .eq("status", "held")
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!row) throw conflictError("This item is no longer pending review (already decided, or not found).");
  const held = mapReviewRow(row as ReviewRow);

  const { sendPhoenixEmail } = await import("@/lib/email/send-phoenix-email");
  const result = await sendPhoenixEmail({
    bcc: held.bccAddresses,
    bypassConfidenceGate: true,
    cc: held.ccAddresses,
    html: held.renderedHtml,
    idempotencyKey: `${held.idempotencyKey}:approved`,
    subject: held.subject,
    text: held.renderedText,
    to: held.toAddresses,
  });
  if ("skipped" in result && result.skipped) {
    throw new Error(`Approved, but the send still failed: ${result.reason}`);
  }

  const { error: updateError } = await getSupabaseAdmin()
    .from("notification_send_reviews")
    .update({
      decided_at: new Date().toISOString(),
      decided_by: decidedBy,
      decision_note: note?.trim() || null,
      provider_message_id: "id" in result ? (result.id ?? null) : null,
      status: "approved",
      updated_at: new Date().toISOString(),
    })
    .eq("id", reviewId);
  if (updateError) throw updateError;
}

import {
  assertPermission,
  normalizeHrId,
  resolveEmployeeIdentityId,
  systemAccessContext,
  type AccessContext,
} from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";
import { buildDeductionCandidateKey } from "@/lib/deductions-governance/candidate-key";
import { assertDeductionsGovernanceDecisionActor } from "@/lib/deductions-governance/calculations";
import {
  compactDeductionHrId,
  insertDeductionCandidateDrafts,
  updateDeductionDecision,
} from "@/lib/deductions-governance/service";
import { conflictError } from "@/lib/http/api-errors";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import type { PrivateCalendarDisputeStatus } from "@/lib/private-calendar/disputes";
import { resolveSuperAdminRecipients } from "@/lib/private-calendar/notify-admin";
import { getCompanyNoActivityDays, type CompanyNoActivityDay } from "@/lib/private-calendar/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// "No Activity Recorded" day clarification + Super Admin deduct/not-deduct
// decision. A deduction decision writes into the SAME deduction_candidates /
// deduction_decisions tables the rest of the Deductions Governance Center
// uses (source_module = 'MANUAL_HR', deduction_type = 'no_activity') so
// there is one payroll ledger, never a parallel one — see
// src/lib/deductions-governance/calculations.ts (payrollColumnForDeduction)
// and src/lib/payroll/copilot/deductions-review.ts
// (buildApprovedDeductionTotals) for the MANUAL_HR wiring.

export type NoActivityResolution = "deducted" | "not_deducted";
export type NoActivityStatus = "pending_review" | "resolved";

export type PrivateCalendarNoActivityClarification = {
  activityDate: string;
  adminHrId: string | null;
  adminNote: string | null;
  clarificationText: string | null;
  confirmedNoActivity: boolean;
  createdAt: string;
  decidedAt: string | null;
  deductionCandidateId: string | null;
  employeeHrId: string;
  employeeName: string | null;
  firstNotifiedAt: string | null;
  id: string;
  resolution: NoActivityResolution | null;
  sourcePointerText: string | null;
  status: NoActivityStatus;
  submittedAt: string | null;
};

type ClarificationRow = {
  activity_date: string;
  admin_hr_id: string | null;
  admin_note: string | null;
  clarification_text: string | null;
  confirmed_no_activity: boolean;
  created_at: string;
  decided_at: string | null;
  deduction_candidate_id: string | null;
  employee_hr_id: string;
  employee_name: string | null;
  first_notified_at: string | null;
  id: string;
  resolution: NoActivityResolution | null;
  source_pointer_text: string | null;
  status: NoActivityStatus;
  submitted_at: string | null;
};

const CLARIFICATION_COLUMNS = "id,employee_hr_id,employee_name,activity_date,clarification_text,source_pointer_text,confirmed_no_activity,submitted_at,status,resolution,deduction_candidate_id,admin_hr_id,admin_note,decided_at,created_at,first_notified_at";

function mapClarificationRow(row: ClarificationRow): PrivateCalendarNoActivityClarification {
  return {
    activityDate: row.activity_date,
    adminHrId: row.admin_hr_id,
    adminNote: row.admin_note,
    clarificationText: row.clarification_text,
    confirmedNoActivity: row.confirmed_no_activity,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    deductionCandidateId: row.deduction_candidate_id,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    firstNotifiedAt: row.first_notified_at,
    id: row.id,
    resolution: row.resolution,
    sourcePointerText: row.source_pointer_text,
    status: row.status,
    submittedAt: row.submitted_at,
  };
}

function clarificationKey(employeeHrId: string, date: string) {
  return `${employeeHrId}|${date}`;
}

export async function submitNoActivityClarification(
  access: AccessContext,
  input: {
    activityDate: string;
    clarificationText?: string | null;
    confirmedNoActivity: boolean;
    employeeName?: string | null;
    sourcePointerText?: string | null;
  },
): Promise<PrivateCalendarNoActivityClarification> {
  await assertPermission(access, "attendance", "read");
  const employeeHrId = resolveEmployeeIdentityId(access);
  if (!employeeHrId) throw new Error("Your employee profile is not linked. Contact HR.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.activityDate)) throw new Error("Invalid date.");

  const clarificationText = input.clarificationText?.trim() || null;
  if (!clarificationText && !input.confirmedNoActivity) {
    throw new Error("Explain what happened, or confirm that no activity occurred that day.");
  }

  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("private_calendar_no_activity_clarifications")
    .select("id,status")
    .eq("employee_hr_id", employeeHrId)
    .eq("activity_date", input.activityDate)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing && (existing as { status: NoActivityStatus }).status === "resolved") {
    throw conflictError("This day has already been decided and can no longer be clarified.");
  }

  const now = new Date().toISOString();
  const payload = {
    activity_date: input.activityDate,
    clarification_text: clarificationText,
    confirmed_no_activity: input.confirmedNoActivity,
    employee_hr_id: employeeHrId,
    employee_name: input.employeeName ?? null,
    source_pointer_text: input.sourcePointerText?.trim() || null,
    status: "pending_review" as const,
    submitted_at: now,
    updated_at: now,
  };

  const query = existing
    ? supabase.from("private_calendar_no_activity_clarifications").update(payload).eq("id", (existing as { id: string }).id)
    : supabase.from("private_calendar_no_activity_clarifications").insert(payload);
  const { data, error } = await query.select(CLARIFICATION_COLUMNS).single();
  if (error) throw error;

  const clarification = mapClarificationRow(data as ClarificationRow);

  await writeAuditLog({
    actorLoginId: access.loginId ?? employeeHrId,
    entityId: clarification.id,
    entityType: "private_calendar_no_activity_clarification",
    newValues: { activityDate: clarification.activityDate, clarificationText, confirmedNoActivity: input.confirmedNoActivity },
    summary: `No-activity clarification submitted for ${clarification.activityDate}`,
  });

  const recipients = await resolveSuperAdminRecipients();
  await Promise.all(recipients.map((recipient) => createSystemNotification({
    actionUrl: "/admin/no-activity-days",
    actorId: employeeHrId,
    channels: ["in_app"],
    eventType: "private_calendar_no_activity_clarified",
    message: `${input.employeeName ?? employeeHrId} clarified the No Activity day ${clarification.activityDate}.`,
    metadata: { clarificationId: clarification.id, employeeHrId, idempotencyKey: `private-calendar-no-activity:${clarification.id}:submitted` },
    module: "private_calendar",
    priority: "low",
    recipientHrId: recipient.hrId,
    subjectHrId: employeeHrId,
    title: `No-activity clarification — ${clarification.activityDate}`,
  })));

  return clarification;
}

export type NoActivityReportRow = CompanyNoActivityDay & {
  clarification: PrivateCalendarNoActivityClarification | null;
  // Set when a DIFFERENT deduction pipeline (e.g. the CRM Field-Workforce
  // no-activity connector) already has a decided candidate covering this
  // exact employee+day — the report shows it read-only instead of allowing a
  // second, possibly-disagreeing decision for the same day.
  existingDecision: { decisionStatus: string; sourceModule: string } | null;
  // Cross-link (any status) to a data-accuracy dispute the same employee filed
  // for the same day, so a decision here is never made blind to a related
  // "the displayed data is wrong" request on the exact same day.
  relatedDispute: { claimText: string; id: string; status: PrivateCalendarDisputeStatus } | null;
};

/**
 * Company-wide No Activity Days report for a date range (typically a payroll
 * cycle window) — every day derivePrivateCalendarExceptions flags as "No
 * Activity Recorded", joined with any employee clarification and any
 * already-decided candidate from another deduction pipeline. Super Admin only
 * (same gate as every other deductions-governance decision surface).
 */
export async function getCompanyNoActivityReport(
  access: AccessContext,
  input: { end: string; start: string },
): Promise<NoActivityReportRow[]> {
  assertDeductionsGovernanceDecisionActor(access);
  const days = await getCompanyNoActivityDays({ access, end: input.end, start: input.start });
  if (days.length === 0) return [];

  const supabase = getSupabaseAdmin();
  const employeeHrIds = Array.from(new Set(days.map((day) => day.employeeHrId)));
  const monthKeys = Array.from(new Set(days.map((day) => day.date.slice(0, 7))));
  const compactIds = new Set(employeeHrIds.map(compactDeductionHrId).filter((value): value is string => Boolean(value)));

  const { data: clarRows, error: clarError } = await supabase
    .from("private_calendar_no_activity_clarifications")
    .select(CLARIFICATION_COLUMNS)
    .in("employee_hr_id", employeeHrIds)
    .gte("activity_date", input.start)
    .lte("activity_date", input.end);
  if (clarError) throw clarError;
  const clarByKey = new Map(
    ((clarRows ?? []) as ClarificationRow[]).map((row) => [clarificationKey(row.employee_hr_id, row.activity_date), mapClarificationRow(row)]),
  );

  const { data: disputeRows, error: disputeError } = await supabase
    .from("private_calendar_data_disputes")
    .select("id,employee_hr_id,dispute_date,claim_text,status")
    .in("employee_hr_id", employeeHrIds)
    .gte("dispute_date", input.start)
    .lte("dispute_date", input.end);
  if (disputeError) throw disputeError;
  const disputeByKey = new Map(
    ((disputeRows ?? []) as Array<{ claim_text: string; dispute_date: string; employee_hr_id: string; id: string; status: PrivateCalendarDisputeStatus }>)
      .map((row) => [clarificationKey(row.employee_hr_id, row.dispute_date), { claimText: row.claim_text, id: row.id, status: row.status }]),
  );

  const { data: candRows, error: candError } = await supabase
    .from("deduction_candidates")
    .select("id,employee_hr_id_compact,source_module,dates,month_key")
    .in("month_key", monthKeys)
    .neq("source_module", "MANUAL_HR")
    .is("superseded_at", null);
  if (candError) throw candError;
  const relevantCandidates = ((candRows ?? []) as Array<{
    dates: string[];
    employee_hr_id_compact: string;
    id: string;
    source_module: string;
  }>).filter((row) => compactIds.has(row.employee_hr_id_compact));

  const candidateIds = relevantCandidates.map((row) => row.id);
  const { data: decRows, error: decError } = candidateIds.length > 0
    ? await supabase.from("deduction_decisions").select("candidate_id,decision_status").in("candidate_id", candidateIds)
    : { data: [] as unknown[], error: null };
  if (decError) throw decError;
  const decisionByCandidateId = new Map(
    ((decRows ?? []) as Array<{ candidate_id: string; decision_status: string }>).map((row) => [row.candidate_id, row.decision_status]),
  );

  const existingByKey = new Map<string, { decisionStatus: string; sourceModule: string }>();
  for (const candidate of relevantCandidates) {
    const decisionStatus = decisionByCandidateId.get(candidate.id);
    if (!decisionStatus || decisionStatus === "Pending") continue;
    for (const date of candidate.dates) {
      existingByKey.set(`${candidate.employee_hr_id_compact}|${date}`, { decisionStatus, sourceModule: candidate.source_module });
    }
  }

  return days.map((day) => {
    const compact = compactDeductionHrId(day.employeeHrId);
    return {
      ...day,
      clarification: clarByKey.get(clarificationKey(day.employeeHrId, day.date)) ?? null,
      existingDecision: compact ? existingByKey.get(`${compact}|${day.date}`) ?? null : null,
      relatedDispute: disputeByKey.get(clarificationKey(day.employeeHrId, day.date)) ?? null,
    };
  });
}

async function decideOneNoActivityDay(
  access: AccessContext,
  input: { activityDate: string; adminNote: string; employeeHrId: string; employeeName?: string | null; resolution: NoActivityResolution },
): Promise<PrivateCalendarNoActivityClarification> {
  const adminNote = input.adminNote.trim();
  if (!adminNote) throw new Error("A decision note is required.");
  const compact = compactDeductionHrId(input.employeeHrId);
  if (!compact) throw new Error("Invalid employee.");
  const monthKey = input.activityDate.slice(0, 7);

  const supabase = getSupabaseAdmin();

  const { data: ownExisting, error: ownExistingError } = await supabase
    .from("private_calendar_no_activity_clarifications")
    .select("id,status")
    .eq("employee_hr_id", input.employeeHrId)
    .eq("activity_date", input.activityDate)
    .maybeSingle();
  if (ownExistingError) throw ownExistingError;
  if (ownExisting && (ownExisting as { status: NoActivityStatus }).status === "resolved") {
    throw conflictError("This day has already been decided.");
  }

  const { data: otherCandidates, error: otherCandidatesError } = await supabase
    .from("deduction_candidates")
    .select("id,source_module,dates")
    .eq("employee_hr_id_compact", compact)
    .eq("month_key", monthKey)
    .neq("source_module", "MANUAL_HR")
    .is("superseded_at", null);
  if (otherCandidatesError) throw otherCandidatesError;
  const conflicting = ((otherCandidates ?? []) as Array<{ dates: string[]; id: string; source_module: string }>)
    .find((candidate) => candidate.dates.includes(input.activityDate));
  if (conflicting) {
    throw conflictError(`This day is already tracked by the ${conflicting.source_module} deduction pipeline — decide it there instead, so there is never two disagreeing records for the same day.`);
  }

  const adminHrId = normalizeHrId(access.hrId) ?? normalizeHrId(access.loginId) ?? "system";
  const now = new Date().toISOString();
  const hasClarification = Boolean(ownExisting);
  const sourceRecordId = `private-calendar-no-activity:${input.employeeHrId}:${input.activityDate}`;
  const decisionStatus = input.resolution === "deducted" ? "Approved for Payroll" : "Do Not Take Action";
  const decisionReason = input.resolution === "deducted"
    ? (hasClarification ? "Policy violation" : "Employee did not respond (auto-confirmed)")
    : (hasClarification ? "Employee confirmed" : "No action needed");

  await insertDeductionCandidateDrafts({
    createdBy: adminHrId,
    drafts: [{
      dates: [input.activityDate],
      deductionType: "no_activity",
      deductionUnit: "days",
      deductionValue: 1,
      employeeCode: input.employeeHrId,
      employeeName: input.employeeName ?? null,
      month: Number(input.activityDate.slice(5, 7)),
      monthKey,
      reason: "Private Calendar No Activity Recorded day — decided via the No Activity Days report.",
      sourceModule: "MANUAL_HR",
      sourceRecordId,
      year: Number(input.activityDate.slice(0, 4)),
    }],
    sourceLabel: "Private Calendar No Activity Report",
  });

  const candidateKey = buildDeductionCandidateKey({
    dates: [input.activityDate],
    deductionType: "no_activity",
    employeeCode: input.employeeHrId,
    monthKey,
    sourceModule: "MANUAL_HR",
    sourceRecordId,
  });
  const { data: candidateRow, error: candidateLookupError } = await supabase
    .from("deduction_candidates")
    .select("id")
    .eq("source_module", "MANUAL_HR")
    .eq("candidate_key", candidateKey)
    .is("superseded_at", null)
    .single();
  if (candidateLookupError) throw candidateLookupError;
  const deductionCandidateId = (candidateRow as { id: string }).id;

  await updateDeductionDecision({
    access,
    candidateId: deductionCandidateId,
    decisionReason,
    decisionStatus,
    hrNote: adminNote,
  });

  const payload = {
    activity_date: input.activityDate,
    admin_hr_id: adminHrId,
    admin_note: adminNote,
    decided_at: now,
    deduction_candidate_id: deductionCandidateId,
    employee_hr_id: input.employeeHrId,
    employee_name: input.employeeName ?? null,
    resolution: input.resolution,
    status: "resolved" as const,
    updated_at: now,
  };
  const query = ownExisting
    ? supabase.from("private_calendar_no_activity_clarifications").update(payload).eq("id", (ownExisting as { id: string }).id)
    : supabase.from("private_calendar_no_activity_clarifications").insert(payload);
  const { data, error } = await query.select(CLARIFICATION_COLUMNS).single();
  if (error) throw error;

  const clarification = mapClarificationRow(data as ClarificationRow);

  await writeAuditLog({
    actorLoginId: access.loginId ?? adminHrId,
    entityId: clarification.id,
    entityType: "private_calendar_no_activity_clarification",
    newValues: { adminNote, decidedAt: now, deductionCandidateId, resolution: input.resolution },
    summary: `No-activity day ${clarification.activityDate} decided as ${input.resolution} by Super Admin`,
  });

  await createSystemNotification({
    actorId: adminHrId,
    channels: ["email", "in_app"],
    eventType: "private_calendar_no_activity_decided",
    message: input.resolution === "deducted"
      ? `${clarification.activityDate} was decided as No Activity — a deduction has been applied to payroll. Note: ${adminNote}`
      : `${clarification.activityDate} was reviewed — no deduction will be applied. Note: ${adminNote}`,
    metadata: { clarificationId: clarification.id, employeeHrId: input.employeeHrId, idempotencyKey: `private-calendar-no-activity:${clarification.id}:decided` },
    module: "private_calendar",
    priority: "high",
    recipientHrId: input.employeeHrId,
    subjectHrId: input.employeeHrId,
    title: `No-activity day ${input.resolution === "deducted" ? "deducted" : "cleared"} — ${clarification.activityDate}`,
  });

  return clarification;
}

export async function decideNoActivityDay(
  access: AccessContext,
  input: { activityDate: string; adminNote: string; employeeHrId: string; employeeName?: string | null; resolution: NoActivityResolution },
): Promise<PrivateCalendarNoActivityClarification> {
  assertDeductionsGovernanceDecisionActor(access);
  return decideOneNoActivityDay(access, input);
}

export type BulkNoActivityDecisionResult = {
  activityDate: string;
  employeeHrId: string;
  error: string | null;
  ok: boolean;
};

export async function decideNoActivityDaysBulk(
  access: AccessContext,
  input: {
    adminNote: string;
    items: Array<{ activityDate: string; employeeHrId: string; employeeName?: string | null }>;
    resolution: NoActivityResolution;
  },
): Promise<BulkNoActivityDecisionResult[]> {
  assertDeductionsGovernanceDecisionActor(access);
  const results: BulkNoActivityDecisionResult[] = [];
  for (const item of input.items) {
    try {
      await decideOneNoActivityDay(access, {
        activityDate: item.activityDate,
        adminNote: input.adminNote,
        employeeHrId: item.employeeHrId,
        employeeName: item.employeeName,
        resolution: input.resolution,
      });
      results.push({ activityDate: item.activityDate, employeeHrId: item.employeeHrId, error: null, ok: true });
    } catch (error) {
      results.push({
        activityDate: item.activityDate,
        employeeHrId: item.employeeHrId,
        error: error instanceof Error ? error.message : "Unable to decide this day.",
        ok: false,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Daily cron: day-after "please clarify" notice. Wired into
// /api/notifications/daily alongside the other daily SLA jobs (see
// runExcuseSlaDaily for the same domain-service-function, no-request-param
// convention).
// ---------------------------------------------------------------------------

function cairoDateOffsetIso(days: number): string {
  const cairoToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const shifted = new Date(`${cairoToday}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export type NoActivityNotificationRunResult = { checked: number; errors: number; notified: number };

/**
 * Runs once daily. For every "No Activity Recorded" day from YESTERDAY
 * (Cairo), creates the tracking row if none exists yet and emails the
 * employee (CC HR/Super Admin) asking them to clarify. If the employee
 * already proactively clarified before this ran, the row is backfilled with
 * first_notified_at but no email is sent — they already responded.
 */
export async function runNoActivityDayFirstNotifications(): Promise<NoActivityNotificationRunResult> {
  const result: NoActivityNotificationRunResult = { checked: 0, errors: 0, notified: 0 };
  try {
    const yesterday = cairoDateOffsetIso(-1);
    const days = await getCompanyNoActivityDays({ access: systemAccessContext, end: yesterday, start: yesterday });
    result.checked = days.length;
    if (days.length === 0) return result;

    const hrRecipients = await resolveSuperAdminRecipients();
    const hrEmails = hrRecipients.map((recipient) => recipient.email).filter((email): email is string => Boolean(email));
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    for (const day of days) {
      try {
        const { data: existing, error: existingError } = await supabase
          .from("private_calendar_no_activity_clarifications")
          .select("id,first_notified_at,clarification_text,confirmed_no_activity")
          .eq("employee_hr_id", day.employeeHrId)
          .eq("activity_date", day.date)
          .maybeSingle();
        if (existingError) throw existingError;

        if (existing) {
          const row = existing as { clarification_text: string | null; confirmed_no_activity: boolean; first_notified_at: string | null; id: string };
          if (row.first_notified_at) continue; // already notified — idempotent re-run
          const alreadyResponded = Boolean(row.clarification_text) || row.confirmed_no_activity;
          await supabase
            .from("private_calendar_no_activity_clarifications")
            .update({ first_notified_at: now })
            .eq("id", row.id);
          if (alreadyResponded) continue; // they beat the cron to it — no need to notify
        } else {
          const { error: insertError } = await supabase
            .from("private_calendar_no_activity_clarifications")
            .insert({
              activity_date: day.date,
              employee_hr_id: day.employeeHrId,
              employee_name: day.employeeName,
              first_notified_at: now,
              status: "pending_review",
            });
          if (insertError) throw insertError;
        }

        await createSystemNotification({
          actionUrl: "/employee-portals/private-calendar",
          actorId: "system",
          channels: ["email", "in_app", "telegram"],
          email: { cc: hrEmails },
          eventType: "private_calendar_no_activity_first_notice",
          message: `No activity was recognized for you on ${day.date}. Please clarify what happened, or confirm nothing happened, from your Private Calendar.`,
          metadata: { activityDate: day.date, employeeHrId: day.employeeHrId, idempotencyKey: `private-calendar-no-activity-notice:${day.employeeHrId}:${day.date}` },
          module: "private_calendar",
          priority: "normal",
          recipientHrId: day.employeeHrId,
          subjectHrId: day.employeeHrId,
          title: `No Activity Recorded — ${day.date}`,
        });
        result.notified += 1;
      } catch (dayError) {
        result.errors += 1;
        logError("No-activity day first notification failed", {
          error: dayError,
          labels: { activityDate: day.date, employeeHrId: day.employeeHrId, event: "private_calendar_no_activity_first_notice_failed" },
        });
      }
    }
  } catch (error) {
    result.errors += 1;
    logError("No-activity day first notifications run failed", {
      error,
      labels: { event: "private_calendar_no_activity_first_notice_run_failed" },
    });
  }
  return result;
}

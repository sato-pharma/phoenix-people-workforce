import { writeAuditLog } from "@/lib/admin/audit";
import type {
  FieldWorkforceArchiveDetail,
  FieldWorkforceArchiveListItem,
  FieldWorkforceCoverageStatus,
  FieldWorkforceDecisionReason,
  FieldWorkforceDecisionStatus,
  FieldWorkforceFinalAction,
  FieldWorkforcePreviewResult,
  FieldWorkforceRecommendation,
  FieldWorkforceRecommendationsReport,
  FieldWorkforceRecommendationSourceType,
  FieldWorkforceRecommendationType,
  FieldWorkforceSeverity,
} from "@/lib/field-workforce-compliance/types";
import { isFieldWorkforceComplianceEligibleTitle, isSfeManagerTitle } from "@/lib/field-workforce-compliance/eligibility";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const decisionsTable = "field_workforce_compliance_decisions";

export const fieldWorkforceDecisionStatuses: FieldWorkforceDecisionStatus[] = [
  "Pending",
  "Approved for Leave Adjustment Report",
  "Approved for Payroll Deduction Report",
  "Do Not Take Action",
  "Needs Follow-up",
  "Disputed",
  "Resolved",
  "Cancelled",
];

const commonDecisionStatuses: FieldWorkforceDecisionStatus[] = [
  "Pending",
  "Do Not Take Action",
  "Needs Follow-up",
  "Disputed",
  "Resolved",
  "Cancelled",
];

export const fieldWorkforceDecisionReasons: FieldWorkforceDecisionReason[] = [
  "System issue",
  "Manager approved field exception",
  "Official training",
  "Meeting / cycle meeting",
  "Medical excuse pending",
  "Doctor conference",
  "Area assignment issue",
  "Public holiday conflict",
  "Late CRM sync",
  "Duplicate / data issue",
  "Already covered",
  "No action needed",
  "Other",
];

const approvedFinalActionStatuses = new Set<FieldWorkforceDecisionStatus>([
  "Approved for Leave Adjustment Report",
  "Approved for Payroll Deduction Report",
]);

export function fieldWorkforceDecisionStatusesForRecommendationType(
  recommendationType: FieldWorkforceRecommendationType,
): FieldWorkforceDecisionStatus[] {
  if (recommendationType === "leave_reconciliation") {
    return [
      "Pending",
      "Approved for Leave Adjustment Report",
      ...commonDecisionStatuses.slice(1),
    ];
  }

  return [
    "Pending",
    "Approved for Payroll Deduction Report",
    ...commonDecisionStatuses.slice(1),
  ];
}

export type FieldWorkforceDecisionRow = {
  created_at?: string;
  dates: string[];
  days_count: number;
  decided_at: string | null;
  decided_by: string | null;
  decision_status: FieldWorkforceDecisionStatus;
  decision_reason?: FieldWorkforceDecisionReason | "";
  employee_code: string;
  employee_name: string;
  estimated_amount: number | null;
  existing_coverage_status: FieldWorkforceCoverageStatus;
  hr_note: string;
  id: string;
  import_id: string | null;
  month_key: string;
  recommendation_key: string;
  recommendation_reason: string;
  recommendation_type: FieldWorkforceRecommendationType;
  resolved_at?: string | null;
  resolved_by?: string | null;
  severity: FieldWorkforceSeverity;
  source_type: FieldWorkforceRecommendationSourceType;
  updated_at?: string;
};

export class FieldWorkforceRecommendationNotFoundError extends Error {
  constructor(key: string) {
    super(`Recommendation ${key} was not found for this archived month.`);
    this.name = "FieldWorkforceRecommendationNotFoundError";
  }
}

export class FieldWorkforceInvalidDecisionStatusError extends Error {
  constructor(message = "This HR decision status is not valid for the recommendation type.") {
    super(message);
    this.name = "FieldWorkforceInvalidDecisionStatusError";
  }
}

export class FieldWorkforceDecisionReasonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldWorkforceDecisionReasonError";
  }
}

export class FieldWorkforceConflictingDecisionError extends Error {
  constructor() {
    super("These dates already have an approved report decision for another action type.");
    this.name = "FieldWorkforceConflictingDecisionError";
  }
}

function dateKey(dates: string[]) {
  return dates.join("_");
}

function normalizedDateKey(dates: string[]) {
  return [...dates].sort().join("|");
}

function isApprovedFinalActionStatus(status: FieldWorkforceDecisionStatus) {
  return approvedFinalActionStatuses.has(status);
}

function sourceLabel(sourceType: FieldWorkforceRecommendationSourceType) {
  const labels: Record<FieldWorkforceRecommendationSourceType, string> = {
    approved_leave_request: "Approved Leave Request",
    av_with_attendance_punch: "AV Contradicted by Fingerprint",
    av_with_partial_attendance_punch: "AV Partial Attendance (Half-Day)",
    calendar_av: "Calendar AV",
    n_retroactive_candidate: "N Retroactive Candidate",
    no_activity_candidate: "No Activity Candidate",
  };
  return labels[sourceType];
}

function decisionOverlay(decisions: Map<string, FieldWorkforceDecisionRow>, recommendationKey: string) {
  const decision = decisions.get(recommendationKey);
  return {
    decisionId: decision?.id ?? null,
    decisionReason: decision?.decision_reason ?? "",
    decisionStatus: decision?.decision_status ?? "Pending",
    decidedAt: decision?.decided_at ?? null,
    decidedBy: decision?.decided_by ?? null,
    hrNote: decision?.hr_note ?? "",
    resolvedAt: decision?.resolved_at ?? null,
    resolvedBy: decision?.resolved_by ?? null,
  };
}

function highestSeverity(values: FieldWorkforceSeverity[]) {
  if (values.includes("High")) return "High";
  if (values.includes("Review")) return "Review";
  if (values.includes("Medium")) return "Medium";
  return "Low";
}

type FieldWorkforceLeaveCoverage = {
  connected: boolean;
  coveredDatesByEmployee: Map<string, Set<string>>;
  message: string;
  sourceUnavailable: boolean;
};

type ApprovedLeaveRequestRow = {
  employee_hr_id?: string | null;
  end_date?: string | null;
  id?: string | null;
  start_date?: string | null;
  status?: string | null;
};

function dateAddDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateRangeWithinMonth(startDate: string, endDate: string, monthStart: string, monthEnd: string) {
  const start = startDate < monthStart ? monthStart : startDate;
  const end = endDate > monthEnd ? monthEnd : endDate;
  const dates: string[] = [];
  if (start > end) return dates;
  for (let date = start; date <= end; date = dateAddDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function emptyLeaveCoverage(message = "Leave request read-only matching is unavailable for this archive."): FieldWorkforceLeaveCoverage {
  return {
    connected: false,
    coveredDatesByEmployee: new Map(),
    message,
    sourceUnavailable: true,
  };
}

export function buildFieldWorkforceLeaveCoverageFromApprovedRequests(input: {
  monthEnd: string;
  monthStart: string;
  rows: ApprovedLeaveRequestRow[];
}): FieldWorkforceLeaveCoverage {
  const coveredDatesByEmployee = new Map<string, Set<string>>();
  for (const row of input.rows) {
    if (String(row.status ?? "").toLowerCase() !== "approved") continue;
    const employeeKey = canonicalHrIdKey(row.employee_hr_id ?? "");
    const startDate = row.start_date?.slice(0, 10);
    const endDate = row.end_date?.slice(0, 10) ?? startDate;
    if (!employeeKey || !startDate || !endDate) continue;

    const dates = dateRangeWithinMonth(startDate, endDate, input.monthStart, input.monthEnd);
    if (dates.length === 0) continue;
    const current = coveredDatesByEmployee.get(employeeKey) ?? new Set<string>();
    for (const date of dates) current.add(date);
    coveredDatesByEmployee.set(employeeKey, current);
  }

  return {
    connected: true,
    coveredDatesByEmployee,
    message: "Approved leave requests were read-only matched by employee code and date. No leave balances were changed.",
    sourceUnavailable: false,
  };
}

function coverageStatusForDates(input: {
  coverage: FieldWorkforceLeaveCoverage;
  dates: string[];
  employeeCode: string;
  fallback: FieldWorkforceCoverageStatus;
}) {
  if (!input.coverage.connected) return input.fallback;
  const covered = input.coverage.coveredDatesByEmployee.get(canonicalHrIdKey(input.employeeCode) ?? "");
  if (!covered || input.dates.length === 0) return "needs_reconciliation";
  return input.dates.every((date) => covered.has(date)) ? "already_covered" : "needs_reconciliation";
}

export function buildFieldWorkforceRecommendationKey(input: {
  dates: string[];
  employeeCode: string;
  recommendationType: FieldWorkforceRecommendationType;
  sourceType: FieldWorkforceRecommendationSourceType;
}) {
  return [
    input.recommendationType,
    input.sourceType,
    input.employeeCode,
    dateKey(input.dates),
  ].join(":");
}

function buildRecommendation(input: {
  archive: FieldWorkforceArchiveDetail["archive"];
  areaName: string | null;
  dates: string[];
  decisions: Map<string, FieldWorkforceDecisionRow>;
  employeeCode: string;
  employeeName: string;
  employmentStatus: string | null;
  estimatedAmount: number | null;
  existingCoverageStatus: FieldWorkforceCoverageStatus;
  holidayContext: string | null;
  lineName: string | null;
  managerName: string | null;
  recommendation: string;
  recommendationReason: string;
  recommendationType: FieldWorkforceRecommendationType;
  roleName: string | null;
  severity: FieldWorkforceSeverity;
  sourceType: FieldWorkforceRecommendationSourceType;
  teamName: string | null;
}): FieldWorkforceRecommendation {
  const recommendationKey = buildFieldWorkforceRecommendationKey({
    dates: input.dates,
    employeeCode: input.employeeCode,
    recommendationType: input.recommendationType,
    sourceType: input.sourceType,
  });

  return {
    ...decisionOverlay(input.decisions, recommendationKey),
    areaName: input.areaName,
    dates: input.dates,
    daysCount: input.dates.length,
    employeeCode: input.employeeCode,
    employeeName: input.employeeName,
    employmentStatus: input.employmentStatus,
    estimatedAmount: input.estimatedAmount,
    existingCoverageStatus: input.existingCoverageStatus,
    holidayContext: input.holidayContext,
    importId: input.archive.id,
    lineName: input.lineName,
    managerName: input.managerName,
    monthKey: input.archive.monthKey,
    recommendation: input.recommendation,
    recommendationKey,
    recommendationReason: input.recommendationReason,
    recommendationType: input.recommendationType,
    roleName: input.roleName,
    severity: input.severity,
    sourceLabel: sourceLabel(input.sourceType),
    sourceType: input.sourceType,
    teamName: input.teamName,
  };
}

/**
 * True when this month's national-holiday data is missing or incomplete, so a "no activity" day
 * cannot be trusted to be a real working day.
 *
 * `holidayCalendarReachable === false` means the Google Egypt calendar could not be read at all —
 * the degraded fallback carries only company + fixed-date holidays, so every MOVING Islamic/Coptic
 * holiday is absent. `holidayConnected === false` means there are no holidays at all. Both are
 * checked explicitly against `false`, never truthiness: `null`/`undefined` means "not asserted"
 * (Excel-upload path, or an archive predating these fields) and must NOT be treated as degraded,
 * or every legacy archive would silently stop producing payroll recommendations.
 */
function isHolidaySourceDegraded(archiveDetail: FieldWorkforceArchiveDetail): boolean {
  const metadata = archiveDetail.preview?.metadata;
  return metadata?.holidayCalendarReachable === false || metadata?.holidayConnected === false;
}

function generatedRecommendations(
  archiveDetail: FieldWorkforceArchiveDetail,
  decisions: Map<string, FieldWorkforceDecisionRow>,
  leaveCoverage: FieldWorkforceLeaveCoverage = emptyLeaveCoverage(),
) {
  const leaveRecommendations: FieldWorkforceRecommendation[] = [];
  const payrollRecommendations: FieldWorkforceRecommendation[] = [];
  // Money guard (sibling of the per-employee "unresolved CRM identity" skip below): when the
  // national-holiday source degraded, this month's public holidays are missing or incomplete, so
  // every rep's holiday reads as an ordinary working day with no activity — which would generate a
  // payroll deduction for the whole field force off a third-party outage. Suppress payroll only;
  // the advisory leave_reconciliation recommendation is unaffected (holiday degradation does not
  // corrupt it) and still surfaces the days for human review.
  const holidaySourceDegraded = isHolidaySourceDegraded(archiveDetail);

  for (const employee of archiveDetail.preview.employees) {
    // Tier 0 guard: an employee we could never tie to a CRM identity has an all-"N" month
    // that reflects a data-mapping gap, not absence. Generating leave/payroll recommendations
    // from it would risk a wrong deduction, so skip them entirely — they still appear in the
    // report (flagged unresolved) for the mapping fix, just never as an actionable candidate.
    // crmIdentity is undefined on the Excel-upload path, where the workbook is the trusted
    // source and no CRM join happens, so those employees are never skipped.
    if (employee.crmIdentity?.confidence === "unresolved") continue;

    const hierarchy = {
      areaName: employee.areaName,
      employeeCode: employee.hrId,
      employeeName: employee.employeeName,
      employmentStatus: employee.employmentStatus,
      lineName: employee.lineName,
      managerName: employee.managerName,
      roleName: employee.roleName,
      teamName: employee.teamName,
    };
    const avCells = employee.timeline.filter((cell) => !cell.ignored && cell.status === "AV");
    // Split out AV days contradicted by a same-day fingerprint punch (attendance-cross-check.ts)
    // into their own recommendations — mainly relevant for device-mapped, office-based (Head
    // Office) staff, since field reps are never fingerprint-device-mapped. Excuse-labeled days
    // (isExcuseLabeledAv) are excluded from BOTH splits: a punch on a day logged as "Afternoon
    // Excuse"/"Morning Excuse" is expected, not a real vacation contradiction, so those stay in
    // the plain calendar_av recommendation below. Genuine contradictions further split by
    // worked duration (attendance-cross-check.ts's AV_HALF_DAY_MAX_WORKED_MINUTES, 5h,
    // owner-confirmed): av_with_punch (>=5h proven worked) is a full contradiction;
    // av_with_partial_punch (<5h, or unresolvable) reads as a half-day vacation instead.
    const avBucket = (cell: (typeof avCells)[number]): "full" | "partial" | "plain" => {
      if (cell.isExcuseLabeledAv) return "plain";
      if (cell.attendanceCrossCheck === "av_with_punch") return "full";
      if (cell.attendanceCrossCheck === "av_with_partial_punch") return "partial";
      return "plain";
    };
    const avDates = avCells.filter((cell) => avBucket(cell) === "plain").map((cell) => cell.dateIso);
    const avPartialPunchDates = avCells.filter((cell) => avBucket(cell) === "partial").map((cell) => cell.dateIso);
    const avWithPunchDates = avCells.filter((cell) => avBucket(cell) === "full").map((cell) => cell.dateIso);
    if (avDates.length > 0) {
      leaveRecommendations.push(buildRecommendation({
        archive: archiveDetail.archive,
        dates: avDates,
        decisions,
        ...hierarchy,
        estimatedAmount: null,
        existingCoverageStatus: coverageStatusForDates({
          coverage: leaveCoverage,
          dates: avDates,
          employeeCode: employee.hrId,
          fallback: "leave_source_not_connected",
        }),
        holidayContext: null,
        recommendation: "Reconcile calendar vacation signals before any leave balance action.",
        recommendationReason: "AV means vacation signal from the field calendar. It does not automatically deduct leave balance.",
        recommendationType: "leave_reconciliation",
        severity: "Review",
        sourceType: "calendar_av",
      }));
    }
    if (avWithPunchDates.length > 0) {
      leaveRecommendations.push(buildRecommendation({
        archive: archiveDetail.archive,
        dates: avWithPunchDates,
        decisions,
        ...hierarchy,
        estimatedAmount: null,
        existingCoverageStatus: coverageStatusForDates({
          coverage: leaveCoverage,
          dates: avWithPunchDates,
          employeeCode: employee.hrId,
          fallback: "leave_source_not_connected",
        }),
        holidayContext: null,
        recommendation: "Fingerprint attendance shows a physical punch on a day the field calendar marks as vacation. Verify with the employee before treating this as leave.",
        recommendationReason: "AV means vacation signal from the field calendar, but a matching fingerprint punch was recorded the same day — the two systems disagree. It does not automatically deduct or restore leave balance.",
        recommendationType: "leave_reconciliation",
        severity: "High",
        sourceType: "av_with_attendance_punch",
      }));
    }
    if (avPartialPunchDates.length > 0) {
      leaveRecommendations.push(buildRecommendation({
        archive: archiveDetail.archive,
        dates: avPartialPunchDates,
        decisions,
        ...hierarchy,
        estimatedAmount: null,
        existingCoverageStatus: coverageStatusForDates({
          coverage: leaveCoverage,
          dates: avPartialPunchDates,
          employeeCode: employee.hrId,
          fallback: "leave_source_not_connected",
        }),
        holidayContext: null,
        recommendation: "Fingerprint attendance shows under 5 hours worked on a day the field calendar marks as vacation — likely a half-day rather than a full vacation day. Verify with the employee before adjusting leave balance.",
        recommendationReason: "AV means vacation signal from the field calendar, but a short fingerprint punch window (under 5h worked, or unresolvable) was recorded the same day. It does not automatically deduct or restore leave balance.",
        recommendationType: "leave_reconciliation",
        severity: "Review",
        sourceType: "av_with_partial_attendance_punch",
      }));
    }

    if (leaveCoverage.connected) {
      const employeeCoveredDates = leaveCoverage.coveredDatesByEmployee.get(canonicalHrIdKey(employee.hrId) ?? "") ?? new Set<string>();
      const approvedLeaveWithoutCalendarAv = employee.timeline
        .filter((cell) =>
          employeeCoveredDates.has(cell.dateIso) &&
          !cell.ignored &&
          cell.status !== "AV",
        )
        .map((cell) => cell.dateIso);
      if (approvedLeaveWithoutCalendarAv.length > 0) {
        leaveRecommendations.push(buildRecommendation({
          archive: archiveDetail.archive,
          dates: approvedLeaveWithoutCalendarAv,
          decisions,
          ...hierarchy,
          estimatedAmount: null,
          existingCoverageStatus: "already_covered",
          holidayContext: null,
          recommendation: "Approved leave exists, but the field calendar is not marked AV for these dates. Reconcile the calendar signal before any future action.",
          recommendationReason: "Leave source is read-only matched. This highlights a source mismatch only; no leave balance is changed.",
          recommendationType: "leave_reconciliation",
          severity: "Review",
          sourceType: "approved_leave_request",
        }));
      }
    }

    const normalNoActivityCells = employee.timeline.filter((cell) =>
      cell.countedAsNoActivityCandidate &&
      !cell.isPublicHoliday &&
      !cell.isPreHire &&
      !cell.ignored,
    );
    const normalNoActivityDates = normalNoActivityCells.map((cell) => cell.dateIso);
    if (normalNoActivityDates.length > 0) {
      const severity = highestSeverity(normalNoActivityCells.map((cell) => cell.severity ?? "Low"));
      leaveRecommendations.push(buildRecommendation({
        archive: archiveDetail.archive,
        dates: normalNoActivityDates,
        decisions,
        ...hierarchy,
        estimatedAmount: null,
        existingCoverageStatus: coverageStatusForDates({
          coverage: leaveCoverage,
          dates: normalNoActivityDates,
          employeeCode: employee.hrId,
          fallback: "leave_source_not_connected",
        }),
        holidayContext: null,
        recommendation: "HR may review these N days as possible retroactive leave. No automatic leave action is taken.",
        recommendationReason: "N means no activity candidate. HR decision is required before any leave reconciliation.",
        recommendationType: "leave_reconciliation",
        severity,
        sourceType: "n_retroactive_candidate",
      }));

      // APPROVED LEAVE CANCELS THE DEDUCTION — you cannot log a CRM visit on a day
      // you were approved to be away.
      //
      // leaveCoverage is already loaded for this archive and already consulted TWICE
      // above: once for the `approved_leave_request` advisory (which reports the exact
      // dates where approved leave exists but the field calendar is not marked AV), and
      // once for this employee's `existingCoverageStatus`. The payroll path simply never
      // read it. So the module would notice you were on approved leave, file an advisory
      // saying so, and then deduct a full day of base salary for each of those same days.
      //
      // Measured on July 2026 production: 8 employee-days, 6,983.89 EGP, across 3 people
      // — including 5 consecutive days of APPROVED PAID ANNUAL leave for the Training
      // Manager, plus approved emergency and compensatory days.
      const employeeLeaveDates = leaveCoverage.coveredDatesByEmployee.get(canonicalHrIdKey(employee.hrId) ?? "") ?? new Set<string>();
      const deductibleCells = normalNoActivityCells.filter((cell) => !employeeLeaveDates.has(cell.dateIso));
      const deductibleDates = deductibleCells.map((cell) => cell.dateIso);
      // Severity must be recomputed from what actually remains: carrying the original
      // severity would rate a one-day candidate by days that are no longer charged.
      const deductibleSeverity = highestSeverity(deductibleCells.map((cell) => cell.severity ?? "Low"));

      // SFE Manager appears in the compliance report above (leaveRecommendations) but must
      // never generate a payroll-deduction recommendation — see the ELIGIBLE_TITLES comment
      // in eligibility.ts. This is the "enforced separately in the deductions-governance
      // connector" half of that promise; it was previously undocumented-but-missing.
      //
      // isFieldWorkforceComplianceEligibleTitle is required here too: employees now also enter
      // the Team Calendar via fingerprint device-mapping alone (Head Office staff with no
      // field-eligible title — see the `eligible` filter in ireports360-source.ts). That
      // inclusion is informational only and must never itself create a payroll consequence, so
      // only the ORIGINAL, title-eligible population can ever reach a payroll_deduction
      // recommendation — this is the only place payroll_deduction is generated in the codebase.
      //
      // NOT gated on leaveCoverage.sourceUnavailable, deliberately. Suppressing the whole
      // category whenever the leave read fails would turn a source outage into a silent
      // 0.00 EGP month, and archives legitimately carry no leave matching at all
      // ("Leave request read-only matching is unavailable for this archive"). When
      // coverage is absent the covered set is simply empty, so behaviour is byte-for-byte
      // what it was before — the exclusion only ever subtracts dates it can prove.
      if (
        !holidaySourceDegraded &&
        deductibleDates.length > 0 &&
        !isSfeManagerTitle(employee.roleName) &&
        isFieldWorkforceComplianceEligibleTitle(employee.roleName)
      ) {
        payrollRecommendations.push(buildRecommendation({
          archive: archiveDetail.archive,
          dates: deductibleDates,
          decisions,
          ...hierarchy,
          estimatedAmount: null,
          existingCoverageStatus: "payroll_calculation_required",
          holidayContext: null,
          recommendation: "Review no-activity days for possible payroll deduction report. Amount requires payroll calculation.",
          recommendationReason: "N means no activity candidate only. It is not an automatic payroll deduction.",
          recommendationType: "payroll_deduction",
          severity: deductibleSeverity,
          sourceType: "no_activity_candidate",
        }));
      }
    }
  }

  return { leaveRecommendations, payrollRecommendations };
}

function finalActionsFromRecommendations(recommendations: FieldWorkforceRecommendation[]): FieldWorkforceFinalAction[] {
  return recommendations.flatMap<FieldWorkforceFinalAction>((recommendation) => {
    if (
      recommendation.decisionStatus === "Approved for Leave Adjustment Report" &&
      recommendation.recommendationType === "leave_reconciliation"
    ) {
      return [{
        actionType: "Leave Balance Adjustment",
        amount: null,
        areaName: recommendation.areaName,
        approvedAt: recommendation.decidedAt,
        approvedBy: recommendation.decidedBy,
        approvedDates: recommendation.dates,
        approvedDaysCount: recommendation.daysCount,
        decisionReason: recommendation.decisionReason,
        decisionStatus: recommendation.decisionStatus,
        employeeCode: recommendation.employeeCode,
        employeeName: recommendation.employeeName,
        employmentStatus: recommendation.employmentStatus,
        hrNote: recommendation.hrNote,
        lineName: recommendation.lineName,
        managerName: recommendation.managerName,
        monthKey: recommendation.monthKey,
        pushStatus: "Export only",
        recommendationKey: recommendation.recommendationKey,
        roleName: recommendation.roleName,
        teamName: recommendation.teamName,
      } satisfies FieldWorkforceFinalAction];
    }
    if (
      recommendation.decisionStatus === "Approved for Payroll Deduction Report" &&
      recommendation.recommendationType === "payroll_deduction"
    ) {
      return [{
        actionType: "Payroll Deduction",
        amount: recommendation.estimatedAmount,
        areaName: recommendation.areaName,
        approvedAt: recommendation.decidedAt,
        approvedBy: recommendation.decidedBy,
        approvedDates: recommendation.dates,
        approvedDaysCount: recommendation.daysCount,
        decisionReason: recommendation.decisionReason,
        decisionStatus: recommendation.decisionStatus,
        employeeCode: recommendation.employeeCode,
        employeeName: recommendation.employeeName,
        employmentStatus: recommendation.employmentStatus,
        hrNote: recommendation.hrNote,
        lineName: recommendation.lineName,
        managerName: recommendation.managerName,
        monthKey: recommendation.monthKey,
        pushStatus: "Export only",
        recommendationKey: recommendation.recommendationKey,
        roleName: recommendation.roleName,
        teamName: recommendation.teamName,
      } satisfies FieldWorkforceFinalAction];
    }
    return [];
  });
}

export function assertFieldWorkforceDecisionStatusAllowed(input: {
  decisionStatus: FieldWorkforceDecisionStatus;
  recommendationType: FieldWorkforceRecommendationType;
}) {
  const allowed = fieldWorkforceDecisionStatusesForRecommendationType(input.recommendationType);
  if (!allowed.includes(input.decisionStatus)) {
    throw new FieldWorkforceInvalidDecisionStatusError();
  }
}

export function assertFieldWorkforceDecisionReasonAllowed(input: {
  decisionReason: string;
  decisionStatus: FieldWorkforceDecisionStatus;
  hrNote: string;
}) {
  const decisionReason = input.decisionReason.trim();
  if (input.decisionStatus === "Pending") return;
  if (!decisionReason) {
    throw new FieldWorkforceDecisionReasonError("A decision reason is required for non-Pending HR decisions.");
  }
  if (!fieldWorkforceDecisionReasons.includes(decisionReason as FieldWorkforceDecisionReason)) {
    throw new FieldWorkforceDecisionReasonError("Choose a supported HR decision reason.");
  }
  if (decisionReason === "Other" && !input.hrNote.trim()) {
    throw new FieldWorkforceDecisionReasonError("HR note is required when decision reason is Other.");
  }
}

export function assertNoFieldWorkforceApprovedDecisionConflict(input: {
  decisionStatus: FieldWorkforceDecisionStatus;
  existingRows: FieldWorkforceDecisionRow[];
  recommendation: FieldWorkforceRecommendation;
}) {
  if (!isApprovedFinalActionStatus(input.decisionStatus)) return;

  const candidateDateKey = normalizedDateKey(input.recommendation.dates);
  const conflict = input.existingRows.some((row) =>
    row.month_key === input.recommendation.monthKey &&
    // Canonical (case/alias-insensitive) compare so a casing drift in employee_code can't slip a
    // second approved decision past this deductions-safety guard.
    canonicalHrIdKey(row.employee_code) === canonicalHrIdKey(input.recommendation.employeeCode) &&
    row.recommendation_key !== input.recommendation.recommendationKey &&
    isApprovedFinalActionStatus(row.decision_status) &&
    normalizedDateKey(row.dates) === candidateDateKey,
  );

  if (conflict) throw new FieldWorkforceConflictingDecisionError();
}

/**
 * Decision rows for a live (mirror-sourced) month, keyed by month_key since a live month
 * has no import_id to key off. Deliberately NOT filtered to import_id IS NULL: once the
 * month_key+recommendation_key unique index is in place, a decision made against an
 * Excel-archived view of this month and a decision made against the live-mirror view of
 * the same month collide onto the same row when the recommendation_key matches (same
 * employee/dates/type) — they're the same real-world HR decision, just reached via two
 * different UI paths. Excluding import_id-carrying rows here would hide that existing
 * decision and risk the live-path upsert silently orphaning it (see the import_id
 * preservation in saveFieldWorkforceRecommendationDecisionForLiveMonth below).
 */
async function loadDecisionRowsByMonthKey(monthKey: string) {
  const { data, error } = await getSupabaseAdmin()
    .from(decisionsTable)
    .select("*")
    .eq("month_key", monthKey);
  if (error) throw error;
  return (data ?? []) as FieldWorkforceDecisionRow[];
}

function decisionMap(rows: FieldWorkforceDecisionRow[]) {
  return new Map(rows.map((row) => [row.recommendation_key, row]));
}

async function loadApprovedLeaveCoverageForArchive(archiveDetail: FieldWorkforceArchiveDetail) {
  const monthStart = archiveDetail.preview.metadata.dateRange.start;
  const monthEnd = archiveDetail.preview.metadata.dateRange.end;
  if (!monthStart || !monthEnd) {
    return emptyLeaveCoverage("Leave request read-only matching is unavailable because the archive date range is missing.");
  }

  const { data, error } = await getSupabaseAdmin()
    .from("v2_vacation_requests")
    .select("id,employee_hr_id,start_date,end_date,status")
    .eq("status", "approved")
    .lte("start_date", monthEnd)
    .gte("end_date", monthStart);

  if (error) {
    const message = error.message ? `Leave source unavailable: ${error.message}` : "Leave source unavailable.";
    return emptyLeaveCoverage(message);
  }

  return buildFieldWorkforceLeaveCoverageFromApprovedRequests({
    monthEnd,
    monthStart,
    rows: (data ?? []) as ApprovedLeaveRequestRow[],
  });
}

export function buildFieldWorkforceRecommendationsReportFromArchive(
  archiveDetail: FieldWorkforceArchiveDetail,
  decisionRows: FieldWorkforceDecisionRow[] = [],
  leaveCoverage: FieldWorkforceLeaveCoverage = emptyLeaveCoverage(
    "Leave request read-only matching is deferred until the leave source is explicitly connected.",
  ),
): FieldWorkforceRecommendationsReport {
  const decisions = decisionMap(decisionRows);
  const generated = generatedRecommendations(archiveDetail, decisions, leaveCoverage);
  const allRecommendations = [
    ...generated.leaveRecommendations,
    ...generated.payrollRecommendations,
  ];
  const finalActions = finalActionsFromRecommendations(allRecommendations);

  const holidaySourceDegraded = isHolidaySourceDegraded(archiveDetail);

  return {
    archive: archiveDetail.archive,
    finalActions,
    integrationStatus: {
      // Surfaced so a suppressed month is visibly explained rather than looking like a clean
      // "no deductions this month" — the whole point of the guard is to fail loudly.
      holidaySource: holidaySourceDegraded ? "degraded" : "connected",
      holidaySourceMessage: holidaySourceDegraded
        ? `${archiveDetail.preview?.metadata?.holidayMessage ?? "National holiday data is incomplete for this month."} Payroll deduction recommendations are suppressed for this month because a missing public holiday would be misread as a no-activity day.`
        : null,
      leaveSource: leaveCoverage.connected ? "connected" : "not_connected",
      leaveSourceMessage: leaveCoverage.message,
      payrollAmount: "requires_calculation",
      payrollAmountMessage: "Payroll amounts are not estimated because no safe payroll formula is connected for this report.",
    },
    leaveRecommendations: generated.leaveRecommendations,
    payrollRecommendations: generated.payrollRecommendations,
  };
}

/**
 * Fabricates an archive-shaped object for a live (mirror-sourced) month, which has no
 * field_workforce_compliance_imports row. Only used internally so the existing
 * buildFieldWorkforceRecommendationsReportFromArchive/buildRecommendation code — which
 * only ever reads archive.id (threaded through as an opaque importId string) and
 * archive.monthKey — can run unchanged for live months. Never persisted; status is a
 * filler value from the existing union (the live path never displays it — the UI branches
 * on sourceMode instead).
 */
function buildSyntheticArchiveForLiveMonth(
  preview: FieldWorkforcePreviewResult,
  monthKey: string,
): FieldWorkforceArchiveListItem {
  return {
    employeeCount: preview.metadata.employeeCount,
    highSeverityCount: preview.severityCounts.High,
    id: `live:${monthKey}`,
    month: preview.metadata.month,
    monthKey,
    reviewCandidateCount: preview.reviewCandidates.length,
    sheetName: preview.metadata.sheetName,
    sourceFilename: preview.metadata.fileName,
    status: "archived",
    uploadedAt: new Date().toISOString(),
    uploadedBy: "ireports360_visits_mirror",
    year: preview.metadata.year,
  };
}

/**
 * Recommendations report for a live (mirror-sourced) month — same shape and generation
 * logic as buildFieldWorkforceRecommendationsReportFromArchive, but sourced from a preview
 * that was just computed live from the visits mirror rather than an archived import row.
 */
export async function buildFieldWorkforceRecommendationsReportForLiveMonth(input: {
  monthKey: string;
  preview: FieldWorkforcePreviewResult;
}): Promise<FieldWorkforceRecommendationsReport> {
  const archiveDetail: FieldWorkforceArchiveDetail = {
    archive: buildSyntheticArchiveForLiveMonth(input.preview, input.monthKey),
    preview: input.preview,
  };
  const [decisionRows, leaveCoverage] = await Promise.all([
    loadDecisionRowsByMonthKey(input.monthKey),
    loadApprovedLeaveCoverageForArchive(archiveDetail),
  ]);
  return buildFieldWorkforceRecommendationsReportFromArchive(archiveDetail, decisionRows, leaveCoverage);
}

/**
 * Decision save for a live (mirror-sourced) month — parallel to
 * saveFieldWorkforceRecommendationDecision, but keyed by month_key/preview instead of an
 * archiveId, since a live month has no field_workforce_compliance_imports row. The caller
 * (the API route) already has the freshly-built preview, so it's passed in rather than
 * re-fetched here.
 */
export async function saveFieldWorkforceRecommendationDecisionForLiveMonth(input: {
  actorLoginId: string;
  decisionReason: string;
  decisionStatus: FieldWorkforceDecisionStatus;
  hrNote: string;
  monthKey: string;
  preview: FieldWorkforcePreviewResult;
  recommendationKey: string;
}): Promise<FieldWorkforceRecommendationsReport> {
  if (!fieldWorkforceDecisionStatuses.includes(input.decisionStatus)) {
    throw new Error("Unsupported Field Workforce Compliance decision status.");
  }

  const report = await buildFieldWorkforceRecommendationsReportForLiveMonth({
    monthKey: input.monthKey,
    preview: input.preview,
  });

  const recommendations = [
    ...report.leaveRecommendations,
    ...report.payrollRecommendations,
  ];
  const recommendation = recommendations.find((item) => item.recommendationKey === input.recommendationKey);
  if (!recommendation) throw new FieldWorkforceRecommendationNotFoundError(input.recommendationKey);
  assertFieldWorkforceDecisionStatusAllowed({
    decisionStatus: input.decisionStatus,
    recommendationType: recommendation.recommendationType,
  });
  assertFieldWorkforceDecisionReasonAllowed({
    decisionReason: input.decisionReason,
    decisionStatus: input.decisionStatus,
    hrNote: input.hrNote,
  });

  const existingRows = await loadDecisionRowsByMonthKey(input.monthKey);
  assertNoFieldWorkforceApprovedDecisionConflict({
    decisionStatus: input.decisionStatus,
    existingRows,
    recommendation,
  });
  const existing = existingRows.find((row) => row.recommendation_key === input.recommendationKey) ?? null;
  const hasDecision = input.decisionStatus !== "Pending";
  const now = new Date().toISOString();
  const decisionReason = hasDecision ? input.decisionReason.trim() as FieldWorkforceDecisionReason : "";
  const isResolved = input.decisionStatus === "Resolved";
  const payload = {
    dates: recommendation.dates,
    days_count: recommendation.daysCount,
    decided_at: hasDecision ? now : null,
    decided_by: hasDecision ? input.actorLoginId : null,
    decision_reason: decisionReason,
    decision_status: input.decisionStatus,
    employee_code: recommendation.employeeCode,
    employee_name: recommendation.employeeName,
    estimated_amount: recommendation.estimatedAmount,
    existing_coverage_status: recommendation.existingCoverageStatus,
    hr_note: input.hrNote.trim(),
    // Preserve an existing Excel-archived decision's import_id if this exact
    // (month_key, recommendation_key) was already decided from that path — the live and
    // Excel views of the same month share one decision domain post-migration, so this
    // must not silently null out a real import_id on conflict.
    import_id: existing?.import_id ?? null,
    month_key: input.monthKey,
    recommendation_key: input.recommendationKey,
    recommendation_reason: recommendation.recommendationReason,
    recommendation_type: recommendation.recommendationType,
    resolved_at: isResolved ? now : null,
    resolved_by: isResolved ? input.actorLoginId : null,
    severity: recommendation.severity,
    source_type: recommendation.sourceType,
    updated_at: now,
  };

  const { error } = await getSupabaseAdmin()
    .from(decisionsTable)
    .upsert(payload, {
      onConflict: "month_key,recommendation_key",
    });
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: input.monthKey,
    entityType: "field_workforce_compliance_import",
    newValues: {
      decisionReason: payload.decision_reason,
      decisionStatus: input.decisionStatus,
      hrNote: payload.hr_note,
      recommendationKey: input.recommendationKey,
      recommendationType: recommendation.recommendationType,
    },
    oldValues: existing ? {
      decisionReason: existing.decision_reason ?? "",
      decisionStatus: existing.decision_status,
      hrNote: existing.hr_note,
    } : null,
    summary: existing
      ? input.decisionStatus === "Disputed" || input.decisionStatus === "Resolved" || existing.decision_status === "Disputed"
        ? "Field Workforce Compliance dispute/review status changed."
        : (existing.decision_reason ?? "") !== payload.decision_reason
          ? "Field Workforce Compliance decision reason updated."
          : "Field Workforce Compliance HR decision changed."
      : "Field Workforce Compliance recommendation decision created.",
  });

  return buildFieldWorkforceRecommendationsReportForLiveMonth({
    monthKey: input.monthKey,
    preview: input.preview,
  });
}

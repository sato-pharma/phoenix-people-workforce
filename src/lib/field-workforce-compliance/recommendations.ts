import { writeAuditLog } from "@/lib/admin/audit";
import { loadFieldWorkforceComplianceArchive } from "@/lib/field-workforce-compliance/archive";
import type {
  FieldWorkforceArchiveDetail,
  FieldWorkforceCoverageStatus,
  FieldWorkforceDecisionStatus,
  FieldWorkforceFinalAction,
  FieldWorkforceRecommendation,
  FieldWorkforceRecommendationsReport,
  FieldWorkforceRecommendationSourceType,
  FieldWorkforceRecommendationType,
  FieldWorkforceSeverity,
} from "@/lib/field-workforce-compliance/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const decisionsTable = "field_workforce_compliance_decisions";

export const fieldWorkforceDecisionStatuses: FieldWorkforceDecisionStatus[] = [
  "Pending",
  "Approved for Leave Adjustment Report",
  "Approved for Payroll Deduction Report",
  "Do Not Take Action",
  "Needs Follow-up",
  "Cancelled",
];

export type FieldWorkforceDecisionRow = {
  created_at?: string;
  dates: string[];
  days_count: number;
  decided_at: string | null;
  decided_by: string | null;
  decision_status: FieldWorkforceDecisionStatus;
  employee_code: string;
  employee_name: string;
  estimated_amount: number | null;
  existing_coverage_status: FieldWorkforceCoverageStatus;
  hr_note: string;
  id: string;
  import_id: string;
  month_key: string;
  recommendation_key: string;
  recommendation_reason: string;
  recommendation_type: FieldWorkforceRecommendationType;
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

function dateKey(dates: string[]) {
  return dates.join("_");
}

function sourceLabel(sourceType: FieldWorkforceRecommendationSourceType) {
  const labels: Record<FieldWorkforceRecommendationSourceType, string> = {
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
    decisionStatus: decision?.decision_status ?? "Pending",
    decidedAt: decision?.decided_at ?? null,
    decidedBy: decision?.decided_by ?? null,
    hrNote: decision?.hr_note ?? "",
  };
}

function highestSeverity(values: FieldWorkforceSeverity[]) {
  if (values.includes("High")) return "High";
  if (values.includes("Review")) return "Review";
  if (values.includes("Medium")) return "Medium";
  return "Low";
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
  dates: string[];
  decisions: Map<string, FieldWorkforceDecisionRow>;
  employeeCode: string;
  employeeName: string;
  estimatedAmount: number | null;
  existingCoverageStatus: FieldWorkforceCoverageStatus;
  holidayContext: string | null;
  recommendation: string;
  recommendationReason: string;
  recommendationType: FieldWorkforceRecommendationType;
  severity: FieldWorkforceSeverity;
  sourceType: FieldWorkforceRecommendationSourceType;
}): FieldWorkforceRecommendation {
  const recommendationKey = buildFieldWorkforceRecommendationKey({
    dates: input.dates,
    employeeCode: input.employeeCode,
    recommendationType: input.recommendationType,
    sourceType: input.sourceType,
  });

  return {
    ...decisionOverlay(input.decisions, recommendationKey),
    dates: input.dates,
    daysCount: input.dates.length,
    employeeCode: input.employeeCode,
    employeeName: input.employeeName,
    estimatedAmount: input.estimatedAmount,
    existingCoverageStatus: input.existingCoverageStatus,
    holidayContext: input.holidayContext,
    importId: input.archive.id,
    monthKey: input.archive.monthKey,
    recommendation: input.recommendation,
    recommendationKey,
    recommendationReason: input.recommendationReason,
    recommendationType: input.recommendationType,
    severity: input.severity,
    sourceLabel: sourceLabel(input.sourceType),
    sourceType: input.sourceType,
  };
}

function generatedRecommendations(
  archiveDetail: FieldWorkforceArchiveDetail,
  decisions: Map<string, FieldWorkforceDecisionRow>,
) {
  const leaveRecommendations: FieldWorkforceRecommendation[] = [];
  const payrollRecommendations: FieldWorkforceRecommendation[] = [];

  for (const employee of archiveDetail.preview.employees) {
    const avDates = employee.timeline
      .filter((cell) => !cell.ignored && cell.status === "AV")
      .map((cell) => cell.dateIso);
    if (avDates.length > 0) {
      leaveRecommendations.push(buildRecommendation({
        archive: archiveDetail.archive,
        dates: avDates,
        decisions,
        employeeCode: employee.hrId,
        employeeName: employee.employeeName,
        estimatedAmount: null,
        existingCoverageStatus: "leave_source_not_connected",
        holidayContext: null,
        recommendation: "Reconcile calendar vacation signals before any leave balance action.",
        recommendationReason: "AV means vacation signal from the field calendar. It does not automatically deduct leave balance.",
        recommendationType: "leave_reconciliation",
        severity: "Review",
        sourceType: "calendar_av",
      }));
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
        employeeCode: employee.hrId,
        employeeName: employee.employeeName,
        estimatedAmount: null,
        existingCoverageStatus: "leave_source_not_connected",
        holidayContext: null,
        recommendation: "HR may review these N days as possible retroactive leave. No automatic leave action is taken.",
        recommendationReason: "N means no activity candidate. HR decision is required before any leave reconciliation.",
        recommendationType: "leave_reconciliation",
        severity,
        sourceType: "n_retroactive_candidate",
      }));

      payrollRecommendations.push(buildRecommendation({
        archive: archiveDetail.archive,
        dates: normalNoActivityDates,
        decisions,
        employeeCode: employee.hrId,
        employeeName: employee.employeeName,
        estimatedAmount: null,
        existingCoverageStatus: "payroll_calculation_required",
        holidayContext: null,
        recommendation: "Review no-activity days for possible payroll deduction report. Amount requires payroll calculation.",
        recommendationReason: "N means no activity candidate only. It is not an automatic payroll deduction.",
        recommendationType: "payroll_deduction",
        severity,
        sourceType: "no_activity_candidate",
      }));
    }
  }

  return { leaveRecommendations, payrollRecommendations };
}

function finalActionsFromRecommendations(recommendations: FieldWorkforceRecommendation[]): FieldWorkforceFinalAction[] {
  return recommendations.flatMap<FieldWorkforceFinalAction>((recommendation) => {
    if (recommendation.decisionStatus === "Approved for Leave Adjustment Report") {
      return [{
        actionType: "Leave Balance Adjustment",
        amount: null,
        approvedAt: recommendation.decidedAt,
        approvedBy: recommendation.decidedBy,
        approvedDates: recommendation.dates,
        approvedDaysCount: recommendation.daysCount,
        employeeCode: recommendation.employeeCode,
        employeeName: recommendation.employeeName,
        hrNote: recommendation.hrNote,
        monthKey: recommendation.monthKey,
        pushStatus: "Export only",
        recommendationKey: recommendation.recommendationKey,
      } satisfies FieldWorkforceFinalAction];
    }
    if (recommendation.decisionStatus === "Approved for Payroll Deduction Report") {
      return [{
        actionType: "Payroll Deduction",
        amount: recommendation.estimatedAmount,
        approvedAt: recommendation.decidedAt,
        approvedBy: recommendation.decidedBy,
        approvedDates: recommendation.dates,
        approvedDaysCount: recommendation.daysCount,
        employeeCode: recommendation.employeeCode,
        employeeName: recommendation.employeeName,
        hrNote: recommendation.hrNote,
        monthKey: recommendation.monthKey,
        pushStatus: "Export only",
        recommendationKey: recommendation.recommendationKey,
      } satisfies FieldWorkforceFinalAction];
    }
    return [];
  });
}

async function loadDecisionRows(importId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from(decisionsTable)
    .select("*")
    .eq("import_id", importId);
  if (error) throw error;
  return (data ?? []) as FieldWorkforceDecisionRow[];
}

function decisionMap(rows: FieldWorkforceDecisionRow[]) {
  return new Map(rows.map((row) => [row.recommendation_key, row]));
}

export function buildFieldWorkforceRecommendationsReportFromArchive(
  archiveDetail: FieldWorkforceArchiveDetail,
  decisionRows: FieldWorkforceDecisionRow[] = [],
): FieldWorkforceRecommendationsReport {
  const decisions = decisionMap(decisionRows);
  const generated = generatedRecommendations(archiveDetail, decisions);
  const allRecommendations = [
    ...generated.leaveRecommendations,
    ...generated.payrollRecommendations,
  ];
  const finalActions = finalActionsFromRecommendations(allRecommendations);

  return {
    archive: archiveDetail.archive,
    finalActions,
    integrationStatus: {
      leaveSource: "not_connected",
      leaveSourceMessage: "Leave request read-only matching is deferred until the leave source is explicitly connected.",
      payrollAmount: "requires_calculation",
      payrollAmountMessage: "Payroll amounts are not estimated because no safe payroll formula is connected for this report.",
    },
    leaveRecommendations: generated.leaveRecommendations,
    payrollRecommendations: generated.payrollRecommendations,
  };
}

export async function getFieldWorkforceRecommendationsReport(input: {
  actorLoginId: string;
  archiveId: string;
  auditFinalReportView?: boolean;
}): Promise<FieldWorkforceRecommendationsReport | null> {
  const archiveDetail = await loadFieldWorkforceComplianceArchive({
    actorLoginId: input.actorLoginId,
    auditView: false,
    id: input.archiveId,
  });
  if (!archiveDetail) return null;

  const report = buildFieldWorkforceRecommendationsReportFromArchive(
    archiveDetail,
    await loadDecisionRows(input.archiveId),
  );

  if (input.auditFinalReportView) {
    await writeAuditLog({
      actorLoginId: input.actorLoginId,
      entityId: input.archiveId,
      entityType: "field_workforce_compliance_import",
      newValues: {
        finalActionCount: report.finalActions.length,
        monthKey: archiveDetail.archive.monthKey,
      },
      summary: "Field Workforce Compliance final approved actions report viewed.",
    });
  }

  return report;
}

export async function saveFieldWorkforceRecommendationDecision(input: {
  actorLoginId: string;
  archiveId: string;
  decisionStatus: FieldWorkforceDecisionStatus;
  hrNote: string;
  recommendationKey: string;
}): Promise<FieldWorkforceRecommendationsReport | null> {
  if (!fieldWorkforceDecisionStatuses.includes(input.decisionStatus)) {
    throw new Error("Unsupported Field Workforce Compliance decision status.");
  }

  const report = await getFieldWorkforceRecommendationsReport({
    actorLoginId: input.actorLoginId,
    archiveId: input.archiveId,
  });
  if (!report) return null;

  const recommendations = [
    ...report.leaveRecommendations,
    ...report.payrollRecommendations,
  ];
  const recommendation = recommendations.find((item) => item.recommendationKey === input.recommendationKey);
  if (!recommendation) throw new FieldWorkforceRecommendationNotFoundError(input.recommendationKey);

  const existingRows = await loadDecisionRows(input.archiveId);
  const existing = existingRows.find((row) => row.recommendation_key === input.recommendationKey) ?? null;
  const hasDecision = input.decisionStatus !== "Pending";
  const payload = {
    dates: recommendation.dates,
    days_count: recommendation.daysCount,
    decided_at: hasDecision ? new Date().toISOString() : null,
    decided_by: hasDecision ? input.actorLoginId : null,
    decision_status: input.decisionStatus,
    employee_code: recommendation.employeeCode,
    employee_name: recommendation.employeeName,
    estimated_amount: recommendation.estimatedAmount,
    existing_coverage_status: recommendation.existingCoverageStatus,
    hr_note: input.hrNote.trim(),
    import_id: input.archiveId,
    month_key: recommendation.monthKey,
    recommendation_key: input.recommendationKey,
    recommendation_reason: recommendation.recommendationReason,
    recommendation_type: recommendation.recommendationType,
    severity: recommendation.severity,
    source_type: recommendation.sourceType,
    updated_at: new Date().toISOString(),
  };

  const { error } = await getSupabaseAdmin()
    .from(decisionsTable)
    .upsert(payload, {
      onConflict: "import_id,recommendation_key",
    });
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: input.archiveId,
    entityType: "field_workforce_compliance_import",
    newValues: {
      decisionStatus: input.decisionStatus,
      hrNote: payload.hr_note,
      recommendationKey: input.recommendationKey,
      recommendationType: recommendation.recommendationType,
    },
    oldValues: existing ? {
      decisionStatus: existing.decision_status,
      hrNote: existing.hr_note,
    } : null,
    summary: existing
      ? "Field Workforce Compliance HR decision changed."
      : "Field Workforce Compliance recommendation decision created.",
  });

  return getFieldWorkforceRecommendationsReport({
    actorLoginId: input.actorLoginId,
    archiveId: input.archiveId,
  });
}

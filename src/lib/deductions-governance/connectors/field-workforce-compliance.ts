// Field Workforce Compliance to Deductions Governance connector. Read-only of FWC decisions; insert-only on deduction_candidates. NEVER mutates payroll or leave.

import type { SupabaseClient } from "@supabase/supabase-js";

import { writeAuditLog } from "@/lib/admin/audit";
import { listFieldWorkforceComplianceArchives } from "@/lib/field-workforce-compliance/archive";
import { buildFieldWorkforceCompliancePreviewFromVisitsReport } from "@/lib/field-workforce-compliance/ireports360-source";
import {
  buildFieldWorkforceRecommendationsReportForLiveMonth,
  getFieldWorkforceRecommendationsReport,
} from "@/lib/field-workforce-compliance/recommendations";
import type { FieldWorkforceRecommendationsReport } from "@/lib/field-workforce-compliance/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeMonthKey } from "../candidate-key.ts";
import {
  insertDeductionCandidateDrafts,
  prepareCandidateInsertPayload,
  validateCandidateDraft,
} from "../service.ts";
import {
  deductionSeverities,
  type DeductionCandidateDraft,
  type DeductionSeverity,
} from "../types.ts";

// The two decision_status values we honor as "approved" per FWC governance.
// Pending / Disputed / Needs Follow-up / Do Not Take Action / Cancelled / Resolved
// must NEVER be returned by the approved-decision query.
export const APPROVED_FWC_DECISION_STATUSES = [
  "Approved for Payroll Deduction Report",
  "Approved for Leave Adjustment Report",
] as const;

export type ApprovedFwcDecisionStatus = (typeof APPROVED_FWC_DECISION_STATUSES)[number];

export type FieldWorkforceApprovedDecisionRow = {
  id: string;
  import_id: string | null;
  recommendation_key: string;
  recommendation_type: string;
  source_type: string | null;
  employee_code: string;
  employee_name: string | null;
  month_key: string;
  dates: string[];
  days_count: number;
  severity: string | null;
  decision_status: ApprovedFwcDecisionStatus;
  decision_reason: string | null;
  hr_note: string | null;
  decided_at: string | null;
  decided_by: string | null;
  estimated_amount: number | null;
  existing_coverage_status: string | null;
  holiday_context?: string | null;
};

export type FwcSyncResult = {
  sourceTotal: number;
  created: number;
  skippedExisting: number;
  warnings: string[];
};

/**
 * Pure helper. Exposed for tests so the approved-decision filter shape is
 * verifiable without hitting Supabase.
 */
export function buildApprovedDecisionFilter(): {
  decisionStatuses: readonly string[];
} {
  return { decisionStatuses: APPROVED_FWC_DECISION_STATUSES };
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      out.push(entry.trim());
    }
  }
  return out;
}

function asInteger(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.trunc(value);
}

function asNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeSeverity(value: unknown): DeductionSeverity | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return (deductionSeverities as readonly string[]).includes(trimmed)
    ? (trimmed as DeductionSeverity)
    : null;
}

function coerceRow(raw: Record<string, unknown>): FieldWorkforceApprovedDecisionRow {
  const decisionStatus = asString(raw.decision_status) ?? "";
  if (!(APPROVED_FWC_DECISION_STATUSES as readonly string[]).includes(decisionStatus)) {
    throw new Error(`FWC decision_status "${decisionStatus}" is not an approved status`);
  }
  return {
    id: asString(raw.id) ?? "",
    // null for live (mirror-sourced) months, which have no field_workforce_compliance_imports
    // row to reference. Do not fall back to "" here — that would make an absent import_id
    // indistinguishable from a real-but-empty string downstream.
    import_id: asString(raw.import_id),
    recommendation_key: asString(raw.recommendation_key) ?? "",
    recommendation_type: asString(raw.recommendation_type) ?? "",
    source_type: asString(raw.source_type),
    employee_code: asString(raw.employee_code) ?? "",
    employee_name: asString(raw.employee_name),
    month_key: asString(raw.month_key) ?? "",
    dates: asStringArray(raw.dates),
    days_count: asInteger(raw.days_count, 0),
    severity: asString(raw.severity),
    decision_status: decisionStatus as ApprovedFwcDecisionStatus,
    decision_reason: asString(raw.decision_reason),
    hr_note: asString(raw.hr_note),
    decided_at: asString(raw.decided_at),
    decided_by: asString(raw.decided_by),
    estimated_amount: asNumberOrNull(raw.estimated_amount),
    existing_coverage_status: asString(raw.existing_coverage_status),
    holiday_context: asString(raw.holiday_context),
  };
}

/**
 * Read-only query against field_workforce_compliance_decisions.
 * NEVER writes back to FWC tables. Returns only rows in one of the two
 * approved final-action statuses.
 */
export async function listFieldWorkforceApprovedDecisions(input: {
  importId?: string;
  monthKey?: string;
  supabase?: SupabaseClient;
} = {}): Promise<FieldWorkforceApprovedDecisionRow[]> {
  const client = input.supabase ?? getSupabaseAdmin();
  let query = client
    .from("field_workforce_compliance_decisions")
    .select(
      "id, import_id, recommendation_key, recommendation_type, source_type, employee_code, employee_name, month_key, dates, days_count, severity, decision_status, decision_reason, hr_note, decided_at, decided_by, estimated_amount, existing_coverage_status",
    )
    .in("decision_status", APPROVED_FWC_DECISION_STATUSES as unknown as string[]);

  if (input.importId && input.importId.trim()) {
    query = query.eq("import_id", input.importId.trim());
  }
  if (input.monthKey && input.monthKey.trim()) {
    query = query.eq("month_key", input.monthKey.trim());
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load approved Field Workforce Compliance decisions: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data : [];
  const coerced: FieldWorkforceApprovedDecisionRow[] = [];
  for (const raw of rows) {
    try {
      coerced.push(coerceRow(raw as Record<string, unknown>));
    } catch {
      // Skip malformed rows defensively; sync warnings will surface count gaps.
    }
  }
  return coerced;
}

/**
 * Pure mapping. Produces a DeductionCandidateDraft from one FWC approved
 * decision row. Never touches the DB. Used by both the connector sync path
 * and tests.
 */
export function toDeductionCandidateDraft(
  row: FieldWorkforceApprovedDecisionRow,
  options?: { hierarchySnapshot?: Record<string, unknown> },
): DeductionCandidateDraft {
  const monthKey = normalizeMonthKey(row.month_key);
  const [yearStr, monthStr] = monthKey.split("-");
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);

  const severity = normalizeSeverity(row.severity);

  const evidence: Record<string, unknown> = {
    importId: row.import_id,
    recommendationKey: row.recommendation_key,
    recommendationType: row.recommendation_type,
    sourceType: row.source_type ?? null,
    decisionStatus: row.decision_status,
    decisionReason: row.decision_reason ?? null,
    hrNote: row.hr_note ?? null,
    decidedAt: row.decided_at ?? null,
    decidedBy: row.decided_by ?? null,
    existingCoverageStatus: row.existing_coverage_status ?? null,
    severity: row.severity ?? null,
  };

  // import_id is null for live (mirror-sourced) months — fall back to month_key so this
  // never collapses to the literal string "null:<key>", which would be a malformed,
  // non-unique audit-trail value for every live-mirror-sourced approved decision.
  const sourceRecordId = `${row.import_id ?? row.month_key}:${row.recommendation_key}`;
  const hierarchySnapshot = options?.hierarchySnapshot ?? {};
  const holidayContext = row.holiday_context ?? null;

  if (row.decision_status === "Approved for Payroll Deduction Report") {
    return {
      sourceModule: "FIELD_WORKFORCE",
      sourceRecordId,
      employeeCode: row.employee_code,
      employeeName: row.employee_name,
      monthKey,
      month,
      year,
      deductionType: "no_activity",
      deductionUnit: "days",
      deductionValue: row.days_count,
      estimatedAmount: null,
      calculationStatus: "requires_payroll_review",
      severity,
      reason: "Approved Field Workforce Compliance no-activity recommendation",
      evidence,
      holidayContext,
      dates: row.dates,
      hierarchySnapshot,
    };
  }

  // Approved for Leave Adjustment Report
  return {
    sourceModule: "FIELD_WORKFORCE",
    sourceRecordId,
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    monthKey,
    month,
    year,
    deductionType: "retroactive_leave",
    deductionUnit: "days",
    deductionValue: row.days_count,
    estimatedAmount: null,
    calculationStatus: "not_applicable",
    severity,
    reason: "Approved Field Workforce Compliance leave adjustment recommendation",
    evidence,
    holidayContext,
    dates: row.dates,
    hierarchySnapshot,
  };
}

type AuditLogger = (input: Parameters<typeof writeAuditLog>[0]) => Promise<void> | void;

/**
 * Sync approved Field Workforce Compliance decisions into deduction_candidates.
 * - READ-ONLY of FWC tables.
 * - INSERT-ONLY of deduction_candidates (no update, no delete, no decision write).
 * - Skips candidates whose deterministic candidate_key already exists live.
 */
export async function syncFieldWorkforceApprovedDecisions(input: {
  importId?: string;
  monthKey?: string;
  createdBy: string;
  supabase?: SupabaseClient;
  auditLogger?: AuditLogger;
}): Promise<FwcSyncResult> {
  if (typeof input.createdBy !== "string" || !input.createdBy.trim()) {
    throw new Error("syncFieldWorkforceApprovedDecisions requires createdBy");
  }
  const client = input.supabase ?? getSupabaseAdmin();
  const auditLog: AuditLogger = input.auditLogger ?? writeAuditLog;

  const approvedRows = await listFieldWorkforceApprovedDecisions({
    importId: input.importId,
    monthKey: input.monthKey,
    supabase: client,
  });

  let created = 0;
  let skippedExisting = 0;
  const warnings: string[] = [];

  for (const row of approvedRows) {
    let draft: DeductionCandidateDraft;
    try {
      draft = toDeductionCandidateDraft(row);
    } catch (error) {
      warnings.push(
        `FWC row ${row.id} (${row.recommendation_key}): mapping failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const validation = validateCandidateDraft(draft);
    if (!validation.valid) {
      warnings.push(
        `FWC row ${row.id} (${row.recommendation_key}): invalid draft: ${validation.errors.join("; ")}`,
      );
      continue;
    }

    let payload;
    try {
      payload = prepareCandidateInsertPayload(draft, { createdBy: input.createdBy });
    } catch (error) {
      warnings.push(
        `FWC row ${row.id} (${row.recommendation_key}): prepare failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    // Idempotency probe against the live unique partial index
    // (source_module, candidate_key) WHERE superseded_at IS NULL.
    const probe = await client
      .from("deduction_candidates")
      .select("id")
      .eq("source_module", payload.source_module)
      .eq("candidate_key", payload.candidate_key)
      .is("superseded_at", null)
      .limit(1);

    if (probe.error) {
      warnings.push(
        `FWC row ${row.id} (${row.recommendation_key}): probe failed: ${probe.error.message}`,
      );
      continue;
    }
    if (Array.isArray(probe.data) && probe.data.length > 0) {
      skippedExisting += 1;
      continue;
    }

    const insert = await client
      .from("deduction_candidates")
      .insert(payload)
      .select("id")
      .single();

    if (insert.error) {
      const code = (insert.error as { code?: string }).code ?? "";
      if (code === "23505") {
        // Raced with another sync; treat as already-present.
        skippedExisting += 1;
        continue;
      }
      warnings.push(
        `FWC row ${row.id} (${row.recommendation_key}): insert failed: ${insert.error.message}`,
      );
      continue;
    }

    created += 1;
    const insertedId = (insert.data as { id?: string } | null)?.id ?? null;

    try {
      await auditLog({
        actorLoginId: input.createdBy,
        entityId: insertedId,
        entityType: "deduction_candidate",
        newValues: payload as unknown as Record<string, unknown>,
        summary: "Deduction candidate created from Field Workforce Compliance",
      });
    } catch {
      // writeAuditLog already swallows; defensive in case a custom logger throws.
    }
  }

  return {
    sourceTotal: approvedRows.length,
    created,
    skippedExisting,
    warnings,
  };
}

/**
 * Pure mapping shared by the archive-scoped and live-month-scoped no-activity syncs:
 * turns a recommendations report's no-activity payroll recommendations into drafts.
 * recommendation.importId is always a non-null string here (a real archive id or the
 * synthetic "live:<monthKey>" sentinel from buildSyntheticArchiveForLiveMonth), so no
 * null-fallback is needed the way toDeductionCandidateDraft needs one for import_id.
 */
function draftsFromNoActivityRecommendations(report: FieldWorkforceRecommendationsReport): DeductionCandidateDraft[] {
  const drafts: DeductionCandidateDraft[] = [];
  for (const recommendation of report.payrollRecommendations) {
    if (recommendation.sourceType !== "no_activity_candidate") continue;
    const [yearStr, monthStr] = recommendation.monthKey.split("-");
    const year = Number.parseInt(yearStr, 10);
    const month = Number.parseInt(monthStr, 10);
    drafts.push({
      sourceModule: "FIELD_WORKFORCE",
      sourceRecordId: `${recommendation.importId}:${recommendation.recommendationKey}:pending`,
      employeeCode: recommendation.employeeCode,
      employeeName: recommendation.employeeName,
      monthKey: recommendation.monthKey,
      month,
      year,
      deductionType: "no_activity",
      deductionUnit: "days",
      deductionValue: recommendation.daysCount,
      estimatedAmount: null,
      calculationStatus: "requires_payroll_review",
      severity: recommendation.severity,
      reason: "Field Workforce Compliance no-activity absence candidate",
      evidence: {
        archiveId: recommendation.importId,
        existingCoverageStatus: recommendation.existingCoverageStatus,
        recommendationKey: recommendation.recommendationKey,
        recommendationReason: recommendation.recommendationReason,
        sourceType: recommendation.sourceType,
      },
      holidayContext: recommendation.holidayContext,
      dates: recommendation.dates,
      hierarchySnapshot: {
        areaName: recommendation.areaName,
        lineName: recommendation.lineName,
        managerName: recommendation.managerName,
        roleName: recommendation.roleName,
        teamName: recommendation.teamName,
      },
    });
  }
  return drafts;
}

export async function syncFieldWorkforceNoActivityCandidates(input: {
  archiveId?: string;
  monthKey?: string;
  createdBy: string;
}): Promise<FwcSyncResult> {
  if (typeof input.createdBy !== "string" || !input.createdBy.trim()) {
    throw new Error("syncFieldWorkforceNoActivityCandidates requires createdBy");
  }
  const monthKey = input.monthKey ? normalizeMonthKey(input.monthKey) : undefined;
  const archives = input.archiveId
    ? [{ id: input.archiveId.trim(), monthKey: monthKey ?? "" }]
    : (await listFieldWorkforceComplianceArchives()).filter((archive) =>
        monthKey ? archive.monthKey === monthKey : true,
      );
  if (archives.length === 0) {
    return {
      sourceTotal: 0,
      created: 0,
      skippedExisting: 0,
      warnings: ["No archived Field Workforce Compliance month matched this sync scope."],
    };
  }

  const drafts: DeductionCandidateDraft[] = [];
  const warnings: string[] = [];
  for (const archive of archives) {
    const report = await getFieldWorkforceRecommendationsReport({
      actorLoginId: input.createdBy,
      archiveId: archive.id,
      auditFinalReportView: false,
    });
    if (!report) {
      warnings.push(`FWC archive ${archive.id}: report not found.`);
      continue;
    }
    drafts.push(...draftsFromNoActivityRecommendations(report));
  }

  const inserted = await insertDeductionCandidateDrafts({
    createdBy: input.createdBy,
    drafts,
    sourceLabel: "Field Workforce Compliance no-activity",
  });

  return {
    sourceTotal: drafts.length,
    created: inserted.created,
    skippedExisting: inserted.skippedExisting,
    warnings: [...warnings, ...inserted.warnings],
  };
}

/**
 * Live-month sibling of syncFieldWorkforceNoActivityCandidates. The archive-scoped version
 * only ever sees Excel-archived months (it iterates listFieldWorkforceComplianceArchives());
 * live (mirror-sourced) months never get an imports row, so without this sibling the
 * payroll-deduction-candidate generator would silently never run for CRM-sourced months
 * post-migration. Builds the month's preview from the visits mirror, computes its
 * recommendations report the same way the live-month API route does, and reuses the same
 * insert-only drafts pipeline.
 */
export async function syncFieldWorkforceNoActivityCandidatesForLiveMonth(input: {
  createdBy: string;
  month: number;
  year: number;
}): Promise<FwcSyncResult> {
  if (typeof input.createdBy !== "string" || !input.createdBy.trim()) {
    throw new Error("syncFieldWorkforceNoActivityCandidatesForLiveMonth requires createdBy");
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const preview = await buildFieldWorkforceCompliancePreviewFromVisitsReport({
    month: input.month,
    todayIso,
    year: input.year,
  });
  const monthKey = normalizeMonthKey(`${input.year}-${String(input.month).padStart(2, "0")}`);
  const report = await buildFieldWorkforceRecommendationsReportForLiveMonth({ monthKey, preview });
  const drafts = draftsFromNoActivityRecommendations(report);

  const inserted = await insertDeductionCandidateDrafts({
    createdBy: input.createdBy,
    drafts,
    sourceLabel: "Field Workforce Compliance no-activity (live)",
  });

  return {
    sourceTotal: drafts.length,
    created: inserted.created,
    skippedExisting: inserted.skippedExisting,
    warnings: inserted.warnings,
  };
}

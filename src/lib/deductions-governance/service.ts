// Deductions Governance Center foundation. NEVER mutate payroll (salary_records) or employee leave balances from this module. Decisions are governance-only.

import { writeAuditLog } from "@/lib/admin/audit";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "../hr-id.ts";
import {
  assertDeductionsGovernanceDecisionActor,
  calculateDeductionAmountFromBaseSalary,
  payrollColumnForDeduction,
} from "./calculations.ts";
import {
  buildDeductionCandidateKey,
  normalizeDates,
  normalizeMonthKey,
} from "./candidate-key.ts";
import {
  deductionCalculationStatuses,
  deductionDecisionReasons,
  deductionDecisionStatuses,
  deductionPayrollColumns,
  deductionPayrollHandoffStatuses,
  deductionSeverities,
  deductionSourceModules,
  deductionTypes,
  deductionUnits,
  type DeductionCalculationStatus,
  type DeductionCandidate,
  type DeductionCandidateDraft,
  type DeductionDecision,
  type DeductionDecisionReason,
  type DeductionDecisionStatus,
  type DeductionMonthlySummary,
  type DeductionMonthlySummaryLine,
  type DeductionComment,
  type DeductionPayrollColumn,
  type DeductionPayrollHandoffStatus,
  type DeductionSeverity,
  type DeductionSourceModule,
  type DeductionType,
} from "./types.ts";

export type CandidateValidationResult = {
  valid: boolean;
  errors: string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

export function compactDeductionHrId(value: string | null | undefined): string | null {
  const canonical = canonicalHrIdKey(value);
  if (!canonical) return null;
  const compact = canonical.replace(/[^a-z0-9]/g, "");
  return compact ? compact : null;
}

const compactHrId = compactDeductionHrId;

export function validateCandidateDraft(
  draft: DeductionCandidateDraft,
): CandidateValidationResult {
  const errors: string[] = [];

  if (!draft || typeof draft !== "object") {
    errors.push("draft must be an object");
    return { valid: false, errors };
  }

  if (!deductionSourceModules.includes(draft.sourceModule)) {
    errors.push(`sourceModule "${String(draft.sourceModule)}" is not a recognized source module`);
  }

  if (typeof draft.sourceRecordId !== "string" || !draft.sourceRecordId.trim()) {
    errors.push("sourceRecordId must be a non-empty string");
  }

  if (typeof draft.employeeCode !== "string" || !draft.employeeCode.trim()) {
    errors.push("employeeCode must be a non-empty string");
  } else if (!canonicalHrIdKey(draft.employeeCode)) {
    errors.push("employeeCode could not be normalized to a canonical HR_ID");
  }

  let normalizedMonthKey: string | null = null;
  if (typeof draft.monthKey !== "string" || !draft.monthKey.trim()) {
    errors.push("monthKey must be a non-empty string");
  } else {
    try {
      normalizedMonthKey = normalizeMonthKey(draft.monthKey);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!Number.isInteger(draft.month) || draft.month < 1 || draft.month > 12) {
    errors.push("month must be an integer between 1 and 12");
  }
  if (!Number.isInteger(draft.year) || draft.year < 2000 || draft.year > 2100) {
    errors.push("year must be an integer between 2000 and 2100");
  }
  if (normalizedMonthKey) {
    const [yearStr, monthStr] = normalizedMonthKey.split("-");
    const yearFromKey = Number.parseInt(yearStr, 10);
    const monthFromKey = Number.parseInt(monthStr, 10);
    if (yearFromKey !== draft.year) {
      errors.push(`year ${draft.year} does not match monthKey ${normalizedMonthKey}`);
    }
    if (monthFromKey !== draft.month) {
      errors.push(`month ${draft.month} does not match monthKey ${normalizedMonthKey}`);
    }
  }

  if (!deductionTypes.includes(draft.deductionType)) {
    errors.push(`deductionType "${String(draft.deductionType)}" is not recognized`);
  }
  if (!deductionUnits.includes(draft.deductionUnit)) {
    errors.push(`deductionUnit "${String(draft.deductionUnit)}" is not recognized`);
  }
  if (
    typeof draft.deductionValue !== "number" ||
    !Number.isFinite(draft.deductionValue) ||
    draft.deductionValue < 0
  ) {
    errors.push("deductionValue must be a finite non-negative number");
  }

  if (draft.estimatedAmount !== undefined && draft.estimatedAmount !== null) {
    if (typeof draft.estimatedAmount !== "number" || !Number.isFinite(draft.estimatedAmount)) {
      errors.push("estimatedAmount must be a finite number when provided");
    }
  }

  const status: DeductionCalculationStatus =
    draft.calculationStatus ?? "requires_payroll_review";
  if (!deductionCalculationStatuses.includes(status)) {
    errors.push(`calculationStatus "${String(draft.calculationStatus)}" is not recognized`);
  }

  if (draft.severity !== undefined && draft.severity !== null) {
    if (!deductionSeverities.includes(draft.severity)) {
      errors.push(`severity "${String(draft.severity)}" is not recognized`);
    }
  }

  if (!Array.isArray(draft.dates)) {
    errors.push("dates must be an array of YYYY-MM-DD strings");
  } else {
    try {
      normalizeDates(draft.dates);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (draft.evidence !== undefined && draft.evidence !== null && !isPlainObject(draft.evidence)) {
    errors.push("evidence must be a plain object when provided");
  }
  if (
    draft.hierarchySnapshot !== undefined &&
    draft.hierarchySnapshot !== null &&
    !isPlainObject(draft.hierarchySnapshot)
  ) {
    errors.push("hierarchySnapshot must be a plain object when provided");
  }

  return { valid: errors.length === 0, errors };
}

export type CandidateInsertPayload = {
  source_module: string;
  source_record_id: string;
  candidate_key: string;
  employee_code: string;
  employee_hr_id_compact: string;
  employee_name: string | null;
  month_key: string;
  month: number;
  year: number;
  deduction_type: string;
  deduction_unit: string;
  deduction_value: number;
  estimated_amount: number | null;
  calculation_status: string;
  severity: string | null;
  reason: string | null;
  evidence: Record<string, unknown>;
  holiday_context: string | null;
  dates: string[];
  hierarchy_snapshot: Record<string, unknown>;
  created_by: string;
};

export function prepareCandidateInsertPayload(
  draft: DeductionCandidateDraft,
  options: { createdBy: string },
): CandidateInsertPayload {
  const validation = validateCandidateDraft(draft);
  if (!validation.valid) {
    throw new Error(
      `Invalid deduction candidate draft: ${validation.errors.join("; ")}`,
    );
  }
  if (!options || typeof options.createdBy !== "string" || !options.createdBy.trim()) {
    throw new Error("prepareCandidateInsertPayload requires options.createdBy");
  }

  const normalizedEmployeeCode = canonicalHrIdKey(draft.employeeCode);
  const compactHr = compactHrId(draft.employeeCode);
  if (!normalizedEmployeeCode || !compactHr) {
    throw new Error("employeeCode could not be normalized to a canonical HR_ID");
  }

  const normalizedMonthKey = normalizeMonthKey(draft.monthKey);
  const normalizedDates = normalizeDates(draft.dates);
  const candidateKey = buildDeductionCandidateKey({
    sourceModule: draft.sourceModule,
    sourceRecordId: draft.sourceRecordId,
    employeeCode: draft.employeeCode,
    monthKey: draft.monthKey,
    deductionType: draft.deductionType,
    dates: draft.dates,
  });

  return {
    source_module: draft.sourceModule,
    source_record_id: draft.sourceRecordId.trim(),
    candidate_key: candidateKey,
    employee_code: normalizedEmployeeCode,
    employee_hr_id_compact: compactHr,
    employee_name: draft.employeeName ?? null,
    month_key: normalizedMonthKey,
    month: draft.month,
    year: draft.year,
    deduction_type: draft.deductionType,
    deduction_unit: draft.deductionUnit,
    deduction_value: draft.deductionValue,
    estimated_amount:
      draft.estimatedAmount === undefined || draft.estimatedAmount === null
        ? null
        : draft.estimatedAmount,
    calculation_status: draft.calculationStatus ?? "requires_payroll_review",
    severity: draft.severity ?? null,
    reason: draft.reason ?? null,
    evidence: draft.evidence ?? {},
    holiday_context: draft.holidayContext ?? null,
    dates: normalizedDates,
    hierarchy_snapshot: draft.hierarchySnapshot ?? {},
    created_by: options.createdBy.trim(),
  };
}

export type CandidateDraftInsertResult = {
  created: number;
  skippedExisting: number;
  warnings: string[];
};

export async function insertDeductionCandidateDrafts(input: {
  createdBy: string;
  drafts: DeductionCandidateDraft[];
  sourceLabel: string;
}): Promise<CandidateDraftInsertResult> {
  if (!input.createdBy.trim()) {
    throw new Error("insertDeductionCandidateDrafts requires createdBy");
  }
  const supabase = getSupabaseAdmin();
  let created = 0;
  let skippedExisting = 0;
  const warnings: string[] = [];

  for (const draft of input.drafts) {
    let payload: CandidateInsertPayload;
    try {
      payload = prepareCandidateInsertPayload(draft, {
        createdBy: input.createdBy,
      });
    } catch (error) {
      warnings.push(
        `${input.sourceLabel}: invalid draft: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const probe = await supabase
      .from("deduction_candidates")
      .select("id")
      .eq("source_module", payload.source_module)
      .eq("candidate_key", payload.candidate_key)
      .is("superseded_at", null)
      .limit(1);

    if (probe.error) {
      warnings.push(`${input.sourceLabel}: duplicate probe failed: ${probe.error.message}`);
      continue;
    }
    if (Array.isArray(probe.data) && probe.data.length > 0) {
      skippedExisting += 1;
      continue;
    }

    const insert = await supabase
      .from("deduction_candidates")
      .insert(payload)
      .select("id")
      .single();

    if (insert.error) {
      const code = (insert.error as { code?: string }).code ?? "";
      if (code === "23505") {
        skippedExisting += 1;
        continue;
      }
      warnings.push(`${input.sourceLabel}: insert failed: ${insert.error.message}`);
      continue;
    }

    created += 1;
    await writeAuditLog({
      actorLoginId: input.createdBy,
      entityId: (insert.data as { id?: string } | null)?.id ?? null,
      entityType: "deduction_candidate",
      newValues: payload as unknown as Record<string, unknown>,
      summary: `Deduction candidate created from ${input.sourceLabel}`,
    });
  }

  return { created, skippedExisting, warnings };
}

// ---------------------------------------------------------------------------
// Deductions Governance service surface.
//
// Strict boundaries (read this before adding anything):
// - No write to salary_records, salary_batches, payroll_batches, payslips,
//   employee_leave_balances, leave_transactions, v2_vacation_requests, or any
//   payroll/leave RPC from this module.
// - Governance decisions, summaries, comments, and export registry writes are
//   allowed here. Payroll handoff/import lives in a separate module/RPC.
// ---------------------------------------------------------------------------

export type DeductionInboxFilters = {
  monthKey?: string;
  sourceModule?: DeductionSourceModule;
  deductionType?: DeductionType;
  decisionStatus?: DeductionDecisionStatus;
  severity?: DeductionSeverity;
  employeeSearch?: string;
  includeSuperseded?: boolean;
};

export type DeductionInboxRow = DeductionCandidate & {
  decision: DeductionDecision | null;
};

export type DeductionInboxPage = {
  page: number;
  pageSize: number;
  total: number;
  rows: DeductionInboxRow[];
};

export type DeductionInboxKpis = {
  total: number;
  pending: number;
  approvedForPayroll: number;
  approvedForLeaveAdjustment: number;
  doNotTakeAction: number;
  needsFollowUp: number;
  disputed: number;
  resolved: number;
  cancelled: number;
  employeesAffected: number;
  activeSources: number;
  estimatedAmountSubtotal: number;
};

export type DeductionSourceGroup = {
  sourceModule: DeductionSourceModule;
  count: number;
  pending: number;
  approvedForPayroll: number;
  approvedForLeaveAdjustment: number;
  disputed: number;
  estimatedAmountCalculatedSubtotal: number;
};

export type DeductionEmployeeGroup = {
  employeeCode: string;
  employeeName: string;
  totalCandidates: number;
  pending: number;
  approvedForPayroll: number;
  approvedForLeaveAdjustment: number;
  disputed: number;
  monthsAffected: string[];
};

export type DeductionAuditEvent = {
  id: string;
  createdAt: string;
  actorLoginId: string;
  entityType: string | null;
  entityId: string | null;
  summary: string | null;
};

export type DeductionCommentFeedItem = DeductionComment & {
  deductionType: DeductionType | null;
  employeeCode: string | null;
  employeeName: string | null;
  monthKey: string | null;
  sourceModule: DeductionSourceModule | null;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_KPI_ROWS = 10000;
const MAX_BY_EMPLOYEE_DEFAULT = 100;

function clampPageSize(input: number | undefined): number {
  if (!Number.isFinite(input ?? NaN)) return DEFAULT_PAGE_SIZE;
  const value = Math.floor(input as number);
  if (value <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, value);
}

function clampPage(input: number | undefined): number {
  if (!Number.isFinite(input ?? NaN)) return 1;
  const value = Math.floor(input as number);
  return value <= 0 ? 1 : value;
}

function safeNormalizeMonthKey(input: string | undefined | null): string | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;
  try {
    return normalizeMonthKey(input);
  } catch {
    return undefined;
  }
}

export function sanitizeDeductionInboxFilters(
  raw: DeductionInboxFilters | undefined,
): DeductionInboxFilters {
  const filters: DeductionInboxFilters = {};
  if (!raw) return filters;

  const monthKey = safeNormalizeMonthKey(raw.monthKey);
  if (monthKey) filters.monthKey = monthKey;

  if (raw.sourceModule && deductionSourceModules.includes(raw.sourceModule)) {
    filters.sourceModule = raw.sourceModule;
  }
  if (raw.deductionType && deductionTypes.includes(raw.deductionType)) {
    filters.deductionType = raw.deductionType;
  }
  if (raw.decisionStatus && deductionDecisionStatuses.includes(raw.decisionStatus)) {
    filters.decisionStatus = raw.decisionStatus;
  }
  if (raw.severity && deductionSeverities.includes(raw.severity)) {
    filters.severity = raw.severity;
  }
  if (typeof raw.employeeSearch === "string") {
    const trimmed = raw.employeeSearch.trim();
    if (trimmed) filters.employeeSearch = trimmed.slice(0, 120);
  }
  if (typeof raw.includeSuperseded === "boolean") {
    filters.includeSuperseded = raw.includeSuperseded;
  }
  return filters;
}

type CandidateRow = {
  id: string;
  source_module: string;
  source_record_id: string;
  candidate_key: string;
  employee_code: string;
  employee_hr_id_compact: string;
  employee_name: string | null;
  month_key: string;
  month: number;
  year: number;
  deduction_type: string;
  deduction_unit: string;
  deduction_value: string | number;
  estimated_amount: string | number | null;
  calculation_status: string;
  severity: string | null;
  reason: string | null;
  evidence: Record<string, unknown> | null;
  holiday_context: string | null;
  dates: unknown;
  hierarchy_snapshot: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  superseded_at: string | null;
  superseded_by_candidate_id: string | null;
};

type DecisionRow = {
  id: string;
  candidate_id: string;
  decision_status: string;
  decision_reason: string | null;
  hr_note: string | null;
  applied_deduction_value: string | number | null;
  applied_amount: string | number | null;
  payroll_column: string | null;
  decided_by: string | null;
  decided_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  payroll_handoff_status: string;
  last_export_id: string | null;
  finalized_summary_id: string | null;
  actor_role_at_decision: string | null;
  actor_scope_at_decision: string | null;
  created_at: string;
  updated_at: string;
};

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asDates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string") as string[];
}

function isSourceModule(value: string): value is DeductionSourceModule {
  return (deductionSourceModules as readonly string[]).includes(value);
}

function isDeductionType(value: string): value is DeductionType {
  return (deductionTypes as readonly string[]).includes(value);
}

function isDecisionStatus(value: string): value is DeductionDecisionStatus {
  return (deductionDecisionStatuses as readonly string[]).includes(value);
}

function isPayrollHandoff(value: string): value is DeductionPayrollHandoffStatus {
  return (deductionPayrollHandoffStatuses as readonly string[]).includes(value);
}

function isPayrollColumn(value: string | null | undefined): value is DeductionPayrollColumn {
  return Boolean(value && (deductionPayrollColumns as readonly string[]).includes(value));
}

function mapCandidateRow(row: CandidateRow): DeductionCandidate {
  const sourceModule = isSourceModule(row.source_module) ? row.source_module : "OTHER";
  const deductionType = isDeductionType(row.deduction_type)
    ? row.deduction_type
    : "other";
  const calculationStatus: DeductionCalculationStatus = (
    deductionCalculationStatuses as readonly string[]
  ).includes(row.calculation_status)
    ? (row.calculation_status as DeductionCalculationStatus)
    : "requires_payroll_review";
  const severity =
    row.severity && (deductionSeverities as readonly string[]).includes(row.severity)
      ? (row.severity as DeductionSeverity)
      : null;
  const deductionUnit = (deductionUnits as readonly string[]).includes(row.deduction_unit)
    ? (row.deduction_unit as DeductionCandidate["deductionUnit"])
    : "count";

  return {
    id: row.id,
    sourceModule,
    sourceRecordId: row.source_record_id,
    candidateKey: row.candidate_key,
    employeeCode: row.employee_code,
    employeeHrIdCompact: row.employee_hr_id_compact,
    employeeName: row.employee_name,
    monthKey: row.month_key,
    month: row.month,
    year: row.year,
    deductionType,
    deductionUnit,
    deductionValue: toNumber(row.deduction_value),
    estimatedAmount: toNullableNumber(row.estimated_amount),
    calculationStatus,
    severity,
    reason: row.reason,
    evidence: row.evidence ?? {},
    holidayContext: row.holiday_context,
    dates: asDates(row.dates),
    hierarchySnapshot: row.hierarchy_snapshot ?? {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
    supersededByCandidateId: row.superseded_by_candidate_id,
  };
}

function mapDecisionRow(row: DecisionRow): DeductionDecision {
  const decisionStatus = isDecisionStatus(row.decision_status)
    ? row.decision_status
    : "Pending";
  const payrollHandoffStatus = isPayrollHandoff(row.payroll_handoff_status)
    ? row.payroll_handoff_status
    : "Not pushed";
  return {
    id: row.id,
    candidateId: row.candidate_id,
    decisionStatus,
    decisionReason: row.decision_reason ?? "",
    hrNote: row.hr_note ?? "",
    appliedDeductionValue: toNullableNumber(row.applied_deduction_value),
    appliedAmount: toNullableNumber(row.applied_amount),
    payrollColumn: isPayrollColumn(row.payroll_column) ? row.payroll_column : null,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    payrollHandoffStatus,
    lastExportId: row.last_export_id,
    finalizedSummaryId: row.finalized_summary_id,
    actorRoleAtDecision: row.actor_role_at_decision,
    actorScopeAtDecision: row.actor_scope_at_decision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CANDIDATE_COLUMNS =
  "id, source_module, source_record_id, candidate_key, employee_code, employee_hr_id_compact, employee_name, month_key, month, year, deduction_type, deduction_unit, deduction_value, estimated_amount, calculation_status, severity, reason, evidence, holiday_context, dates, hierarchy_snapshot, created_by, created_at, superseded_at, superseded_by_candidate_id";

const DECISION_COLUMNS =
  "id, candidate_id, decision_status, decision_reason, hr_note, applied_deduction_value, applied_amount, payroll_column, decided_by, decided_at, resolved_at, resolved_by, payroll_handoff_status, last_export_id, finalized_summary_id, actor_role_at_decision, actor_scope_at_decision, created_at, updated_at";

// Use a structurally typed builder so the helper composes both with .select()
// outputs and chained filter builders without coupling to internal generics.
// We intentionally use `unknown` + a structural cast inside to keep the
// Supabase generic inference shallow (deep types from PostgREST explode here).
type AnyFilterableBuilder = {
  is: (column: string, value: unknown) => AnyFilterableBuilder;
  eq: (column: string, value: unknown) => AnyFilterableBuilder;
  or: (filters: string) => AnyFilterableBuilder;
};

function applyCandidateFilters(
  query: unknown,
  filters: DeductionInboxFilters,
): unknown {
  let next = query as AnyFilterableBuilder;
  if (!filters.includeSuperseded) {
    next = next.is("superseded_at", null);
  }
  if (filters.monthKey) {
    next = next.eq("month_key", filters.monthKey);
  }
  if (filters.sourceModule) {
    next = next.eq("source_module", filters.sourceModule);
  }
  if (filters.deductionType) {
    next = next.eq("deduction_type", filters.deductionType);
  }
  if (filters.severity) {
    next = next.eq("severity", filters.severity);
  }
  if (filters.employeeSearch) {
    const term = filters.employeeSearch.replace(/[%_]/g, "");
    if (term) {
      next = next.or(
        `employee_name.ilike.%${term}%,employee_code.ilike.%${term}%`,
      );
    }
  }
  return next;
}

async function fetchDecisionsByCandidateIds(
  candidateIds: string[],
): Promise<Map<string, DeductionDecision>> {
  const decisionMap = new Map<string, DeductionDecision>();
  if (candidateIds.length === 0) return decisionMap;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("deduction_decisions")
    .select(DECISION_COLUMNS)
    .in("candidate_id", candidateIds);

  if (error) throw error;
  for (const row of (data ?? []) as DecisionRow[]) {
    decisionMap.set(row.candidate_id, mapDecisionRow(row));
  }
  return decisionMap;
}

function joinRowsAndDecisions(
  candidates: DeductionCandidate[],
  decisions: Map<string, DeductionDecision>,
): DeductionInboxRow[] {
  return candidates.map((candidate) => ({
    ...candidate,
    decision: decisions.get(candidate.id) ?? null,
  }));
}

function passesDecisionStatusFilter(
  row: DeductionInboxRow,
  status: DeductionDecisionStatus | undefined,
): boolean {
  if (!status) return true;
  const effective = row.decision?.decisionStatus ?? "Pending";
  return effective === status;
}

export async function listDeductionCandidates(input: {
  access: AccessContext;
  filters?: DeductionInboxFilters;
  page?: number;
  pageSize?: number;
}): Promise<DeductionInboxPage> {
  // Caller is expected to assert read permission on `deductions`.
  // This service does not duplicate the role gate; it relies on the route layer.
  const filters = sanitizeDeductionInboxFilters(input.filters);
  const pageSize = clampPageSize(input.pageSize);
  const page = clampPage(input.page);
  const offset = (page - 1) * pageSize;
  const decisionStatusFilter = filters.decisionStatus;

  const supabase = getSupabaseAdmin();

  // When decisionStatus is required, we need a wider candidate window because
  // we filter the join in JS. Without it we can use exact pagination.
  if (!decisionStatusFilter) {
    const baseQuery = supabase
      .from("deduction_candidates")
      .select(CANDIDATE_COLUMNS, { count: "exact" });
    const filteredQuery = applyCandidateFilters(baseQuery, filters) as typeof baseQuery;
    const { data, error, count } = await filteredQuery
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const candidates = ((data ?? []) as CandidateRow[]).map(mapCandidateRow);
    const decisions = await fetchDecisionsByCandidateIds(candidates.map((c) => c.id));
    const rows = joinRowsAndDecisions(candidates, decisions);
    return {
      page,
      pageSize,
      total: count ?? rows.length,
      rows,
    };
  }

  // decisionStatus filter requires loading a bounded window of candidates and
  // matching against decisions client-side (since Supabase PostgREST does not
  // expose a join filter for nullable inverse joins cleanly here).
  const baseQuery = supabase
    .from("deduction_candidates")
    .select(CANDIDATE_COLUMNS);
  const filteredQuery = applyCandidateFilters(baseQuery, filters) as typeof baseQuery;
  const { data, error } = await filteredQuery
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(MAX_KPI_ROWS);
  if (error) throw error;
  const candidates = ((data ?? []) as CandidateRow[]).map(mapCandidateRow);
  const decisions = await fetchDecisionsByCandidateIds(candidates.map((c) => c.id));
  const joined = joinRowsAndDecisions(candidates, decisions);
  const filtered = joined.filter((row) =>
    passesDecisionStatusFilter(row, decisionStatusFilter),
  );
  const total = filtered.length;
  const rows = filtered.slice(offset, offset + pageSize);
  return { page, pageSize, total, rows };
}

export type ExitedCandidateSweepResult = {
  checked: number;
  error?: string;
  superseded: number;
};

/**
 * Supersedes still-undecided deduction candidates that belong to employees who
 * had already exited before the candidate's month even started — a resigned
 * employee must not sit in the inbox as a pending warning for months they never
 * worked. Candidates for months the employee actually worked (including the
 * final month) are left untouched: those can be legitimate final-settlement
 * deductions. Candidates with any human decision are never touched. Idempotent;
 * safe to run on every scheduled-processing pass.
 */
export async function supersedeExitedEmployeeDeductionCandidates(): Promise<ExitedCandidateSweepResult> {
  try {
    const supabase = getSupabaseAdmin();
    const { data: employeeData, error: employeeError } = await supabase
      .from("employees")
      .select("hr_id,employment_status,last_working_date");
    if (employeeError) throw employeeError;

    // compact HR id -> last working date (null when the exit date was never recorded)
    const exitedByCompact = new Map<string, string | null>();
    for (const row of (employeeData ?? []) as Array<{ employment_status: string | null; hr_id: string; last_working_date: string | null }>) {
      const status = String(row.employment_status ?? "").trim().toLowerCase();
      if (!status || status === "active" || status === "on_leave") continue;
      const compact = compactDeductionHrId(row.hr_id);
      if (compact) exitedByCompact.set(compact, row.last_working_date ?? null);
    }
    if (exitedByCompact.size === 0) return { checked: 0, superseded: 0 };

    const { data: candidateData, error: candidateError } = await supabase
      .from("deduction_candidates")
      .select("id,employee_hr_id_compact,month_key")
      .is("superseded_at", null)
      .in("employee_hr_id_compact", Array.from(exitedByCompact.keys()));
    if (candidateError) throw candidateError;

    const candidates = (candidateData ?? []) as Array<{ employee_hr_id_compact: string; id: string; month_key: string }>;
    const staleIds: string[] = [];
    for (const candidate of candidates) {
      const lastWorkingDate = exitedByCompact.get(candidate.employee_hr_id_compact);
      const monthStart = `${candidate.month_key}-01`;
      // No recorded exit date means we cannot place the exit — treat as pre-dating the month.
      if (!lastWorkingDate || lastWorkingDate < monthStart) staleIds.push(candidate.id);
    }
    if (staleIds.length === 0) return { checked: candidates.length, superseded: 0 };

    const { data: decisionData, error: decisionError } = await supabase
      .from("deduction_decisions")
      .select("candidate_id")
      .in("candidate_id", staleIds);
    if (decisionError) throw decisionError;
    const decidedIds = new Set(((decisionData ?? []) as Array<{ candidate_id: string }>).map((row) => row.candidate_id));
    const toSupersede = staleIds.filter((id) => !decidedIds.has(id));
    if (toSupersede.length === 0) return { checked: candidates.length, superseded: 0 };

    const { error: updateError } = await supabase
      .from("deduction_candidates")
      .update({ superseded_at: new Date().toISOString() })
      .in("id", toSupersede);
    if (updateError) throw updateError;

    return { checked: candidates.length, superseded: toSupersede.length };
  } catch (error) {
    return {
      checked: 0,
      error: error instanceof Error ? error.message : "Exited-employee candidate sweep failed.",
      superseded: 0,
    };
  }
}

async function fetchInboxRowsForAggregation(
  filters: DeductionInboxFilters,
  limit: number,
): Promise<DeductionInboxRow[]> {
  const supabase = getSupabaseAdmin();
  const baseQuery = supabase
    .from("deduction_candidates")
    .select(CANDIDATE_COLUMNS);
  const filteredQuery = applyCandidateFilters(baseQuery, filters) as typeof baseQuery;
  const { data, error } = await filteredQuery
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const candidates = ((data ?? []) as CandidateRow[]).map(mapCandidateRow);
  const decisions = await fetchDecisionsByCandidateIds(candidates.map((c) => c.id));
  const joined = joinRowsAndDecisions(candidates, decisions);
  if (filters.decisionStatus) {
    return joined.filter((row) =>
      passesDecisionStatusFilter(row, filters.decisionStatus),
    );
  }
  return joined;
}

// Pure-core KPI rollup. Operates on already-joined rows; testable without DB.
export function rollupKpis(rows: DeductionInboxRow[]): DeductionInboxKpis {
  const kpis: DeductionInboxKpis = {
    total: 0,
    pending: 0,
    approvedForPayroll: 0,
    approvedForLeaveAdjustment: 0,
    doNotTakeAction: 0,
    needsFollowUp: 0,
    disputed: 0,
    resolved: 0,
    cancelled: 0,
    employeesAffected: 0,
    activeSources: 0,
    estimatedAmountSubtotal: 0,
  };
  const employees = new Set<string>();
  const sources = new Set<string>();
  for (const row of rows) {
    kpis.total += 1;
    employees.add(row.employeeCode);
    sources.add(row.sourceModule);
    const status = row.decision?.decisionStatus ?? "Pending";
    switch (status) {
      case "Pending":
        kpis.pending += 1;
        break;
      case "Approved for Payroll":
        kpis.approvedForPayroll += 1;
        if (typeof row.decision?.appliedAmount === "number") {
          kpis.estimatedAmountSubtotal += row.decision.appliedAmount;
        } else if (typeof row.estimatedAmount === "number") {
          kpis.estimatedAmountSubtotal += row.estimatedAmount;
        }
        break;
      case "Approved for Leave Adjustment":
        kpis.approvedForLeaveAdjustment += 1;
        if (typeof row.decision?.appliedAmount === "number") {
          kpis.estimatedAmountSubtotal += row.decision.appliedAmount;
        } else if (typeof row.estimatedAmount === "number") {
          kpis.estimatedAmountSubtotal += row.estimatedAmount;
        }
        break;
      case "Do Not Take Action":
        kpis.doNotTakeAction += 1;
        break;
      case "Needs Follow-up":
        kpis.needsFollowUp += 1;
        break;
      case "Disputed":
        kpis.disputed += 1;
        break;
      case "Resolved":
        kpis.resolved += 1;
        break;
      case "Cancelled":
        kpis.cancelled += 1;
        break;
      default:
        break;
    }
  }
  kpis.employeesAffected = employees.size;
  kpis.activeSources = sources.size;
  // Round to 2 dp to avoid float artifacts in UI.
  kpis.estimatedAmountSubtotal =
    Math.round(kpis.estimatedAmountSubtotal * 100) / 100;
  return kpis;
}

export async function getDeductionInboxKpis(input: {
  access: AccessContext;
  filters?: DeductionInboxFilters;
}): Promise<DeductionInboxKpis> {
  const filters = sanitizeDeductionInboxFilters(input.filters);
  const rows = await fetchInboxRowsForAggregation(filters, MAX_KPI_ROWS);
  return rollupKpis(rows);
}

// Pure-core source rollup.
export function rollupBySource(rows: DeductionInboxRow[]): DeductionSourceGroup[] {
  const buckets = new Map<DeductionSourceModule, DeductionSourceGroup>();
  for (const row of rows) {
    const key = row.sourceModule;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        sourceModule: key,
        count: 0,
        pending: 0,
        approvedForPayroll: 0,
        approvedForLeaveAdjustment: 0,
        disputed: 0,
        estimatedAmountCalculatedSubtotal: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const status = row.decision?.decisionStatus ?? "Pending";
    if (status === "Pending") bucket.pending += 1;
    if (status === "Approved for Payroll") bucket.approvedForPayroll += 1;
    if (status === "Approved for Leave Adjustment") {
      bucket.approvedForLeaveAdjustment += 1;
    }
    if (status === "Disputed") bucket.disputed += 1;
    if (typeof row.decision?.appliedAmount === "number") {
      bucket.estimatedAmountCalculatedSubtotal += row.decision.appliedAmount;
    } else if (
      row.calculationStatus === "calculated" &&
      typeof row.estimatedAmount === "number"
    ) {
      bucket.estimatedAmountCalculatedSubtotal += row.estimatedAmount;
    }
  }
  const list = [...buckets.values()].sort((a, b) => b.count - a.count);
  for (const bucket of list) {
    bucket.estimatedAmountCalculatedSubtotal =
      Math.round(bucket.estimatedAmountCalculatedSubtotal * 100) / 100;
  }
  return list;
}

export async function groupBySource(input: {
  access: AccessContext;
  filters?: DeductionInboxFilters;
}): Promise<DeductionSourceGroup[]> {
  const filters = sanitizeDeductionInboxFilters(input.filters);
  const rows = await fetchInboxRowsForAggregation(filters, MAX_KPI_ROWS);
  return rollupBySource(rows);
}

// Pure-core employee rollup.
export function rollupByEmployee(
  rows: DeductionInboxRow[],
  limit: number = MAX_BY_EMPLOYEE_DEFAULT,
): DeductionEmployeeGroup[] {
  const buckets = new Map<string, DeductionEmployeeGroup>();
  for (const row of rows) {
    const key = row.employeeCode;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        employeeCode: key,
        employeeName: row.employeeName ?? key,
        totalCandidates: 0,
        pending: 0,
        approvedForPayroll: 0,
        approvedForLeaveAdjustment: 0,
        disputed: 0,
        monthsAffected: [],
      };
      buckets.set(key, bucket);
    }
    if (!bucket.employeeName && row.employeeName) {
      bucket.employeeName = row.employeeName;
    }
    bucket.totalCandidates += 1;
    const status = row.decision?.decisionStatus ?? "Pending";
    if (status === "Pending") bucket.pending += 1;
    if (status === "Approved for Payroll") bucket.approvedForPayroll += 1;
    if (status === "Approved for Leave Adjustment") {
      bucket.approvedForLeaveAdjustment += 1;
    }
    if (status === "Disputed") bucket.disputed += 1;
    if (!bucket.monthsAffected.includes(row.monthKey)) {
      bucket.monthsAffected.push(row.monthKey);
    }
  }
  for (const bucket of buckets.values()) {
    bucket.monthsAffected.sort();
  }
  const sorted = [...buckets.values()].sort(
    (a, b) => b.totalCandidates - a.totalCandidates,
  );
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_BY_EMPLOYEE_DEFAULT;
  return sorted.slice(0, cap);
}

export async function groupByEmployee(input: {
  access: AccessContext;
  filters?: DeductionInboxFilters;
  limit?: number;
}): Promise<DeductionEmployeeGroup[]> {
  const filters = sanitizeDeductionInboxFilters(input.filters);
  const rows = await fetchInboxRowsForAggregation(filters, MAX_KPI_ROWS);
  return rollupByEmployee(rows, input.limit);
}

export async function listFinalApprovedDecisions(input: {
  access: AccessContext;
  filters?: DeductionInboxFilters;
}): Promise<DeductionInboxRow[]> {
  const filters = sanitizeDeductionInboxFilters(input.filters);
  const rows = await fetchInboxRowsForAggregation(filters, MAX_KPI_ROWS);
  return rows.filter((row) => {
    const status = row.decision?.decisionStatus;
    return (
      status === "Approved for Payroll" ||
      status === "Approved for Leave Adjustment"
    );
  });
}

export async function listDisputes(input: {
  access: AccessContext;
  filters?: DeductionInboxFilters;
}): Promise<DeductionInboxRow[]> {
  const filters = sanitizeDeductionInboxFilters(input.filters);
  const rows = await fetchInboxRowsForAggregation(filters, MAX_KPI_ROWS);
  return rows.filter((row) => {
    const status = row.decision?.decisionStatus;
    return (
      status === "Disputed" ||
      status === "Needs Follow-up" ||
      status === "Resolved"
    );
  });
}

export async function listRecentAuditEvents(input: {
  access: AccessContext;
  monthKey?: string;
  limit?: number;
}): Promise<DeductionAuditEvent[]> {
  const supabase = getSupabaseAdmin();
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
  let query = supabase
    .from("audit_logs")
    .select("id, actor_login_id, entity_id, entity_type, summary, created_at")
    .in("entity_type", [
      "deduction_candidate",
      "deduction_comment",
      "deduction_decision",
      "deduction_export",
      "deduction_finalization",
      "deduction_payroll_import",
      "deduction_payroll_preview",
    ])
    .order("created_at", { ascending: false })
    .limit(limit);
  const monthKey = safeNormalizeMonthKey(input.monthKey);
  if (monthKey) {
    query = query.ilike("summary", `%${monthKey}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as Array<{
    id: string;
    actor_login_id: string | null;
    entity_id: string | null;
    entity_type: string | null;
    summary: string | null;
    created_at: string;
  }>).map((row) => ({
    id: String(row.id),
    actorLoginId: row.actor_login_id ?? "system",
    entityId: row.entity_id,
    entityType: row.entity_type,
    summary: row.summary,
    createdAt: row.created_at,
  }));
}

type CommentFeedCandidateRow = {
  deduction_type: string | null;
  employee_code: string | null;
  employee_name: string | null;
  id: string;
  month_key: string | null;
  source_module: string | null;
};

function isCommentFeedSourceModule(value: string | null | undefined): value is DeductionSourceModule {
  return Boolean(value && deductionSourceModules.includes(value as DeductionSourceModule));
}

function isCommentFeedDeductionType(value: string | null | undefined): value is DeductionType {
  return Boolean(value && deductionTypes.includes(value as DeductionType));
}

export async function listRecentDeductionComments(input: {
  access: AccessContext;
  limit?: number;
}): Promise<DeductionCommentFeedItem[]> {
  const supabase = getSupabaseAdmin();
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 100)));
  const { data, error } = await supabase
    .from("deduction_comments")
    .select("id, candidate_id, author_login_id, author_hr_id, author_role, body, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const comments = ((data ?? []) as CommentRow[]).map(mapCommentRow);
  const candidateIds = [...new Set(comments.map((comment) => comment.candidateId))];
  const candidates = new Map<string, CommentFeedCandidateRow>();
  if (candidateIds.length > 0) {
    const { data: candidateData, error: candidateError } = await supabase
      .from("deduction_candidates")
      .select("id, employee_code, employee_name, month_key, source_module, deduction_type")
      .in("id", candidateIds);
    if (candidateError) throw candidateError;
    for (const row of (candidateData ?? []) as CommentFeedCandidateRow[]) {
      candidates.set(row.id, row);
    }
  }

  return comments.map((comment) => {
    const candidate = candidates.get(comment.candidateId);
    return {
      ...comment,
      deductionType: isCommentFeedDeductionType(candidate?.deduction_type)
        ? candidate.deduction_type
        : null,
      employeeCode: candidate?.employee_code ?? null,
      employeeName: candidate?.employee_name ?? null,
      monthKey: candidate?.month_key ?? null,
      sourceModule: isCommentFeedSourceModule(candidate?.source_module)
        ? candidate.source_module
        : null,
    };
  });
}

async function loadCandidateById(candidateId: string): Promise<DeductionCandidate> {
  const { data, error } = await getSupabaseAdmin()
    .from("deduction_candidates")
    .select(CANDIDATE_COLUMNS)
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Deduction candidate not found.");
  return mapCandidateRow(data as CandidateRow);
}

async function loadEmployeeBaseSalary(employeeCode: string): Promise<number | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("base_salary")
    .eq("hr_id", employeeCode.toUpperCase())
    .limit(1);
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] as { base_salary?: unknown } | undefined : undefined;
  const baseSalary = Number(row?.base_salary ?? 0);
  return Number.isFinite(baseSalary) && baseSalary > 0 ? baseSalary : null;
}

function normalizeAppliedValue(input: {
  candidate: DeductionCandidate;
  decisionStatus: DeductionDecisionStatus;
  requestedValue?: number | null;
}) {
  if (input.decisionStatus !== "Approved for Payroll") return null;
  const value = input.requestedValue == null
    ? input.candidate.deductionValue
    : Number(input.requestedValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Applied deduction value must be a non-negative number.");
  }
  if (value > input.candidate.deductionValue) {
    throw new Error("Applied deduction value cannot exceed the original system-flagged value.");
  }
  return Math.round(value * 100) / 100;
}

async function calculateAppliedAmount(input: {
  appliedValue: number | null;
  candidate: DeductionCandidate;
}) {
  if (input.appliedValue == null) return null;
  if (input.candidate.deductionUnit === "amount") {
    return Math.round(input.appliedValue * 100) / 100;
  }
  if (input.candidate.deductionUnit === "days") {
    const baseSalary = await loadEmployeeBaseSalary(input.candidate.employeeCode);
    const amount = calculateDeductionAmountFromBaseSalary({
      baseSalary,
      deductionDays: input.appliedValue,
    });
    if (amount == null) {
      throw new Error(`Base salary is required before approving deduction for ${input.candidate.employeeCode}.`);
    }
    return amount;
  }
  if (input.candidate.estimatedAmount != null && input.candidate.deductionValue > 0) {
    return Math.round((input.candidate.estimatedAmount / input.candidate.deductionValue) * input.appliedValue * 100) / 100;
  }
  throw new Error("This deduction unit cannot be approved for payroll until an amount is available.");
}

export type UpdateDeductionDecisionInput = {
  access: AccessContext;
  appliedDeductionValue?: number | null;
  candidateId: string;
  decisionReason?: string;
  decisionStatus: DeductionDecisionStatus;
  hrNote?: string;
};

export async function updateDeductionDecision(input: UpdateDeductionDecisionInput): Promise<DeductionDecision> {
  assertDeductionsGovernanceDecisionActor(input.access);
  if (!deductionDecisionStatuses.includes(input.decisionStatus)) {
    throw new Error("Invalid deduction decision status.");
  }
  const decisionReason = String(input.decisionReason ?? "").trim();
  const hrNote = String(input.hrNote ?? "").trim();
  if (input.decisionStatus !== "Pending") {
    if (!decisionReason) {
      throw new Error("Decision reason is required for non-pending decisions.");
    }
    if (!(deductionDecisionReasons as readonly string[]).includes(decisionReason)) {
      throw new Error("Choose a supported decision reason.");
    }
    if (decisionReason === "Other" && !hrNote) {
      throw new Error("HR note is required when decision reason is Other.");
    }
  }

  const candidate = await loadCandidateById(input.candidateId);
  const payrollColumn = payrollColumnForDeduction({
    deductionType: candidate.deductionType,
    sourceModule: candidate.sourceModule,
  });
  if (input.decisionStatus === "Approved for Payroll" && !payrollColumn) {
    throw new Error("This deduction source is not mapped to a payroll column.");
  }

  const appliedValue = normalizeAppliedValue({
    candidate,
    decisionStatus: input.decisionStatus,
    requestedValue: input.appliedDeductionValue,
  });
  const appliedAmount = await calculateAppliedAmount({
    appliedValue,
    candidate,
  });
  const actor = input.access.loginId ?? input.access.hrId ?? "system";
  const now = new Date().toISOString();
  const resolvedAt = ["Resolved", "Cancelled", "Do Not Take Action"].includes(input.decisionStatus)
    ? now
    : null;

  const payload = {
    actor_role_at_decision: input.access.role,
    actor_scope_at_decision: input.access.scope,
    applied_amount: appliedAmount,
    applied_deduction_value: appliedValue,
    candidate_id: candidate.id,
    decided_at: input.decisionStatus === "Pending" ? null : now,
    decided_by: input.decisionStatus === "Pending" ? null : actor,
    decision_reason: input.decisionStatus === "Pending" ? "" : decisionReason,
    decision_status: input.decisionStatus,
    hr_note: hrNote,
    payroll_column: input.decisionStatus === "Approved for Payroll" ? payrollColumn : null,
    payroll_handoff_status: "Not pushed",
    resolved_at: resolvedAt,
    resolved_by: resolvedAt ? actor : null,
  };

  const { data, error } = await getSupabaseAdmin()
    .from("deduction_decisions")
    .upsert(payload, { onConflict: "candidate_id" })
    .select(DECISION_COLUMNS)
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: actor,
    entityId: candidate.id,
    entityType: "deduction_decision",
    newValues: payload,
    summary: `Deduction decision saved for ${candidate.employeeCode} (${candidate.monthKey}).`,
  });

  return mapDecisionRow(data as DecisionRow);
}

/**
 * Records an "Approved for Payroll" or "Do Not Take Action" decision made by
 * the CEO/Super Admin from inside the Payroll Copilot's simplified review
 * tabs (fingerprint/attendance and CRM no-activity deductions) — reads and
 * writes the exact same `deduction_candidates`/`deduction_decisions` rows the
 * full HR Deductions Governance workspace uses, so there is one shared source
 * of truth regardless of which UI made the call.
 *
 * Deliberately bypasses `assertDeductionsGovernanceDecisionActor` (which is
 * Super-Admin-only) — the caller (the Copilot API route) has already
 * asserted CEO/Super Admin access via `assertCopilotAccess`, so gating again
 * here on the HR-only role would just lock the CEO out of a page built for
 * them. Every write is stamped with a `copilot:<actor>` decided_by and a
 * closed reason enum so it is never confused with a human HR-governance
 * decision in the audit trail.
 */
export async function recordCopilotDeductionDecision(input: {
  candidateId: string;
  decisionStatus: "Approved for Payroll" | "Do Not Take Action";
  appliedDeductionValue?: number | null;
  actorLoginId: string;
}): Promise<DeductionDecision> {
  const candidate = await loadCandidateById(input.candidateId);
  if (candidate.sourceModule !== "ATTENDANCE_DEVICE" && candidate.sourceModule !== "FIELD_WORKFORCE") {
    throw new Error("recordCopilotDeductionDecision only supports ATTENDANCE_DEVICE and FIELD_WORKFORCE candidates.");
  }

  const payrollColumn = payrollColumnForDeduction({
    deductionType: candidate.deductionType,
    sourceModule: candidate.sourceModule,
  });
  if (input.decisionStatus === "Approved for Payroll" && !payrollColumn) {
    throw new Error("This deduction source is not mapped to a payroll column.");
  }

  const appliedValue = normalizeAppliedValue({
    candidate,
    decisionStatus: input.decisionStatus,
    requestedValue: input.appliedDeductionValue ?? null,
  });
  const appliedAmount = await calculateAppliedAmount({ appliedValue, candidate });
  const actor = `copilot:${input.actorLoginId || "unknown"}`;
  const now = new Date().toISOString();
  const decisionReason =
    input.decisionStatus === "Approved for Payroll"
      ? "Approved via Payroll Copilot"
      : "Rejected via Payroll Copilot";

  const payload = {
    actor_role_at_decision: "CEO/Super Admin (Payroll Copilot)",
    actor_scope_at_decision: "system",
    applied_amount: appliedAmount,
    applied_deduction_value: appliedValue,
    candidate_id: candidate.id,
    decided_at: now,
    decided_by: actor,
    decision_reason: decisionReason,
    decision_status: input.decisionStatus,
    hr_note: "",
    payroll_column: input.decisionStatus === "Approved for Payroll" ? payrollColumn : null,
    payroll_handoff_status: "Not pushed" as const,
    resolved_at: input.decisionStatus === "Do Not Take Action" ? now : null,
    resolved_by: input.decisionStatus === "Do Not Take Action" ? actor : null,
  };

  const { data, error } = await getSupabaseAdmin()
    .from("deduction_decisions")
    .upsert(payload, { onConflict: "candidate_id" })
    .select(DECISION_COLUMNS)
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: actor,
    entityId: candidate.id,
    entityType: "deduction_decision",
    newValues: payload,
    summary: `Payroll Copilot decision for ${candidate.employeeCode} (${candidate.monthKey}): ${decisionReason}.`,
  });

  return mapDecisionRow(data as DecisionRow);
}

type SummaryRow = {
  candidate_count: number;
  created_at: string;
  employee_count: number;
  finalized_at: string;
  finalized_by: string;
  id: string;
  month: number;
  month_key: string;
  notes: string | null;
  source_counts: Record<string, unknown> | null;
  status: string;
  total_amount: string | number;
  total_days: string | number;
  year: number;
};

type SummaryLineRow = {
  applied_amount: string | number;
  applied_deduction_value: string | number;
  candidate_id: string;
  created_at: string;
  dates: unknown;
  decision_id: string;
  deduction_type: string;
  deduction_unit: string;
  employee_code: string;
  employee_hr_id_compact: string;
  employee_name: string | null;
  hr_note: string | null;
  id: string;
  month_key: string;
  original_deduction_value: string | number;
  payroll_column: string;
  reason: string | null;
  source_module: string;
  summary_id: string;
};

function mapSummaryRow(row: SummaryRow): DeductionMonthlySummary {
  return {
    id: row.id,
    monthKey: row.month_key,
    month: row.month,
    year: row.year,
    status: row.status === "superseded" ? "superseded" : "finalized",
    finalizedBy: row.finalized_by,
    finalizedAt: row.finalized_at,
    candidateCount: row.candidate_count,
    employeeCount: row.employee_count,
    totalDays: toNumber(row.total_days),
    totalAmount: toNumber(row.total_amount),
    sourceCounts: row.source_counts ?? {},
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function mapSummaryLineRow(row: SummaryLineRow): DeductionMonthlySummaryLine {
  const sourceModule = isSourceModule(row.source_module) ? row.source_module : "OTHER";
  const deductionType = isDeductionType(row.deduction_type) ? row.deduction_type : "other";
  const deductionUnit = (deductionUnits as readonly string[]).includes(row.deduction_unit)
    ? row.deduction_unit as DeductionMonthlySummaryLine["deductionUnit"]
    : "count";
  const payrollColumn = isPayrollColumn(row.payroll_column)
    ? row.payroll_column
    : "crm";
  return {
    id: row.id,
    summaryId: row.summary_id,
    candidateId: row.candidate_id,
    decisionId: row.decision_id,
    employeeCode: row.employee_code,
    employeeHrIdCompact: row.employee_hr_id_compact,
    employeeName: row.employee_name,
    monthKey: row.month_key,
    sourceModule,
    deductionType,
    payrollColumn,
    deductionUnit,
    originalDeductionValue: toNumber(row.original_deduction_value),
    appliedDeductionValue: toNumber(row.applied_deduction_value),
    appliedAmount: toNumber(row.applied_amount),
    dates: asDates(row.dates),
    reason: row.reason,
    hrNote: row.hr_note,
    createdAt: row.created_at,
  };
}

export type FinalizeMonthlyDeductionsResult = {
  lines: DeductionMonthlySummaryLine[];
  summary: DeductionMonthlySummary;
};

export async function finalizeMonthlyDeductions(input: {
  access: AccessContext;
  monthKey: string;
  notes?: string;
}): Promise<FinalizeMonthlyDeductionsResult> {
  assertDeductionsGovernanceDecisionActor(input.access);
  const monthKey = normalizeMonthKey(input.monthKey);
  const [yearText, monthText] = monthKey.split("-");
  const month = Number(monthText);
  const year = Number(yearText);
  const actor = input.access.loginId ?? input.access.hrId ?? "system";
  const rows = await fetchInboxRowsForAggregation({ monthKey }, MAX_KPI_ROWS);
  const approved = rows.filter((row) =>
    row.decision?.decisionStatus === "Approved for Payroll" &&
    row.decision.payrollColumn &&
    row.decision.appliedDeductionValue != null &&
    row.decision.appliedAmount != null,
  );
  if (approved.length === 0) {
    throw new Error(`No approved payroll deductions are ready to finalize for ${monthKey}.`);
  }

  const employeeCodes = new Set<string>();
  const sourceCounts: Record<string, number> = {};
  let totalDays = 0;
  let totalAmount = 0;
  for (const row of approved) {
    employeeCodes.add(row.employeeCode);
    sourceCounts[row.sourceModule] = (sourceCounts[row.sourceModule] ?? 0) + 1;
    totalDays += row.decision?.appliedDeductionValue ?? 0;
    totalAmount += row.decision?.appliedAmount ?? 0;
  }

  const linePayloads = approved.map((row) => ({
    applied_amount: row.decision?.appliedAmount ?? 0,
    applied_deduction_value: row.decision?.appliedDeductionValue ?? 0,
    candidate_id: row.id,
    dates: row.dates,
    decision_id: row.decision?.id,
    deduction_type: row.deductionType,
    deduction_unit: row.deductionUnit,
    employee_code: row.employeeCode,
    employee_hr_id_compact: row.employeeHrIdCompact,
    employee_name: row.employeeName ?? null,
    hr_note: row.decision?.hrNote ?? null,
    month_key: row.monthKey,
    original_deduction_value: row.deductionValue,
    payroll_column: row.decision?.payrollColumn,
    reason: row.reason ?? null,
    source_module: row.sourceModule,
  }));

  const decisionIds = approved
    .map((row) => row.decision?.id)
    .filter((value): value is string => Boolean(value));

  // Single atomic RPC — summary insert + lines insert + decisions update in one transaction.
  const { data: rpcData, error: rpcError } = await getSupabaseAdmin().rpc(
    "phx_finalize_monthly_deductions",
    {
      p_month_key:       monthKey,
      p_month:           month,
      p_year:            year,
      p_finalized_by:    actor,
      p_candidate_count: approved.length,
      p_employee_count:  employeeCodes.size,
      p_total_days:      Math.round(totalDays * 100) / 100,
      p_total_amount:    Math.round(totalAmount * 100) / 100,
      p_source_counts:   sourceCounts,
      p_notes:           String(input.notes ?? "").trim() || null,
      p_lines:           linePayloads,
      p_decision_ids:    decisionIds,
    },
  );
  if (rpcError) throw rpcError;

  const summary = mapSummaryRow(rpcData as SummaryRow);

  // Load the newly created lines so the caller gets the full hydrated result.
  const linesResult = await getSupabaseAdmin()
    .from("deduction_monthly_summary_lines")
    .select("id, summary_id, candidate_id, decision_id, employee_code, employee_hr_id_compact, employee_name, month_key, source_module, deduction_type, payroll_column, deduction_unit, original_deduction_value, applied_deduction_value, applied_amount, dates, reason, hr_note, created_at")
    .eq("summary_id", summary.id)
    .order("employee_name", { ascending: true });
  if (linesResult.error) throw linesResult.error;
  const lines = ((linesResult.data ?? []) as SummaryLineRow[]).map(mapSummaryLineRow);

  await writeAuditLog({
    actorLoginId: actor,
    entityId: summary.id,
    entityType: "deduction_summary",
    newValues: {
      candidateCount: approved.length,
      monthKey,
      totalAmount: summary.totalAmount,
    },
    summary: `Monthly deductions finalized for ${monthKey}.`,
  });

  return { summary, lines };
}

export async function listMonthlyDeductionSummaries(input: {
  access: AccessContext;
  monthKey?: string;
  limit?: number;
}): Promise<DeductionMonthlySummary[]> {
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 24)));
  let query = getSupabaseAdmin()
    .from("deduction_monthly_summaries")
    .select("id, month_key, month, year, status, finalized_by, finalized_at, candidate_count, employee_count, total_days, total_amount, source_counts, notes, created_at")
    .order("finalized_at", { ascending: false })
    .limit(limit);
  const monthKey = safeNormalizeMonthKey(input.monthKey);
  if (monthKey) query = query.eq("month_key", monthKey);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as SummaryRow[]).map(mapSummaryRow);
}

export async function listMonthlyDeductionSummaryLines(input: {
  access: AccessContext;
  summaryId: string;
}): Promise<DeductionMonthlySummaryLine[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("deduction_monthly_summary_lines")
    .select("id, summary_id, candidate_id, decision_id, employee_code, employee_hr_id_compact, employee_name, month_key, source_module, deduction_type, payroll_column, deduction_unit, original_deduction_value, applied_deduction_value, applied_amount, dates, reason, hr_note, created_at")
    .eq("summary_id", input.summaryId)
    .order("employee_name", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as SummaryLineRow[]).map(mapSummaryLineRow);
}

type CommentRow = {
  author_hr_id: string | null;
  author_login_id: string;
  author_role: string | null;
  body: string;
  candidate_id: string;
  created_at: string;
  id: string;
};

function mapCommentRow(row: CommentRow): DeductionComment {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    authorLoginId: row.author_login_id,
    authorHrId: row.author_hr_id,
    authorRole: row.author_role,
    body: row.body,
    createdAt: row.created_at,
  };
}

export async function listDeductionComments(input: {
  access: AccessContext;
  candidateIds: string[];
}): Promise<DeductionComment[]> {
  if (input.candidateIds.length === 0) return [];
  const { data, error } = await getSupabaseAdmin()
    .from("deduction_comments")
    .select("id, candidate_id, author_login_id, author_hr_id, author_role, body, created_at")
    .in("candidate_id", input.candidateIds)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as CommentRow[]).map(mapCommentRow);
}

async function assertEmployeeCanCommentOnCandidate(access: AccessContext, candidateId: string) {
  const candidate = await loadCandidateById(candidateId);
  const actorHr = compactHrId(access.hrId ?? access.loginId);
  if (!actorHr || actorHr !== candidate.employeeHrIdCompact) {
    throw new Error("Forbidden: employees can comment only on their own published deductions.");
  }
  const { data, error } = await getSupabaseAdmin()
    .from("deduction_monthly_summary_lines")
    .select("id")
    .eq("candidate_id", candidateId)
    .limit(1);
  if (error) throw error;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Comments are available only after the deduction is finalized.");
  }
}

export async function addDeductionComment(input: {
  access: AccessContext;
  body: string;
  candidateId: string;
}): Promise<DeductionComment> {
  await assertEmployeeCanCommentOnCandidate(input.access, input.candidateId);
  const body = String(input.body ?? "").replace(/\s+/g, " ").trim();
  if (!body) throw new Error("Comment is required.");
  if (body.length > 2000) throw new Error("Comment cannot exceed 2000 characters.");
  const payload = {
    author_hr_id: input.access.hrId,
    author_login_id: input.access.loginId ?? input.access.hrId ?? "employee",
    author_role: input.access.role,
    body,
    candidate_id: input.candidateId,
  };
  const { data, error } = await getSupabaseAdmin()
    .from("deduction_comments")
    .insert(payload)
    .select("id, candidate_id, author_login_id, author_hr_id, author_role, body, created_at")
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: payload.author_login_id,
    entityId: input.candidateId,
    entityType: "deduction_comment",
    newValues: { bodyLength: body.length },
    summary: "Employee comment added to published deduction.",
  });

  return mapCommentRow(data as CommentRow);
}

type EmployeeScopeRow = {
  full_name: string | null;
  hr_id: string | null;
  line_name: string | null;
  line_id: number | null;
  manager_hr_id: string | null;
};

function collectPortalDeductionScope(input: {
  access: AccessContext;
  employees: EmployeeScopeRow[];
}) {
  if (input.access.scope === "system") return { all: true, compactHrIds: new Set<string>() };
  const root = compactHrId(input.access.hrId ?? input.access.loginId);
  // Marketing Manager (Head of Department) keeps broad analytics oversight elsewhere, but
  // portal Deductions are intentionally SELF-only: a marketing lead must not read other line
  // employees' financial/disciplinary deduction PII. Return the viewer's own record only,
  // before any line/hierarchy widening below.
  if (input.access.role === "Marketing Manager") {
    return { all: false, compactHrIds: new Set<string>(root ? [root] : []) };
  }
  const compactHrIds = new Set<string>();
  if (root) compactHrIds.add(root);
  const byManager = new Map<string, EmployeeScopeRow[]>();
  const rootRows = input.employees.filter((employee) => compactHrId(employee.hr_id) === root);
  const rootLineIds = new Set(rootRows.map((row) => row.line_id).filter((value): value is number => typeof value === "number"));
  const rootLineNames = new Set(rootRows.map((row) => String(row.line_name ?? "").trim().toLowerCase()).filter(Boolean));

  for (const employee of input.employees) {
    const manager = compactHrId(employee.manager_hr_id);
    if (!manager) continue;
    const list = byManager.get(manager) ?? [];
    list.push(employee);
    byManager.set(manager, list);
  }

  const addDirect = (managerId: string) => {
    for (const child of byManager.get(managerId) ?? []) {
      const childId = compactHrId(child.hr_id);
      if (childId) compactHrIds.add(childId);
    }
  };

  const addHierarchy = (managerId: string) => {
    const queue = [managerId];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      for (const child of byManager.get(current) ?? []) {
        const childId = compactHrId(child.hr_id);
        if (!childId || compactHrIds.has(childId)) continue;
        compactHrIds.add(childId);
        queue.push(childId);
      }
    }
  };

  if (root) {
    if (input.access.scope === "team") addDirect(root);
    if (
      input.access.scope === "hierarchy" ||
      input.access.scope === "line" ||
      input.access.scope === "company" ||
      input.access.role === "National Sales Manager" ||
      input.access.role === "Regional Manager"
    ) {
      addHierarchy(root);
    }
  }

  if (input.access.scope === "line" || input.access.role === "National Sales Manager") {
    for (const employee of input.employees) {
      const normalizedLineName = String(employee.line_name ?? "").trim().toLowerCase();
      const inLine =
        (typeof employee.line_id === "number" && rootLineIds.has(employee.line_id)) ||
        (normalizedLineName && rootLineNames.has(normalizedLineName));
      const employeeId = compactHrId(employee.hr_id);
      if (inLine && employeeId) compactHrIds.add(employeeId);
    }
  }

  return { all: false, compactHrIds };
}

export async function listPublishedDeductionsForPortal(input: {
  access: AccessContext;
  monthKey?: string;
}): Promise<{
  comments: DeductionComment[];
  lines: DeductionMonthlySummaryLine[];
}> {
  const { data: employees, error: employeesError } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id,full_name,manager_hr_id,line_id,line_name");
  const monthKey = safeNormalizeMonthKey(input.monthKey);
  if (employeesError) throw employeesError;
  const scope = collectPortalDeductionScope({
    access: input.access,
    employees: (employees ?? []) as EmployeeScopeRow[],
  });

  let query = getSupabaseAdmin()
    .from("deduction_monthly_summary_lines")
    .select("id, summary_id, candidate_id, decision_id, employee_code, employee_hr_id_compact, employee_name, month_key, source_module, deduction_type, payroll_column, deduction_unit, original_deduction_value, applied_deduction_value, applied_amount, dates, reason, hr_note, created_at")
    .order("month_key", { ascending: false })
    .order("employee_name", { ascending: true });
  if (monthKey) query = query.eq("month_key", monthKey);
  const { data, error } = await query;
  if (error) throw error;
  const allLines = ((data ?? []) as SummaryLineRow[]).map(mapSummaryLineRow);
  const lines = scope.all
    ? allLines
    : allLines.filter((line) => scope.compactHrIds.has(line.employeeHrIdCompact));
  const comments = await listDeductionComments({
    access: input.access,
    candidateIds: lines.map((line) => line.candidateId),
  });
  return { comments, lines };
}

/** The last `count` calendar month keys (YYYY-MM), most recent first, including the current month. */
function recentCalendarMonthKeys(count: number): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

/**
 * Returns the month keys the Deductions Governance picker should offer, sorted
 * descending (most recent first). This is the UNION of:
 *   - months that already have deduction candidates (so finished months stay pickable);
 *   - months with an archived Field Workforce Compliance import (the months you can
 *     actually sync FWC absence from — the primary source);
 *   - the last few calendar months (so the current month and recent months are always
 *     available to bootstrap a first sync of attendance/vacation).
 *
 * Without the FWC/calendar months a brand-new install has zero candidates, so the picker
 * was empty and every action errored with "Select a monthKey filter ..." — a chicken-and-egg
 * because you needed a month picked to Sync, but the list only came from already-synced data.
 */
export async function listAvailableDeductionMonthKeys(_input: {
  access: AccessContext;
}): Promise<{ defaultMonthKey: string | undefined; months: string[] }> {
  const supabase = getSupabaseAdmin();

  // The FWC Excel-archive month enrichment was removed with the Excel import (its
  // field_workforce_compliance_imports table is orphaned) — candidate months + the recent
  // calendar window are the source now. Live FWC months surface via deduction_candidates once
  // their no-activity sync has run.
  const candidateResult = await supabase.from("deduction_candidates").select("month_key");
  if (candidateResult.error) throw candidateResult.error;

  const candidateMonths = new Set<string>();
  const collect = (set: Set<string>, value: unknown) => {
    const key = String(value ?? "").trim();
    if (key) set.add(key);
  };
  for (const row of candidateResult.data ?? []) collect(candidateMonths, row.month_key);

  const all = new Set<string>([...candidateMonths, ...recentCalendarMonthKeys(4)]);
  const months = Array.from(all).sort((left, right) => right.localeCompare(left));

  const descending = (set: Set<string>) =>
    Array.from(set).sort((left, right) => right.localeCompare(left))[0];

  // Prefer a month that actually has data to act on: most recent month with candidates, else the
  // most recent month offered (current calendar month) as a last resort.
  const defaultMonthKey = descending(candidateMonths) ?? months[0];

  return { defaultMonthKey, months };
}

// Type-only re-exports kept so call sites can type their state shape against
// the same union the DB constrains to. Pure typing; no DB.
export type { DeductionDecisionReason };

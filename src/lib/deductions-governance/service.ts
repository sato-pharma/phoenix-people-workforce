// Deductions Governance Center foundation. NEVER mutate payroll (salary_records) or employee leave balances from this module. Decisions are export-only.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "../hr-id.ts";
import {
  buildDeductionCandidateKey,
  normalizeDates,
  normalizeMonthKey,
} from "./candidate-key.ts";
import {
  deductionCalculationStatuses,
  deductionDecisionStatuses,
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

function compactHrId(value: string | null | undefined): string | null {
  const canonical = canonicalHrIdKey(value);
  if (!canonical) return null;
  const compact = canonical.replace(/[^a-z0-9]/g, "");
  return compact ? compact : null;
}

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

// ---------------------------------------------------------------------------
// Phase C: Read-only Deduction Inbox service surface.
//
// Strict boundaries (read this before adding anything):
// - No write to salary_records, salary_batches, payroll_batches, payslips,
//   employee_leave_balances, leave_transactions, v2_vacation_requests, or any
//   payroll/leave RPC. Phase C is governance/reporting only.
// - Decision PATCH (updateDeductionDecision) is DEFERRED to Phase C2. The
//   foundation, route shell, and UI prepare for it but the mutation entry
//   point is intentionally not exposed here yet. See risksAndLimitations.
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
  decided_by: string | null;
  decided_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  payroll_handoff_status: string;
  last_export_id: string | null;
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
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    payrollHandoffStatus,
    lastExportId: row.last_export_id,
    actorRoleAtDecision: row.actor_role_at_decision,
    actorScopeAtDecision: row.actor_scope_at_decision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CANDIDATE_COLUMNS =
  "id, source_module, source_record_id, candidate_key, employee_code, employee_hr_id_compact, employee_name, month_key, month, year, deduction_type, deduction_unit, deduction_value, estimated_amount, calculation_status, severity, reason, evidence, holiday_context, dates, hierarchy_snapshot, created_by, created_at, superseded_at, superseded_by_candidate_id";

const DECISION_COLUMNS =
  "id, candidate_id, decision_status, decision_reason, hr_note, decided_by, decided_at, resolved_at, resolved_by, payroll_handoff_status, last_export_id, actor_role_at_decision, actor_scope_at_decision, created_at, updated_at";

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
        if (typeof row.estimatedAmount === "number") {
          kpis.estimatedAmountSubtotal += row.estimatedAmount;
        }
        break;
      case "Approved for Leave Adjustment":
        kpis.approvedForLeaveAdjustment += 1;
        if (typeof row.estimatedAmount === "number") {
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
    if (
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
      "deduction_decision",
      "deduction_export",
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

// ---------------------------------------------------------------------------
// Decision PATCH (updateDeductionDecision) — DEFERRED to Phase C2.
//
// Reasoning: a safe implementation must (a) re-check the conflict window with
// detectCandidateConflict against live data, (b) bind actor_role_at_decision +
// actor_scope_at_decision atomically with writeRequiredAuditLog, and (c) be
// covered by integration tests against the real Supabase tables before HR is
// allowed to click "Approve". Shipping the write surface without that proof
// risks producing approve-state rows that the Payroll Handoff (Phase H) would
// then export. Phase C ships fully read-only; the UI disables the decision
// dropdown with a "Phase C2" hint.
// ---------------------------------------------------------------------------

// Intentionally NOT exported: this constant signals to readers that we
// considered a writer and chose to defer it. Removing this comment without
// reading the audit chain is a code-smell.
const PHASE_C_DECISION_WRITER_DEFERRED = true as const;
void PHASE_C_DECISION_WRITER_DEFERRED;
// Type-only re-exports kept so call sites can type their state shape against
// the same union the DB constrains to. Pure typing; no DB.
export type { DeductionDecisionReason };

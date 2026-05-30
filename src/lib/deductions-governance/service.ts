// Deductions Governance Center foundation. NEVER mutate payroll (salary_records) or employee leave balances from this module. Decisions are export-only.

import { canonicalHrIdKey } from "../hr-id.ts";
import {
  buildDeductionCandidateKey,
  normalizeDates,
  normalizeMonthKey,
} from "./candidate-key.ts";
import {
  deductionCalculationStatuses,
  deductionSeverities,
  deductionSourceModules,
  deductionTypes,
  deductionUnits,
  type DeductionCalculationStatus,
  type DeductionCandidateDraft,
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

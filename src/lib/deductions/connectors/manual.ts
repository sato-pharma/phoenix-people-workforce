// Unified Deductions module: Loan / Other manual-entry "connector".
//
// Unlike the four automated connectors, this isn't a scan of source data —
// there is no loans table anywhere in the schema, and "Other" is inherently
// ad hoc. This is a pure builder around one HR-typed line per call; the
// service layer inserts it AND auto-creates its paired decision as "Approved
// for Payroll" at insert time (see service.ts) — gating a number a human
// directly typed in adds friction with no governance value, unlike a computed
// candidate that genuinely needs a human decision.

import { calculateDeductionAmountFromBaseSalary } from "../calculations.ts";
import { hashStable } from "../candidate-key.ts";
import type { DeductionsCandidateDraft, DeductionsCategory, DeductionsUnit } from "../types.ts";

export type ManualDeductionEntryInput = {
  category: Extract<DeductionsCategory, "loan" | "other">;
  employeeHrId: string;
  employeeName?: string | null;
  month: number;
  year: number;
  unit: DeductionsUnit;
  value: number;
  reason: string;
  enteredBy: string;
  /**
   * The employee's base salary, required to price a DAYS entry.
   *
   * Without it a day-based manual entry was inserted with no amount at all and
   * `requires_review` — which publish then refuses outright ("no computable
   * amount"), so adding an employee by days produced a row that could never be
   * paid. Amount-unit entries ignore this: the typed figure IS the money.
   */
  baseSalary?: number | null;
};

export function buildManualDeductionDraft(rawInput: ManualDeductionEntryInput): DeductionsCandidateDraft {
  if (!rawInput.employeeHrId.trim()) {
    throw new Error("Validation: an employee is required for a manual deduction entry.");
  }
  if (!Number.isFinite(rawInput.value) || rawInput.value <= 0) {
    throw new Error("Validation: the value must be a positive number for a manual deduction entry.");
  }
  if (!rawInput.reason.trim()) {
    throw new Error("Validation: a reason is required for a manual deduction entry.");
  }
  // A days entry can never be more days than the month has — "365" typed for "3" was accepted and
  // auto-approved for payroll. An amount is held to piasters, the unit payroll pays in.
  const daysInMonth = new Date(Date.UTC(rawInput.year, rawInput.month, 0)).getUTCDate();
  if (rawInput.unit === "days" && rawInput.value > daysInMonth) {
    throw new Error(
      `Validation: ${rawInput.value} days is more than the ${daysInMonth} days of that month. Enter the days actually deducted.`,
    );
  }
  const input = { ...rawInput, value: Math.round(rawInput.value * 100) / 100 };
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  // No natural per-day-in-range date to anchor a manual amount entry on — the
  // 1st of the target month is a stable, deterministic placeholder (kept out
  // of the candidate-key's date hash's meaning as "this literally happened
  // that day") so idempotency hashing stays reproducible without implying a
  // specific date.
  const anchorDate = `${monthKey}-01`;

  // Deterministic, clock-free identity.
  //
  // This previously appended Date.now(), which made every call produce a unique
  // candidate_key — so the (category, candidate_key) unique index could never
  // fire, and because manual entries auto-approve, a double-clicked 5,000 EGP
  // loan silently became a 10,000 EGP deduction. Hashing the normalized reason
  // plus the value instead means the same entry submitted twice collides and is
  // skipped, while a genuinely different second entry (different amount or
  // different reason) still gets its own row.
  const identity = hashStable(
    `${input.unit}|${input.value}|${input.reason.trim().replace(/\s+/g, " ").toLowerCase()}`,
  );

  // An amount entry IS the money. A days entry is priced the same way every
  // other category prices a day — base ÷ actual calendar days in the month —
  // via the shared helper, so a manually added day can never cost a different
  // amount from a detected one for the same person in the same month.
  const estimatedAmount =
    input.unit === "amount"
      ? input.value
      : calculateDeductionAmountFromBaseSalary({
          baseSalary: input.baseSalary,
          deductionDays: input.value,
          month: input.month,
          year: input.year,
        });

  return {
    category: input.category,
    sourceSystem: "manual_hr",
    sourceRecordId: `manual:${input.category}:${input.employeeHrId}:${monthKey}:${identity}`,
    employeeHrId: input.employeeHrId,
    employeeName: input.employeeName ?? null,
    monthKey,
    month: input.month,
    year: input.year,
    unit: input.unit,
    rawValue: input.value,
    estimatedAmount,
    // Still "requires review" when a days entry could not be priced (no base
    // salary on record) — that is a real gap a human must resolve, not a zero.
    calculationStatus: estimatedAmount != null ? "calculated" : "requires_review",
    reason: input.reason.trim(),
    evidence: { enteredBy: input.enteredBy },
    dates: [anchorDate],
  };
}

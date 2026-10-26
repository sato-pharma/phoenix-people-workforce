import { STEP_DEFINITIONS } from "./step-definitions.ts";
import type { ChargeSource } from "./module-drift.ts";
import type { DraftCellChange, DraftWriteReason, StepKey } from "./types.ts";

/**
 * Plain-language wording for the payroll cell history — the draft column a change landed in, why it
 * was written, and who wrote it. Pure, so the wording is tested without a browser.
 */

/** Every draft column the history can name. A column missing here shows its raw name, never a blank. */
export const DRAFT_COLUMN_LABELS: Record<string, string> = {
  days_worked: "Days worked",
  base_for_month: "Base for the month",
  ecol_paid: "Cost-of-living allowance paid",
  fuel_paid: "Fuel paid",
  fingerprint_days: "Fingerprint days",
  fingerprint_value: "Fingerprint deduction",
  expenses: "Outstation expenses",
  expenses_note: "Expenses note",
  incentive: "Incentive",
  bonus: "Bonus",
  overtime: "Overtime",
  other_additions: "Other additions",
  unpaid_vacations: "Unpaid vacation deduction",
  resignation_crm_days: "Resignation CRM days",
  crm: "CRM deduction",
  manual_other_deductions: "Other deductions",
  manual_reason: "Other deductions reason",
  additions_reason: "Additions reason",
  held_release_value: "Held salary released",
  pay_deferral_value: "Pay deferred",
  pay_deferral_month: "Pay deferred to",
  p1od_crm_days: "Part 1 CRM days",
  p1od_crm_value: "Part 1 CRM deduction",
  p1od_crm_reason: "Part 1 CRM reason",
  p1od_vacation_days: "Part 1 unpaid vacation days",
  p1od_vacation_value: "Part 1 unpaid vacation deduction",
  p1od_vacation_reason: "Part 1 unpaid vacation reason",
  p1od_no_record_days: "Days without record",
  p1od_no_record_value: "Day-without-record deduction",
  p1od_no_record_reason: "Day-without-record reason",
  p1od_loan_days: "Loan days",
  p1od_loan_value: "Loan deduction",
  p1od_loan_reason: "Loan reason",
  p1od_other_days: "Other Part 1 days",
  p1od_other_value: "Other Part 1 deduction",
  p1od_other_reason: "Other Part 1 reason",
  special_deduction_days: "Special situation deduction days",
  special_deduction_value: "Special situation deduction",
  special_addition_days: "Special situation addition days",
  special_addition_value: "Special situation addition",
  special_situation_part: "Special situation paid in",
  first_part_frozen: "First part (frozen)",
  settled_in_part1: "Settled in Part 1",
  part1_withheld: "Part 1 withheld (held at Part 1 confirm)",
  on_hold: "On hold",
  hold_reason: "Hold reason",
  excluded: "Excluded from the run",
  excluded_reason: "Exclusion reason",
};

const REASON_LABELS: Record<DraftWriteReason, string> = {
  step_saved: "Saved on the step",
  step_confirmed: "Step confirmed",
  part1_confirmed: "Part 1 confirmed",
  part1_reopened: "Part 1 reopened",
  employee_excluded: "Excluded from the run",
  employee_included: "Brought back into the run",
  deduction_resync: "Cleared after a Deductions push",
  expense_resync: "Cleared after an expense change",
};

export function columnLabel(column: string): string {
  return DRAFT_COLUMN_LABELS[column] ?? column;
}

/**
 * Why the change happened, naming the step where there was one. "Saved on the step" is the only
 * reason a person typed the figure; every other reason is the system carrying a figure across.
 */
export function reasonLabel(change: Pick<DraftCellChange, "writeReason" | "stepKey" | "inputMode">): string {
  const reason = change.writeReason as DraftWriteReason | null;
  const base = reason && reason in REASON_LABELS ? REASON_LABELS[reason] : "Reason not recorded";
  const step = change.stepKey && change.stepKey in STEP_DEFINITIONS
    ? STEP_DEFINITIONS[change.stepKey as StepKey].title
    : null;
  const viaFile = reason === "step_saved" && change.inputMode === "xlsx" ? " (uploaded sheet)" : "";
  return step ? `${base}: ${step}${viaFile}` : `${base}${viaFile}`;
}

/** True only when a person typed this figure — a save on a step, inline or by uploaded sheet. */
export function isTypedByHand(change: Pick<DraftCellChange, "writeReason">): boolean {
  return change.writeReason === "step_saved";
}

/** Who made the change, by name. Never an HR id: an unresolved id reads as an unknown person. */
export function actorLabel(change: Pick<DraftCellChange, "changedBy" | "changedByName">): string {
  if (change.changedBy === "system") return "Phoenix (automatic)";
  if (change.changedByName) return change.changedByName;
  return change.changedBy ? "A user not on the employee list" : "Not recorded";
}

/** A stored value as it reads on screen: blank is "empty", booleans read as Yes/No. */
export function valueLabel(value: string | null): string {
  if (value === null || value === "") return "empty";
  if (value === "true") return "Yes";
  if (value === "false") return "No";
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && /^-?\d+(\.\d+)?$/.test(value)) {
    return asNumber.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  return value;
}

/**
 * The clause that explains a drift row's charged figure, after "this run charges X". Says "typed"
 * ONLY when the cell history says a person saved it. The drift report used to call every mismatch
 * hand-entered, and on 2026-10-07 that named two CRM deductions a step confirm had written as
 * somebody's own figure. Lives here, not in module-drift.ts, because the wizard renders it in the
 * browser and module-drift.ts pulls in server-side helpers.
 */
export function describeChargeSource(
  source: ChargeSource | undefined,
  formatTime: (iso: string) => string = cairoTimeLabel,
): string {
  const when = source?.at ? ` on ${formatTime(source.at)}` : "";
  const step =
    source?.stepKey && Object.prototype.hasOwnProperty.call(STEP_DEFINITIONS, source.stepKey)
      ? STEP_DEFINITIONS[source.stepKey as StepKey].title
      : null;
  switch (source?.kind) {
    case "typed":
      return `which ${source.name ?? "a user not on the employee list"} typed${step ? ` on ${step}` : ""}${when}; it still stands`;
    case "step":
      return `which ${step ? `the ${step} step` : "another step"} wrote when it was confirmed${when}; nobody typed it, and it still stands`;
    case "system":
      return `which Phoenix set automatically${when}; it still stands`;
    default:
      return "which differs from the figure confirmed here; who set it is not recorded (the edit history starts 7 October 2026), and it still stands";
  }
}

/** When, in Cairo local time — the owner's standing rule for every time shown. */
export function cairoTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

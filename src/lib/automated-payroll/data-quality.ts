import { lookupSource } from "@/lib/payroll/copilot/assemble.ts";
import type { PayrollSalarySource } from "@/lib/payroll/salary-source-model.ts";
import { usableInsuranceWage } from "@/lib/payroll/statutory/insurance-wages.ts";

import type { PopulationMember } from "./recommend.ts";
import type { DraftRow } from "./types.ts";

/**
 * Pay-determining data that is missing or ambiguous, per employee, for one run.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-04, found by a deep audit of the live
 * July run). The owner opened the July sheet and found employees hired in AUGUST
 * being paid a full July month. PR #1710 fixed the dated case — hire_date after
 * the period ends — but two more August starters kept appearing, because their
 * hire_date is NULL and a null cannot be compared against anything.
 *
 * Pulling that thread found one root cause behind four separate defects:
 * PAYROLL TRUSTS EMPLOYEE-MASTER FIELDS THAT NOBODY VALIDATED. Each missing
 * field silently becomes a default, and every one of those defaults pays money:
 *
 *   - no hire date     -> isInPeriod() is false, so they are not a joiner, so
 *                         they are "regular" -> a FULL UNPRORATED MONTH.
 *   - no salary        -> renders 0.00, indistinguishable from a real zero.
 *   - no payment mode  -> normalizePayrollPaymentMode defaults to two_parts, so
 *                         a default decides the first/second installment split.
 *   - joined the run after Part 1 was frozen -> no frozen first part, which
 *                         assemble.ts used to fill in by recomputing LIVE,
 *                         silently changing a Part 1 total finance had executed.
 *
 * None of these throw, none log, and none look wrong on screen — which is
 * exactly why they survived. This module makes them visible.
 *
 * Modelled deliberately on population-diff.ts: pure, I/O-free, unit-tested, and
 * surfaced as a loud banner. That module exists for the same class of bug (a
 * payroll defect with no error and no empty state to notice it by) and this one
 * should behave and read the same way.
 *
 * Owner decision, same day: FLAG, DO NOT BLOCK. HR acknowledges and proceeds,
 * and the acknowledgement is written to the audit log — the same contract the
 * Part 1 overpayment gate already uses. Nobody is dropped from a sheet over a
 * missing field, because a genuine long-serving employee (B-165 Gannatallah
 * Amer, 17,500 net, no hire date since May) must never silently lose a month's
 * pay to a data-entry gap.
 */

export type PayrollDataIssue =
  | "missing_hire_date"
  | "missing_salary"
  | "zero_base_after_allowances"
  | "missing_payment_mode"
  | "joined_after_part1"
  | "missing_insurance_wage";

export type PayrollDataQualityRow = {
  hrId: string;
  fullName: string;
  issues: PayrollDataIssue[];
};

export type PayrollDataQualityReport = {
  rows: PayrollDataQualityRow[];
  /** Employees carrying at least one issue. Zero means the run is clean. */
  total: number;
};

/** Plain-English label per issue — shared by the wizard banner and the audit log. */
export const PAYROLL_DATA_ISSUE_LABELS: Record<PayrollDataIssue, string> = {
  missing_hire_date:
    "No hire date — cannot prove they worked this month, so they are being paid a full unprorated month",
  missing_salary: "No salary on record at all — they would be paid 0.00",
  // Deliberately NOT "would be paid 0.00" — this month's pay (new-hire proration,
  // etc.) is usually computed from net salary and is fine. What is actually zero
  // is BASE salary, which every day-rate deduction (Base ÷ the month's calendar days × days — Fingerprint,
  // CRM, Vacation, ...) derives from. Real case, owner-reported 2026-08-08: 6
  // August new hires whose entered net salary exactly equals their title's
  // standard cost-of-living + fuel allowance (e.g. 2500 = 2000 + 500 for a
  // Medical Rep), so net-minus-allowances lands on exactly zero.
  zero_base_after_allowances:
    "Net salary is on record but no base salary — after standard allowances that nets to a zero base, so every day-rate deduction (Base ÷ the month's calendar days × days) will compute as 0.00 for them",
  missing_payment_mode: "No payment mode — the First/Second Part split is being decided by a default",
  joined_after_part1: "Added to the run after Part 1 was confirmed — no frozen first installment",
  // The one issue here that costs nobody a pound. Social insurance is absorbed by the company and
  // never reduces take-home, so this is a FILING gap, not a pay gap — the label says so plainly,
  // because the banner it appears in is otherwise a list of ways somebody gets paid the wrong
  // amount, and reading this one as pay would send HR looking for money that never moved.
  missing_insurance_wage:
    "No social insurance wage on record — the statutory filing has nothing to compute from, so the raw insurance figure on the employee record is carried instead. Nobody's take-home pay is affected: the company absorbs social insurance",
};

function hasSalary(source: PayrollSalarySource | undefined): boolean {
  // Base is the figure every downstream formula derives from (policy.ts), so a
  // missing base is the honest test. A zero base is treated as missing too: it
  // produces a zero salary, which is the "renders as 0" failure this catches.
  return Boolean(source && Number.isFinite(source.baseSalary ?? NaN) && (source.baseSalary ?? 0) > 0);
}

/**
 * Audits one run's population. Pure — the caller supplies everything, so the
 * rules are unit-tested without a database.
 *
 * `part1Confirmed` matters: before Part 1 is confirmed NOBODY has a frozen first
 * part yet, so flagging a missing one would fire on the entire company. It is
 * only meaningful once the freeze has happened.
 */
export function auditPayrollDataQuality(input: {
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
  draftRows: DraftRow[];
  part1Confirmed: boolean;
  /**
   * Every employee's insurance wage, keyed by compact HR id. Optional: a caller that has not
   * loaded it simply does not raise the filing issue, rather than accusing the whole company of a
   * missing wage because the map was never passed.
   */
  insuranceWages?: Map<string, number | null>;
}): PayrollDataQualityReport {
  const draftByCompact = new Map(input.draftRows.map((row) => [row.employeeHrIdCompact, row]));
  const rows: PayrollDataQualityRow[] = [];

  for (const member of input.members) {
    const issues: PayrollDataIssue[] = [];
    const source = lookupSource(input.sources, member.employee.hrId);

    if (!String(member.employee.hireDate ?? "").trim()) issues.push("missing_hire_date");
    if (!hasSalary(source)) {
      // Same underlying signal (base salary computes to zero) but two very
      // different real-world situations — see PAYROLL_DATA_ISSUE_LABELS.
      issues.push(source?.hasAnyRawCompensationFigure ? "zero_base_after_allowances" : "missing_salary");
    }
    // Read the RAW field, not the normalized one: normalizePayrollPaymentMode's
    // whole job is to turn a null into "two_parts", so asking it would always
    // answer "fine" and hide the very gap being looked for.
    // `paymentModeOnRecord` is the raw answer when the payroll builder supplied it — its
    // `paymentMode` is already normalised, so asking that alone always said "fine" (owner,
    // 2026-11-07: 17 of 142 active employees had none, and none was ever flagged).
    if (source?.paymentModeOnRecord === false || !String(source?.paymentMode ?? "").trim()) {
      issues.push("missing_payment_mode");
    }

    if (input.part1Confirmed && draftByCompact.get(member.compact)?.firstPartFrozen == null) {
      issues.push("joined_after_part1");
    }

    // Only asked when the caller supplied the map. `usableInsuranceWage` rather than a null check:
    // the column is hand-edited and an unusable value (a zero, a stray non-number) has to read as
    // missing, because that is exactly what the engine will treat it as when it computes the
    // filing.
    if (input.insuranceWages && usableInsuranceWage(input.insuranceWages.get(member.compact)) === null) {
      issues.push("missing_insurance_wage");
    }

    if (issues.length > 0) {
      rows.push({ hrId: member.employee.hrId, fullName: member.employee.fullName, issues });
    }
  }

  // Most-broken first, then by name, so the worst records are read first and the
  // order is stable between loads.
  rows.sort(
    (left, right) => right.issues.length - left.issues.length || left.fullName.localeCompare(right.fullName),
  );

  return { rows, total: rows.length };
}

/**
 * Does this issue change what somebody is PAID?
 *
 * Every issue on this list except one does: a missing hire date pays a full unprorated month, a
 * missing salary pays nothing, a missing payment mode lets a default split the instalments. The
 * confirm gate exists for exactly that class — a human must see them before money moves.
 *
 * A missing insurance wage does not. Social insurance is absorbed by the company and never reduces
 * take-home, so it changes the statutory filing and nothing else. It is shown in the banner, where
 * HR can act on it, and deliberately does NOT hold up a confirm — a gate that stops payroll over a
 * figure that moves nobody's money teaches people to acknowledge without reading, which is how the
 * gate stops working for the four issues that do.
 */
export const PAYROLL_DATA_ISSUE_AFFECTS_PAY: Record<PayrollDataIssue, boolean> = {
  missing_hire_date: true,
  missing_salary: true,
  zero_base_after_allowances: true,
  missing_payment_mode: true,
  joined_after_part1: true,
  missing_insurance_wage: false,
};

/** The subset the confirm gate acts on — people carrying at least one pay-affecting issue. */
export function payAffectingIssues(report: PayrollDataQualityReport): PayrollDataQualityReport {
  const rows = report.rows
    .map((row) => ({ ...row, issues: row.issues.filter((issue) => PAYROLL_DATA_ISSUE_AFFECTS_PAY[issue]) }))
    .filter((row) => row.issues.length > 0);
  return { rows, total: rows.length };
}

/** One-line summary for the confirm-gate error message and the audit log. */
export function describePayrollDataQuality(report: PayrollDataQualityReport): string {
  if (report.total === 0) return "No missing payroll data.";
  const sample = report.rows
    .slice(0, 5)
    .map((row) => `${row.fullName} (${row.hrId}): ${row.issues.map((issue) => PAYROLL_DATA_ISSUE_LABELS[issue]).join("; ")}`);
  const more = report.total > 5 ? ` …and ${report.total - 5} more.` : "";
  return `${report.total} employee(s) have missing payroll data. ${sample.join(" | ")}${more}`;
}

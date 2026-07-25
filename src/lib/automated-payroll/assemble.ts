import { lookupSource } from "@/lib/payroll/copilot/assemble.ts";
import { roundCurrency } from "@/lib/payroll/money";
import { normalizePayrollPaymentMode } from "@/lib/payroll/policy";
import type { SalaryValidationRow } from "@/lib/payroll/salary-import";
import type { PayrollSalarySource } from "@/lib/payroll/salary-source-model.ts";

import type { PopulationMember } from "./recommend.ts";
import {
  assembleParts,
  effectiveSalary,
  freezeFirstPart,
  type EffectiveSalary,
} from "./split.ts";
import type { DraftRow, PayrollPeriod, RowLifecycle } from "./types.ts";

/**
 * Assembles the canonical monthly rows (the exact SalaryValidationRow shape the
 * existing createSalaryBatch machinery consumes) from the run's salary sources +
 * confirmed draft rows, using the two-phase split in split.ts.
 *
 * Base/ECoL/Fuel/Net for the month reflect any joiner/leaver proration or HR
 * settlement override; Gross/SI/Tax are carried from the master (matching the
 * existing Copilot's owner-confirmed scope). Held employees keep their computed
 * amounts (rendered red + flagged); they are dropped from the published batch by
 * the publish step, never here.
 */

export type AssembledRow = {
  row: SalaryValidationRow;
  compact: string;
  onHold: boolean;
  overpaidResidual: number;
  /**
   * Amount recovered THIS run from a previous run's overpayment (owner rule
   * 2026-07-25). Already included in the row's deduction totals; surfaced
   * separately so the sheet and UI can show it as its own line rather than
   * burying a past month's correction inside "other deductions".
   */
  carriedForwardApplied: number;
  lifecycle: RowLifecycle;
  /** For the Part-1 sheet's bank columns — not part of the canonical salary_records payload. */
  bankName: string | null;
  bankAccount: string | null;
};

function draftByCompact(draftRows: DraftRow[]): Map<string, DraftRow> {
  return new Map(draftRows.map((row) => [row.employeeHrIdCompact, row]));
}

function num(value: number | null | undefined): number {
  return value == null || !Number.isFinite(value) ? 0 : value;
}

/** Sum of the Part-1 manual deduction tabs' 5 category values (CRM/Vacation/No-Record/Loan/Other; 0 for any not filled in). */
function otherPart1DeductionsTotal(draft: DraftRow | undefined): number {
  return roundCurrency(
    num(draft?.p1odCrmValue) +
      num(draft?.p1odVacationValue) +
      num(draft?.p1odNoRecordValue) +
      num(draft?.p1odLoanValue) +
      num(draft?.p1odOtherValue),
  );
}

/**
 * Special Situations (owner rule 2026-07-25): a manual deduction + addition that
 * always count once in the whole-month total, but only reduce/increase the
 * FROZEN First Part when HR has routed them there via the shared
 * `specialSituationPart` choice. Routed to "second" (or unset), they land purely
 * in Part 2 — same self-canceling pattern the other Part-1 manual tabs already
 * rely on (see otherPart1DeductionsTotal): whichever installment isn't holding
 * the amount at freeze time picks it up automatically via
 * `secondPart = totalPayable - firstPart`.
 */
function specialDeductionAmount(draft: DraftRow | undefined): number {
  return roundCurrency(num(draft?.specialDeductionValue));
}
function specialAdditionAmount(draft: DraftRow | undefined): number {
  return roundCurrency(num(draft?.specialAdditionValue));
}
function specialRoutedToFirst(draft: DraftRow | undefined): boolean {
  return draft?.specialSituationPart === "first";
}

function buildEffective(
  member: PopulationMember,
  source: PayrollSalarySource | undefined,
  draft: DraftRow | undefined,
  period: PayrollPeriod,
): EffectiveSalary {
  return effectiveSalary({
    baseSalary: roundCurrency(source?.baseSalary ?? 0),
    extraCostOfLiving: roundCurrency(source?.extraCostOfLiving ?? 0),
    fuelAllowance: roundCurrency(source?.fuelAllowance ?? 0),
    netSalary: roundCurrency(source?.netSalary ?? 0),
    period,
    lifecycle: member.lifecycle,
    hireDate: member.employee.hireDate,
    lastWorkingDate: member.lastWorkingDate,
    unpaidDaysInSpan: member.unpaidDaysInSpan,
    overrideBase: draft?.baseForMonth ?? null,
    overrideEcol: draft?.ecolPaid ?? null,
    overrideFuel: draft?.fuelPaid ?? null,
  });
}

/**
 * The frozen First Part for each employee (keyed by compact HR id), computed
 * from Part-1 knowledge only. Called at Part-1 confirm and persisted to
 * draft_rows.first_part_frozen; never recomputed afterward.
 */
export function computeFrozenFirstParts(input: {
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
  draftRows: DraftRow[];
  period: PayrollPeriod;
}): Map<string, number> {
  const drafts = draftByCompact(input.draftRows);
  const frozen = new Map<string, number>();
  for (const member of input.members) {
    const source = lookupSource(input.sources, member.employee.hrId);
    const draft = drafts.get(member.compact);
    const effective = buildEffective(member, source, draft, input.period);
    const value = freezeFirstPart({
      effective,
      fullBaseSalary: roundCurrency(source?.baseSalary ?? 0),
      paymentMode: source?.paymentMode ?? "two_parts",
      fingerprint: num(draft?.fingerprintValue),
      otherPart1Deductions: roundCurrency(
        otherPart1DeductionsTotal(draft) + (specialRoutedToFirst(draft) ? specialDeductionAmount(draft) : 0),
      ),
      otherPart1Additions: specialRoutedToFirst(draft) ? specialAdditionAmount(draft) : 0,
      medicalInsurance: roundCurrency(num(member.employee.medicalInsurance)),
      leaverDeduction: leaverDeductionFor(member, draft),
    });
    frozen.set(member.compact, value);
  }
  return frozen;
}

/** Leaver's own CRM+vacation deduction, confirmed on the Resignation step (owner rule 2026-07-20). Non-leavers: 0. */
function leaverDeductionFor(member: PopulationMember, draft: DraftRow | undefined): number {
  if (member.lifecycle !== "leaver") return 0;
  return roundCurrency(num(draft?.crm) + num(draft?.unpaidVacations));
}

/** Assemble every employee's canonical row for the run. */
export function assembleRows(input: {
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
  draftRows: DraftRow[];
  period: PayrollPeriod;
  /**
   * Outstanding overpayments from PREVIOUS runs, keyed by compact HR id, to
   * recover this month (see carry-forward.ts). Omitted for callers that only
   * need this month's own figures, e.g. the Part-1 freeze pass.
   */
  carryForwardByCompact?: Map<string, number>;
}): AssembledRow[] {
  const drafts = draftByCompact(input.draftRows);
  const results: AssembledRow[] = [];

  input.members.forEach((member, index) => {
    const employee = member.employee;
    const source = lookupSource(input.sources, employee.hrId);
    const draft = drafts.get(member.compact);

    const effective = buildEffective(member, source, draft, input.period);
    const paymentMode = normalizePayrollPaymentMode(source?.paymentMode ?? "two_parts");
    const fullBaseSalary = roundCurrency(source?.baseSalary ?? 0);

    const fingerprint = num(draft?.fingerprintValue);
    const otherPart1Total = otherPart1DeductionsTotal(draft);
    const specialDeduction = specialDeductionAmount(draft);
    const specialAddition = specialAdditionAmount(draft);
    const specialToFirst = specialRoutedToFirst(draft);
    const medicalInsurance = roundCurrency(num(employee.medicalInsurance));
    // Use the frozen First Part after Part-1 confirm; before that, compute live.
    const firstPartFrozen =
      draft?.firstPartFrozen != null
        ? draft.firstPartFrozen
        : freezeFirstPart({
            effective,
            fullBaseSalary,
            paymentMode,
            fingerprint,
            otherPart1Deductions: roundCurrency(otherPart1Total + (specialToFirst ? specialDeduction : 0)),
            otherPart1Additions: specialToFirst ? specialAddition : 0,
            medicalInsurance,
            leaverDeduction: leaverDeductionFor(member, draft),
          });

    const expenses = num(draft?.expenses);
    const incentive = num(draft?.incentive);
    const bonus = num(draft?.bonus);
    const overtime = num(draft?.overtime);
    const crm = num(draft?.crm);
    const unpaidVacations = num(draft?.unpaidVacations);
    const manualOtherDeductions = num(draft?.manualOtherDeductions);
    // Special Situations amounts always count once in the whole-month total,
    // whichever installment HR routed them to (see specialRoutedToFirst doc).
    // A previous run's overpayment being recovered this month. Counts as a
    // deduction exactly once, like every other component (see the
    // deduction-counted-once test), and is clamped so it can never turn into a
    // negative "addition" if the ledger ever holds a bad value.
    const carriedForwardApplied = Math.max(
      0,
      roundCurrency(input.carryForwardByCompact?.get(member.compact) ?? 0),
    );
    const otherDeductionsTotal = roundCurrency(
      manualOtherDeductions + otherPart1Total + specialDeduction + carriedForwardApplied,
    );
    const otherAdditionsTotal = specialAddition;
    const loans = 0;

    const parts = assembleParts({
      effective,
      paymentMode,
      firstPartFrozen,
      additions: { expenses, incentive, overtime, bonus, otherAdditions: otherAdditionsTotal },
      deductions: {
        fingerprint,
        crm,
        unpaidVacations,
        medicalInsurance,
        loans,
        otherDeductions: otherDeductionsTotal,
      },
    });

    const socialInsurance = roundCurrency(num(source?.socialInsurance));
    const employmentIncomeTax = roundCurrency(num(source?.employmentIncomeTax));
    // Gross is derived FORWARD from the effective (prorated) base so it reconciles
    // with net for joiner/leaver rows (Gross = Base + SI + Tax, the locked policy
    // formula). For a regular employee effective.base == master base, so this
    // equals the stored gross — no change.
    const grossSalary = roundCurrency(effective.base + socialInsurance + employmentIncomeTax);
    const governmentalDeductions = roundCurrency(socialInsurance + employmentIncomeTax);
    const totalAdditions = roundCurrency(
      expenses + incentive + overtime + bonus + effective.ecol + effective.fuel + otherAdditionsTotal,
    );
    const totalDeductions = roundCurrency(
      crm + fingerprint + unpaidVacations + medicalInsurance + loans + otherDeductionsTotal,
    );
    const onHold = Boolean(draft?.onHold);

    const row: SalaryValidationRow = {
      area: employee.areaName ?? "Unassigned",
      baseSalary: effective.base,
      bonus,
      crm,
      hrId: employee.hrId,
      employmentIncomeTax,
      expenses,
      extraCostOfLiving: effective.ecol,
      fingerPrint: fingerprint,
      firstPart: parts.firstPart,
      fuelAllowance: effective.fuel,
      governmentalDeductions,
      fullName: employee.fullName,
      grossSalary,
      hireDate: employee.hireDate,
      incentive,
      jobTitle: employee.jobTitle ?? "Unassigned",
      line: employee.lineName ?? "Unassigned",
      loans,
      medicalInsurance,
      monthSalary: parts.monthSalary,
      nameAr: employee.nameAr,
      netSalary: effective.net,
      otherAdditions: otherAdditionsTotal,
      otherDeductions: otherDeductionsTotal,
      overtime,
      payrollComment: onHold ? draft?.holdReason ?? "HOLD" : draft?.manualReason ?? null,
      paymentMode,
      row: index + 1,
      secondPart: parts.secondPart,
      socialInsurance,
      totalAdditions,
      totalDeductions,
      unpaidVacations,
    };

    results.push({
      row,
      compact: member.compact,
      onHold,
      overpaidResidual: parts.overpaidResidual,
      carriedForwardApplied,
      lifecycle: member.lifecycle,
      bankName: employee.bankName ?? null,
      bankAccount: employee.bankAccount ?? null,
    });
  });

  return results;
}

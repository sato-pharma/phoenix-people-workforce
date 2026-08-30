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
import type { DraftRow, PayrollPeriod, RowLifecycle, RowSettlementBasis } from "./types.ts";

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

/**
 * One employee's month broken into components, for the four-figure summary the
 * owner asked to see on every step screen (2026-08-30). See
 * settlement-summary.ts for what is done with it and why the client is the one
 * that adds it up.
 *
 * IT LIVES HERE, NOT IN recommend.ts, ON PURPOSE. Every value below is lifted
 * from assembleRows a few lines down — the same `buildEffective`, the same
 * `num`, the same helpers — so the two read as one function and a change to the
 * money has both in front of it. Additive: assembleRows is untouched, so
 * nothing that pays anybody moves.
 *
 * The component list must stay the exact flattening of assembleParts'
 * sumAdditions/sumDeductions. It is pinned that way by
 * tests/automated-payroll-settlement-summary.test.ts, which runs this and
 * assembleRows over the same inputs and asserts the three derived figures
 * match — so a new deduction added to the payroll but not to this list turns
 * the PR red instead of quietly overstating someone's take-home.
 */
export function settlementBasisFor(input: {
  member: PopulationMember;
  source: PayrollSalarySource | undefined;
  draft: DraftRow | undefined;
  period: PayrollPeriod;
  /** This run's recovery of a PREVIOUS run's overpayment (carry-forward.ts). */
  carriedForward?: number;
}): RowSettlementBasis {
  const draft = input.draft;
  const effective = buildEffective(input.member, input.source, draft, input.period);
  return {
    monthNet: roundCurrency(num(input.source?.netSalary)),
    components: {
      // Earned — already carrying any joiner/leaver proration AND any HR
      // settlement override, exactly as the paid row will.
      baseForMonth: effective.base,
      ecolPaid: effective.ecol,
      fuelPaid: effective.fuel,
      // Added on top.
      expenses: num(draft?.expenses),
      incentive: num(draft?.incentive),
      bonus: num(draft?.bonus),
      overtime: num(draft?.overtime),
      specialAdditionValue: specialAdditionAmount(draft),
      // Taken off.
      fingerprintValue: num(draft?.fingerprintValue),
      crm: num(draft?.crm),
      unpaidVacations: num(draft?.unpaidVacations),
      medicalInsurance: roundCurrency(num(input.member.employee.medicalInsurance)),
      p1odCrmValue: num(draft?.p1odCrmValue),
      p1odVacationValue: num(draft?.p1odVacationValue),
      p1odNoRecordValue: num(draft?.p1odNoRecordValue),
      p1odLoanValue: num(draft?.p1odLoanValue),
      p1odOtherValue: num(draft?.p1odOtherValue),
      manualOtherDeductions: num(draft?.manualOtherDeductions),
      specialDeductionValue: specialDeductionAmount(draft),
      // Clamped the same way assembleRows clamps it, so a bad ledger value can
      // never read as an addition.
      carriedForwardApplied: Math.max(0, roundCurrency(input.carriedForward ?? 0)),
    },
  };
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
  /**
   * Whether this run's Part 1 has already been confirmed — i.e. the first
   * installment is real, executed money. Changes what a MISSING frozen first
   * part means; see the `firstPartFrozen` comment below. Defaults to false so
   * an omitting caller keeps the pre-2026-08-04 preview behaviour.
   */
  part1Confirmed?: boolean;
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
    //
    // A MISSING frozen value means two different things, and conflating them was
    // a real defect (audit, 2026-08-04 — 5 of 123 rows on the live July run):
    //
    //  - Part 1 still OPEN  -> nobody is frozen yet, so computing live IS the
    //                          preview. Correct, unchanged.
    //  - Part 1 CONFIRMED   -> this employee entered the population AFTER the
    //                          freeze, so they were not in the first installment
    //                          finance actually executed. Their first part is
    //                          therefore 0 and the whole month pays in Part 2.
    //
    // Recomputing live in the second case silently changed a Part 1 total that
    // had already been paid out — the one number this module promises never
    // moves (see freezeFirstPart's "never recomputed" invariant). Using 0 keeps
    // firstPart + secondPart === monthSalary, the invariant reconcile.ts
    // asserts, and matches the money that actually left the bank. The employee
    // is separately flagged as `joined_after_part1` by data-quality.ts, so this
    // is visible rather than merely silent-and-correct.
    const firstPartFrozen =
      draft?.firstPartFrozen != null
        ? draft.firstPartFrozen
        : input.part1Confirmed === true
          ? 0
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

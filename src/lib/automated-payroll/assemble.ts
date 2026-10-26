import { lookupSource } from "@/lib/payroll/copilot/assemble.ts";
import { roundCurrency } from "@/lib/payroll/money";
import { calendarDaysInMonth } from "@/lib/payroll/copilot/proration";
import { isResignationEmploymentStatus } from "@/lib/payroll/leaver-kind.ts";
import { normalizePayrollPaymentMode } from "@/lib/payroll/policy";
import type { SalaryValidationRow } from "@/lib/payroll/salary-import";
import { HELD_RELEASE_ONLY_COMMENT } from "@/lib/payroll/held-release";
import type { PayrollSalarySource } from "@/lib/payroll/salary-source-model.ts";
import {
  statutoryFromInsuranceWage,
  type InsuranceWageMap,
} from "@/lib/payroll/statutory/insurance-wages.ts";
import type { StatutoryConfig } from "@/lib/payroll/statutory/types.ts";

import { HELD_NO_REASON_COMMENT, normalizeHoldReason } from "./hold-reason.ts";
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
 * Base/ECoL/Fuel/Net/Gross carry the FULL contract salary — they are NOT prorated
 * (owner rule 2026-09-04). A joiner/leaver is still paid for their working days
 * only: that proration lives in `effective`, which feeds assembleParts and
 * freezeFirstPart untouched and lands in monthSalary/firstPart/secondPart. The
 * new `workingDays` column is what explains the gap between the two on the sheet.
 *
 * This split is safe because nothing downstream re-derives money from the salary
 * columns: mapRecord (payroll/service.ts) and the salary importer both prefer the
 * stored first_part/second_part/month_salary and only fall back to
 * calculatePayrollParts when those are NULL, which they never are here.
 *
 * SOCIAL INSURANCE is computed from the employee's own `social_insurance_wage`, which is the
 * column that ALONE decides the statutory filing. It used to be copied raw off
 * `employees.social_insurance`, and on production's August 2026 run 94 of 100 records carried
 * exactly that raw figure while NONE carried 11% of the person's clamped wage — so the Copilot and
 * this engine filed the same person at two different amounts depending on which one built the
 * month. Income tax is still carried from the master; that is a separate figure and a separate fix.
 *
 * NEITHER STATUTORY FIGURE REDUCES TAKE-HOME PAY. Both are reported as `governmentalDeductions`
 * and neither appears in `totalDeductions` or in what `assembleParts` is handed, because the
 * company absorbs them. So this change moves the filing and the sheet's Gross column, and moves
 * nobody's money.
 *
 * Held employees keep their computed amounts (rendered red + flagged); they are dropped from the
 * published batch by the publish step, never here.
 */

export type AssembledRow = {
  row: SalaryValidationRow;
  compact: string;
  onHold: boolean;
  overpaidResidual: number;
  /**
   * What the LOCKED engine says this month owes, before the split decides which instalment pays it.
   *
   * Carried through so reconcile() can compare the split against something it did not derive from
   * the split. `monthSalary` is literally `firstPart + secondPart` (see assembleParts), so a check
   * of one against the other can never fail — which is what the pre-Part-2 gate was doing.
   */
  totalPayable: number;
  /**
   * Amount recovered THIS run from a previous run's overpayment (owner rule
   * 2026-07-25). Already included in the row's deduction totals; surfaced
   * separately so the sheet and UI can show it as its own line rather than
   * burying a past month's correction inside "other deductions".
   */
  carriedForwardApplied: number;
  /**
   * Held salary from an earlier published month that this row pays (Held Salary Release, owner
   * 2026-10-26). Already inside Other Additions and the Part 2 instalment; surfaced separately so
   * publish can record exactly what was released against the held balance, and nothing else.
   */
  heldReleaseApplied: number;
  /**
   * Taken off this month's Part 2 by Defer Pay and owed again later (owner, 2026-10-26). Already
   * inside Other Deductions; surfaced so publish can record it as owed. Never above the Part 2 the
   * row had before the deferral, and 0 on a held row — a held month is withheld whole.
   */
  payDeferralApplied: number;
  /**
   * The person was ON HOLD when Part 1 was confirmed, so the Part 1 bank files did not pay their first
   * instalment. Undefined before Part 1 confirm or on a run confirmed before this was recorded —
   * readers then fall back to `onHold`, which is what they did before.
   */
  part1Withheld?: boolean;
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

/**
 * The Part-1 LOAN repayment, which the sheet shows in its own Loans column (owner, 2026-10-09).
 *
 * It used to be `const loans = 0` with the money folded into Other Deductions, so the September
 * 2026 full sheet showed a Loans column of zeros for all 102 rows while Mahmoud Ibrahim Ahmed
 * Mohamed (A-1) 1,250.00 and Muhammad AlMinshawy (B-148) 725.01 sat under *Other Deductions*. The
 * money was right and the column was not, which is the worse half: a reader checking a loan
 * balance against the sheet finds nothing and the figure beside it unexplained.
 *
 * 🔴 PRESENTATION ONLY — IT MOVES NO MONEY. The loan stays inside
 * `otherPart1DeductionsTotal`, which is what feeds `freezeFirstPart`, so the frozen First Part
 * cannot shift; and Total Deductions sums `loans` and `otherDeductions` together, so taking the
 * loan out of one and putting it in the other leaves every total byte-identical. Pinned by
 * `tests/automated-payroll-assemble.test.ts`.
 */
function part1LoanDeduction(draft: DraftRow | undefined): number {
  return roundCurrency(num(draft?.p1odLoanValue));
}

/** The Part-1 manual deduction tabs EXCEPT the loan, which now carries its own column. */
function otherPart1DeductionsExceptLoan(draft: DraftRow | undefined): number {
  return roundCurrency(
    num(draft?.p1odCrmValue) +
      num(draft?.p1odVacationValue) +
      num(draft?.p1odNoRecordValue) +
      num(draft?.p1odOtherValue),
  );
}

/**
 * Sum of the Part-1 manual deduction tabs' 5 category values (CRM/Vacation/No-Record/Loan/Other;
 * 0 for any not filled in).
 *
 * 🔴 THE LOAN STAYS IN HERE even though it is now shown in its own column: this total is what
 * `freezeFirstPart` takes off the First Part, and dropping the loan from it would move money
 * that has already been paid. Only the PRESENTATION splits — see `part1LoanDeduction`.
 */
function otherPart1DeductionsTotal(draft: DraftRow | undefined): number {
  return roundCurrency(otherPart1DeductionsExceptLoan(draft) + part1LoanDeduction(draft));
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
    // The exit workflow records dismissals too, so the last working date cannot say which kind of
    // departure this is — only the employee's own status can. A dismissal keeps neither allowance
    // and gets no >25th waiver (owner ruling 2026-08-14).
    isResignation: isResignationEmploymentStatus(member.employee.employmentStatus),
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
      otherAdditions: num(draft?.otherAdditions),
      heldReleaseValue: heldReleaseAmount(draft),
      // Taken off.
      // Defer Pay: assembleRows also caps it at the row's Part 2, which the step's save already enforces.
      payDeferralValue: draft?.onHold ? 0 : payDeferralAmount(draft),
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

/** The Held Salary Release step's figure for this row, never negative. */
function heldReleaseAmount(draft: DraftRow | undefined): number {
  return Math.max(0, roundCurrency(num(draft?.heldReleaseValue)));
}

/** The Defer Pay step's figure for this row, never negative. */
function payDeferralAmount(draft: DraftRow | undefined): number {
  return Math.max(0, roundCurrency(num(draft?.payDeferralValue)));
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
  /**
   * The statutory parameters plus every employee's insurance wage, keyed by compact HR id.
   *
   * Optional so a caller that only needs this month's payable figures — none of which depend on a
   * statutory amount — does not have to load it. Omitted, each row carries the master's raw
   * `social_insurance` column exactly as it did before, which is the honest fallback: no wage, no
   * derived figure, and nothing invented in between.
   */
  statutory?: { config: StatutoryConfig; insuranceWages: InsuranceWageMap };
  /**
   * People outside this month's population who are on the sheet ONLY to be paid an earlier month's
   * held salary (recommend.ts releaseOnlyMember). Built by assembleReleaseOnlyRow, never by the split.
   */
  releaseOnlyMembers?: PopulationMember[];
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
    // The CONTRACT salary — what the employee is worth per month, independent of
    // how many days of this month he was actually on payroll. Owner rule
    // 2026-09-04: these are what the payroll sheet, the payslip and the portal
    // DISPLAY. `effective` (the prorated slice) stays the basis of every money
    // figure below — it is passed to assembleParts and freezeFirstPart untouched,
    // so nothing about what anybody is PAID moves.
    const fullExtraCostOfLiving = roundCurrency(source?.extraCostOfLiving ?? 0);
    const fullFuelAllowance = roundCurrency(source?.fuelAllowance ?? 0);
    const fullNetSalary = roundCurrency(source?.netSalary ?? 0);

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
    // The loan is shown in the Loans column, so it must not also be counted inside Other
    // Deductions — `totalDeductions` adds both, and counting it twice would overstate every
    // affected row's deductions. `otherPart1Total` above is untouched and still carries it, which
    // is what keeps the frozen First Part exactly where it was.
    const otherDeductionsBeforeDeferral = roundCurrency(
      manualOtherDeductions +
        otherPart1DeductionsExceptLoan(draft) +
        specialDeduction +
        carriedForwardApplied,
    );
    // The Additions step's Other additions cell (a dispute refund, 2026-10-09) is paid in the same
    // column as the Special Situations addition, and like it counts once for the whole month. A held
    // salary released this month (2026-10-26) joins them: it is an addition with no Part 1 share, so
    // it lands in Part 2 through `secondPart = totalPayable - firstPartFrozen`. A row HELD again this
    // month releases nothing: the release stays owed on its own month, and folding it into a held row
    // would let it cancel this month's overpayment and vanish with the hold.
    const heldReleaseApplied = draft?.onHold ? 0 : heldReleaseAmount(draft);
    const otherAdditionsTotal = roundCurrency(specialAddition + num(draft?.otherAdditions) + heldReleaseApplied);
    const loans = part1LoanDeduction(draft);

    const partsWith = (otherDeductions: number) =>
      assembleParts({
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
          otherDeductions,
        },
      });
    // Defer Pay (owner, 2026-10-26): part of this month's pay moved to a later month. It comes off Part 2
    // only — Part 1 is frozen money — so it is capped at the Part 2 the row has without it, which keeps
    // it from ever eating into the first instalment or creating an overpayment. Taken as a deduction so
    // the month's total, the payslip and the bank file all show the smaller figure; publish records it
    // as owed and Held Salary Release pays it in its month. A held row defers nothing.
    const partsBeforeDeferral = partsWith(otherDeductionsBeforeDeferral);
    const payDeferralApplied = draft?.onHold
      ? 0
      : Math.min(payDeferralAmount(draft), partsBeforeDeferral.secondPart);
    const otherDeductionsTotal = roundCurrency(otherDeductionsBeforeDeferral + payDeferralApplied);
    const parts = payDeferralApplied > 0 ? partsWith(otherDeductionsTotal) : partsBeforeDeferral;

    // The insurance wage decides the filing, so it decides this figure. Falling back to the
    // master's raw column when no wage is on file is deliberate: the alternative is to publish a
    // zero, and a confident zero on a statutory line is worse than a stale number that at least
    // came from somewhere. The Data Quality step names anyone in that state.
    const filed = input.statutory
      ? statutoryFromInsuranceWage(
          input.statutory.insuranceWages.get(member.compact),
          input.statutory.config,
        )
      : null;
    const socialInsurance = filed
      ? roundCurrency(filed.employee)
      : roundCurrency(num(source?.socialInsurance));
    const employmentIncomeTax = roundCurrency(num(source?.employmentIncomeTax));
    // Gross is derived from the CONTRACT base, so the locked policy identity
    // Gross = Base + SI + Tax still reads true across the row now that Base
    // shows the full salary (owner rule 2026-09-04). It used to be derived from
    // effective.base; for a regular employee the two are identical, and for a
    // joiner/leaver this is the half that had to move with Base.
    const grossSalary = roundCurrency(fullBaseSalary + socialInsurance + employmentIncomeTax);
    const governmentalDeductions = roundCurrency(socialInsurance + employmentIncomeTax);
    // ECoL and Fuel are shown at their full contract value too (owner's choice
    // when asked, 2026-09-04: "show them full too, so Net = Base + ECoL + Fuel
    // adds up"). This total is presentational — it has never fed the money,
    // because totalPayable takes ECoL/Fuel through netSalary, not through here.
    const totalAdditions = roundCurrency(
      expenses + incentive + overtime + bonus + fullExtraCostOfLiving + fullFuelAllowance + otherAdditionsTotal,
    );
    const totalDeductions = roundCurrency(
      crm + fingerprint + unpaidVacations + medicalInsurance + loans + otherDeductionsTotal,
    );
    const onHold = Boolean(draft?.onHold);

    const row: SalaryValidationRow = {
      area: employee.areaName ?? "Unassigned",
      baseSalary: fullBaseSalary,
      bonus,
      calendarDays: effective.calendarDays,
      crm,
      hrId: employee.hrId,
      employmentIncomeTax,
      expenses,
      extraCostOfLiving: fullExtraCostOfLiving,
      fingerPrint: fingerprint,
      firstPart: parts.firstPart,
      fuelAllowance: fullFuelAllowance,
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
      netSalary: fullNetSalary,
      otherAdditions: otherAdditionsTotal,
      otherDeductions: otherDeductionsTotal,
      overtime,
      // A held row's comment is its hold reason — the only record of why this
      // person was not paid, since publish drops the row and writes no payslip.
      // The fallback used to be the bare word "HOLD", which read as a status
      // label rather than as missing information, so a blank reason looked
      // answered. `assertHoldReasonsPresent` makes it unreachable for any hold
      // set from now on; what reaches it is a row held before that rule existed,
      // and those are precisely the ones that must announce themselves.
      payrollComment: onHold
        ? normalizeHoldReason(draft?.holdReason) ?? HELD_NO_REASON_COMMENT
        : draft?.manualReason ?? null,
      paymentMode,
      row: index + 1,
      secondPart: parts.secondPart,
      socialInsurance,
      totalAdditions,
      totalDeductions,
      unpaidVacations,
      workingDays: effective.workingDays,
    };

    results.push({
      row,
      compact: member.compact,
      onHold,
      overpaidResidual: parts.overpaidResidual,
      totalPayable: parts.totalPayable,
      carriedForwardApplied,
      heldReleaseApplied,
      payDeferralApplied,
      part1Withheld: draft?.part1Withheld ?? undefined,
      lifecycle: member.lifecycle,
      bankName: employee.bankName ?? null,
      bankAccount: employee.bankAccount ?? null,
    });
  });

  const memberCompacts = new Set(input.members.map((member) => member.compact));
  for (const member of input.releaseOnlyMembers ?? []) {
    // Someone in the population is paid the release through their ordinary row above.
    if (memberCompacts.has(member.compact)) continue;
    // Held again: nothing is released, so there is no row (see heldReleaseApplied above).
    if (drafts.get(member.compact)?.onHold) continue;
    const release = heldReleaseAmount(drafts.get(member.compact));
    if (release <= 0) continue;
    results.push(
      assembleReleaseOnlyRow({
        member,
        source: lookupSource(input.sources, member.employee.hrId),
        draft: drafts.get(member.compact),
        period: input.period,
        index: results.length,
      }),
    );
  }

  return results;
}

/**
 * The row for someone paid ONLY a held-salary release this month — typically a resigned employee
 * whose last Part 2 was withheld (owner, 2026-10-26: "if someone's salary is held, it's not added
 * afterwards").
 *
 * Not built through the split: they earned nothing this month, so there is no Part 1, no deduction
 * and no proration. The whole release is the Part 2 instalment, and the month's pay is the release.
 *
 * The salary columns still show the CONTRACT salary, because the sheet's own rules need them (a
 * gross of zero is refused, and gross and net must follow the locked formulas). Social insurance
 * and income tax are ZERO: nothing was earned this month, so nothing is filed for it — the
 * withheld money was already filed in the month it was earned. Gross is therefore the contract
 * base, which the gross formula accepts. Working days 0 says on the sheet that no work is paid.
 */
export function assembleReleaseOnlyRow(input: {
  member: PopulationMember;
  source: PayrollSalarySource | undefined;
  draft: DraftRow | undefined;
  period: PayrollPeriod;
  index: number;
}): AssembledRow {
  const { member, source, draft } = input;
  const employee = member.employee;
  const release = heldReleaseAmount(draft);
  const baseSalary = roundCurrency(source?.baseSalary ?? 0);
  const extraCostOfLiving = roundCurrency(source?.extraCostOfLiving ?? 0);
  const fuelAllowance = roundCurrency(source?.fuelAllowance ?? 0);
  const row: SalaryValidationRow = {
    area: employee.areaName ?? "Unassigned",
    baseSalary,
    bonus: 0,
    calendarDays: calendarDaysInMonth(input.period),
    crm: 0,
    hrId: employee.hrId,
    employmentIncomeTax: 0,
    expenses: 0,
    extraCostOfLiving,
    fingerPrint: 0,
    firstPart: 0,
    fuelAllowance,
    governmentalDeductions: 0,
    fullName: employee.fullName,
    grossSalary: baseSalary,
    hireDate: employee.hireDate,
    incentive: 0,
    jobTitle: employee.jobTitle ?? "Unassigned",
    line: employee.lineName ?? "Unassigned",
    loans: 0,
    medicalInsurance: 0,
    monthSalary: release,
    nameAr: employee.nameAr,
    netSalary: roundCurrency(baseSalary + extraCostOfLiving + fuelAllowance),
    otherAdditions: release,
    otherDeductions: 0,
    overtime: 0,
    // The marker the Statutory Summary reads to keep this row out of the month's insured payroll.
    payrollComment: HELD_RELEASE_ONLY_COMMENT,
    paymentMode: normalizePayrollPaymentMode(source?.paymentMode ?? "two_parts"),
    row: input.index + 1,
    secondPart: release,
    socialInsurance: 0,
    totalAdditions: roundCurrency(extraCostOfLiving + fuelAllowance + release),
    totalDeductions: 0,
    unpaidVacations: 0,
    workingDays: 0,
  };
  return {
    row,
    compact: member.compact,
    onHold: false,
    overpaidResidual: 0,
    totalPayable: release,
    carriedForwardApplied: 0,
    heldReleaseApplied: release,
    payDeferralApplied: 0,
    // Paid nothing in Part 1 by construction (firstPart 0), so there was nothing to withhold.
    part1Withheld: false,
    lifecycle: member.lifecycle,
    bankName: employee.bankName ?? null,
    bankAccount: employee.bankAccount ?? null,
  };
}

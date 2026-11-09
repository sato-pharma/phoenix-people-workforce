import assert from "node:assert/strict";

import { assembleRows, settlementBasisFor } from "../src/lib/automated-payroll/assemble.ts";
import type { PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import {
  ADDITION_COMPONENT_KEYS,
  DEDUCTION_COMPONENT_KEYS,
  WORKED_NET_COMPONENT_KEYS,
  computeSettlementSummary,
} from "../src/lib/automated-payroll/settlement-summary.ts";
import { STEP_DEFINITIONS } from "../src/lib/automated-payroll/step-definitions.ts";
import type {
  DraftRow,
  PayrollPeriod,
  RowLifecycle,
  StepKey,
} from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { roundCurrency } from "../src/lib/payroll/money.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";

/**
 * Guards the FOUR FIGURES the owner asked to see on every screen of the
 * Automated Payroll sheet (2026-08-30): full month net, working-days net, total
 * deducted, and net payable — recomputed live as he edits.
 *
 * He asked for it with a screenshot of the Windows calculator showing
 * 612.9032258064516 x 5. The sheet was showing him fragments and leaving the
 * arithmetic to him, on a payroll that pays real people.
 *
 * TWO THINGS CAN GO WRONG HERE, and both are silent, so both are the headline:
 *
 *  1. THE SUMMARY DISAGREES WITH WHAT IS ACTUALLY PAID. Payable is the whole
 *     month across all sixteen steps, and that arithmetic already exists in
 *     assembleRows. So this test runs the summary and assembleRows over the SAME
 *     inputs and asserts the three derived figures match to the cent. A
 *     deduction added to payroll but not to DEDUCTION_COMPONENT_KEYS would
 *     overstate everybody's take-home on screen while the bank paid something
 *     else — that is what this catches. Every component below is non-zero and
 *     DISTINCT, so a missing one and a double-counted one both move the total.
 *
 *  2. THE FIGURES FREEZE. A summary that does not follow the edit is worthless
 *     precisely when HR is revising — the same defect that retired the "This
 *     Month Net" context column on the New hires step. So the second headline
 *     asserts payable MOVES, by exactly the right amount, and that a step only
 *     overlays the boxes it actually declares.
 */

const AUGUST: PayrollPeriod = { month: 8, year: 2026 };

const BASE = 30000;
const ECOL = 1000;
const FUEL = 500;
const NET = 31500;

function employee(hrId: string, medicalInsurance: number): EmployeeDirectoryRow {
  // Only the fields the basis and assembleRows actually read.
  return {
    hrId,
    fullName: `Employee ${hrId}`,
    nameAr: null,
    jobTitle: "Medical Representative",
    lineName: "Anti Infective",
    areaName: "Cairo",
    hireDate: "2024-01-01",
    medicalInsurance,
    bankName: "NBE",
    bankAccount: "123456",
    // Resignation Rule 1's generosity is scoped to genuine resignations; a dismissal keeps neither
    // allowance. Every fixture in this file models someone who chose to leave.
    employmentStatus: "resigned",
    lastWorkingDate: null,
  } as unknown as EmployeeDirectoryRow;
}

function compact(hrId: string): string {
  return hrId.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function member(
  hrId: string,
  opts: { lifecycle?: RowLifecycle; medicalInsurance?: number; lastWorkingDate?: string | null } = {},
): PopulationMember {
  return {
    employee: employee(hrId, opts.medicalInsurance ?? 0),
    compact: compact(hrId),
    lifecycle: opts.lifecycle ?? "regular",
    lastWorkingDate: opts.lastWorkingDate ?? null,
    noticeLastWorkingDate: null,
  };
}

function sourceMap(hrId: string, paymentMode: "one_part" | "two_parts"): Map<string, PayrollSalarySource> {
  const source: PayrollSalarySource = {
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    netSalary: NET,
    grossSalary: BASE,
    socialInsurance: 0,
    employmentIncomeTax: 0,
    paymentMode,
  };
  const map = new Map<string, PayrollSalarySource>();
  map.set(hrId.toLowerCase(), source);
  map.set(compact(hrId), source);
  return map;
}

function draft(hrId: string, patch: Partial<DraftRow>): DraftRow {
  return {
    runId: "run-1",
    employeeHrId: hrId,
    employeeHrIdCompact: compact(hrId),
    daysWorked: null,
    baseForMonth: null,
    ecolPaid: null,
    fuelPaid: null,
    fingerprintDays: null,
    fingerprintValue: null,
    expenses: null,
    expensesNote: null,
    incentive: null,
    bonus: null,
    overtime: null,
    unpaidVacations: null,
    crm: null,
    manualOtherDeductions: null,
    manualReason: null,
    additionsReason: null,
    resignationCrmDays: null,
    p1odCrmDays: null,
    p1odCrmValue: null,
    p1odCrmReason: null,
    p1odVacationDays: null,
    p1odVacationValue: null,
    p1odVacationReason: null,
    p1odNoRecordDays: null,
    p1odNoRecordValue: null,
    p1odNoRecordReason: null,
    p1odLoanDays: null,
    p1odLoanValue: null,
    p1odLoanReason: null,
    p1odOtherDays: null,
    p1odOtherValue: null,
    p1odOtherReason: null,
    specialDeductionDays: null,
    specialDeductionValue: null,
    specialAdditionDays: null,
    specialAdditionValue: null,
    specialSituationPart: null,
    firstPartFrozen: null,
    // Not frozen: these fixtures stand before Part 1 confirm, so the live rule still answers.
    settledInPart1: null,
    onHold: false,
    holdReason: null,
    excluded: false,
    excludedReason: null,
    source: "inline",
    editedBy: null,
    updatedAt: "",
    ...patch,
  };
}

export function runAutomatedPayrollSettlementSummaryTests() {
  // ---- 1. HEADLINE: the summary equals what actually gets paid ---------------
  //
  // Every money column non-zero and DISTINCT, so any component omitted from the
  // classification lists — or counted twice — shifts the total by a unique
  // amount and cannot cancel out against another.

  const hrId = "B-1";
  const carriedForward = 175;
  const patch: Partial<DraftRow> = {
    fingerprintValue: 111,
    crm: 222,
    unpaidVacations: 333,
    p1odCrmValue: 444,
    p1odVacationValue: 555,
    p1odNoRecordValue: 666,
    p1odLoanValue: 777,
    p1odOtherValue: 888,
    manualOtherDeductions: 999,
    specialDeductionValue: 121,
    specialAdditionValue: 131,
    specialSituationPart: "second",
    expenses: 1400,
    incentive: 1500,
    bonus: 1600,
    overtime: 1700,
  };
  const medicalInsurance = 400;
  const one = member(hrId, { medicalInsurance });
  const carryForwardByCompact = new Map([[one.compact, carriedForward]]);

  const [assembled] = assembleRows({
    members: [one],
    sources: sourceMap(hrId, "two_parts"),
    period: AUGUST,
    draftRows: [draft(hrId, patch)],
    carryForwardByCompact,
  });
  assert.ok(assembled, "assembleRows must produce the canonical row to reconcile against");

  const basis = settlementBasisFor({
    member: one,
    source: sourceMap(hrId, "two_parts").get(compact(hrId)),
    draft: draft(hrId, patch),
    period: AUGUST,
    carriedForward,
  });

  // Read on a screen that edits none of these, so nothing is overlaid and the
  // summary is purely what the server holds — the exact state assembleRows sees.
  const holds = STEP_DEFINITIONS.p1_holds;
  const saved = computeSettlementSummary(basis, holds, {});
  assert.ok(saved, "a row with a basis must produce a summary");

  assert.equal(
    saved.workedNet,
    assembled.row.netSalary,
    "Working Days Net must equal the net that is actually paid — Base + Extra Cost of Living + Fuel, prorated",
  );
  assert.equal(
    saved.deductions,
    assembled.row.totalDeductions,
    "Total Deductions must equal the row's real total — a component missing from DEDUCTION_COMPONENT_KEYS " +
      "would overstate take-home on screen while the bank paid something else",
  );
  // totalPayable, recovered from the assembled row: monthSalary is firstPart +
  // secondPart, which equals totalPayable except when Part-2 deductions
  // overshot the already-paid first installment, and then the excess is exactly
  // overpaidResidual.
  assert.equal(
    saved.payable,
    roundCurrency(assembled.row.monthSalary - assembled.overpaidResidual),
    "Net Payable must equal the locked engine's totalPayable for the same employee",
  );
  assert.equal(saved.monthNet, NET, "Full Month Net is the contractual month, never prorated");

  // The arithmetic, spelled out, so a future reader can check it by hand:
  // deductions 111+222+333+400+444+555+666+777+888+999+121+175 = 5691.
  assert.equal(saved.deductions, 5691, "the twelve deduction components, each counted exactly once");
  assert.equal(saved.additions, 1400 + 1500 + 1600 + 1700 + 131, "the five addition components");
  assert.equal(saved.payable, roundCurrency(NET + 6331 - 5691), "payable = worked net + additions − deductions");

  // ---- 2. every editable money box on every step moves one component --------
  //
  // The overlay is by KEY: a step field named for a column that is in no
  // classification list would be typed into and change nothing on the summary,
  // which reads as the figures being frozen.

  const classified = new Set<string>([
    ...WORKED_NET_COMPONENT_KEYS,
    ...ADDITION_COMPONENT_KEYS,
    ...DEDUCTION_COMPONENT_KEYS,
  ]);
  const unclassified: string[] = [];
  for (const [stepKey, definition] of Object.entries(STEP_DEFINITIONS)) {
    for (const field of definition.fields) {
      // A field that saves no draft column (Held Salary Release's Part 1 Not Paid, which is a record
      // against an EARLIER month) is no component of this month, so it has nothing to move.
      if (field.kind !== "money" || field.notPersisted) continue;
      if (!classified.has(field.key)) unclassified.push(`${stepKey}.${field.key}`);
    }
  }
  assert.deepEqual(
    unclassified,
    [],
    "every editable money field must map to a settlement component, or typing in that box moves no figure in the summary",
  );

  // ---- 3. HEADLINE: the figures follow the edit ------------------------------

  const p2Crm = STEP_DEFINITIONS.p2_crm;
  const onLoad = computeSettlementSummary(basis, p2Crm, { crm: 222 });
  assert.ok(onLoad);
  assert.equal(onLoad.payable, saved.payable, "before any edit the screen agrees with the saved state");

  // HR corrects the CRM deduction from 222 to 1222 — not saved yet, just typed.
  const afterEdit = computeSettlementSummary(basis, p2Crm, { crm: 1222 });
  assert.ok(afterEdit);
  assert.equal(
    afterEdit.deductions,
    saved.deductions + 1000,
    "an extra 1000 of CRM deduction must appear in Total Deductions immediately",
  );
  assert.equal(
    afterEdit.payable,
    roundCurrency(saved.payable - 1000),
    "and must come straight off Net Payable — the figure has to MOVE, or it is worthless exactly when it is being read",
  );
  assert.notEqual(afterEdit.payable, onLoad.payable, "the payable must not stay at the loaded figure");

  // ---- 4. a step only overlays the boxes it declares -------------------------
  //
  // Every screen shows the same whole-month figures, so a stray value in
  // `row.values` must not be read as a component the step does not edit —
  // otherwise two screens would show the same employee two different payables.

  const fingerprint = STEP_DEFINITIONS.p1_fingerprint;
  assert.equal(
    fingerprint.fields.some((field) => field.key === "crm"),
    false,
    "precondition: the fingerprint step does not edit crm",
  );
  const elsewhere = computeSettlementSummary(basis, fingerprint, { crm: 999999 });
  assert.ok(elsewhere);
  assert.equal(
    elsewhere.deductions,
    saved.deductions,
    "a step must ignore a value for a component it does not declare — the saved figure is the one that counts",
  );

  // ---- 5. the two net lines diverge exactly where they should ----------------

  assert.equal(
    saved.monthNet,
    saved.workedNet,
    "for a full-month employee the two net lines are the same number, and that is correct, not a bug",
  );

  // A leaver who last worked 10 August: on or before the 25th, so the whole net
  // prorates to the days worked (owner rule 2026-08-29).
  const leaverId = "B-2";
  const leaver = member(leaverId, { lifecycle: "leaver", lastWorkingDate: "2026-08-10" });
  const leaverBasis = settlementBasisFor({
    member: leaver,
    source: sourceMap(leaverId, "two_parts").get(compact(leaverId)),
    draft: undefined,
    period: AUGUST,
  });
  const leaverSummary = computeSettlementSummary(leaverBasis, holds, {});
  assert.ok(leaverSummary);
  assert.equal(leaverSummary.monthNet, NET, "a leaver's contractual month is unchanged");
  assert.equal(
    leaverSummary.workedNet,
    10161.29,
    "10 of 31 days: 9677.42 + 322.58 + 161.29 — each component rounded to cents, then summed",
  );
  assert.equal(
    leaverSummary.payable,
    10161.29,
    "with nothing deducted, a leaver takes home exactly the prorated net",
  );
  assert.notEqual(
    leaverSummary.workedNet,
    leaverSummary.monthNet,
    "THE WHOLE POINT of showing both: for a leaver they differ, and that gap is what HR is checking",
  );

  // ---- 6. a payslip never goes negative -------------------------------------

  const brokeId = "B-3";
  const broke = member(brokeId, {});
  const brokeBasis = settlementBasisFor({
    member: broke,
    source: sourceMap(brokeId, "two_parts").get(compact(brokeId)),
    draft: draft(brokeId, { manualOtherDeductions: 999999 }),
    period: AUGUST,
  });
  const brokeSummary = computeSettlementSummary(brokeBasis, holds, {});
  assert.ok(brokeSummary);
  assert.equal(
    brokeSummary.payable,
    0,
    "deductions beyond the net floor payable at zero, matching the locked engine — the excess is carried, never billed",
  );

  // ---- 7. no basis renders nothing, not a confident zero --------------------

  assert.equal(
    computeSettlementSummary(undefined, holds, {}),
    null,
    "a row with no settlement basis must produce no summary — on a payroll screen a missing figure is safer than a " +
      "zero, which is a number HR can act on",
  );

  // ---- 8. the summary is available on every step, holds included ------------

  for (const stepKey of Object.keys(STEP_DEFINITIONS) as StepKey[]) {
    const summary = computeSettlementSummary(basis, STEP_DEFINITIONS[stepKey], {});
    assert.ok(summary, `every screen must be able to show the four figures — ${stepKey} could not`);
    assert.equal(
      summary.monthNet,
      NET,
      `the same employee must show the same full month net on every screen — ${stepKey} disagreed`,
    );
  }

  // ---- 9. October 2026: Part 2 takes no medical insurance from a two-part employee ----
  //
  // Owner, 2026-11-09: "only in oct 2026 payroll part 2 remove all the medical insurance
  // deduction" — two-part only, by his choice. A one-part employee's medical left with the paid
  // Part 1 and stays taken; every other month is untouched.

  const OCTOBER: PayrollPeriod = { month: 10, year: 2026 };
  const NOVEMBER: PayrollPeriod = { month: 11, year: 2026 };
  const assembleOne = (mode: "one_part" | "two_parts", period: PayrollPeriod) => {
    const insured = member("B-9", { medicalInsurance: 250 });
    const [row] = assembleRows({
      members: [insured],
      sources: sourceMap("B-9", mode),
      period,
      draftRows: [draft("B-9", {})],
    });
    const basisFor = settlementBasisFor({
      member: insured,
      source: sourceMap("B-9", mode).get(compact("B-9")),
      draft: draft("B-9", {}),
      period,
    });
    assert.ok(row);
    return { row: row.row, basis: basisFor };
  };

  const octTwoPart = assembleOne("two_parts", OCTOBER);
  assert.equal(octTwoPart.row.medicalInsurance, 0, "October 2026 Part 2 must charge a two-part employee no medical insurance");
  assert.equal(octTwoPart.row.totalDeductions, 0, "the waived medical must leave October's deductions, not just its column");
  assert.equal(octTwoPart.row.monthSalary, NET, "a two-part employee's October is paid in full, medical not taken");
  assert.equal(
    octTwoPart.basis.components.medicalInsurance,
    0,
    "the on-screen summary must waive the same medical the paid row waives",
  );

  const octOnePart = assembleOne("one_part", OCTOBER);
  assert.equal(
    octOnePart.row.medicalInsurance,
    250,
    "a one-part employee's October medical was taken with the paid Part 1 and stays taken",
  );

  const novTwoPart = assembleOne("two_parts", NOVEMBER);
  assert.equal(novTwoPart.row.medicalInsurance, 250, "November charges medical insurance exactly as before");
  assert.equal(novTwoPart.row.monthSalary, NET - 250, "November's two-part pay still loses the medical");
}

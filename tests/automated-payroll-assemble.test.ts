import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assembleRows, computePart1Freeze, type AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import type { PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import { reconcile } from "../src/lib/automated-payroll/reconcile.ts";
import { OVERPAID_ACK_REQUIRED } from "../src/lib/automated-payroll/run-service.ts";
import type { DraftRow, PayrollPeriod, RowLifecycle } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Covers `assembleRows()` (builds the canonical payroll row) and `reconcile()`
 * (the accuracy net) — the two highest-risk untested functions in the module
 * per the 2026-07-25 audit.
 *
 * The headline assertion is DEDUCTION-COUNTED-ONCE. A 4-tab refactor plus a new
 * eligibility rule once passed the entire 428-file suite while carrying a live
 * double-deduction bug, because nothing exercised this function. Asserting the
 * exact expected total is precisely the "each deduction lands exactly once"
 * check: any component counted twice makes the number bigger, and this fails.
 */

const JUNE: PayrollPeriod = { month: 6, year: 2026 };

const BASE = 30000;
const ECOL = 1000;
const FUEL = 500;
const NET = 31500;

function employee(hrId: string, medicalInsurance: number): EmployeeDirectoryRow {
  // Only the fields assembleRows actually reads; cast keeps the fixture honest
  // and small rather than restating ~60 unrelated directory columns.
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

function member(hrId: string, opts: { lifecycle?: RowLifecycle; medicalInsurance?: number } = {}): PopulationMember {
  return {
    employee: employee(hrId, opts.medicalInsurance ?? 0),
    compact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    lifecycle: opts.lifecycle ?? "regular",
    lastWorkingDate: null,
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
  map.set(hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""), source);
  return map;
}

function draft(hrId: string, patch: Partial<DraftRow>): DraftRow {
  return {
    runId: "run-1",
    employeeHrId: hrId,
    employeeHrIdCompact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
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

export function runAutomatedPayrollAssembleTests() {
  // ---- DEDUCTION COUNTED ONCE -----------------------------------------------
  // Every distinct deduction column, all non-zero and all DIFFERENT values so a
  // double-count of any single one is arithmetically visible in the total.
  const hrId = "B-1";
  const rows = assembleRows({
    members: [member(hrId, { medicalInsurance: 400 })],
    sources: sourceMap(hrId, "two_parts"),
    period: JUNE,
    draftRows: [
      draft(hrId, {
        fingerprintValue: 100,
        // Part 1 manual tabs (p1od* columns) — a DIFFERENT set of columns from
        // the Part 2 crm/unpaidVacations below. Both are summed by design; the
        // populations are kept disjoint by isSettledInPart1, not by the math.
        p1odCrmValue: 200,
        p1odVacationValue: 300,
        p1odLoanValue: 400,
        // Part 2 automatic steps.
        crm: 50,
        unpaidVacations: 60,
        manualOtherDeductions: 70,
        // Special Situations, routed to Second Part.
        specialDeductionValue: 80,
        specialSituationPart: "second",
      }),
    ],
  });
  assert.equal(rows.length, 1);
  const row = rows[0]!.row;

  // THE LOANS COLUMN IS THE PART-1 LOAN (owner, 2026-10-09). It was `const loans = 0` with the
  // money folded into Other Deductions, so the September 2026 sheet showed zeros down the whole
  // Loans column while Mahmoud Ibrahim Ahmed Mohamed (A-1) 1,250.00 and Muhammad AlMinshawy
  // (B-148) 725.01 sat under Other Deductions with nothing to explain them.
  //
  // otherDeductions = manual(70) + p1od EXCEPT the loan(200+300=500) + special(80)
  assert.equal(row.otherDeductions, 650, "otherDeductions must count each source exactly once");
  assert.equal(row.loans, 400, "and the Part-1 loan must appear in the Loans column it belongs to");
  // totalDeductions = crm(50) + fingerprint(100) + vacation(60) + medical(400) + loans(400) + other(650)
  //
  // 🔴 STILL 1660 — the figure it was before the loan moved column. That is the whole point: the
  // loan is counted once, and splitting the presentation moves no money. Counting it in BOTH
  // columns would read 2060 here.
  assert.equal(row.totalDeductions, 1660, "totalDeductions must count each deduction exactly once");
  assert.equal(
    row.loans + row.otherDeductions,
    1050,
    "the two columns together must still equal what Other Deductions alone used to carry",
  );
  // Individually surfaced columns keep their own values (not folded into other).
  assert.equal(row.fingerPrint, 100);
  assert.equal(row.crm, 50);
  assert.equal(row.unpaidVacations, 60);
  assert.equal(row.medicalInsurance, 400);

  // ---- the split always balances -------------------------------------------
  assert.equal(row.firstPart + row.secondPart, row.monthSalary, "First + Second must equal Month Salary");

  // ---- THE LOANS COLUMN MOVES NO MONEY (owner, 2026-10-09) -------------------
  // The strongest statement of that, without a magic number to maintain: take the SAME amount and
  // put it once in the Part-1 Loan column and once in the Part-1 Other column. Only the column
  // showing it may differ — the First Part, Second Part, Month Salary and Total Deductions must be
  // identical, because `otherPart1DeductionsTotal` still carries the loan and that total is what
  // `freezeFirstPart` takes off the First Part. Part 1 is left OPEN here on purpose, so the First
  // Part is computed live and any change in the freeze math shows up instead of being hidden by a
  // frozen column.
  const asLoan = assembleRows({
    members: [member("B-5")],
    sources: sourceMap("B-5", "two_parts"),
    period: JUNE,
    draftRows: [draft("B-5", { p1odLoanValue: 1250 })],
  })[0]!.row;
  const asOther = assembleRows({
    members: [member("B-5")],
    sources: sourceMap("B-5", "two_parts"),
    period: JUNE,
    draftRows: [draft("B-5", { p1odOtherValue: 1250 })],
  })[0]!.row;
  assert.equal(asLoan.loans, 1250, "the loan shows in the Loans column");
  assert.equal(asLoan.otherDeductions, 0, "and not a second time under Other Deductions");
  assert.equal(asOther.loans, 0, "an Other-column deduction is not a loan");
  assert.equal(asOther.otherDeductions, 1250);
  assert.equal(
    asLoan.totalDeductions,
    asOther.totalDeductions,
    "the same amount must deduct the same whichever Part-1 column holds it",
  );
  assert.equal(
    asLoan.firstPart,
    asOther.firstPart,
    "🔴 THE FROZEN FIRST PART MUST NOT MOVE — the loan stays inside otherPart1DeductionsTotal, " +
      "which is what freezeFirstPart takes off; dropping it from there would change money that " +
      "has already been paid out",
  );
  assert.equal(asLoan.secondPart, asOther.secondPart, "nor the Second Part");
  assert.equal(asLoan.monthSalary, asOther.monthSalary, "nor the month");
  assert.equal(
    asLoan.firstPart + asLoan.secondPart,
    asLoan.monthSalary,
    "and the split still balances with the loan in its own column",
  );

  // ---- additions counted once too ------------------------------------------
  const withAdditions = assembleRows({
    members: [member(hrId)],
    sources: sourceMap(hrId, "two_parts"),
    period: JUNE,
    draftRows: [
      draft(hrId, {
        expenses: 1000,
        incentive: 2000,
        bonus: 300,
        overtime: 400,
        specialAdditionValue: 500,
        specialSituationPart: "second",
      }),
    ],
  });
  const additionsRow = withAdditions[0]!.row;
  assert.equal(additionsRow.otherAdditions, 500, "special addition lands in otherAdditions exactly once");
  // totalAdditions = expenses+incentive+overtime+bonus+ecol+fuel+otherAdditions
  assert.equal(additionsRow.totalAdditions, 1000 + 2000 + 400 + 300 + ECOL + FUEL + 500);
  assert.equal(additionsRow.firstPart + additionsRow.secondPart, additionsRow.monthSalary);

  // ---- a frozen First Part is honoured verbatim, never recomputed -----------
  // (the module's core invariant: money already disbursed cannot move)
  const frozen = assembleRows({
    members: [member(hrId)],
    sources: sourceMap(hrId, "two_parts"),
    period: JUNE,
    draftRows: [draft(hrId, { firstPartFrozen: 12345, fingerprintValue: 999 })],
  });
  assert.equal(frozen[0]!.row.firstPart, 12345, "a frozen First Part must be used as-is");

  // ---- held employees still compute a full row (excluded only at publish) ---
  const held = assembleRows({
    members: [member(hrId)],
    sources: sourceMap(hrId, "two_parts"),
    period: JUNE,
    draftRows: [draft(hrId, { onHold: true, holdReason: "pending investigation" })],
  });
  assert.equal(held[0]!.onHold, true);
  assert.equal(held[0]!.row.monthSalary > 0, true, "a held employee still carries computed amounts");

  // ---- reconcile: a balanced run reports no problems ------------------------
  const clean = reconcile(rows);
  assert.equal(clean.headcount, 1);
  assert.deepEqual(clean.splitMismatches, [], "a balanced run must report no split mismatches");
  assert.deepEqual(clean.overpaid, [], "a run with no residual must report no overpaid rows");
  assert.equal(clean.totalFirstPart + clean.totalSecondPart, clean.totalMonthSalary);

  // ---- reconcile: DETECTS a broken split (its comment says this can only mean
  // a code bug, so it must never silently pass) ------------------------------
  const brokenSplit: AssembledRow = {
    ...rows[0]!,
    row: { ...rows[0]!.row, firstPart: 100, secondPart: 100, monthSalary: 999 },
  };
  const brokenTotals = reconcile([brokenSplit]);
  assert.equal(brokenTotals.splitMismatches.length, 1, "reconcile must catch First+Second != Month");
  assert.equal(brokenTotals.splitMismatches[0]?.hrId, hrId);

  // ---- reconcile: DETECTS an overpaid row ----------------------------------
  const overpaidRow: AssembledRow = { ...rows[0]!, overpaidResidual: 250 };
  const overpaidTotals = reconcile([overpaidRow]);
  assert.equal(overpaidTotals.overpaid.length, 1, "reconcile must surface a Part-1 overpayment");
  assert.equal(overpaidTotals.overpaid[0]?.residual, 250);

  // ---- reconcile: counts lifecycle + payment mode correctly ------------------
  const mixed = reconcile([
    { ...rows[0]!, lifecycle: "joiner" },
    { ...rows[0]!, lifecycle: "leaver", onHold: true },
    { ...rows[0]!, row: { ...rows[0]!.row, paymentMode: "one_part" } },
  ]);
  assert.equal(mixed.headcount, 3);
  assert.equal(mixed.joiners, 1);
  assert.equal(mixed.leavers, 1);
  assert.equal(mixed.held, 1);
  assert.equal(mixed.oneParts, 1);
  assert.equal(mixed.twoParts, 2);

  // ---- CARRY-FORWARD: a previous month's overpayment is recovered here ------
  // (owner decision 2026-07-25 — carry forward rather than silently write off)
  const carried = assembleRows({
    members: [member(hrId)],
    sources: sourceMap(hrId, "two_parts"),
    period: JUNE,
    draftRows: [draft(hrId, { manualOtherDeductions: 70 })],
    carryForwardByCompact: new Map([[member(hrId).compact, 500]]),
  });
  const carriedRow = carried[0]!;
  assert.equal(carriedRow.carriedForwardApplied, 500, "the recovered amount must be surfaced on its own");
  // Counted exactly ONCE, inside otherDeductions alongside the manual 70.
  assert.equal(carriedRow.row.otherDeductions, 570, "carry-forward lands in otherDeductions exactly once");
  assert.equal(
    carriedRow.row.totalDeductions,
    570,
    "carry-forward must not be double-counted between otherDeductions and totalDeductions",
  );
  assert.equal(carriedRow.row.firstPart + carriedRow.row.secondPart, carriedRow.row.monthSalary);

  // An employee with no outstanding balance is completely unaffected.
  const notCarried = assembleRows({
    members: [member("B-2")],
    sources: sourceMap("B-2", "two_parts"),
    period: JUNE,
    draftRows: [draft("B-2", { manualOtherDeductions: 70 })],
    carryForwardByCompact: new Map([[member(hrId).compact, 500]]),
  });
  assert.equal(notCarried[0]!.carriedForwardApplied, 0);
  assert.equal(notCarried[0]!.row.otherDeductions, 70, "an unrelated employee must not absorb someone else's debt");

  // Omitting the map entirely (e.g. the Part-1 freeze pass) recovers nothing.
  assert.equal(rows[0]!.carriedForwardApplied, 0, "no carry-forward map means nothing is recovered");

  // A HELD row recovers nothing: its withheld Second Part is paid later as recorded, and publish
  // leaves the ledger open for a held row, so a debt taken here was taken twice (audit 2026-11-07).
  const heldWithDebt = assembleRows({
    members: [member(hrId)],
    sources: sourceMap(hrId, "two_parts"),
    period: JUNE,
    draftRows: [draft(hrId, { onHold: true, holdReason: "pending investigation", manualOtherDeductions: 70 })],
    carryForwardByCompact: new Map([[member(hrId).compact, 500]]),
  });
  assert.equal(heldWithDebt[0]!.carriedForwardApplied, 0, "HEADLINE: a held row must not recover a debt the ledger keeps open");
  assert.equal(heldWithDebt[0]!.row.otherDeductions, 70, "and its withheld pay carries only its own deductions");

  // A ONE-PART row recovers its debt from the First Part — the only instalment it is paid (audit
  // 2026-11-07). Taken only in Part 2, it met a Second Part of zero and rolled forward for ever.
  const onePartDebt = new Map([[member(hrId).compact, 800]]);
  const onePartFreeze = computePart1Freeze({
    members: [member(hrId)],
    sources: sourceMap(hrId, "one_part"),
    draftRows: [draft(hrId, {})],
    period: JUNE,
    carryForwardByCompact: onePartDebt,
  }).get(member(hrId).compact)!;
  const onePartNoDebt = computePart1Freeze({
    members: [member(hrId)],
    sources: sourceMap(hrId, "one_part"),
    draftRows: [draft(hrId, {})],
    period: JUNE,
  }).get(member(hrId).compact)!;
  assert.equal(
    onePartFreeze.firstPart,
    onePartNoDebt.firstPart - 800,
    "HEADLINE: a one-part employee's debt comes off the First Part that actually pays them",
  );
  const onePartPaid = assembleRows({
    members: [member(hrId)],
    sources: sourceMap(hrId, "one_part"),
    period: JUNE,
    draftRows: [draft(hrId, { firstPartFrozen: onePartFreeze.firstPart })],
    carryForwardByCompact: onePartDebt,
    part1Confirmed: true,
  })[0]!;
  assert.equal(onePartPaid.carriedForwardApplied, 800, "the ledger is settled at publish as before");
  assert.equal(onePartPaid.overpaidResidual, 0, "and the debt is NOT recorded again as this month's overpayment");
  assert.equal(onePartPaid.row.firstPart + onePartPaid.row.secondPart, onePartPaid.row.monthSalary);
  // A two-part row keeps recovering in Part 2: its freeze is untouched by the ledger.
  const twoPartFreeze = computePart1Freeze({
    members: [member(hrId)],
    sources: sourceMap(hrId, "two_parts"),
    draftRows: [draft(hrId, {})],
    period: JUNE,
    carryForwardByCompact: onePartDebt,
  }).get(member(hrId).compact)!;
  const twoPartNoDebt = computePart1Freeze({
    members: [member(hrId)],
    sources: sourceMap(hrId, "two_parts"),
    draftRows: [draft(hrId, {})],
    period: JUNE,
  }).get(member(hrId).compact)!;
  assert.equal(twoPartFreeze.firstPart, twoPartNoDebt.firstPart, "a two-part First Part never carries the debt");

  // A month base saved by New Hires or Resignations holds only while the person is still a joiner or
  // leaver this month (audit 2026-11-07): a corrected hire date used to keep paying the old fraction.
  const prorated = { baseForMonth: 10000, ecolPaid: 0, fuelPaid: 0 };
  const stillJoiner = assembleRows({
    members: [member(hrId, { lifecycle: "joiner" })],
    sources: sourceMap(hrId, "two_parts"),
    period: JUNE,
    draftRows: [draft(hrId, prorated)],
  })[0]!;
  assert.equal(stillJoiner.row.monthSalary, 10000, "a joiner is paid the month figure HR settled");
  const noLongerJoiner = assembleRows({
    members: [member(hrId, { lifecycle: "regular" })],
    sources: sourceMap(hrId, "two_parts"),
    period: JUNE,
    draftRows: [draft(hrId, prorated)],
  })[0]!;
  assert.equal(noLongerJoiner.row.monthSalary, NET, "HEADLINE: once not a joiner, the stale fraction no longer applies");

  // A negative/corrupt ledger value can never become a stealth ADDITION.
  const negativeLedger = assembleRows({
    members: [member(hrId)],
    sources: sourceMap(hrId, "two_parts"),
    period: JUNE,
    draftRows: [draft(hrId, {})],
    carryForwardByCompact: new Map([[member(hrId).compact, -900]]),
  });
  assert.equal(negativeLedger[0]!.carriedForwardApplied, 0, "a negative balance must clamp to 0, never pay the employee");
  assert.equal(negativeLedger[0]!.row.otherDeductions, 0);

  // ---- CANCEL MUST NOT FORGIVE DEBT ----------------------------------------
  // A run whose Part 2 was confirmed has already marked previous months'
  // overpayments as recovered. Cancelling it (a `ready` run IS cancellable —
  // assertActiveRun only blocks published/cancelled) must hand those balances
  // back, or the company writes off money it collected from nobody. This pins
  // the CONTRACT: cancelRun has to consult the ledger at all. The two-way
  // behaviour (release consumed + discard created) is exercised against the
  // real table by the staging smoke test, since it is pure SQL.
  const cancelSource = readFileSync(
    new URL("../src/lib/automated-payroll/run-service.ts", import.meta.url),
    "utf8",
  );
  const cancelBodyRaw = cancelSource.slice(
    cancelSource.indexOf("export async function cancelRun"),
    cancelSource.indexOf("// ---- Per-step recommend"),
  );
  assert.ok(cancelBodyRaw.length > 0, "cancelRun body must be locatable — update these markers if it moved");
  // Strip comments FIRST. Matching the bare function name would also match the
  // explanatory comment inside cancelRun, so removing the real call would still
  // pass — verified: it did. Assert on the executable call only.
  const cancelBody = stripComments(cancelBodyRaw);
  assert.ok(
    cancelBody.includes("await releaseCarryForwardForCancelledRun("),
    "cancelRun must actually CALL releaseCarryForwardForCancelledRun — otherwise cancelling after Part 2 confirm silently forgives recovered debt",
  );
  assert.ok(
    cancelBody.indexOf("await releaseCarryForwardForCancelledRun(") < cancelBody.indexOf('phase: "cancelled"'),
    "the ledger must be released BEFORE the run is marked cancelled",
  );

  // ---- the Part-2 gate marker is a STABLE contract between run-service and the
  // API route. The route keys the "prompt HR to acknowledge" branch off this
  // exact token; renaming it silently downgrades the overpayment gate into a
  // plain red error that HR can never get past. -------------------------------
  assert.equal(typeof OVERPAID_ACK_REQUIRED, "string");
  assert.equal(OVERPAID_ACK_REQUIRED.length > 0, true);
  assert.equal(
    OVERPAID_ACK_REQUIRED,
    "[overpaid-acknowledgment-required]",
    "changing this marker breaks the route's acknowledgment branch — update both together",
  );
}

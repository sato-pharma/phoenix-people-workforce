import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assembleRows, type AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import type { PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import { reconcile } from "../src/lib/automated-payroll/reconcile.ts";
import { OVERPAID_ACK_REQUIRED } from "../src/lib/automated-payroll/run-service.ts";
import type { DraftRow, PayrollPeriod, RowLifecycle } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";

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
    lastWorkingDate: null,
  } as unknown as EmployeeDirectoryRow;
}

function member(hrId: string, opts: { lifecycle?: RowLifecycle; medicalInsurance?: number } = {}): PopulationMember {
  return {
    employee: employee(hrId, opts.medicalInsurance ?? 0),
    compact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    lifecycle: opts.lifecycle ?? "regular",
    lastWorkingDate: null,
    unpaidDaysInSpan: 0,
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
    baseForMonth: null,
    ecolPaid: null,
    fuelPaid: null,
    fingerprintDays: null,
    fingerprintValue: null,
    expenses: null,
    incentive: null,
    bonus: null,
    overtime: null,
    unpaidVacations: null,
    crm: null,
    manualOtherDeductions: null,
    manualReason: null,
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
    onHold: false,
    holdReason: null,
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

  // otherDeductions = manual(70) + p1od total(200+300+400=900) + special(80)
  assert.equal(row.otherDeductions, 1050, "otherDeductions must count each source exactly once");
  // totalDeductions = crm(50) + fingerprint(100) + vacation(60) + medical(400) + loans(0) + other(1050)
  assert.equal(row.totalDeductions, 1660, "totalDeductions must count each deduction exactly once");
  // Individually surfaced columns keep their own values (not folded into other).
  assert.equal(row.fingerPrint, 100);
  assert.equal(row.crm, 50);
  assert.equal(row.unpaidVacations, 60);
  assert.equal(row.medicalInsurance, 400);

  // ---- the split always balances -------------------------------------------
  assert.equal(row.firstPart + row.secondPart, row.monthSalary, "First + Second must equal Month Salary");

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
  const cancelBody = cancelBodyRaw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
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

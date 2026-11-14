import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assembleRows } from "../src/lib/automated-payroll/assemble.ts";
import { heldForScope } from "../src/lib/automated-payroll/exports/bank-coverage.ts";
import {
  heldBalancesForRun,
  monthKeyAfter,
  notYetDue,
  type HeldSettlement,
} from "../src/lib/automated-payroll/held-settlements.ts";
import type { PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import type { DraftRow, PayrollPeriod } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * DEFER PAY AND THE UNPAID PART 1 (owner, 2026-10-26).
 *
 * "An employee should be paid 2,000 this month. I have the option to transfer this payment to the next
 * month, or to the month after." And: "they will hold it in the previous salary, first and second. So I
 * should be able to release their whole the previous salary this month."
 *
 * What must hold:
 *   1. a deferral comes off Part 2 only, never above the Part 2 the row had, and a held row defers
 *      nothing (its whole month is already withheld);
 *   2. someone held when Part 1 was confirmed is left out of the Part 1 bank files even after Part 2
 *      releases them — and a run confirmed before that was recorded keeps reading the live hold;
 *   3. a published month owes its Part 2 withheld, its Part 1 withheld, its deferred pay and whatever
 *      HR entered as "Part 1 Not Paid" — one balance per person, the two reports of one unpaid Part 1
 *      never added together;
 *   4. deferred pay is not offered before its month.
 */

const OCTOBER: PayrollPeriod = { month: 10, year: 2026 };

function compactOf(hrId: string): string {
  return hrId.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function member(hrId: string): PopulationMember {
  return {
    employee: {
      hrId,
      fullName: `Employee ${hrId}`,
      nameAr: null,
      jobTitle: "Medical Representative",
      lineName: "Anti Infective",
      areaName: "Cairo",
      hireDate: "2024-01-01",
      medicalInsurance: 0,
      bankName: "NBE",
      bankAccount: "123456",
      employmentStatus: "active",
      lastWorkingDate: null,
    } as unknown as EmployeeDirectoryRow,
    compact: compactOf(hrId),
    lifecycle: "regular",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  };
}

function sourcesFor(hrId: string): Map<string, PayrollSalarySource> {
  const source: PayrollSalarySource = {
    baseSalary: 30000,
    extraCostOfLiving: 1000,
    fuelAllowance: 500,
    netSalary: 31500,
    grossSalary: 30000,
    socialInsurance: 0,
    employmentIncomeTax: 0,
    paymentMode: "two_parts",
  };
  return new Map([
    [hrId.toLowerCase(), source],
    [compactOf(hrId), source],
  ]);
}

function draft(hrId: string, patch: Partial<DraftRow>): DraftRow {
  return {
    runId: "run-oct",
    employeeHrId: hrId,
    employeeHrIdCompact: compactOf(hrId),
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

function assembleOne(patch: Partial<DraftRow>) {
  const [entry] = assembleRows({
    members: [member("B-1")],
    sources: sourcesFor("B-1"),
    period: OCTOBER,
    draftRows: [draft("B-1", { firstPartFrozen: 15000, ...patch })],
    part1Confirmed: true,
  });
  return entry;
}

export function runAutomatedPayrollPayDeferralTests() {
  // ---- 1. A DEFERRAL COMES OFF PART 2 ONLY, CAPPED AT IT ------------------------------------------
  const plain = assembleOne({});
  assert.equal(plain.payDeferralApplied, 0, "nothing is deferred unless HR types an amount");
  const part2 = plain.row.secondPart;
  assert.ok(part2 > 2000, "the fixture's Part 2 is large enough to defer 2,000 from");

  const deferred = assembleOne({ payDeferralValue: 2000, payDeferralMonth: "next" });
  assert.equal(deferred.payDeferralApplied, 2000, "the typed amount is deferred");
  assert.equal(deferred.row.firstPart, plain.row.firstPart, "Part 1 is frozen money — a deferral never touches it");
  assert.equal(deferred.row.secondPart, part2 - 2000, "the deferral comes off this month's Part 2");
  assert.equal(
    deferred.row.monthSalary,
    plain.row.monthSalary - 2000,
    "the month's total shows the smaller figure, so the payslip and the bank file agree",
  );

  const tooMuch = assembleOne({ payDeferralValue: 999999 });
  assert.equal(tooMuch.payDeferralApplied, part2, "never more than the Part 2 the row had before the deferral");
  assert.equal(tooMuch.row.secondPart, 0, "a capped deferral empties Part 2 and never goes below it");

  const held = assembleOne({ payDeferralValue: 2000, onHold: true, holdReason: "Pending clearance" });
  assert.equal(held.payDeferralApplied, 0, "a held row defers nothing — its whole month is already withheld");

  // ---- 2. PART 1 IS DECIDED BY THE HOLD AT PART 1 CONFIRM ------------------------------------------
  const releasedAtPart2 = assembleOne({ part1Withheld: true, onHold: false });
  assert.equal(heldForScope(releasedAtPart2, "part1"), true, "held at Part 1: the Part 1 file still leaves them out");
  assert.equal(heldForScope(releasedAtPart2, "part2"), false, "released by Part 2: the Part 2 file pays them");
  const heldAtPart2Only = assembleOne({ part1Withheld: false, onHold: true, holdReason: "Pending clearance" });
  assert.equal(heldForScope(heldAtPart2Only, "part1"), false, "not held at Part 1: their Part 1 was paid");
  assert.equal(heldForScope(heldAtPart2Only, "part2"), true);
  const beforeTheColumn = assembleOne({ onHold: true, holdReason: "Pending clearance" });
  assert.equal(beforeTheColumn.part1Withheld, undefined);
  assert.equal(heldForScope(beforeTheColumn, "part1"), true, "a run confirmed before the stamp reads the live hold, as before");

  // ---- 3. WHAT A PUBLISHED MONTH STILL OWES ---------------------------------------------------------
  const balances = heldBalancesForRun({
    runId: "run-sep",
    month: 9,
    year: 2026,
    detail: {
      held: [
        { hrId: "B-1", name: "Held Both Parts", firstPartAlreadyPaid: 0, firstPartWithheld: 15000, secondPartWithheld: 16500 },
        { hrId: "B-5", name: "Held Before The Stamp", firstPartAlreadyPaid: 15000, secondPartWithheld: 16500 },
      ],
      part1Unpaid: [{ hrId: "B-2", name: "Released At Part 2", amount: 15000 }],
      deferred: [{ hrId: "B-3", name: "Deferred", amount: 2000, releaseIn: "2026-11" }],
    },
    settlements: new Map<string, HeldSettlement>(),
    releasedByPayroll: new Map(),
    corrections: [
      // The same unpaid Part 1 the run already froze: the larger stands, never the sum.
      { heldRunId: "run-sep", hrId: "B-1", compact: "b1", name: "Held Both Parts", amount: 15000 },
      // A September run published before the stamp: HR enters what was not paid.
      { heldRunId: "run-sep", hrId: "B-5", compact: "b5", name: "Held Before The Stamp", amount: 15000 },
      // Released at Part 2 and never recorded: HR adds them.
      { heldRunId: "run-sep", hrId: "B-4", compact: "b4", name: "Added By HR", amount: 12000 },
      // Another month's entry is not this month's money.
      { heldRunId: "run-aug", hrId: "B-6", compact: "b6", name: "August Only", amount: 9000 },
    ],
  });
  const by = new Map(balances.map((balance) => [balance.compact, balance]));
  assert.equal(balances.length, 5, "one balance per person, and nobody from another month");
  assert.equal(by.get("b1")?.outstanding, 31500, "held at Part 1 and Part 2: the whole month is owed, once");
  assert.equal(by.get("b1")?.firstPartWithheld, 15000);
  assert.equal(by.get("b5")?.outstanding, 31500, "HR's Part 1 Not Paid joins an old run's Part 2 withheld");
  assert.equal(by.get("b5")?.firstPartAlreadyPaid, 0, "and what HR says was not paid stops reading as paid");
  assert.equal(by.get("b2")?.outstanding, 15000, "released at Part 2: the unpaid Part 1 is owed");
  assert.equal(by.get("b4")?.outstanding, 12000, "someone HR adds is owed what HR entered");
  assert.equal(by.get("b3")?.outstanding, 2000, "deferred pay is owed");
  assert.equal(by.get("b3")?.deferredTo, "2026-11");
  assert.equal(by.has("b6"), false);

  // ---- 4. DEFERRED PAY IS NOT OFFERED BEFORE ITS MONTH ----------------------------------------------
  const b3 = [by.get("b3")!];
  assert.equal(notYetDue(b3, OCTOBER), 2000, "deferred to November: not due in October");
  assert.equal(notYetDue(b3, { month: 11, year: 2026 }), 0, "due in November");
  assert.equal(notYetDue([{ ...b3[0], outstanding: 500 }], OCTOBER), 500, "never more not-due than is owed");
  assert.equal(notYetDue([by.get("b1")!], OCTOBER), 0, "a withheld month with nothing deferred is due at once");
  assert.equal(monthKeyAfter(10, 2026, 1), "2026-11");
  assert.equal(monthKeyAfter(10, 2026, 2), "2026-12");
  assert.equal(monthKeyAfter(12, 2026, 1), "2027-01", "the year rolls over");

  // ---- THE WIRING: the stamp is written under the claim, and publish records both lists -------------
  const path = "src/lib/automated-payroll/run-service.ts";
  const source = stripComments(readFileSync(path, "utf8"));
  function bodyOf(name: string): string {
    const start = source.search(new RegExp(`(export )?(async )?function ${name}\\s*\\(`));
    assert.ok(start >= 0, `${path}: ${name} not found — has it been renamed?`);
    return source.slice(start, source.indexOf("\n}\n", start));
  }
  const confirm = bodyOf("confirmPart1");
  const stamp = confirm.indexOf("patch.part1Withheld = heldNow.has(");
  assert.ok(stamp > confirm.indexOf("whileClaimed"), `${path}: the Part 1 hold is read under the claim`);
  assert.ok(stamp < confirm.indexOf("upsertDraftRows(runId, patches)"), `${path}: and written with the freeze`);
  assert.match(bodyOf("unconfirmPart1"), /reopenPart1Atomically\(/, `${path}: reopening Part 1 goes through the one call`);
  assert.match(
    readFileSync("supabase/migrations/20261114170804_automated_payroll_reopen_part1_atomically.sql", "utf8"),
    /part1_withheld = null/,
    `${path}: reopening Part 1 clears the stamp`,
  );
  const publish = bodyOf("publishToPayslips");
  assert.match(publish, /part1Unpaid,\s*deferred,/, `${path}: publish records the unpaid Part 1 and the deferred pay`);
  assert.match(
    publish,
    /firstPartAlreadyPaid: entry\.part1Withheld === true \? 0 :/,
    `${path}: a Part 1 the bank files never paid is not recorded as paid`,
  );
  assert.match(
    bodyOf("saveStep"),
    /const deferralFields = PAY_DEFERRAL_FIELDS\[stepKey\];\s*if \(deferralFields\) assertPayDeferralEdits\(applicable, currentRows, deferralFields\)/,
    `${path}: a save can never defer more than the step's Part 1 or Part 2 column`,
  );
}

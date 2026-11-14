import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assembleRows, computePart1Freeze, settlementBasisFor } from "../src/lib/automated-payroll/assemble.ts";
import { heldBalancesForRun, type HeldSettlement } from "../src/lib/automated-payroll/held-settlements.ts";
import { releaseOnlyMember, type PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import { reconcile } from "../src/lib/automated-payroll/reconcile.ts";
import { computeSettlementSummary } from "../src/lib/automated-payroll/settlement-summary.ts";
import { STEP_DEFINITIONS } from "../src/lib/automated-payroll/step-definitions.ts";
import { preflightValidate } from "../src/lib/automated-payroll/validate.ts";
import type { DraftRow, PayrollPeriod } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * HELD SALARY RELEASE AND DEFER PAY IN PART 1 TOO (owner, 2026-10-26: "it should be also in part one.
 * For example, if an employee is resigned and his value of working days is only covered in the first
 * part" — and, asked whether Part 1's amounts go in Part 1's bank file: "Both").
 *
 * What must hold:
 *   1. Part 1's release is paid in the First Part — added to Other Additions once for the month — and
 *      leaves the Second Part where it was;
 *   2. Part 1's deferral comes off the First Part only, never above the First Part the row had
 *      without it, and leaves the Second Part where it was;
 *   3. someone held at Part 1 is paid no Part 1 release and defers nothing from a Part 1 never paid;
 *   4. the frozen First Part is the previewed one, and after the freeze the row reads it back;
 *   5. someone on the sheet only for a held salary is paid Part 1's release in the First Part and
 *      Part 2's in the Second Part, and held again at Part 2 keeps only Part 1's;
 *   6. Part 1 and Part 2 deferring to different months owe the whole sum from the LATER month;
 *   7. confirming Part 1 reserves its releases under the claim, and reopening it withdraws them;
 *   8. the four-figure summary keeps each instalment's release and deferral apart, so typing in one
 *      step's box never wipes out the other instalment's share.
 */

const OCTOBER: PayrollPeriod = { month: 10, year: 2026 };

function compactOf(hrId: string): string {
  return hrId.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function employee(hrId: string): EmployeeDirectoryRow {
  return {
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
  } as unknown as EmployeeDirectoryRow;
}

function member(hrId: string): PopulationMember {
  return {
    employee: employee(hrId),
    compact: compactOf(hrId),
    lifecycle: "regular",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  };
}

function sourcesFor(...hrIds: string[]): Map<string, PayrollSalarySource> {
  const map = new Map<string, PayrollSalarySource>();
  for (const hrId of hrIds) {
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
    map.set(hrId.toLowerCase(), source);
    map.set(compactOf(hrId), source);
  }
  return map;
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

/** The live preview, before Part 1 is confirmed. */
function live(patch: Partial<DraftRow>) {
  const [entry] = assembleRows({
    members: [member("B-1")],
    sources: sourcesFor("B-1"),
    period: OCTOBER,
    draftRows: [draft("B-1", patch)],
    part1Confirmed: false,
  });
  return entry;
}

/** Confirm Part 1 the way confirmPart1 does: freeze, store the capped deferral, read it back. */
function frozenAndRead(patch: Partial<DraftRow>) {
  const draftRow = draft("B-1", patch);
  const freeze = computePart1Freeze({
    members: [member("B-1")],
    sources: sourcesFor("B-1"),
    draftRows: [draftRow],
    period: OCTOBER,
  }).get("b1");
  assert.ok(freeze, "the freeze covers every member");
  const [entry] = assembleRows({
    members: [member("B-1")],
    sources: sourcesFor("B-1"),
    period: OCTOBER,
    draftRows: [
      {
        ...draftRow,
        firstPartFrozen: freeze.firstPart,
        payDeferralP1Value: freeze.payDeferralApplied,
        part1Withheld: Boolean(draftRow.onHold),
      },
    ],
    part1Confirmed: true,
  });
  return { freeze, entry };
}

export function runAutomatedPayrollPart1ReleaseDeferralTests() {
  const plain = live({});
  assert.ok(plain);
  assert.equal(plain.heldReleasePart1Applied, 0, "nothing is released in Part 1 unless HR types an amount");
  assert.equal(plain.payDeferralPart1Applied, 0, "nothing is deferred from Part 1 unless HR types an amount");
  const firstPart = plain.row.firstPart;
  const secondPart = plain.row.secondPart;
  assert.ok(firstPart > 2000, "the fixture's Part 1 is large enough to defer 2,000 from");

  // ---- 1. PART 1'S RELEASE IS PAID IN THE FIRST PART -------------------------------------------------
  const released = live({ heldReleaseP1Value: 3000 });
  assert.equal(released.heldReleasePart1Applied, 3000, "the row reports what Part 1 releases, for the reservation");
  assert.equal(released.heldReleaseApplied, 0, "and none of it is Part 2's release");
  assert.equal(released.row.firstPart, firstPart + 3000, "Part 1's release is paid in the Part 1 bank file");
  assert.equal(released.row.secondPart, secondPart, "and Part 2 is left exactly where it was");
  assert.equal(released.row.otherAdditions - plain.row.otherAdditions, 3000, "shown once, in Other Additions");
  assert.equal(released.row.monthSalary - plain.row.monthSalary, 3000);
  assert.equal(released.row.grossSalary, plain.row.grossSalary, "a release is not this month's salary: no filing moves");
  assert.equal(released.row.socialInsurance, plain.row.socialInsurance);
  assert.equal(released.row.employmentIncomeTax, plain.row.employmentIncomeTax);

  // ---- 2. PART 1'S DEFERRAL COMES OFF THE FIRST PART ONLY, CAPPED AT IT --------------------------------
  const deferred = live({ payDeferralP1Value: 2000, payDeferralP1Month: "next" });
  assert.equal(deferred.payDeferralPart1Applied, 2000, "the typed amount is deferred");
  assert.equal(deferred.payDeferralApplied, 0, "and none of it is Part 2's deferral");
  assert.equal(deferred.row.firstPart, firstPart - 2000, "the deferral comes off this month's Part 1");
  assert.equal(deferred.row.secondPart, secondPart, "and never reaches Part 2");
  assert.equal(deferred.row.monthSalary, plain.row.monthSalary - 2000, "the month shows the smaller figure");
  assert.equal(deferred.row.otherDeductions - plain.row.otherDeductions, 2000, "shown once, in Other Deductions");

  const tooMuch = live({ payDeferralP1Value: 999999 });
  assert.equal(tooMuch.payDeferralPart1Applied, firstPart, "never more than the Part 1 the row had without it");
  assert.equal(tooMuch.row.firstPart, 0, "a capped deferral empties Part 1 and never goes below it");
  assert.equal(tooMuch.row.secondPart, secondPart, "and still leaves Part 2 alone");

  const both = live({ heldReleaseP1Value: 3000, payDeferralP1Value: 999999 });
  assert.equal(both.payDeferralPart1Applied, firstPart + 3000, "the cap is the First Part with the release in it");
  assert.equal(both.row.firstPart, 0);
  assert.equal(both.row.secondPart, secondPart);

  // ---- 3. HELD AT PART 1: NO PART 1 RELEASE, NOTHING DEFERRED FROM A PART 1 NEVER PAID ----------------
  const held = live({ onHold: true, holdReason: "Pending clearance", heldReleaseP1Value: 3000, payDeferralP1Value: 2000 });
  assert.equal(held.heldReleasePart1Applied, 0, "a row held at Part 1 releases nothing in Part 1 — it stays owed");
  assert.equal(held.payDeferralPart1Applied, 0, "and defers nothing — its Part 1 is already withheld");
  const withheldThenReleased = live({ part1Withheld: true, onHold: false, heldReleaseP1Value: 3000, payDeferralP1Value: 2000 });
  assert.equal(withheldThenReleased.heldReleasePart1Applied, 0, "the hold at Part 1 confirm decides, not today's");
  assert.equal(withheldThenReleased.payDeferralPart1Applied, 0);

  // ---- 4. THE FROZEN FIRST PART IS THE PREVIEWED ONE ---------------------------------------------------
  const confirmedRelease = frozenAndRead({ heldReleaseP1Value: 3000 });
  assert.equal(confirmedRelease.freeze.firstPart, released.row.firstPart, "Part 1 confirm freezes the previewed First Part");
  assert.equal(confirmedRelease.freeze.heldReleaseApplied, 3000);
  assert.equal(confirmedRelease.entry.row.firstPart, released.row.firstPart);
  assert.equal(confirmedRelease.entry.row.secondPart, secondPart, "after the freeze Part 2 is still untouched");
  assert.equal(confirmedRelease.entry.heldReleasePart1Applied, 3000, "and the row still reports Part 1's release");

  const confirmedCap = frozenAndRead({ payDeferralP1Value: 999999 });
  assert.equal(confirmedCap.freeze.payDeferralApplied, firstPart, "the freeze keeps the deferral as it was applied");
  assert.equal(confirmedCap.entry.payDeferralPart1Applied, firstPart, "so the figure owed later is what the bank file left out");
  assert.equal(confirmedCap.entry.row.firstPart, 0);
  assert.equal(confirmedCap.entry.row.secondPart, secondPart);

  const confirmedDeferral = frozenAndRead({ payDeferralP1Value: 2000 });
  assert.equal(confirmedDeferral.entry.row.firstPart, firstPart - 2000);
  assert.equal(confirmedDeferral.entry.row.secondPart, secondPart);
  for (const entry of [confirmedDeferral.entry, confirmedRelease.entry, confirmedCap.entry]) {
    const checked = preflightValidate([entry]);
    assert.ok(checked.ok, `a Part 1 release or deferral passes the sheet validator: ${JSON.stringify(checked.issues)}`);
  }

  // ---- 5. SOMEONE ON THE SHEET ONLY FOR A HELD SALARY ---------------------------------------------------
  const leaver = releaseOnlyMember(employee("B-2"));
  assert.ok(leaver);
  const releaseOnly = (patch: Partial<DraftRow>) =>
    assembleRows({
      members: [member("B-1")],
      sources: sourcesFor("B-1", "B-2"),
      period: OCTOBER,
      draftRows: [draft("B-1", {}), draft("B-2", patch)],
      releaseOnlyMembers: [leaver],
    });
  const twoParts = releaseOnly({ heldReleaseP1Value: 1000, heldReleaseValue: 500 });
  const leaverRow = twoParts.find((entry) => entry.compact === "b2");
  assert.ok(leaverRow, "a Part 1 release alone puts them on the sheet");
  assert.equal(leaverRow.row.firstPart, 1000, "Part 1's release is their First Part");
  assert.equal(leaverRow.row.secondPart, 500, "Part 2's release is their Second Part");
  assert.equal(leaverRow.totalPayable, 1500);
  assert.equal(leaverRow.heldReleasePart1Applied, 1000);
  assert.equal(leaverRow.heldReleaseApplied, 500);
  assert.ok(preflightValidate(twoParts).ok, JSON.stringify(preflightValidate(twoParts).issues));
  assert.deepEqual(reconcile(twoParts).splitMismatches, [], "and the two parts foot to the month");

  const part1Only = releaseOnly({ heldReleaseP1Value: 1000 }).find((entry) => entry.compact === "b2");
  assert.ok(part1Only, "Part 1's release alone is enough for a row");
  assert.equal(part1Only.row.firstPart, 1000);
  assert.equal(part1Only.row.secondPart, 0);

  const heldAtPart2 = releaseOnly({
    heldReleaseP1Value: 1000,
    heldReleaseValue: 500,
    part1Withheld: false,
    onHold: true,
    holdReason: "Pending clearance",
  }).find((entry) => entry.compact === "b2");
  assert.ok(heldAtPart2, "held at Part 2 after Part 1 paid: the row stays, for what Part 1 paid");
  assert.equal(heldAtPart2.row.firstPart, 1000, "what Part 1 paid stays paid");
  assert.equal(heldAtPart2.row.secondPart, 0, "Part 2's release stays owed");
  assert.equal(heldAtPart2.heldReleaseApplied, 0);
  assert.equal(
    releaseOnly({ heldReleaseP1Value: 1000, heldReleaseValue: 500, onHold: true, holdReason: "Pending clearance" }).length,
    1,
    "held at both parts: nothing is released, so there is no row",
  );

  // ---- 6. TWO DEFERRALS TO TWO MONTHS: THE LATER ONE STANDS ----------------------------------------------
  for (const order of [
    ["2026-12", "2026-11"],
    ["2026-11", "2026-12"],
  ]) {
    const [balance] = heldBalancesForRun({
      runId: "run-oct",
      month: 10,
      year: 2026,
      detail: {
        held: [],
        part1Unpaid: [],
        deferred: [
          { hrId: "B-3", name: "Deferred Twice", amount: 2000, releaseIn: order[0] },
          { hrId: "B-3", name: "Deferred Twice", amount: 1500, releaseIn: order[1] },
        ],
      },
      settlements: new Map<string, HeldSettlement>(),
      releasedByPayroll: new Map(),
      corrections: [],
    });
    assert.equal(balance?.deferred, 3500, "both deferrals are owed, as one balance");
    assert.equal(balance?.deferredTo, "2026-12", `the later month stands whichever is listed first (${order.join(", ")})`);
  }

  // ---- 7. THE WIRING -------------------------------------------------------------------------------------
  const path = "src/lib/automated-payroll/run-service.ts";
  const source = stripComments(readFileSync(path, "utf8"));
  function bodyOf(name: string): string {
    const start = source.search(new RegExp(`(export )?(async )?function ${name}\\s*\\(`));
    assert.ok(start >= 0, `${path}: ${name} not found — has it been renamed?`);
    return source.slice(start, source.indexOf("\n}\n", start));
  }
  const confirm = bodyOf("confirmPart1");
  const reserve = confirm.indexOf('stage: "part1_confirmed"');
  assert.ok(reserve > confirm.indexOf("whileClaimed"), `${path}: Part 1's releases are reserved under the claim`);
  assert.ok(reserve < confirm.indexOf("updateRun("), `${path}: before the run moves on to Part 2`);
  assert.match(confirm, /releases: part1Releases/, `${path}: from what the freeze actually released`);
  assert.match(confirm, /patch\.payDeferralP1Value = freeze\.payDeferralApplied/, `${path}: the capped deferral is stored`);
  assert.match(
    confirm,
    /await assertHeldReleasesPayable\(runId, draftRows, preflightRows\)/,
    `${path}: a Part 1 release must still be owed before it is frozen as money`,
  );
  const reopen = bodyOf("unconfirmPart1");
  // Withdrawn inside phx_reopen_automated_payroll_part1, in the same transaction as the freeze (payroll
  // audit 2026-11-14, finding 3).
  const reopenSql = readFileSync(
    "supabase/migrations/20261114170804_automated_payroll_reopen_part1_atomically.sql",
    "utf8",
  );
  assert.match(
    reopenSql,
    /delete from public\.automated_payroll_held_releases\s+where paying_run_id = p_run_id;/,
    `${path}: reopening Part 1 withdraws what it reserved`,
  );
  assert.ok(reopen.indexOf("reopenPart1Atomically(") > reopen.indexOf("whileClaimed"), `${path}: under the claim`);
  assert.match(
    source,
    /const PART1_ONLY_STEP_KEYS: ReadonlySet<StepKey> = new Set<StepKey>\(\["p1_held_release", "p1_pay_deferral"\]\)/,
    `${path}: Part 1's release and deferral steps lock once Part 1 is confirmed`,
  );
  assert.match(
    bodyOf("assertStepPhaseAllowed"),
    /PART1_ONLY_STEP_KEYS\.has\(stepKey\) && run\.phase !== "part1"/,
    `${path}: a save after Part 1 confirm is refused — that money already left`,
  );
  assert.match(
    bodyOf("owedLaterRecords"),
    /deferred: \[\.\.\.deferredPart1, \.\.\.deferredPart2\]/,
    `${path}: publish records Part 1's deferral as owed beside Part 2's`,
  );

  // ---- 8. THE FOUR FIGURES KEEP THE TWO INSTALMENTS APART ------------------------------------------------
  // Each step's box overlays the component of its OWN key. Folding Part 1's share into Part 2's key let
  // the Part 2 screen's box replace both, and Part 1's box moved nothing.
  const instalments = { heldReleaseP1Value: 3000, heldReleaseValue: 1000, payDeferralP1Value: 2000, payDeferralValue: 500 };
  const summaryBasis = settlementBasisFor({
    member: member("B-1"),
    source: sourcesFor("B-1").get("b1"),
    draft: draft("B-1", instalments),
    period: OCTOBER,
  });
  const saved = computeSettlementSummary(summaryBasis, STEP_DEFINITIONS.p1_holds, {});
  assert.ok(saved);
  const onPart2Release = computeSettlementSummary(summaryBasis, STEP_DEFINITIONS.p2_held_release, { heldReleaseValue: 1000 });
  assert.equal(onPart2Release?.additions, saved.additions, "the Part 2 screen keeps Part 1's release in the additions");
  const onPart1Release = computeSettlementSummary(summaryBasis, STEP_DEFINITIONS.p1_held_release, { heldReleaseP1Value: 3500 });
  assert.equal(onPart1Release?.additions, saved.additions + 500, "typing in Part 1's release box moves the additions");
  const onPart2Deferral = computeSettlementSummary(summaryBasis, STEP_DEFINITIONS.p2_pay_deferral, { payDeferralValue: 500 });
  assert.equal(onPart2Deferral?.deductions, saved.deductions, "the Part 2 screen keeps Part 1's deferral in the deductions");
  const onPart1Deferral = computeSettlementSummary(summaryBasis, STEP_DEFINITIONS.p1_pay_deferral, { payDeferralP1Value: 2500 });
  assert.equal(onPart1Deferral?.deductions, saved.deductions + 500, "typing in Part 1's deferral box moves the deductions");
}

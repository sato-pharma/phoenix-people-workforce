import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assembleRows } from "../src/lib/automated-payroll/assemble.ts";
import {
  allocateRelease,
  payrollReleasedByHeldMonth,
  planHeldReleases,
  type HeldBalance,
} from "../src/lib/automated-payroll/held-settlements.ts";
import {
  recommendHeldRelease,
  releaseOnlyMember,
  releaseOnlyMembersFor,
  type PopulationMember,
} from "../src/lib/automated-payroll/recommend.ts";
import { reconcile } from "../src/lib/automated-payroll/reconcile.ts";
import { preflightValidate } from "../src/lib/automated-payroll/validate.ts";
import type { DraftRow, PayrollPeriod } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";
import { buildStatutorySummaryRows } from "../src/lib/payroll/exports/statutory-summary.ts";
import { HELD_RELEASE_ONLY_COMMENT } from "../src/lib/payroll/held-release.ts";
import { DEFAULT_STATUTORY_CONFIG } from "../src/lib/payroll/statutory/config.ts";
import type { SalaryRecord } from "../src/lib/payroll/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * HELD SALARY RELEASE (owner, 2026-10-26: "if someone's salary is held, it's not added afterwards").
 *
 * Publish drops a held row, so its Part 2 is never paid — and until this step nothing ever paid it
 * later. September 2026 held 9 people, six of them with money withheld (Ahmed Hemdan 7,265.00,
 * Mohamed Nasr 6,473.00 among them), and no later month carried a pound of it.
 *
 * The release step puts the money back on a later month's sheet. What must hold:
 *   1. a release lands in Part 2 only, in Other Additions, and moves nothing else on the row;
 *   2. someone who has LEFT (most of the held) still gets a row, which passes the sheet's own
 *      validator and the reconciliation, with Part 1 zero and Part 2 the release;
 *   3. a payment clears the OLDEST held month first and never more than is owed;
 *   4. publish records the payment from the rows actually published, never a held one, and a row
 *      held again this month does not owe the released money twice;
 *   5. what payroll released lives in its OWN ledger, reserved at Part 2 confirm and replaced (never
 *      added to) at publish, so a re-confirm or a retried publish never counts the money twice and a
 *      by-hand edit on the held-salary sheet can never erase it;
 *   6. a release-only row is not part of the month's insurance filing.
 */

const OCTOBER: PayrollPeriod = { month: 10, year: 2026 };
const BASE = 30000;
const ECOL = 1000;
const FUEL = 500;

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

function addSource(map: Map<string, PayrollSalarySource>, hrId: string): Map<string, PayrollSalarySource> {
  const source: PayrollSalarySource = {
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    netSalary: BASE + ECOL + FUEL,
    grossSalary: BASE,
    socialInsurance: 0,
    employmentIncomeTax: 0,
    paymentMode: "two_parts",
  };
  map.set(hrId.toLowerCase(), source);
  map.set(compactOf(hrId), source);
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

function balance(runId: string, month: number, outstanding: number): HeldBalance {
  return {
    runId,
    month,
    year: 2026,
    hrId: "B-2",
    compact: "b2",
    name: "Employee B-2",
    reason: null,
    firstPartAlreadyPaid: 0,
    secondPartWithheld: outstanding,
    firstPartWithheld: 0,
    part1Correction: 0,
    deferred: 0,
    deferredTo: null,
    settled: null,
    releasedByPayroll: 0,
    outstanding,
  };
}

export function runAutomatedPayrollHeldReleaseTests() {
  // ---- 3. OLDEST HELD MONTH FIRST, NEVER MORE THAN OWED ----------------------------------------
  // Given newest-first on purpose: the order must come from the months, not the input.
  const owed = [balance("run-sep", 9, 7265), balance("run-aug", 8, 1000)];
  assert.deepEqual(
    allocateRelease(owed, 1500),
    [
      { runId: "run-aug", month: 8, year: 2026, amount: 1000 },
      { runId: "run-sep", month: 9, year: 2026, amount: 500 },
    ],
    "a partial release clears August before it touches September",
  );
  assert.deepEqual(
    allocateRelease(owed, 99999).map((allocation) => allocation.amount),
    [1000, 7265],
    "a release above the balance records only what was owed",
  );
  assert.deepEqual(allocateRelease(owed, 0), [], "a zero release records nothing");
  assert.deepEqual(allocateRelease([balance("run-sep", 9, 0)], 500), [], "a settled month takes nothing");

  // ---- 1. A RELEASE ON SOMEONE STILL EMPLOYED: PART 2 ONLY, OTHER ADDITIONS ONLY ----------------
  const sources = addSource(addSource(new Map(), "B-1"), "B-2");
  const [plain] = assembleRows({ members: [member("B-1")], sources, period: OCTOBER, draftRows: [draft("B-1", {})] });
  const [paid] = assembleRows({
    members: [member("B-1")],
    sources,
    period: OCTOBER,
    draftRows: [draft("B-1", { heldReleaseValue: 7265 })],
  });
  assert.ok(plain && paid);
  assert.equal(paid.heldReleaseApplied, 7265, "the row reports what it releases, for publish to record");
  assert.equal(plain.heldReleaseApplied, 0);
  assert.equal(paid.row.firstPart, plain.row.firstPart, "a release never changes Part 1 — that money already left");
  assert.equal(paid.row.secondPart - plain.row.secondPart, 7265, "the whole release is paid in Part 2");
  assert.equal(paid.row.otherAdditions - plain.row.otherAdditions, 7265, "and shown in Other Additions");
  assert.equal(paid.row.monthSalary - plain.row.monthSalary, 7265);
  assert.equal(paid.row.grossSalary, plain.row.grossSalary, "a release is not this month's salary: no filing moves");
  assert.equal(paid.row.socialInsurance, plain.row.socialInsurance);
  assert.equal(paid.row.employmentIncomeTax, plain.row.employmentIncomeTax);
  assert.equal(paid.row.totalDeductions, plain.row.totalDeductions);
  assert.ok(preflightValidate([paid]).ok, JSON.stringify(preflightValidate([paid]).issues));

  // ---- 2. SOMEONE WHO HAS LEFT: A RELEASE-ONLY ROW ---------------------------------------------
  const leaver = releaseOnlyMember(employee("B-2"));
  assert.ok(leaver && leaver.releaseOnly === true);
  const rows = assembleRows({
    members: [member("B-1")],
    sources,
    period: OCTOBER,
    draftRows: [draft("B-1", {}), draft("B-2", { heldReleaseValue: 6473 })],
    releaseOnlyMembers: [leaver],
  });
  assert.equal(rows.length, 2, "the leaver is on the sheet, beside the population");
  const released = rows.find((entry) => entry.compact === "b2");
  assert.ok(released, "the release-only row is built");
  assert.equal(released.row.firstPart, 0, "nothing was earned this month, so there is no Part 1");
  assert.equal(released.row.secondPart, 6473, "Part 2 is the release");
  assert.equal(released.totalPayable, 6473);
  assert.equal(released.row.monthSalary, 6473);
  assert.equal(released.row.otherAdditions, 6473);
  assert.equal(released.row.socialInsurance, 0, "nothing earned, nothing filed — it was filed in the held month");
  assert.equal(released.row.employmentIncomeTax, 0);
  assert.equal(released.row.totalDeductions, 0);
  assert.equal(released.row.workingDays, 0);
  assert.equal(released.heldReleaseApplied, 6473);
  const preflight = preflightValidate(rows);
  assert.ok(preflight.ok, `a release-only row must pass the sheet's validator: ${JSON.stringify(preflight.issues)}`);
  const totals = reconcile(rows);
  assert.deepEqual(totals.splitMismatches, [], "and the reconciliation");
  assert.equal(totals.headcount, 2);

  // Never twice, never empty.
  assert.equal(
    assembleRows({
      members: [member("B-1")],
      sources,
      period: OCTOBER,
      draftRows: [draft("B-1", { heldReleaseValue: 100 })],
      releaseOnlyMembers: [releaseOnlyMember(employee("B-1"))!],
    }).length,
    1,
    "someone in the population is paid through their own row, never a second one",
  );
  assert.equal(
    assembleRows({
      members: [member("B-1")],
      sources,
      period: OCTOBER,
      draftRows: [draft("B-1", {}), draft("B-2", { heldReleaseValue: 0 })],
      releaseOnlyMembers: [leaver],
    }).length,
    1,
    "a release set to 0 keeps holding — no row",
  );

  // Who gets a release-only row: a saved release, not excluded, not in the population, on record.
  const directory = new Map([
    ["b1", employee("B-1")],
    ["b2", employee("B-2")],
    ["b4", employee("B-4")],
  ]);
  const picked = releaseOnlyMembersFor({
    members: [member("B-1")],
    directory,
    sources,
    period: OCTOBER,
    draftRows: [
      draft("B-1", { heldReleaseValue: 100 }),
      draft("B-2", { heldReleaseValue: 6473 }),
      draft("B-3", { heldReleaseValue: 50 }),
      draft("B-4", { heldReleaseValue: 70, excluded: true }),
    ],
  });
  assert.deepEqual(
    picked.map((entry) => entry.compact),
    ["b2"],
    "only B-2: B-1 is in the population, B-3 has no employee record, B-4 is excluded from the run",
  );

  // ---- 1b. HELD AGAIN THIS MONTH: NOTHING IS RELEASED, NOTHING IS LOST ------------------------------
  // A held row is dropped at publish. Folding the release into it would let the release cancel this
  // month's overpayment and vanish with the hold; it must stay owed on its own month instead.
  const [heldPlain] = assembleRows({
    members: [member("B-1")],
    sources,
    period: OCTOBER,
    draftRows: [draft("B-1", { onHold: true })],
  });
  const [heldPaid] = assembleRows({
    members: [member("B-1")],
    sources,
    period: OCTOBER,
    draftRows: [draft("B-1", { onHold: true, heldReleaseValue: 7265 })],
  });
  assert.ok(heldPlain && heldPaid);
  assert.equal(heldPaid.heldReleaseApplied, 0, "a row held again releases nothing");
  assert.equal(heldPaid.row.secondPart, heldPlain.row.secondPart, "and its Part 2 is this month's own");
  assert.equal(heldPaid.overpaidResidual, heldPlain.overpaidResidual, "the release cannot absorb an overpayment");
  assert.equal(
    assembleRows({
      members: [member("B-1")],
      sources,
      period: OCTOBER,
      draftRows: [draft("B-1", {}), draft("B-2", { heldReleaseValue: 6473, onHold: true })],
      releaseOnlyMembers: [leaver],
    }).length,
    1,
    "a leaver held again gets no release-only row",
  );
  assert.equal(released.row.payrollComment, HELD_RELEASE_ONLY_COMMENT, "the marker the Statutory Summary reads");

  // ---- 5. THE PAYROLL LEDGER: WHAT STILL COUNTS, AND A RELEASE THAT IS NOT OWED -------------------
  const ledger = [
    { payingRunId: "run-oct", payingRunPhase: "ready", heldRunId: "run-sep", compact: "b2", amount: 3000 },
    { payingRunId: "run-nov", payingRunPhase: "published", heldRunId: "run-sep", compact: "b2", amount: 1000 },
    { payingRunId: "run-dec", payingRunPhase: "cancelled", heldRunId: "run-sep", compact: "b2", amount: 2000 },
    { payingRunId: "run-jan", payingRunPhase: null, heldRunId: "run-aug", compact: "b2", amount: 400 },
  ];
  const everyone = payrollReleasedByHeldMonth(ledger);
  assert.equal(everyone.get("run-sep|b2"), 4000, "confirmed and published releases count; a cancelled run paid nobody");
  assert.equal(everyone.get("run-aug|b2"), 400, "an unreadable run's phase still holds its money back");
  assert.equal(
    payrollReleasedByHeldMonth(ledger, "run-oct").get("run-sep|b2"),
    1000,
    "the asking run's own reservation is left out, so a re-confirm or retried publish can record it again",
  );
  const planned = planHeldReleases(new Map([["b2", owed]]), [{ hrId: "B-2", amount: 1500 }]);
  assert.equal(planned.length, 1);
  assert.deepEqual(
    planned[0]!.allocations.map((allocation) => [allocation.runId, allocation.amount]),
    [
      ["run-aug", 1000],
      ["run-sep", 500],
    ],
    "the record splits oldest month first",
  );
  assert.throws(
    () => planHeldReleases(new Map([["b2", owed]]), [{ hrId: "B-2", amount: 9000 }]),
    /only 8265.00 is still held/,
    "a release above what is still owed is refused, never recorded short",
  );
  assert.throws(
    () => planHeldReleases(new Map(), [{ hrId: "B-9", amount: 10 }]),
    /only 0.00 is still held/,
    "a release for someone with nothing held is refused",
  );
  assert.deepEqual(planHeldReleases(new Map(), [{ hrId: "B-9", amount: 0 }]), [], "a zero release records nothing");

  // ---- 6. A RELEASE-ONLY ROW IS NOT IN THE MONTH'S INSURANCE FILING -------------------------------
  const filed = buildStatutorySummaryRows(
    [
      statutoryRecord({ hrId: "B-1", socialInsurance: 1837 }),
      statutoryRecord({
        hrId: "B-2",
        payrollComment: HELD_RELEASE_ONLY_COMMENT,
        workingDays: 0,
        socialInsurance: 0,
        employmentIncomeTax: 0,
        monthSalary: 6473,
      }),
    ],
    DEFAULT_STATUTORY_CONFIG,
    new Map<string, number | null>([
      ["b1", 16700],
      ["b2", 16700],
    ]),
  );
  assert.deepEqual(
    filed.rows.map((row) => row.hrId),
    ["B-1"],
    "the leaver paid only a release worked nothing this month and is not filed for it",
  );
  assert.equal(
    buildStatutorySummaryRows(
      [statutoryRecord({ hrId: "B-1", payrollComment: HELD_RELEASE_ONLY_COMMENT, socialInsurance: 1837 })],
      DEFAULT_STATUTORY_CONFIG,
      new Map<string, number | null>([["b1", 16700]]),
    ).rows.length,
    1,
    "the comment alone never drops a row that worked and paid insurance",
  );

  // ---- 4. PUBLISH RECORDS WHAT WAS PUBLISHED, AND CONFIRM/PUBLISH REFUSE WHAT IS NOT OWED ---------
  const path = "src/lib/automated-payroll/run-service.ts";
  const source = stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
  function bodyOf(name: string): string {
    const start = source.search(new RegExp(`(export )?(async )?function ${name}\\s*\\(`));
    assert.ok(start >= 0, `${path}: ${name} not found — has it been renamed?`);
    const end = source.indexOf("\n}\n", start);
    assert.ok(end > start, `${path}: could not find the end of ${name}`);
    return source.slice(start, end);
  }
  assert.match(
    bodyOf("heldReleasesOf"),
    /entry\.heldReleasePart1Applied \+ \(entry\.onHold \? 0 : entry\.heldReleaseApplied\)/,
    `${path}: Part 2 releases only on a row that is paid — a held row's Part 2 release stays owed — and Part 1's wherever Part 1 paid it`,
  );
  const publish = bodyOf("publishToPayslips");
  const record = publish.slice(publish.search(/recordHeldReleases\(/));
  assert.ok(/recordHeldReleases\(/.test(publish), `${path}: publish must record the release`);
  assert.match(record.slice(0, 300), /releases: heldReleasesOf\(rows\)/, `${path}: from the rows actually published`);
  assert.ok(
    publish.indexOf("recordHeldReleases(") < publish.indexOf('phase: "published"'),
    `${path}: the release is recorded before the run is marked published, inside the claim`,
  );
  assert.match(
    publish,
    /secondPartWithheld: roundCurrency\(entry\.row\.secondPart\)/,
    `${path}: a held row released nothing, so its withholding is its own Part 2`,
  );
  const confirm = bodyOf("confirmPart2");
  const reserve = confirm.search(/recordHeldReleases\(/);
  assert.ok(reserve > 0, `${path}: Part 2 confirm reserves the release — the bank files can pay it from then on`);
  assert.ok(
    reserve > confirm.indexOf("whileClaimed") && reserve < confirm.indexOf('phase: "ready"'),
    `${path}: the reservation is written under the claim, before the run is ready`,
  );
  assert.match(
    bodyOf("assertFileMatchesPart2Confirm"),
    /assertHeldReleasesPayable\(run\.id, draftRows, rows\)/,
    `${path}: every Part 2 bank file refuses a release a by-hand transfer has since paid`,
  );
  assert.equal(
    (source.match(/assertFileMatchesPart2Confirm\(run, rows, draftRows\)/g) ?? []).length,
    3,
    `${path}: the finance, FAB and CIB files all pass the drafts to that check`,
  );
  assert.match(publish, /assertHeldReleasesPayable\(runId, publishDraftRows, rows\)/, `${path}: publish re-checks the balance`);
  assert.match(
    bodyOf("confirmPart2"),
    /assertHeldReleasesPayable\(runId, assembledDraftRows, rows\)/,
    `${path}: Part 2 confirm refuses a release above what is owed`,
  );
  assert.match(
    bodyOf("saveStep"),
    /assertHeldReleaseEdits\(applicable, currentRows, stepKey === "p1_held_release" \? "heldReleaseP1Value" : "heldReleaseValue"\)/,
    `${path}: a save can never raise a release above the Outstanding column`,
  );
  assert.match(
    bodyOf("assembleForRun"),
    /releaseOnlyMembers,/,
    `${path}: every sheet finance executes carries the leavers' releases`,
  );

  // ---- NOTHING IS RELEASED UNLESS HR CHOOSES IT (owner, 2026-11-09) ------------------------------
  //
  // "only who i choose because u were gonna make me mistake": the step used to pre-fill every held
  // person with everything due, so confirming it paid people he never picked. The box starts at 0,
  // what is owed shows as Due Now, and a figure he did enter is kept.
  const chooseBalances = new Map([["b2", [balance("run-sep", 9, 7265)]]]);
  const chooseDirectory = new Map([["b2", employee("B-2")]]);
  for (const part of [1, 2] as const) {
    const field = part === 1 ? "heldReleaseP1Value" : "heldReleaseValue";
    const [untouched] = recommendHeldRelease([], chooseDirectory, new Map(), chooseBalances, OCTOBER, new Map(), part);
    assert.ok(untouched, `Part ${part}: a held person is still listed`);
    assert.equal(untouched.values[field], 0, `Part ${part}: nobody is released until HR enters an amount`);
    assert.equal(untouched.recommended[field], 0, `Part ${part}: the system recommends no release on its own`);
    assert.equal(untouched.context["Due Now"], 7265, `Part ${part}: what is owed now is shown, so HR can choose it`);
    assert.equal(untouched.releaseOnly, true, `Part ${part}: someone on the step only for a held release is tinted as a resignation`);
    const chosen = recommendHeldRelease(
      [],
      chooseDirectory,
      new Map([["b2", draft("B-2", { [field]: 1183 })]]),
      chooseBalances,
      OCTOBER,
      new Map(),
      part,
    )[0];
    assert.equal(chosen?.values[field], 1183, `Part ${part}: an amount HR entered is kept`);

    // "at least what I add only": a held amount HR added while working in this run starts in the box,
    // never above what is due now; everyone else stays at 0, and a figure already saved still wins.
    const addedInRun = new Map([["b2", 9401]]);
    const added = recommendHeldRelease([], chooseDirectory, new Map(), chooseBalances, OCTOBER, new Map(), part, addedInRun)[0];
    assert.equal(added?.values[field], 7265, `Part ${part}: what HR added is pre-filled, capped at Due Now`);
    assert.equal(added?.recommended[field], 7265, `Part ${part}: and recommended, so confirming the step releases it`);
    const addedSmall = recommendHeldRelease([], chooseDirectory, new Map(), chooseBalances, OCTOBER, new Map(), part, new Map([["b2", 2201]]))[0];
    assert.equal(addedSmall?.values[field], 2201, `Part ${part}: only the added amount, not everything owed`);
    const otherPerson = recommendHeldRelease([], chooseDirectory, new Map(), chooseBalances, OCTOBER, new Map(), part, new Map([["b9", 5000]]))[0];
    assert.equal(otherPerson?.values[field], 0, `Part ${part}: someone HR did not add is still not released`);
    const savedZero = recommendHeldRelease(
      [],
      chooseDirectory,
      new Map([["b2", draft("B-2", { [field]: 0 })]]),
      chooseBalances,
      OCTOBER,
      new Map(),
      part,
      addedInRun,
    )[0];
    assert.equal(savedZero?.values[field], 0, `Part ${part}: a 0 HR saved is kept`);
  }

  // What Part 1 already released of an added amount is not added again in Part 2: 6,665 of the 7,265
  // owed was added and released in Part 1, so the 600 still due is NOT something HR added.
  const afterPart1 = recommendHeldRelease(
    [],
    chooseDirectory,
    new Map([["b2", draft("B-2", { heldReleaseP1Value: 6665 })]]),
    chooseBalances,
    OCTOBER,
    new Map(),
    2,
    new Map([["b2", 6665]]),
  )[0];
  assert.equal(afterPart1?.context["Due Now"], 600, "Part 2: Part 1's release comes off what is due");
  assert.equal(afterPart1?.values.heldReleaseValue, 0, "Part 2: nothing HR did not add is filled in after Part 1 released the added amount");
  const addedMore = recommendHeldRelease(
    [],
    chooseDirectory,
    new Map([["b2", draft("B-2", { heldReleaseP1Value: 6665 })]]),
    chooseBalances,
    OCTOBER,
    new Map(),
    2,
    new Map([["b2", 7000]]),
  )[0];
  assert.equal(addedMore?.values.heldReleaseValue, 335, "Part 2: only what was added beyond Part 1's release is filled in");
}

function statutoryRecord(overrides: Partial<SalaryRecord>): SalaryRecord {
  return {
    area: "Area 1",
    batchId: "batch-1",
    baseSalary: 15000,
    bonus: 0,
    calendarDays: 31,
    crm: 0,
    employeeCode: "",
    hrId: "B-1",
    employmentIncomeTax: 900,
    expenses: 0,
    extraCostOfLiving: 0,
    fingerPrint: 0,
    firstPart: 0,
    fuelAllowance: 0,
    fullName: "Test Employee",
    governmentalDeductions: 0,
    grossSalary: 15000,
    hireDate: null,
    nameAr: null,
    id: "rec-1",
    incentive: 0,
    jobTitle: "Medical Representative",
    line: "Line A",
    loans: 0,
    medicalInsurance: 0,
    monthSalary: 12000,
    netSalary: 15000,
    otherAdditions: 0,
    otherDeductions: 0,
    overtime: 0,
    payrollComment: null,
    paymentMode: "two_parts",
    secondPart: 0,
    socialInsurance: 0,
    totalAdditions: 0,
    totalDeductions: 0,
    unpaidVacations: 0,
    workingDays: 31,
    ...overrides,
  };
}

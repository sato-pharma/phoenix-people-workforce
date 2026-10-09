import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  claimsFor,
  describeReconciliation,
  reconcileDeductions,
} from "../src/lib/automated-payroll/deduction-reconciliation.ts";
import type { EmployeeDeductions } from "../src/lib/automated-payroll/deductions-source.ts";
import type { PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import type { DraftRow, RowLifecycle } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";

/**
 * Guards the run-versus-module reconciliation, whose whole difficulty is the ROUTING.
 *
 * A deduction bucket does not have one salary column. `isSettledInPart1` decides which it has, and
 * the Part 2 manual column carries loan and other TOGETHER while the Part 1 tab gives each its own.
 * Compare a bucket against the wrong column and the report invents a gap for money that is charged,
 * or misses one that is not — which is exactly what happened when this comparison was done by hand
 * in SQL on 2026-10-09 and gave two different answers for the same month.
 *
 * Every assertion below is a column the live steps write. If a recommender in recommend.ts is
 * changed to write somewhere else, `claimsFor` has to change with it and this fails first.
 */

const compact = (hrId: string) => hrId.toLowerCase().replace(/[^a-z0-9]+/g, "");

function member(hrId: string, lifecycle: RowLifecycle = "regular"): PopulationMember {
  return {
    // Only the three fields the reconciliation reads — hrId for the lookup, fullName for the
    // report (names, never codes), and the rest of the directory row is irrelevant here.
    employee: { hrId, fullName: `Employee ${hrId}` } as unknown as EmployeeDirectoryRow,
    compact: compact(hrId),
    lifecycle,
    lastWorkingDate: lifecycle === "leaver" ? "2026-09-20" : null,
    noticeLastWorkingDate: null,
  } as PopulationMember;
}

/** Keyed the way `salarySourceLookupKeys` keys it, so `lookupSource` can actually find it. */
function sources(
  entries: [string, "one_part" | "two_parts"][],
): Map<string, PayrollSalarySource> {
  const map = new Map<string, PayrollSalarySource>();
  for (const [hrId, paymentMode] of entries) {
    const source = { paymentMode } as unknown as PayrollSalarySource;
    map.set(hrId.toLowerCase(), source);
    map.set(compact(hrId), source);
  }
  return map;
}

function draft(hrId: string, patch: Partial<DraftRow>): DraftRow {
  return {
    runId: "run-1",
    employeeHrId: hrId,
    employeeHrIdCompact: compact(hrId),
    fingerprintValue: null,
    crm: null,
    unpaidVacations: null,
    manualOtherDeductions: null,
    p1odCrmValue: null,
    p1odVacationValue: null,
    p1odLoanValue: null,
    p1odOtherValue: null,
    settledInPart1: null,
    ...patch,
  } as unknown as DraftRow;
}

function approved(
  buckets: Partial<EmployeeDeductions["buckets"]>,
): EmployeeDeductions {
  return {
    buckets: { fingerprint: 0, crm: 0, unpaidVacation: 0, loan: 0, other: 0, ...buckets },
    lines: [],
    pendingLines: [],
  };
}

function deductionMap(entries: [string, EmployeeDeductions][]): Map<string, EmployeeDeductions> {
  return new Map(entries.map(([hrId, value]) => [compact(hrId), value]));
}

export function runAutomatedPayrollDeductionReconciliationTests() {
  // ---- LOAN + OTHER ARE ONE CLAIM IN PART 2 -------------------------------------------------
  // `recommendManualDeductions` recommends `buckets.loan + buckets.other` into the SINGLE
  // `manualOtherDeductions` column. Comparing either bucket against that column alone reports a
  // difference that does not exist: 1,000 against 1,250 reads as 250 under-charged, and 250
  // against 1,250 reads as 1,000 over-charged, on a row that is charged exactly right.
  {
    const report = reconcileDeductions({
      members: [member("B-50")],
      sources: sources([["B-50", "two_parts"]]),
      deductions: deductionMap([["B-50", approved({ loan: 1000, other: 250 })]]),
      draftRows: [draft("B-50", { manualOtherDeductions: 1250, settledInPart1: false })],
    });
    assert.deepEqual(
      report.rows.map((row) => [row.label, row.verdict, row.moduleAmount, row.runAmount]),
      [["Loan + Other · Part 2", "matches", 1250, 1250]],
      "loan and other must be compared TOGETHER against manualOtherDeductions",
    );
    assert.equal(report.differences.length, 0);
    assert.equal(report.netDifference, 0);
  }

  // ---- A ONE-PART EMPLOYEE TAKES LOAN AND OTHER IN SEPARATE PART 1 COLUMNS ------------------
  // Same two buckets, different routing: `recommendP1OtherDeductions` writes p1odLoanValue and
  // p1odOtherValue, and `recommendManualDeductions` recommends 0 for this population. Reading the
  // Part 2 column for them reports the whole 1,250 as missing.
  {
    const report = reconcileDeductions({
      members: [member("B-51")],
      sources: sources([["B-51", "one_part"]]),
      deductions: deductionMap([["B-51", approved({ loan: 1000, other: 250 })]]),
      draftRows: [draft("B-51", { p1odLoanValue: 1000, p1odOtherValue: 250, settledInPart1: true })],
    });
    assert.deepEqual(
      report.rows.map((row) => [row.label, row.verdict]).sort(),
      [
        ["Loan · Part 1", "matches"],
        ["Other · Part 1", "matches"],
      ].sort(),
      "a one-part employee's loan and other each have their OWN Part 1 column",
    );
    assert.equal(report.differences.length, 0);
  }

  // ---- A LEAVER'S CRM IS NOT FED BY DESIGN -------------------------------------------------
  // `recommendP1Crm` skips leavers outright, and `recommendResignationCrm` takes only the DAY
  // COUNT from the module, pricing it at the leaver's own net day rate (owner, 2026-08-30). The
  // module prices the same day off the BASE, so the two amounts differ legitimately and
  // subtracting them is meaningless. Reporting it as a gap is a false alarm on a final settlement.
  {
    const report = reconcileDeductions({
      members: [member("B-52", "leaver")],
      sources: sources([["B-52", "two_parts"]]),
      deductions: deductionMap([["B-52", approved({ crm: 1450 })]]),
      draftRows: [draft("B-52", { crm: 1200, settledInPart1: true })],
    });
    const crmRow = report.rows.find((row) => row.buckets.includes("crm"));
    assert.ok(crmRow, "the leaver's CRM bucket must still be reported");
    assert.equal(
      crmRow.verdict,
      "not comparable by design",
      "a leaver's CRM amount comes from the settlement engine, never from the module",
    );
    assert.equal(
      crmRow.runAmount,
      1200,
      "the leaver's CRM column holds REAL money and must be shown, never printed as 0.00",
    );
    assert.equal(report.differences.length, 0, "a by-design routing must not read as a difference");
    assert.equal(report.netDifference, 0);
    // ...but NEVER dropped. This is where the owner's own typed figure over the module's proposal
    // lives for a leaver, and a report showing only `differences` would lose it in silence —
    // measured on the September 2026 run, a 200.00 figure he typed himself at 03:28 Cairo.
    assert.equal(
      report.notComparableGaps.length,
      1,
      "a non-comparable claim whose sides still differ must stay visible, just uncounted",
    );
    assert.equal(report.notComparableGaps[0]?.difference, 250);
    assert.match(
      describeReconciliation(report),
      /priced by a different rule and are NOT counted above/,
      "the wording must say why the figure is not counted, not hide it",
    );
    assert.match(describeReconciliation(report), /Employee B-52/, "and it must name the person");
  }

  // ---- A ONE-PART CONTINUING EMPLOYEE'S CRM *IS* FED, INTO p1odCrmValue --------------------
  // The leaver carve-out above must not swallow this one: `recommendP1Crm` runs for exactly this
  // population, and widening "not comparable by design" to every settled-in-Part-1 employee would hide a
  // real under-charge.
  {
    const report = reconcileDeductions({
      members: [member("B-53")],
      sources: sources([["B-53", "one_part"]]),
      deductions: deductionMap([["B-53", approved({ crm: 1450 })]]),
      draftRows: [draft("B-53", { p1odCrmValue: 1250, settledInPart1: true })],
    });
    assert.deepEqual(
      report.rows.map((row) => [row.label, row.verdict, row.difference]),
      [["CRM · Part 1", "charged less", 200]],
      "a one-part continuing employee's CRM is fed into p1odCrmValue and IS comparable",
    );
    assert.equal(report.netDifference, 200);
  }

  // ---- A TRIM READS AS "CHARGED LESS", SIGNED THE RIGHT WAY --------------------------------
  // The September 2026 shape (one approved vacation day charged out of two). `difference` is
  // module − run, so a trim is POSITIVE and an over-charge is negative; the report's wording
  // depends on that sign.
  {
    const report = reconcileDeductions({
      members: [member("B-54"), member("B-55")],
      sources: sources([
        ["B-54", "two_parts"],
        ["B-55", "two_parts"],
      ]),
      deductions: deductionMap([
        ["B-54", approved({ unpaidVacation: 966.66 })],
        ["B-55", approved({ fingerprint: 100 })],
      ]),
      draftRows: [
        draft("B-54", { unpaidVacations: 483.33, settledInPart1: false }),
        draft("B-55", { fingerprintValue: 150, settledInPart1: false }),
      ],
    });
    const trim = report.rows.find((row) => row.hrId === "B-54");
    const over = report.rows.find((row) => row.hrId === "B-55");
    assert.equal(trim?.verdict, "charged less");
    assert.equal(trim?.difference, 483.33);
    assert.equal(over?.verdict, "charged more");
    assert.equal(over?.difference, -50);
    assert.equal(report.netDifference, 433.33);
    assert.match(describeReconciliation(report), /2 figure\(s\) differ/);
    assert.match(describeReconciliation(report), /Employee B-54/, "the report names people");
  }

  // ---- APPROVED MONEY FOR SOMEBODY NOT ON THE RUN IS REPORTED, NOT DROPPED -----------------
  // Iterating the population instead of the module's own keys loses this row in silence. September
  // 2026 had one: 733.33 approved for somebody terminated on 31 August, correctly not payable.
  {
    const report = reconcileDeductions({
      members: [],
      sources: sources([]),
      deductions: deductionMap([["A-7", approved({ other: 733.33 })]]),
      draftRows: [],
    });
    assert.equal(
      report.unreachable.length,
      1,
      "the comparison is driven by the MODULE keys, so approved money for somebody absent from the population is still reported",
    );
    assert.equal(report.unreachable[0]?.moduleAmount, 733.33);
    assert.equal(report.unreachable[0]?.verdict, "not on this run");
    assert.equal(
      report.differences.length,
      0,
      "money that cannot be charged on this run is not an under-charge",
    );
  }

  // ---- A DRAFT ROW WITH NO POPULATION ROW IS "NOT IN THE POPULATION", NOT AN UNDER-CHARGE --
  // The real September 2026 shape: somebody terminated on 31 August still has a draft row on the
  // run, but is outside the population, so NO recommender runs for them and no column can receive
  // the money. Reading that as 733.33 under-charged sends the reader hunting a shortfall against
  // an employee nobody can charge — and the name must still come through, not the HR id.
  {
    const report = reconcileDeductions({
      members: [],
      sources: sources([]),
      deductions: deductionMap([["A-7", approved({ unpaidVacation: 733.33 })]]),
      draftRows: [draft("A-7", { p1odCrmValue: 0, settledInPart1: null })],
      names: new Map([[compact("A-7"), "Ahmed Mohamed Rabiee Fayk Elkawas"]]),
    });
    assert.equal(
      report.unreachable.length,
      1,
      "a draft row for somebody outside the population belongs in unreachable, not in differences",
    );
    assert.equal(
      report.unreachable[0]?.verdict,
      "not in the population",
      "a draft row with no population row can receive nothing, so it is not a shortfall",
    );
    assert.equal(
      report.unreachable[0]?.fullName,
      "Ahmed Mohamed Rabiee Fayk Elkawas",
      "names, never codes — and this is exactly the row with no population name to fall back on",
    );
    assert.equal(report.differences.length, 0);
    assert.equal(report.netDifference, 0);
  }

  // ---- THE FROZEN STAMP BEATS THE LIVE RULE ------------------------------------------------
  // Once Part 1 is confirmed the routing is READ, not recomputed (the stamp exists because both
  // inputs move). A two-part regular employee stamped as settled in Part 1 takes their loan on the
  // Part 1 tab, and the live rule would send the comparison to the wrong column.
  {
    const report = reconcileDeductions({
      members: [member("B-56")],
      sources: sources([["B-56", "two_parts"]]),
      deductions: deductionMap([["B-56", approved({ loan: 1250 })]]),
      draftRows: [draft("B-56", { p1odLoanValue: 1250, settledInPart1: true })],
    });
    assert.deepEqual(
      report.rows.map((row) => [row.label, row.verdict]),
      [["Loan · Part 1", "matches"]],
      "the Part 1 stamp decides the routing, not the payment mode",
    );
    assert.equal(report.provisionalRouting, 0);
  }

  // ---- A NULL STAMP IS FLAGGED AS PROVISIONAL ----------------------------------------------
  // Before the Part 1 confirm the split is computed live and can still move, so the reading is of
  // today rather than a settled fact. Saying so is the difference between a report and a claim.
  {
    const report = reconcileDeductions({
      members: [member("B-57")],
      sources: sources([["B-57", "two_parts"]]),
      deductions: deductionMap([["B-57", approved({ fingerprint: 100 })]]),
      draftRows: [draft("B-57", { fingerprintValue: 100, settledInPart1: null })],
    });
    assert.equal(report.provisionalRouting, 1, "an unconfirmed Part 1 must be reported as such");
  }

  // ---- A LEAVER'S UNPAID VACATION IS SUMMED ACROSS BOTH COLUMNS ----------------------------
  // `recommendP1UnpaidVacation` writes p1odVacationValue but reads a leaver's saved figure back
  // from `unpaidVacations`, and assembleRows charges BOTH independently. Reading only one column
  // halves what the employee is actually charged.
  {
    const report = reconcileDeductions({
      members: [member("B-58", "leaver")],
      sources: sources([["B-58", "two_parts"]]),
      deductions: deductionMap([["B-58", approved({ unpaidVacation: 900 })]]),
      draftRows: [
        draft("B-58", { unpaidVacations: 400, p1odVacationValue: 500, settledInPart1: true }),
      ],
    });
    const vacation = report.rows.find((row) => row.buckets.includes("unpaidVacation"));
    assert.equal(vacation?.runAmount, 900, "both vacation columns are charged, so both are summed");
    assert.equal(vacation?.verdict, "matches");
  }

  // ---- THE CLAIM TABLE ITSELF ---------------------------------------------------------------
  // Pinned directly, because it is the one thing a reader has to be able to trust at a glance: no
  // bucket may reach two claims in the same routing (that would compare the same money twice).
  for (const [settled, leaver] of [
    [true, true],
    [true, false],
    [false, false],
  ] as const) {
    const claims = claimsFor(settled, leaver);
    const seen = claims.flatMap((claim) => claim.buckets);
    assert.equal(new Set(seen).size, seen.length, "a bucket may appear in only one claim");
    assert.equal(new Set(seen).size, 5, "every bucket must be claimed exactly once");
    const columns = claims.flatMap((claim) => claim.columns);
    assert.equal(new Set(columns).size, columns.length, "a column may be claimed only once");
  }
  assert.deepEqual(
    claimsFor(false, false).find((claim) => claim.columns.includes("manualOtherDeductions"))?.buckets,
    ["loan", "other"],
    "the Part 2 manual column carries loan AND other",
  );

  // ---- A REPORT THAT ANSWERS CORRECTLY HAS NOT FAILED --------------------------------------
  // The CLI exited 1 whenever anything differed, so pnpm printed "[ELIFECYCLE] Command failed
  // with exit code 1" underneath a perfectly good September 2026 answer — which reads as the tool
  // being broken rather than as the month holding three figures the owner decided himself. Exit 1
  // is now opt-in behind --gate, for a cron that needs to alarm. Pinned on the source because the
  // exit code lives in the script, and a one-character slip here is invisible until he runs it.
  {
    const script = readFileSync(
      path.join(import.meta.dirname, "..", "scripts", "reconcile-payroll-deductions.ts"),
      "utf8",
    );
    assert.ok(
      script.includes(`const gate = args.includes("--gate");`),
      "the gate must be an explicit opt-in flag",
    );
    assert.ok(
      script.includes("if (gate) process.exitCode = 1;"),
      "exit 1 must be reachable ONLY through --gate",
    );
    const unguarded = script
      .split(String.fromCharCode(10))
      .filter((line) => line.includes("process.exitCode") && !line.includes("if (gate)"));
    assert.deepEqual(
      unguarded,
      [],
      "no other line may set a non-zero exit code: a plain run of a read-only report always succeeds",
    );
  }
}

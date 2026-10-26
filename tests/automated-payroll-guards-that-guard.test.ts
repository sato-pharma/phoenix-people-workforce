import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import { reconcile } from "../src/lib/automated-payroll/reconcile.ts";
import type { SalaryValidationRow } from "../src/lib/payroll/salary-import.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Four guards that did not guard.
 *
 * 1. THE SPLIT CHECK COULD NOT FAIL. The one hard gate before Part 2 asserted
 *    `firstPart + secondPart === monthSalary`. `assembleParts` returns
 *    `monthSalary = roundCurrency(firstPart + secondPart)` on the line it builds them — the same
 *    expression on both sides. So it passed unconditionally on every run this module has ever done,
 *    and every real defect in the split recomputes monthSalary from the same two wrong numbers and
 *    sails through. It now compares the split against `totalPayable`, the locked engine's own answer
 *    for what the month owes, which the split does not derive from.
 *
 * 2. A PUBLISHED MONTH COULD BE STARTED AGAIN. `findActiveRun` sees only part1/part2/ready, and the
 *    one-run-per-month index excludes published runs, so Start on a paid month created a second,
 *    shadow run. It happened on production on 2026-09-10.
 *
 * 3. PUBLISH COULD MARK A RUN PUBLISHED OVER AN UNAPPROVED BATCH. The approve step matched on
 *    `status = "uploaded"` and only checked for an error; a zero-row match returned none. Payslips
 *    are visible only for an approved batch, and a published run returns early forever, so the month
 *    became permanently unpublishable with nothing to see.
 *
 * 4. PART 1 WAVED THROUGH WHAT PART 2 REFUSES. Part 1's data gate is acknowledgeable; Part 2's
 *    pre-flight is not, and refuses some of the same people. Walked end to end on staging: three
 *    employees with no salary were acknowledged at Part 1, frozen at 0.00, then Part 2 refused
 *    outright over the same three and the month was stuck.
 *
 * 1 and 2 of these are asserted behaviourally against the real function. 3 and 4 are call placement
 * inside an async service that needs a database, so they are asserted against comment-stripped
 * source, sliced to the one function each belongs to.
 */

function buildRow(overrides: {
  hrId?: string;
  firstPart: number;
  secondPart: number;
  totalPayable: number;
  overpaidResidual?: number;
}): AssembledRow {
  const firstPart = overrides.firstPart;
  const secondPart = overrides.secondPart;
  const row = {
    area: "Cairo",
    baseSalary: 10000,
    bonus: 0,
    calendarDays: 30,
    crm: 0,
    hrId: overrides.hrId ?? "B-1",
    employmentIncomeTax: 0,
    expenses: 0,
    extraCostOfLiving: 0,
    fingerPrint: 0,
    firstPart,
    fuelAllowance: 0,
    governmentalDeductions: 0,
    fullName: "Test Person",
    grossSalary: 10000,
    hireDate: null,
    incentive: 0,
    jobTitle: "Rep",
    line: "Line 1",
    loans: 0,
    medicalInsurance: 0,
    // EXACTLY what assembleParts does: monthSalary IS the split. Building the fixture this way is
    // the point — it is what makes the old check unable to fail.
    monthSalary: Math.round((firstPart + secondPart) * 100) / 100,
    nameAr: null,
    netSalary: 10000,
    otherAdditions: 0,
    otherDeductions: 0,
    overtime: 0,
    payrollComment: null,
    paymentMode: "two_parts",
    row: 1,
    secondPart,
    socialInsurance: 0,
    totalAdditions: 0,
    totalDeductions: 0,
    unpaidVacations: 0,
    workingDays: 30,
  } as SalaryValidationRow;
  return {
    row,
    compact: (overrides.hrId ?? "B-1").toLowerCase(),
    onHold: false,
    overpaidResidual: overrides.overpaidResidual ?? 0,
    totalPayable: overrides.totalPayable,
    carriedForwardApplied: 0,
    heldReleaseApplied: 0,
    lifecycle: "regular",
    bankName: "FAB",
    bankAccount: "1",
  };
}

export function runAutomatedPayrollGuardsThatGuardTests() {
  // ── 1. The split check can now fail, and fails on the case the old one missed ────────────────
  const healthy = reconcile([buildRow({ firstPart: 6000, secondPart: 4000, totalPayable: 10000 })]);
  assert.equal(healthy.splitMismatches.length, 0, "a split that agrees with the engine must not be flagged");

  // 2,000 of what the month owes reaches neither instalment. monthSalary is 9,000 — exactly
  // firstPart + secondPart — so the OLD assertion passes on this row. The new one must not.
  const lost = buildRow({ hrId: "B-2", firstPart: 6000, secondPart: 3000, totalPayable: 11000 });
  assert.equal(
    Math.round((lost.row.firstPart + lost.row.secondPart) * 100) / 100,
    lost.row.monthSalary,
    "fixture check: the old assertion (first + second === monthSalary) genuinely passes on this row, " +
      "which is what makes it worthless",
  );
  const broken = reconcile([lost]);
  assert.equal(
    broken.splitMismatches.length,
    1,
    "a split that loses money against the engine's own figure MUST be flagged — this is the row the " +
      "old check waved through",
  );
  assert.equal(broken.splitMismatches[0]?.totalPayable, 11000);
  assert.equal(broken.splitMismatches[0]?.hrId, "B-2");

  // The mirror: paying MORE than the month owes is equally a mismatch.
  const over = reconcile([buildRow({ hrId: "B-3", firstPart: 6000, secondPart: 6000, totalPayable: 11000 })]);
  assert.equal(over.splitMismatches.length, 1, "a split that pays more than the engine owes must be flagged");

  // ── 2. The overpaid branch is not a mismatch ─────────────────────────────────────────────────
  // When Part-2 deductions exceed the already-paid first instalment, secondPart is clamped to 0 and
  // the shortfall is carried as overpaidResidual. The identity must still hold in THAT branch, or
  // every overpaid employee would read as a code bug and block Part 2 for a legitimate state.
  const overpaid = reconcile([
    buildRow({ hrId: "B-4", firstPart: 9000, secondPart: 0, totalPayable: 7000, overpaidResidual: 2000 }),
  ]);
  assert.equal(
    overpaid.splitMismatches.length,
    0,
    "a legitimately overpaid row must NOT be reported as a split mismatch — the residual is what makes " +
      "the identity exact in that branch",
  );
  assert.equal(overpaid.overpaid.length, 1, "it is still reported as overpaid");

  // Rounding must not manufacture a mismatch on ordinary cents.
  const cents = reconcile([buildRow({ hrId: "B-5", firstPart: 3333.33, secondPart: 3333.34, totalPayable: 6666.67 })]);
  assert.equal(cents.splitMismatches.length, 0, "cents that add up exactly must not be flagged");

  // ── 3 & 4. Call placement, against the source ────────────────────────────────────────────────
  const path = "src/lib/automated-payroll/run-service.ts";
  const source = stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));

  function bodyOf(name: string): string {
    const start = source.search(new RegExp(`(export )?async function ${name}\\s*\\(`));
    assert.ok(start >= 0, `${path}: ${name} not found`);
    const end = source.indexOf("\n}\n", start);
    assert.ok(end > start, `${path}: could not find the end of ${name}`);
    return source.slice(start, end);
  }

  // A published month cannot be started again.
  const startBody = bodyOf("startOrResumeRun");
  assert.match(
    startBody,
    /findPublishedRun\(/,
    `${path}: startOrResumeRun must check for an already-published run — findActiveRun cannot see one, ` +
      "so without this, Start on a paid month creates a second shadow run (production, 2026-09-10)",
  );
  assert.match(
    startBody,
    /throw new Error\(/,
    `${path}: startOrResumeRun must REFUSE a published month, not fall through to createRun`,
  );

  // Publish proves the batch is approved.
  const publishBody = bodyOf("publishToPayslips");
  assert.match(
    publishBody,
    /assertBatchApproved\(/,
    `${path}: publishToPayslips must assert the batch actually reached "approved" before marking the ` +
      "run published — payslips are visible only for an approved batch, and a published run returns " +
      "early forever, so the month would be permanently unpublishable with nothing to see",
  );
  const finalizeBody = source.slice(source.search(/async function finalizeApproved\s*\(/));
  assert.match(
    finalizeBody.slice(0, 900),
    /\.select\("status"\)/,
    `${path}: finalizeApproved must read back what it changed — a zero-row match returns no error, ` +
      "which is exactly how an unapproved batch got published over",
  );

  // Part 1 runs the same hard validation Part 2 will.
  const part1Body = bodyOf("confirmPart1");
  assert.match(
    part1Body,
    /preflightValidate/,
    `${path}: confirmPart1 must run the same pre-flight Part 2 runs, BEFORE freezing money. Part 1's ` +
      "data gate is acknowledgeable and Part 2's pre-flight is not, so without this Part 1 waves " +
      "through people Part 2 will refuse and the month gets stuck after money is already frozen",
  );
  const freezeAt = part1Body.search(/computeFrozenFirstParts\(/);
  const preflightAt = part1Body.search(/preflightValidate/);
  assert.ok(
    preflightAt >= 0 && freezeAt > preflightAt,
    `${path}: the pre-flight must run BEFORE computeFrozenFirstParts — validating after the freeze ` +
      "would report the problem with the money already committed",
  );
}

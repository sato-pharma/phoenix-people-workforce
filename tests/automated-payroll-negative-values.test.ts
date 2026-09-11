import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assertNoNegativeStepValues, findNegativeStepValues } from "../src/lib/automated-payroll/negative-values.ts";
import { stepDefinition } from "../src/lib/automated-payroll/step-definitions.ts";
import type { StepRow } from "../src/lib/automated-payroll/types.ts";
import { validateSalaryRows, type SalaryValidationRow } from "../src/lib/payroll/salary-import.ts";

/**
 * NOTHING ON A PAYROLL STEP MAY BE NEGATIVE (audit finding 42).
 *
 * No layer refused a negative figure. A negative bonus is a deduction travelling through the
 * additions side, where no deduction guard can see it, and a negative loan is an addition nobody
 * approved. The pre-flight validator checked only base, net, gross and the deductions TOTAL, and a
 * negative component is already folded into the total it is reconciled against, so neither check
 * could fire.
 *
 * Two doors are pinned: `saveStep`, which both the inline grid and a re-uploaded sheet come through,
 * and the shared salary validator every publish re-runs.
 */

function salaryRow(overrides: Partial<SalaryValidationRow> = {}): SalaryValidationRow {
  return {
    area: "Cairo", baseSalary: 10000, bonus: 0, calendarDays: 30, crm: 0, hrId: "B-1",
    employmentIncomeTax: 0, expenses: 0, extraCostOfLiving: 0, fingerPrint: 0, firstPart: 5000,
    fuelAllowance: 0, governmentalDeductions: 0, fullName: "Test Person", grossSalary: 10000,
    hireDate: "2024-01-01", incentive: 0, jobTitle: "Medical Rep", line: "CNS", loans: 0,
    medicalInsurance: 0, monthSalary: 10000, nameAr: null, netSalary: 10000, otherAdditions: 0,
    otherDeductions: 0, overtime: 0, payrollComment: null,
    paymentMode: "two_parts" as SalaryValidationRow["paymentMode"], row: 2, secondPart: 5000,
    socialInsurance: 0, totalAdditions: 0, totalDeductions: 0, unpaidVacations: 0, workingDays: 30,
    ...overrides,
  };
}

const current: StepRow[] = [
  {
    hrId: "B-7", fullName: "Mona Adel", jobTitle: null, line: null, context: {}, values: {},
    recommended: {}, reason: null, onHold: false,
  },
];

export function runAutomatedPayrollNegativeValuesTests() {
  // ---- HEADLINE: a negative addition is refused at the step save ---------------------------------
  const additions = stepDefinition("p2_additions");
  assert.throws(
    () => assertNoNegativeStepValues(additions, [{ hrId: "B-7", values: { incentive: 500, bonus: -300 } }], current),
    (error: unknown) =>
      error instanceof Error &&
      /^Validation:/.test(error.message) &&
      error.message.includes("Mona Adel: Bonus -300"),
    "a negative bonus must be refused by name and field: it is a deduction no deduction check can see",
  );

  // Found case-insensitively by HR id, and named by the person, not the code.
  const found = findNegativeStepValues(additions, [{ hrId: "b-7", values: { bonus: -300 } }], current);
  assert.equal(found.length, 1);
  assert.equal(found[0].fullName, "Mona Adel");
  assert.equal(found[0].field, "Bonus");

  // A negative day count too: it drives a negative amount through the step's own day-rate.
  const noRecord = stepDefinition("p1_no_record");
  assert.throws(
    () => assertNoNegativeStepValues(noRecord, [{ hrId: "B-7", values: { p1odNoRecordDays: -2 } }], current),
    /Day Without Record Days -2/,
    "a negative day count must be refused as well",
  );

  // Zero and positive figures are untouched.
  assert.doesNotThrow(() =>
    assertNoNegativeStepValues(noRecord, [{ hrId: "B-7", values: { p1odNoRecordDays: 0, p1odNoRecordValue: 0 } }], current),
  );
  assert.deepEqual(findNegativeStepValues(additions, [{ hrId: "B-7", values: { incentive: 500 } }], current), []);

  // ---- saveStep actually asks, before anything is written ---------------------------------------
  const source = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const start = source.indexOf("export async function saveStep(");
  const end = source.indexOf("\nexport ", start + 10);
  assert.ok(start > 0 && end > start, "saveStep and its end must be found");
  const body = source.slice(start, end);
  assert.ok(body.length > 1000 && body.length < 14000, `the slice must stay bounded to saveStep (got ${body.length})`);
  const guardAt = body.indexOf("assertNoNegativeStepValues(");
  assert.ok(guardAt > 0, "saveStep must refuse negative values: it is the one door the grid and the sheet share");
  assert.ok(guardAt < body.indexOf("await upsertDraftRows("), "the refusal must come before anything is written");

  // ---- The shared validator checks every component, not just the totals ---------------------------
  const negativeColumns = (row: SalaryValidationRow) =>
    validateSalaryRows([row])
      .filter((issue) => issue.code === "negative_value")
      .map((issue) => issue.column)
      .sort();

  assert.deepEqual(negativeColumns(salaryRow()), [], "a row with no negative figure raises no negative issue");
  assert.deepEqual(
    negativeColumns(salaryRow({ bonus: -300, loans: -150 })),
    ["Bonus", "Loans"],
    "a negative bonus and a negative loan must each be flagged, even though each hides inside its total",
  );
  for (const [field, column] of [
    ["expenses", "Expenses"],
    ["incentive", "Incentive"],
    ["overtime", "Overtime"],
    ["otherAdditions", "Other Additions"],
    ["crm", "CRM"],
    ["fingerPrint", "Finger Print"],
    ["unpaidVacations", "Unpaid Vacations"],
    ["medicalInsurance", "Medical Insurance"],
    ["otherDeductions", "Other Deductions"],
  ] as const) {
    assert.deepEqual(
      negativeColumns(salaryRow({ [field]: -1 } as Partial<SalaryValidationRow>)),
      [column],
      `a negative ${column} must be flagged`,
    );
  }
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dayDrivenMoney, STEP_DEFINITIONS } from "../src/lib/automated-payroll/step-definitions.ts";
import { calculateDeductionAmountFromBaseSalary } from "../src/lib/deductions/calculations.ts";
import { calendarDaysInMonth } from "../src/lib/payroll/copilot/proration.ts";
import type { StepFieldSpec } from "../src/lib/automated-payroll/types.ts";

/**
 * ONE DAY RATE — the owner's ruling of 2026-09-12, closing audit finding 37.
 *
 * He was sent the question as a sheet with three dropdowns and answered:
 *
 *   Q1  what a deducted day is worth  ->  "Actual calendar days (28-31)"
 *   Q2  the same divisor for joiner/leaver pay and for deductions  ->  "Yes - one divisor for both"
 *   Q3  from which month  ->  "From September 2026"            Note: "to future"
 *
 * WHAT WAS WRONG. Three divisors were live at once. Joiner and leaver pay divided by the month's
 * real calendar days (since 2026-08-29). The unified Deductions module divided by the month's real
 * calendar days (since 2026-08-01). But eleven of Automated Payroll's thirteen day-driven money
 * fields divided by a flat 30 — the rate he set on 2026-07-25 and corrected the same day everywhere
 * except here. So one day was worth one amount when it was PAID and a different amount when it was
 * TAKEN AWAY: in a 31-day month the flat 30 deducted about 3.3% MORE than the day it cancelled, and
 * in February about 6.7% LESS. Wrong in both directions, never visible on a payslip, and — because
 * a 30-day month makes the two divisors identical — invisible to any spot check done in September,
 * June, April or November.
 *
 * FROM SEPTEMBER 2026 FORWARD. August 2026 was published and announced before the ruling, and a
 * published month is never corrected however justified the fix. Nothing here reaches it: the
 * divisor is read at compute time from the run's own month, so re-opening an August run is the only
 * way to move an August figure, and a published run cannot be re-opened.
 *
 * THE FLAT-30 FUNCTION IS GONE, not deprecated. `flat-deduction-rate.ts` existed solely to keep
 * Automated Payroll on ÷30 after the deductions-governance module was deleted, and its own doc
 * comment warned the next reader NOT to swap in the calendar-day twin. That warning is what this
 * ruling overturns, so the file is deleted rather than left as a trap someone re-imports.
 */
export async function runPayrollDayRateDivisorTests(): Promise<void> {
  const noRecordDays = STEP_DEFINITIONS.p1_no_record.fields.find((field) => field.key === "p1odNoRecordDays");
  const base = { "Base Salary": 9000 };

  // ---- Q1: a deducted day is worth the month's own day ------------------------------------------
  assert.equal(
    dayDrivenMoney(noRecordDays, base, 5, 31).p1odNoRecordValue,
    1451.61,
    "HEADLINE: in a 31-day month five deducted days cost 9,000 ÷ 31 × 5 = 1,451.61, not the 1,500 a flat 30 charged",
  );
  assert.equal(
    dayDrivenMoney(noRecordDays, base, 5, 28).p1odNoRecordValue,
    1607.14,
    "HEADLINE: and in February the same five days cost MORE, not less — the flat 30 was wrong in both directions",
  );
  assert.equal(
    dayDrivenMoney(noRecordDays, base, 5, 30).p1odNoRecordValue,
    1500,
    "a 30-day month is the one where nothing changes — which is exactly why the split survived so long unnoticed",
  );

  // ---- Q2: ONE divisor. What pays a day is what a deducted day costs ----------------------------
  // A leaver worked 26 of August's 31 days, so 5 days were not worked. The pay side prices the 26,
  // the deduction side prices the 5. They must be two ends of one number.
  const august = calendarDaysInMonth({ month: 8, year: 2026 });
  assert.equal(august, 31, "August 2026 has 31 days — the month where the two divisors visibly disagreed");
  const paidFor26 = dayDrivenMoney(noRecordDays, base, 26, august).p1odNoRecordValue!;
  const deductedFor5 = dayDrivenMoney(noRecordDays, base, 5, august).p1odNoRecordValue!;
  assert.ok(
    Math.abs(paidFor26 + deductedFor5 - 9000) < 0.02,
    `HEADLINE: the days paid and the days deducted must add back up to the whole salary — got ${paidFor26} + ${deductedFor5}`,
  );

  // The same figure the unified Deductions module has charged since 2026-08-01. One rule, two
  // modules, no drift — the drift is the entire finding.
  assert.equal(
    dayDrivenMoney(noRecordDays, base, 5, august).p1odNoRecordValue,
    calculateDeductionAmountFromBaseSalary({ baseSalary: 9000, deductionDays: 5, month: 8, year: 2026 }),
    "HEADLINE: Automated Payroll and the Deductions module must price a deducted day identically — they disagreed by 3.3% until this ruling",
  );

  // ---- Every day-driven field obeys it, not just the two that already did -----------------------
  // Eleven of thirteen carried no divisor key at all and silently fell back to 30. A field added
  // tomorrow with no divisor key must inherit the month, not the retired rate.
  let dayDriven = 0;
  for (const definition of Object.values(STEP_DEFINITIONS)) {
    for (const field of definition.fields as StepFieldSpec[]) {
      if (!field.autoCalcMoneyKey) continue;
      dayDriven += 1;
      const context: Record<string, string | number | null> = {
        "Base Salary": 9000,
        "Net Salary": 9000,
        "Extra Cost Of Living": 0,
        "Fuel Allowance": 0,
      };
      if (field.autoCalcDivisorContextKey) context[field.autoCalcDivisorContextKey] = 31;
      const money = dayDrivenMoney(field, context, 5, 31);
      assert.equal(
        money[field.autoCalcMoneyKey],
        1451.61,
        `${definition.key}.${field.key} must price 5 days of 9,000 at ÷31 (got ${money[field.autoCalcMoneyKey]}); a flat 30 would give 1,500`,
      );
    }
  }
  assert.ok(dayDriven >= 13, `expected the 13 known day-driven money fields, found ${dayDriven}`);

  // ---- Fail closed. A caller that cannot say how long the month is prices NOTHING ---------------
  // This is the shape of the original defect: the divisor used to be `|| 30`, so a call site that
  // never supplied a month silently got the retired rate and nothing said so. Eleven fields reached
  // production that way. A blank cell HR can see beats a wrong number nobody can.
  assert.deepEqual(
    dayDrivenMoney(noRecordDays, base, 5, 0),
    {},
    "HEADLINE: with no month length nothing is priced — it must NEVER fall back to a flat 30, which is how eleven fields ended up on the retired rate",
  );
  assert.deepEqual(dayDrivenMoney(noRecordDays, base, 5, Number.NaN), {}, "and an unusable month length is not a month length");
  assert.deepEqual(dayDrivenMoney(noRecordDays, base, 5, -31), {}, "nor is a negative one");

  // A divisor column that exists but is empty falls through to the month, rather than to 30 or to
  // a division by zero.
  const resignationCrm = STEP_DEFINITIONS.p1_resignation_crm.fields.find((field) => field.key === "resignationCrmDays");
  assert.equal(
    dayDrivenMoney(resignationCrm, { "Net Salary": 9000, "Days In Month": 0 }, 5, 31).crm,
    1451.61,
    "an empty divisor column falls back to the month, never to a flat 30 and never to a divide-by-zero",
  );

  // ---- The retired rate must not come back --------------------------------------------------- //
  assert.throws(
    () => readFileSync("src/lib/automated-payroll/flat-deduction-rate.ts", "utf8"),
    "HEADLINE: flat-deduction-rate.ts is deleted, not deprecated — its own comment told the next reader to keep the ÷30, and that is the trap this ruling removes",
  );

  const sources = [
    "src/lib/automated-payroll/step-definitions.ts",
    "src/lib/automated-payroll/recommend.ts",
    "src/lib/automated-payroll/imports/day-driven-money.ts",
    "src/components/automated-payroll/recommendation-step.tsx",
    "src/components/attendance/employee-day-report.tsx",
  ];
  for (const path of sources) {
    const body = readFileSync(path, "utf8");
    assert.ok(
      !/calculateFlat30DeductionAmount/.test(body),
      `${path} must not reach for the retired flat-30 function`,
    );
    assert.ok(
      !/\/\s*30\s*\)\s*\*/.test(body),
      `HEADLINE: ${path} must not divide a salary by a literal 30 — the divisor is the month's own length`,
    );
  }

  // ---- Both callers hand the month in, from the run itself --------------------------------------
  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  assert.match(
    runService,
    /applyDayDrivenMoney\(\{[\s\S]*?monthDays: calendarDaysInMonth\(\{ month: run\.month, year: run\.year \}\)/,
    "HEADLINE: a re-uploaded sheet is priced at the RUN's own month, so the xlsx path and the grid can never disagree",
  );
  const grid = readFileSync("src/components/automated-payroll/recommendation-step.tsx", "utf8");
  assert.match(
    grid,
    /dayDrivenMoney\(spec, row\.context, days, period \? calendarDaysInMonth\(period\) : 0\)/,
    "HEADLINE: the grid prices what HR types at the run's own month, and prices nothing if it does not know the month",
  );

  // ---- The day report on screen must equal what Approve actually charges ------------------------
  // It promised in its own comment that it mirrored the server, and divided by 30 while the server
  // divided by the month. A reviewer in a 31-day month approved a figure 3.3% above what was saved.
  const dayReport = readFileSync("src/components/attendance/employee-day-report.tsx", "utf8");
  assert.match(
    dayReport,
    /calculateDeductionAmountFromBaseSalary\(\{ baseSalary, deductionDays: parsedDays, month, year \}\)/,
    "HEADLINE: the day report shows the figure the server will save, computed by the server's own function — not a flat-30 lookalike",
  );

  // ---- The sentences HR reads must not still quote the retired rate ------------------------------
  for (const path of ["src/lib/automated-payroll/step-definitions.ts", "src/lib/automated-payroll/data-quality.ts"]) {
    assert.ok(
      !/Base\/30/.test(readFileSync(path, "utf8")),
      `HEADLINE: ${path} still tells HR the rate is Base/30 — help text that contradicts the arithmetic is how a retired rule gets restored`,
    );
  }
}

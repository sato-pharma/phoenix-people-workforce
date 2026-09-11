import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { effectiveSalary } from "../src/lib/automated-payroll/split.ts";
import { resolveReadyLifecycleSettlement } from "../src/lib/payroll/ready-proration.ts";
import {
  formatWorkingDays,
  isPayrollNumericHeader,
  payrollCountHeaders,
  payrollMoneyHeaders,
  payrollSheetHeaders,
  payrollSheetSections,
  payrollSheetValue,
} from "../src/lib/payroll/salary-sheet-fields.ts";
import type { SalaryRecord } from "../src/lib/payroll/types.ts";

/**
 * The payroll sheet's COLUMN GEOMETRY, and the day count that was added to it on
 * 2026-09-04 when the owner asked for the full salary to be shown with the
 * worked days beside it rather than a written-down salary.
 *
 * Two failure modes are pinned here, and neither one announces itself:
 *
 *  1. `payrollSheetSections` is POSITIONAL — integer start/end column numbers
 *     over `payrollSheetHeaders`. Inserting a header shifts every band after it,
 *     and a band left pointing at the old numbers still renders: the payslip
 *     simply files Base Salary under "Employee Data" and nobody notices until an
 *     employee reads it.
 *  2. Several writers emit a row as a POSITIONAL array. A column added to the
 *     header list but not to those arrays shifts every value one place left, so
 *     the income tax lands under Loans — again with no error anywhere.
 *
 * The money invariant is pinned too: showing the full contract must not change
 * what anybody is paid.
 */
export async function runPayrollSheetSectionsTests() {
  // ── geometry ──────────────────────────────────────────────────────────────
  const sorted = [...payrollSheetSections].sort((a, b) => a.start - b.start);

  assert.equal(sorted[0].start, 1, "the first section must start at column 1");
  assert.equal(
    sorted[sorted.length - 1].end,
    payrollSheetHeaders.length,
    "the last section must end on the last header — a header past the final band renders unstyled",
  );

  for (const section of sorted) {
    assert.ok(
      section.start <= section.end,
      `section ${section.label} has start ${section.start} past end ${section.end}`,
    );
  }

  for (let index = 1; index < sorted.length; index += 1) {
    assert.equal(
      sorted[index].start,
      sorted[index - 1].end + 1,
      `sections ${sorted[index - 1].label} and ${sorted[index].label} must be adjacent — a gap leaves a column in no band, an overlap files it under two`,
    );
  }

  // Every header resolves to exactly one band.
  for (let column = 1; column <= payrollSheetHeaders.length; column += 1) {
    const matches = payrollSheetSections.filter(
      (section) => column >= section.start && column <= section.end,
    );
    assert.equal(
      matches.length,
      1,
      `column ${column} (${payrollSheetHeaders[column - 1]}) belongs to ${matches.length} sections, expected exactly 1`,
    );
  }

  // ── the day count's place in the row ──────────────────────────────────────
  const workingDaysIndex = payrollSheetHeaders.indexOf("Working Days");
  const baseSalaryIndex = payrollSheetHeaders.indexOf("Base Salary");
  assert.ok(workingDaysIndex >= 0, "the sheet must carry a Working Days column");
  assert.equal(
    workingDaysIndex + 1,
    baseSalaryIndex,
    "Working Days must sit immediately before Base Salary — it is the column that explains it",
  );

  // It is a COUNT, not money: the totals row sums `payrollMoneyHeaders`, and a
  // company-wide sum of day counts would be meaningless under that heading.
  assert.ok(payrollCountHeaders.has("Working Days"), "Working Days must be a count header");
  assert.ok(
    !payrollMoneyHeaders.has("Working Days"),
    "Working Days must NOT be a money header — that set drives the currency format AND the TOTALS row",
  );
  assert.ok(
    isPayrollNumericHeader("Working Days"),
    "Working Days is still numeric, so it right-aligns with the figures around it",
  );

  // ── the value, and how it reads ───────────────────────────────────────────
  const record = { calendarDays: 31, workingDays: 26 } as SalaryRecord;
  assert.equal(
    payrollSheetValue(record, 8, 2026, 1, "Working Days"),
    26,
    "the Working Days cell must be the record's own count",
  );

  assert.equal(formatWorkingDays({ calendarDays: 31, workingDays: 26 }), "26 of 31");
  assert.equal(
    formatWorkingDays({ calendarDays: 0, workingDays: 0 }),
    "",
    "a row written before the column existed must say NOTHING — a 0 there reads as 'worked no days'",
  );
  assert.equal(
    formatWorkingDays({ calendarDays: 0, workingDays: 26 }),
    "26",
    "with no denominator recorded, state the numerator alone rather than inventing a month length",
  );

  // ── the money invariant: full salary shown, prorated pay unchanged ────────
  const contract = { baseSalary: 12000, extraCostOfLiving: 3000, fuelAllowance: 2500 };
  const contractNet = contract.baseSalary + contract.extraCostOfLiving + contract.fuelAllowance;
  const period = { month: 8, year: 2026 }; // 31 days

  const joiner = effectiveSalary({
    ...contract,
    netSalary: contractNet,
    period,
    lifecycle: "joiner",
    hireDate: "2026-08-20",
  });
  assert.equal(joiner.calendarDays, 31);
  assert.equal(joiner.workingDays, 12, "20th to the 31st inclusive is 12 days");
  assert.ok(
    joiner.net < contractNet,
    "the joiner's EFFECTIVE net must still be prorated — this is the figure the money is built from",
  );
  assert.equal(
    joiner.net,
    Math.round(((contractNet / 31) * 12 + Number.EPSILON) * 100) / 100,
    "a joiner is paid net / calendar days x days worked (owner, 2026-08-29)",
  );

  // The >25th leaver is the trap. He is PAID a full month, and it would be easy
  // to report the day count the money used (31). The count must stay
  // date-derived, or this sheet and the Ready sheet disagree about how long
  // somebody was actually here.
  const lateLeaver = effectiveSalary({
    ...contract,
    netSalary: contractNet,
    period,
    lifecycle: "leaver",
    lastWorkingDate: "2026-08-28",
    // The assertion below is Rule 1's >25th waiver, which belongs to genuine resignations only.
    isResignation: true,
  });
  assert.equal(
    lateLeaver.net,
    contractNet,
    "a resignation after the 25th is paid the FULL month (owner Rule 1) — do not prorate it",
  );
  assert.equal(
    lateLeaver.workingDays,
    28,
    "...but Working Days must read the REAL 28 days, never the 31 the payment implies",
  );

  // The Ready sheet resolves the same person independently. The two engines must
  // agree on the count, or one workbook contradicts the other.
  const readySettlement = resolveReadyLifecycleSettlement({
    ...contract,
    hireDate: "2020-01-01",
    isResignation: true,
    lastWorkingDate: "2026-08-28",
    month: 8,
    year: 2026,
  });
  assert.equal(readySettlement.calendarDays, 31);
  assert.equal(
    readySettlement.workingDays,
    lateLeaver.workingDays,
    "the Ready sheet and the automated engine must report the SAME working days for the same person",
  );
  assert.equal(
    readySettlement.prorationDeduction,
    0,
    "and the >25th leaver is still deducted nothing — the count explains the row, it does not move money",
  );

  // An HR settlement override changes what is PAID. It must not restate how long
  // the person was here.
  const overridden = effectiveSalary({
    ...contract,
    netSalary: contractNet,
    period,
    lifecycle: "joiner",
    hireDate: "2026-08-20",
    overrideBase: 9000,
  });
  assert.notEqual(
    overridden.net,
    joiner.net,
    "the override must reach the money (guard against a vacuous assertion below)",
  );
  assert.equal(
    overridden.workingDays,
    12,
    "an HR override moves the settlement, never the calendar — Working Days stays date-derived",
  );

  // An ordinary full-month row reports the whole month and nothing unusual.
  const regular = effectiveSalary({
    ...contract,
    netSalary: contractNet,
    period,
    lifecycle: "regular",
  });
  assert.equal(regular.workingDays, 31);
  assert.equal(regular.calendarDays, 31);
  assert.equal(regular.net, contractNet);

  // ── failure mode 2: the positional row arrays ─────────────────────────────
  // app/api/payroll/template/route.ts emits each row as a bare array whose
  // ORDER is the header order. A column added to the header list but not to
  // those arrays shifts every later value one place left — the income tax lands
  // under Loans and the workbook still opens cleanly. Nothing else can catch
  // this: TypeScript does not check the length of an array literal against a
  // separate list, and the route is a Next.js handler that a unit test cannot
  // call. So count the elements structurally.
  const routeSource = readFileSync(
    new URL("../app/api/payroll/template/route.ts", import.meta.url),
    "utf8",
  );

  // "Bank" and "Bank Account" are appended to the sheet headers by the route.
  const templateColumnCount = payrollSheetHeaders.length + 2;
  assert.match(
    routeSource,
    /const headers: PayrollTemplateHeader\[\] = \[\.\.\.payrollSheetHeaders, "Bank", "Bank Account"\];/,
    "the template's header row must still be payrollSheetHeaders plus the two bank columns",
  );

  for (const [label, anchor] of [
    ["formula row", "    return [\n      index,"],
    ["plain row", "  return [\n    index,"],
  ] as const) {
    const at = routeSource.indexOf(anchor);
    assert.ok(at >= 0, `could not find the ${label} array in the template route`);
    const elements = topLevelElements(routeSource, routeSource.indexOf("[", at));
    assert.equal(
      elements.length,
      templateColumnCount,
      `the template route's ${label} must emit exactly ${templateColumnCount} values, one per header — it emits ${elements.length}, so every column after the missing one is written into its neighbour's cell`,
    );
    // And the day count must be in the slot the header list gives it.
    assert.match(
      elements[workingDaysIndex],
      /workingDays/,
      `the ${label}'s value at the Working Days position must be the day count`,
    );
    assert.match(
      elements[baseSalaryIndex],
      /baseSalary/,
      `the ${label}'s value at the Base Salary position must be the base salary`,
    );
  }
}

/**
 * Top-level elements of the array literal beginning at `open`. Depth-counted
 * rather than split on commas, because these arrays hold nested calls and
 * template literals full of Excel formulas — and anchored on the array's own
 * text rather than a byte offset, so an edit elsewhere in the file cannot make
 * this read the wrong region.
 */
function topLevelElements(source: string, open: number): string[] {
  let depth = 0;
  let start = open + 1;
  const out: string[] = [];
  let quote: string | null = null;
  let inTemplate = false;

  for (let i = open; i < source.length; i += 1) {
    const character = source[i];

    if (quote) {
      if (character === quote && source[i - 1] !== "\\") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "`") {
      inTemplate = !inTemplate;
      continue;
    }
    if (inTemplate) continue;

    if (character === "[" || character === "(" || character === "{") {
      depth += 1;
    } else if (character === "]" || character === ")" || character === "}") {
      depth -= 1;
      if (depth === 0) {
        out.push(source.slice(start, i).trim());
        return out.filter((entry) => entry.length > 0);
      }
    } else if (character === "," && depth === 1) {
      out.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }

  throw new Error("unterminated array literal in the payroll template route");
}

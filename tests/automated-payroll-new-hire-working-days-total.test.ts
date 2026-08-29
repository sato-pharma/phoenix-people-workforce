import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { buildStepTemplateWorkbook, stepTemplateColumns } from "../src/lib/automated-payroll/exports/step-template.ts";
import { STEP_DEFINITIONS, stepFieldsTotal } from "../src/lib/automated-payroll/step-definitions.ts";
import type { MonthlySalaryRun, StepRow } from "../src/lib/automated-payroll/types.ts";

/**
 * Guards the New hires "Total (month)" line — the total of the three figures a
 * joiner is actually paid this month (owner request 2026-08-29: "add the total
 * of the working days net ... instead of me [having] to revise [it] manual[ly]").
 *
 * The card lets HR edit prorated Base, Extra Cost of Living and Fuel. Nothing
 * added them up, so checking a revised set meant adding three numbers by hand.
 *
 * The one thing that makes this total worth having is that it follows an EDIT.
 * A "This Month Net" CONTEXT column used to show the same quantity and was
 * removed on the owner's instruction the same day: `StepRow.context` is computed
 * once on the server and the grid's `setValue` writes only to `StepRow.values`,
 * so it froze at the figure it was loaded with and disagreed with the boxes the
 * moment one was edited — exactly when it was being read. This total must never
 * acquire that defect, so the headline assertion here is that it is summed from
 * the live `values` and MOVES when one of them is edited.
 */
export async function runAutomatedPayrollNewHireWorkingDaysTotalTests() {
  const definition = STEP_DEFINITIONS.p1_new_hires;
  const spec = definition.fieldsTotal;

  // ---- 1. the step declares a total, and it is legible -----------------------

  assert.ok(spec, "New hires must declare a total of the working-days figures — the owner asked for it");
  assert.equal(spec.label, "Total (month)", "the total's label is what HR reads on the card and in the xlsx header");

  const fieldLabels = definition.fields.map((field) => field.label);
  assert.ok(
    !fieldLabels.includes(spec.label),
    "the total's label must not collide with an editable field's — step-parser.ts matches re-uploaded columns by header name, " +
      "so a collision would feed a read-only total back in as someone's salary",
  );
  assert.ok(
    !definition.contextColumns.some((column) => column.label === spec.label),
    "the total's label must not collide with a context column's — two identical headers make the sheet unreadable",
  );

  // ---- 2. it totals EVERY money field on the step, not just some of them -----

  const moneyFieldKeys = definition.fields.filter((field) => field.kind === "money").map((field) => field.key);
  assert.deepEqual(
    [...spec.fieldKeys].sort(),
    [...moneyFieldKeys].sort(),
    "a 'total' that omits one of the step's money fields is not a total — it is a third number nobody can reconcile",
  );
  assert.deepEqual(
    spec.fieldKeys,
    ["baseForMonth", "ecolPaid", "fuelPaid"],
    "the working-days total is Base (month) + Extra Cost of Living + Fuel Allowance",
  );

  // ---- 3. the arithmetic, in cents ------------------------------------------

  // A real 4-day August joiner on 18,000: the engine rounds each component to
  // cents, and these three summed raw come out 2612.8999999999996.
  const row = buildRow({ baseForMonth: 2322.58, ecolPaid: 217.74, fuelPaid: 72.58 });
  assert.equal(
    stepFieldsTotal(definition, row.values),
    2612.9,
    "the three components must add up to the cent — summed raw these floats print 2612.8999999999996 on a payroll screen",
  );

  assert.equal(
    stepFieldsTotal(definition, { baseForMonth: 1000 }),
    1000,
    "a field with no value counts as zero, matching how the grid renders an empty money box",
  );

  // ---- 4. THE HEADLINE: the total moves with the edit -----------------------

  // The row as loaded, then as it looks after HR has typed a correction into the
  // Base box but before saving anything.
  const loaded = buildRow({ baseForMonth: 2322.58, ecolPaid: 217.74, fuelPaid: 72.58 });
  const onLoad = stepFieldsTotal(definition, loaded.values);

  const edited = { ...loaded.values, baseForMonth: 9000 };
  const afterEdit = stepFieldsTotal(definition, edited);

  assert.equal(
    afterEdit,
    9290.32,
    "the total must be summed from the EDITABLE values — 9000 + 217.74 + 72.58",
  );
  assert.notEqual(
    afterEdit,
    onLoad,
    "the total must MOVE when a box is edited — a total that stays at the loaded figure is worthless precisely when " +
      "HR is revising, which is why the server-computed 'This Month Net' column was retired",
  );

  // And it must not be reachable from context, which is the shape that went stale.
  assert.equal(
    definition.contextColumns.some((column) => column.key === "Net (month)"),
    false,
    "the retired stale column must not come back beside the live total — two figures for the same money, one of them " +
      "frozen, is what this replaced",
  );

  // ---- 5. the xlsx matches the screen ---------------------------------------

  const columns = stepTemplateColumns("p1_new_hires");
  const totalColumn = columns.find((column) => column.label === spec.label);
  assert.ok(totalColumn, "an export must match the screen — the total belongs in the step's xlsx too");
  assert.equal(totalColumn.editable, false, "the total is derived; making it editable would create a second source of truth");
  assert.equal(totalColumn.money, true, "a salary total on a payroll sheet must be currency-formatted");

  const lastFieldIndex = Math.max(
    ...definition.fields.map((field) => columns.findIndex((column) => column.label === field.label)),
  );
  assert.ok(
    columns.indexOf(totalColumn) > lastFieldIndex,
    "the total must come AFTER the figures it sums, so the sheet reads in the same order as the card",
  );

  // ---- 6. end to end: build the real workbook and read the cell back --------

  await assertWorkbookCell();
}

/** Minimal joiner row — only what the total and the xlsx template read. */
function buildRow(values: Record<string, number>): StepRow {
  return {
    hrId: "HR-009",
    fullName: "Test Joiner",
    jobTitle: "Medical Rep",
    line: "CNS",
    context: { "Hire Date": "2026-08-24", "Days Worked": 4, "Net Salary": 18000 },
    values,
    recommended: { baseForMonth: 2322.58, ecolPaid: 217.74, fuelPaid: 72.58 },
    reason: null,
    onHold: false,
  };
}

async function assertWorkbookCell() {
  const definition = STEP_DEFINITIONS.p1_new_hires;
  const spec = definition.fieldsTotal;
  assert.ok(spec);

  // HR's edited figures, NOT the recommendation — the same distinction the card
  // draws. An export that printed the recommended total beside edited boxes
  // would contradict the screen it was downloaded from.
  const row = buildRow({ baseForMonth: 9000, ecolPaid: 500, fuelPaid: 250 });
  const run = { month: 8, year: 2026 } as MonthlySalaryRun;

  const buffer = await buildStepTemplateWorkbook({ run, stepKey: "p1_new_hires", rows: [row] });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  assert.ok(sheet, "the step template must produce a sheet");

  const headerRow = sheet.getRow(5);
  let totalColumnIndex = -1;
  for (let col = 1; col <= sheet.columnCount; col += 1) {
    if (String(headerRow.getCell(col).value ?? "") === spec.label) totalColumnIndex = col;
  }
  assert.ok(totalColumnIndex > 0, `the xlsx header row must carry a "${spec.label}" column`);

  const cell = sheet.getRow(6).getCell(totalColumnIndex);
  assert.equal(
    cell.value,
    9750,
    "the xlsx total must equal the sum of the row's EDITED values — 9000 + 500 + 250",
  );
}

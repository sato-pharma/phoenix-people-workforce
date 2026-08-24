import { strict as assert } from "node:assert";

import ExcelJS from "exceljs";

import {
  canExportPlanningCalendar,
  planKindLabel,
  planStatusLabel,
  type PlanningCalendarPlanItem,
} from "../src/lib/weekly-planning/calendar.ts";
import {
  buildPlanningCalendarDetailRows,
  buildPlanningCalendarSummaryRows,
  buildPlanningCalendarWorkbook,
  planningCalendarExportFileName,
} from "../src/lib/weekly-planning/calendar-export.ts";

/**
 * Coverage for the Planning Calendar XLSX export:
 *   - canExportPlanningCalendar: SFE Manager + Super Admin only (NOT CEO/Finance Manager,
 *     who hold the generic weekly_plans:export action but are excluded from THIS feature).
 *   - the pure summary/detail row builders (aggregation, counts, sort order, label mapping).
 *   - the two-sheet workbook builds and carries the expected sheets, headers and TOTAL row.
 */

function planItem(
  input: Partial<PlanningCalendarPlanItem> & { employeeHrId: string; employeeDisplayName: string; startDate: string },
): PlanningCalendarPlanItem {
  return {
    activityTitle: "Single Visit",
    activityType: "Field",
    area: "Area A",
    conflictKey: null,
    conflictWarning: null,
    employeeHrId: input.employeeHrId,
    employeeJobTitle: "Product Manager",
    employeeName: input.employeeDisplayName,
    employeeDisplayName: input.employeeDisplayName,
    endDate: input.startDate,
    id: `plan-${input.employeeHrId}-${input.startDate}`,
    lineName: "Pedia",
    medicalRepHrId: null,
    medicalRepName: null,
    medicalRepDisplayName: null,
    notes: null,
    planId: `header-${input.employeeHrId}`,
    planKind: "weekly",
    region: "Cairo",
    source: "plan",
    startDate: input.startDate,
    status: "submitted",
    time: "AM",
    title: `${input.employeeDisplayName} — Single Visit`,
    ...input,
  };
}

export async function runPlanningCalendarExportTests() {
  // --- canExportPlanningCalendar: SFE Manager + Super Admin ONLY ---

  for (const role of ["Super Admin", "SFE Manager"]) {
    assert.equal(canExportPlanningCalendar(role), true, `${role} may export the planning calendar`);
  }
  for (const role of ["CEO", "Finance Manager", "Regional Manager", "Medical Rep", "Training Manager", "", null, undefined]) {
    assert.equal(
      canExportPlanningCalendar(role),
      false,
      `${String(role) || "(empty)"} may NOT export — CEO/Finance Manager hold weekly_plans:export but are excluded from this feature`,
    );
  }

  // --- Label helpers (shared with the on-screen chips) ---

  assert.equal(planStatusLabel("ceo_approved"), "CEO approved");
  assert.equal(planStatusLabel("manager_approved"), "Manager approved");
  assert.equal(planStatusLabel("submitted"), "Submitted");
  assert.equal(planStatusLabel("something_else"), "something_else", "an unknown status falls back to the raw value");
  assert.equal(planStatusLabel(""), "", "a blank status stays blank");
  assert.equal(planKindLabel("weekly"), "Weekly");
  assert.equal(planKindLabel("monthly"), "Monthly");

  // Two owners: Alice (2 weekly plans, one carrying a conflict warning) and Bob (1 monthly plan).
  const items: PlanningCalendarPlanItem[] = [
    planItem({ employeeHrId: "A-1", employeeDisplayName: "Alice", startDate: "2026-08-10", conflictWarning: "Overlaps with Bob" }),
    planItem({ employeeHrId: "A-1", employeeDisplayName: "Alice", startDate: "2026-08-03" }),
    planItem({
      employeeHrId: "B-2",
      employeeDisplayName: "Bob",
      employeeJobTitle: "District Manager",
      lineName: "CNS",
      startDate: "2026-08-05",
      planKind: "monthly",
      status: "manager_approved",
    }),
  ];

  // --- Summary rows: one per user, correct counts, sorted by employee name ---

  const summaryRows = buildPlanningCalendarSummaryRows(items);
  assert.equal(summaryRows.length, 2, "one summary row per distinct owner");
  assert.deepEqual(
    summaryRows.map((row) => row.employee),
    ["Alice", "Bob"],
    "summary rows are sorted by employee display name",
  );
  const alice = summaryRows[0];
  assert.equal(alice.hrId, "A-1");
  assert.equal(alice.planEntries, 2, "Alice has two plan entries");
  assert.equal(alice.weekly, 2, "both of Alice's plans are weekly");
  assert.equal(alice.monthly, 0);
  assert.equal(alice.conflicts, 1, "exactly one of Alice's plans carries a conflict warning");
  const bob = summaryRows[1];
  assert.equal(bob.planEntries, 1);
  assert.equal(bob.weekly, 0);
  assert.equal(bob.monthly, 1, "Bob's single plan is monthly");
  assert.equal(bob.conflicts, 0);
  assert.equal(bob.line, "CNS", "the owner's line is carried onto the summary row");

  // --- Detail rows: one per plan, grouped by user then date, labels mapped ---

  const detailRows = buildPlanningCalendarDetailRows(items);
  assert.equal(detailRows.length, 3, "one detail row per plan activity");
  assert.deepEqual(
    detailRows.map((row) => `${row.employee}:${row.date}`),
    ["Alice:2026-08-03", "Alice:2026-08-10", "Bob:2026-08-05"],
    "detail rows are grouped by employee then ordered by date",
  );
  assert.equal(detailRows[0].conflict, "-", "a plan with no conflict shows a dash, not empty");
  assert.equal(detailRows[1].conflict, "Overlaps with Bob", "the conflicting plan carries its warning text");
  assert.equal(detailRows[0].status, "Submitted", "status is rendered with its human label");
  assert.equal(detailRows[2].status, "Manager approved");
  assert.equal(detailRows[2].planKind, "Monthly");
  assert.equal(detailRows[0].hrId, "A-1", "HR ID is preserved on the detail row");
  assert.equal(detailRows[0].day, "Monday", "2026-08-03 is a Monday (day-of-week column)");

  // --- Workbook: two sheets, expected headers, and a SUM TOTAL on the summary ---

  assert.equal(planningCalendarExportFileName(2026, 8), "Phoenix Planning Calendar 2026-08.xlsx");

  const buffer = await buildPlanningCalendarWorkbook({
    items,
    year: 2026,
    month: 8,
    generatedAt: new Date(Date.UTC(2026, 7, 15, 9, 0, 0)),
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ["Summary", "Detailed Plans"],
    "the workbook carries a Summary sheet then a Detailed Plans sheet",
  );

  const summarySheet = workbook.getWorksheet("Summary");
  assert.ok(summarySheet, "Summary worksheet exists");
  // addPhoenixTableSheet lays out: row1 title, row2 subtitle, row3 header, row4+ data, then TOTAL.
  assert.equal(summarySheet.getCell(3, 1).value, "Employee", "summary header row");
  assert.equal(summarySheet.getCell(3, 5).value, "Plan Entries");
  assert.equal(summarySheet.getCell(6, 1).value, "TOTAL", "summary carries a TOTAL row beneath the two owners");

  const detailSheet = workbook.getWorksheet("Detailed Plans");
  assert.ok(detailSheet, "Detailed Plans worksheet exists");
  assert.equal(detailSheet.getCell(3, 1).value, "Employee", "detail header row");
  assert.equal(detailSheet.getCell(4, 1).value, "Alice", "first detail data row is the alphabetically-first owner");

  // An empty month still produces a valid two-sheet workbook (headers, no rows, no TOTAL).
  const emptyBuffer = await buildPlanningCalendarWorkbook({ items: [], year: 2026, month: 8 });
  const emptyWorkbook = new ExcelJS.Workbook();
  await emptyWorkbook.xlsx.load(emptyBuffer);
  assert.equal(emptyWorkbook.worksheets.length, 2, "an empty export is still a valid two-sheet workbook");
}

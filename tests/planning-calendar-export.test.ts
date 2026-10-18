import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";
import { PDFArray, PDFDocument, StandardFonts, decodePDFRawStream, type PDFRawStream } from "pdf-lib";

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
import { buildPlanEmailTable } from "../src/lib/weekly-planning/email-table.ts";
import {
  buildEmployeePlansPdf,
  buildEmployeePlansWorkbook,
  planItemExportCells,
  wrapTextToWidth,
} from "../src/lib/weekly-planning/export.ts";
import {
  decisionActorLabel,
  planEmailMetrics,
  planHeadingLabel,
  planNounLabel,
  planPeriodLabel,
  planRowPartLabel,
  planSentenceLabel,
  summarizeBulkApprove,
} from "../src/lib/weekly-planning/plan-labels.ts";
import type { EmployeePlan } from "../src/lib/weekly-planning/service.ts";
import { stripComments } from "./support/comment-strip.ts";

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
    employeeJobTitle: "Product Manager",
    employeeName: input.employeeDisplayName,
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

  await assertPlanWordingExportsAndEmails();
}

// ---------------------------------------------------------------------------
// Weekly / Monthly plan wording, exports and emails (audit group D).
//
// What a plan reader sees in an export, an approval email or a notification: which half of a day a
// row covers, the words the planner uses for the activity, no code (an HR id) where a name belongs,
// and no text cut short with an ellipsis. The functions under test are pure; the few UI-only changes
// are held by reading the component source with its comments removed.
// ---------------------------------------------------------------------------

type ExportPlanItem = EmployeePlan["items"][number];

function exportItem(input: Partial<ExportPlanItem> & { id: string }): ExportPlanItem {
  return {
    activityDate: "2026-10-18",
    activityTitle: "Single Visit",
    activityType: "Field",
    area: "Nasr City",
    attendees: null,
    doubleVisitMedicalRepHrId: null,
    doubleVisitMedicalRepName: null,
    endTime: null,
    locationText: "Cairo",
    notes: "",
    objective: null,
    returnNotes: [],
    sortOrder: 0,
    startTime: null,
    visitDetails: [],
    ...input,
  };
}

function exportPlan(items: ExportPlanItem[]): EmployeePlan {
  return {
    acknowledgements: [],
    decisions: [],
    employeeDisplayName: "Ahmed Hassan",
    employeeHrId: "B-52",
    employeeJobTitle: "Product Manager",
    employeeName: "Ahmed Hassan",
    finalApprovedAt: null,
    id: "plan-1",
    items,
    managerDisplayName: "Omar Gawish",
    managerHrId: "B-10",
    managerName: "Omar Gawish",
    offWindowFlagged: false,
    periodEndDate: "2026-10-24",
    periodKey: "2026-W42",
    periodStartDate: "2026-10-18",
    planKind: "weekly",
    revision: 1,
    status: "submitted",
    submittedAt: null,
    updatedAt: "2026-10-17T10:00:00.000Z",
  };
}

/** Every string the PDF draws, in drawing order. pdf-lib writes each run as a hex string before Tj. */
async function pdfDrawnText(buffer: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(buffer);
  const runs: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.normalizedEntries().Contents;
    const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    for (const ref of refs) {
      const stream: unknown = doc.context.lookup(ref);
      let bytes: Uint8Array = new Uint8Array();
      if (stream && typeof (stream as { getUnencodedContents?: unknown }).getUnencodedContents === "function") {
        bytes = (stream as { getUnencodedContents(): Uint8Array }).getUnencodedContents();
      } else if (stream) {
        bytes = decodePDFRawStream(stream as PDFRawStream).decode();
      }
      const source = Buffer.from(bytes).toString("latin1");
      for (const match of source.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        runs.push(Buffer.from(match[1], "hex").toString("latin1"));
      }
    }
  }
  return runs;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "richText" in value) return value.richText.map((part) => part.text).join("");
  return String(value);
}

async function assertPlanWordingExportsAndEmails() {
  // --- D1: a plan export tells AM / PM / Full day apart and prints the planner's own type words ---

  const noReps = undefined;
  assert.equal(planItemExportCells(exportItem({ id: "full" }), noReps).part, "Full day", "no times means a full day");
  assert.equal(
    planItemExportCells(exportItem({ endTime: "13:00:00", id: "am", startTime: "09:00:00" }), noReps).part,
    "AM",
    "the 09:00 to 13:00 slot is the morning, whatever seconds the database adds",
  );
  assert.equal(
    planItemExportCells(exportItem({ endTime: "17:00:00", id: "pm", startTime: "13:00:00" }), noReps).part,
    "PM",
  );
  assert.equal(
    planItemExportCells(exportItem({ endTime: "12:00:00", id: "odd", startTime: "10:00:00" }), noReps).part,
    "10:00 - 12:00",
    "an odd slot prints its two clock times",
  );
  assert.equal(
    planItemExportCells(exportItem({ activityTitle: "Visit", activityType: "Field", id: "t1" }), noReps).type,
    "Single Visit",
    "a Field day is a Single Visit in the export, as it is in the planner and the calendar",
  );
  assert.equal(
    planItemExportCells(exportItem({ activityTitle: "Coaching", activityType: "Other", id: "t2" }), noReps).type,
    "Coaching",
  );
  assert.equal(
    planItemExportCells(exportItem({ activityTitle: "Quarterly review", activityType: "Meeting", id: "t3" }), noReps).type,
    "Quarterly review",
  );

  // The XLSX carries a Part column, so a morning row and an afternoon row on one date differ.
  const splitDay = exportPlan([
    exportItem({ endTime: "13:00:00", id: "am-row", sortOrder: 0, startTime: "09:00:00" }),
    exportItem({ endTime: "17:00:00", id: "pm-row", sortOrder: 1, startTime: "13:00:00" }),
  ]);
  const xlsxBuffer = await buildEmployeePlansWorkbook([splitDay], { generatedAt: new Date(Date.UTC(2026, 9, 18, 9, 0, 0)) });
  const planWorkbook = new ExcelJS.Workbook();
  await planWorkbook.xlsx.load(xlsxBuffer as unknown as Parameters<typeof planWorkbook.xlsx.load>[0]);
  const planSheet = planWorkbook.getWorksheet("Weekly Monthly Plans");
  assert.ok(planSheet, "the plans worksheet exists");
  const sheetRows: string[][] = [];
  planSheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    for (let column = 1; column <= 8; column += 1) values.push(cellText(row.getCell(column).value));
    sheetRows.push(values);
  });
  const header = sheetRows.find((values) => values[0] === "Day");
  assert.deepEqual(
    header,
    ["Day", "Date", "Part", "Type", "Region", "Area", "Medical Rep", "Notes"],
    "the day grid has a Part column between Date and Type",
  );
  const dayRows = sheetRows.filter((values) => values[0] === "Sun");
  assert.deepEqual(dayRows.map((values) => values[2]), ["AM", "PM"], "the two halves of one day are told apart in the export");
  assert.deepEqual(dayRows.map((values) => values[3]), ["Single Visit", "Single Visit"]);
  const everyCell = sheetRows.flat().join("\n");
  assert.ok(!/B-52|B-10/.test(everyCell), "no HR id is printed anywhere in the plan export");
  assert.ok(!/\bHR\s+\S/.test(everyCell), "the plan bands do not print an HR-id caption");

  // --- D2: nothing is cut with an ellipsis ---

  const fakeMeasure = (text: string) => text.length * 5;
  assert.deepEqual(wrapTextToWidth("", fakeMeasure, 50), [], "no text, no lines");
  assert.deepEqual(wrapTextToWidth("hello world foo", fakeMeasure, 50), ["hello", "world foo"], "words wrap at spaces");
  assert.deepEqual(
    wrapTextToWidth("abc abcdefghijklmnopqrstuvwxyz def", fakeMeasure, 50),
    ["abc", "abcdefghij", "klmnopqrst", "uvwxyz def"],
    "a word wider than the cell is split across lines, every letter kept and in order",
  );
  const helveticaDoc = await PDFDocument.create();
  const helvetica = await helveticaDoc.embedFont(StandardFonts.Helvetica);
  const narrative =
    "Review the Pedia portfolio with the whole team and agree the follow-up for every pharmacy in the area, " +
    "Supercalifragilisticexpialidocious-and-more-and-more-and-more-without-any-space-at-all end";
  const wrapped = wrapTextToWidth(narrative, (text) => helvetica.widthOfTextAtSize(text, 9), 70);
  assert.ok(wrapped.length > 3, "a long text takes several lines");
  assert.ok(
    wrapped.every((line) => helvetica.widthOfTextAtSize(line, 9) <= 70),
    "every wrapped line fits the real Helvetica width of its column",
  );
  assert.equal(wrapped.join("").replace(/ /g, ""), narrative.replace(/ /g, ""), "wrapping loses no letter");
  assert.ok(wrapped.every((line) => !line.includes("...")), "wrapping never writes an ellipsis");

  // The emitted PDF: the long region word comes out whole (split across lines, in order), there is no
  // ellipsis anywhere, no HR id, and the new Part column heads the grid.
  const longRegion = "Supercalifragilisticexpialidocious".repeat(2);
  const longNote = "Walk the pharmacy route with the new representative and agree the visit order. ".repeat(6).trim();
  const pdfPlan = exportPlan([
    exportItem({ endTime: "13:00:00", id: "pdf-am", locationText: "Cairo", notes: longNote, sortOrder: 0, startTime: "09:00:00" }),
    exportItem({ endTime: "17:00:00", id: "pdf-pm", locationText: longRegion, sortOrder: 1, startTime: "13:00:00" }),
  ]);
  const pdfBuffer = await buildEmployeePlansPdf([pdfPlan], { generatedAt: new Date(Date.UTC(2026, 9, 18, 9, 0, 0)) });
  const drawn = await pdfDrawnText(pdfBuffer);
  assert.ok(drawn.length > 10, "the PDF text could be read back from the emitted file");
  assert.ok(drawn.includes("Part"), "the PDF grid has a Part column heading");
  assert.ok(drawn.includes("AM") && drawn.includes("PM"), "the PDF prints each row's half of the day");
  assert.ok(drawn.includes("Single Visit"), "the PDF prints the planner's Type word");
  assert.ok(drawn.join("").includes(longRegion), "the unbroken region word is on the page in full, wrapped not cut");
  assert.ok(drawn.every((run) => !run.includes("...")), "no run of PDF text ends in an ellipsis");
  assert.ok(drawn.join(" ").includes("agree the visit order."), "the end of a long note reaches the page");
  assert.ok(!/B-52|B-10/.test(drawn.join(" ")), "no HR id is printed in the PDF");

  // The approval email table: a long sentence is whole, the safety cap says so in words, and the
  // row overflow reads as plain English.
  const emailRow = (
    index: number,
    overrides: { activity_title?: string; activity_type?: string; objective?: string | null } = {},
  ) => ({
    activity_date: "2026-10-18",
    activity_title: "Visit",
    activity_type: "Field",
    area: "Nasr City",
    attendees: null,
    double_visit_medical_rep_name: null,
    end_time: "13:00:00",
    location_text: "Cairo",
    objective: "Agree the follow-up",
    sort_order: index,
    start_time: "09:00:00",
    ...overrides,
  });
  const sentence400 = "Review the portfolio and agree the follow-up for every pharmacy. ".repeat(7).trim();
  assert.ok(sentence400.length > 300 && sentence400.length < 500, "fixture: a 400-ish character objective");
  const longObjective = buildPlanEmailTable([emailRow(0, { objective: sentence400 })]);
  assert.ok(longObjective.text.includes(sentence400), "a 400-character objective reaches the email whole (the old cap cut it at 300)");
  assert.ok(longObjective.html.includes(sentence400), "and so does the HTML table");
  const hugeObjective = "alpha ".repeat(500).trim();
  const cappedObjective = buildPlanEmailTable([emailRow(0, { objective: hugeObjective })]);
  assert.ok(cappedObjective.text.includes("(the rest is in Phoenix)"), "past the safety cap the cell says, in words, where the rest is");
  assert.ok(!/\.\.\.|…/.test(cappedObjective.text + cappedObjective.html), "the cap never writes an ellipsis");
  assert.ok(cappedObjective.text.length < hugeObjective.length, "the safety cap still bounds one cell");

  const fortyFive = buildPlanEmailTable(Array.from({ length: 45 }, (_, index) => emailRow(index)));
  assert.ok(
    fortyFive.text.includes("5 more rows are not shown here. Open Phoenix to see the full plan."),
    "rows past the table limit are counted in plain English",
  );
  assert.ok(!/row\(s\)|\.\.\.|…/.test(fortyFive.text + fortyFive.html), "no row(s) shorthand and no ellipsis in the overflow line");
  const fortyOne = Array.from({ length: 41 }, (_, index) => emailRow(index));
  assert.ok(buildPlanEmailTable(fortyOne).text.includes("1 more row is not shown here."), "one hidden row is singular");

  // --- D6: the email's activity cells use the planner's words and a human date ---

  const labelled = buildPlanEmailTable([
    emailRow(0, { activity_title: "Visit", activity_type: "Field" }),
    emailRow(1, { activity_title: "Coaching", activity_type: "Other" }),
    emailRow(2, { activity_title: "Quarterly review", activity_type: "Meeting" }),
    emailRow(3, { activity_title: "Meeting", activity_type: "Meeting" }),
  ]);
  const textLines = labelled.text.split("\n");
  assert.ok(
    textLines[0].startsWith("- Sun 18 Oct 2026 AM | Single Visit | Cairo - Nasr City"),
    `a Field day reads as a Single Visit on a human date (got: ${textLines[0]})`,
  );
  assert.ok(!/\(Field\)|\(Other\)/.test(labelled.text), "the stored type is not printed beside its own label");
  assert.ok(textLines[1].includes("| Coaching |"), "a coaching day is Coaching, not Other");
  assert.ok(textLines[2].includes("Quarterly review (Meeting)"), "a titled Meeting keeps its type as the second word");
  assert.ok(!textLines[3].includes("Meeting (Meeting)"), "a title that repeats the type is not printed twice");
  assert.ok(!labelled.html.includes(">Field<"), "the HTML activity cell does not print the stored type");

  // --- D6/D3: the notification wording and the email's details block ---

  assert.equal(planNounLabel("weekly"), "Weekly plan");
  assert.equal(planNounLabel("monthly"), "Monthly plan");
  assert.equal(planNounLabel("something"), "Plan", "an unknown kind is left as Plan rather than guessed");
  assert.equal(planPeriodLabel("2026-10-18", "2026-10-24"), "18 Oct 2026 to 24 Oct 2026");
  assert.equal(planPeriodLabel("2026-10-18", "2026-10-18"), "18 Oct 2026", "a one-day period is one date");
  assert.equal(planPeriodLabel("", ""), "", "no dates, no label");
  assert.equal(planHeadingLabel("weekly", "2026-10-18", "2026-10-24"), "Weekly plan · 18 Oct 2026 to 24 Oct 2026");
  assert.equal(
    planSentenceLabel("weekly", "2026-10-18", "2026-10-24"),
    "weekly plan for 18 Oct 2026 to 24 Oct 2026",
    "inside a sentence the kind is lower case and the dates are words, not 2026-W42",
  );
  assert.deepEqual(
    planEmailMetrics({
      employee_name: "Ahmed Hassan",
      period_end_date: "2026-10-24",
      period_key: "2026-W42",
      period_start_date: "2026-10-18",
      plan_kind: "weekly",
    }),
    [
      { label: "Employee", value: "Ahmed Hassan" },
      { label: "Plan", value: "Weekly plan" },
      { label: "Period", value: "18 Oct 2026 to 24 Oct 2026" },
    ],
    "the email details name the employee without an HR id and give the period as dates",
  );

  // --- D3: names, never codes ---

  assert.equal(decisionActorLabel({ actorName: "Omar Gawish", actorRole: "HR Manager" }), "Omar Gawish");
  assert.equal(decisionActorLabel({ actorName: null, actorRole: "HR Manager" }), "HR Manager", "no name falls back to the role");
  assert.equal(decisionActorLabel({ actorName: "  ", actorRole: null }), "", "no name and no role prints nothing, never an id");
  const unnamedRep = buildPlanningCalendarDetailRows([
    planItem({
      employeeDisplayName: "Alice",
      employeeHrId: "A-1",
      medicalRepDisplayName: null,
      medicalRepHrId: "M-77",
      medicalRepName: null,
      startDate: "2026-08-03",
    }),
  ]);
  assert.equal(unnamedRep[0].medicalRep, "Unnamed", "a booked rep who left the directory is Unnamed, not an id");

  // --- D4: the return-note label carries the half of the day ---

  assert.equal(planRowPartLabel({ endTime: "13:00:00", startTime: "09:00:00" }), "AM");
  assert.equal(planRowPartLabel({ endTime: "17:00:00", startTime: "13:00:00" }), "PM");
  assert.equal(planRowPartLabel({ endTime: null, startTime: null }), "Full day");

  // --- D5: bulk approve says what happened, plan by plan ---

  const queue = [
    { employeeDisplayName: "Ahmed Hassan", employeeName: "Ahmed H.", id: "p1", periodEndDate: "2026-10-24", periodStartDate: "2026-10-18", planKind: "weekly" },
    { employeeDisplayName: null, employeeName: "Mona Said", id: "p2", periodEndDate: "2026-10-24", periodStartDate: "2026-10-18", planKind: "weekly" },
    { employeeDisplayName: "Karim Adel", employeeName: "Karim Adel", id: "p3", periodEndDate: "2026-10-31", periodStartDate: "2026-10-01", planKind: "monthly" },
  ];
  const allOk = summarizeBulkApprove(["p1", "p2"], [{ ok: true, planId: "p1" }, { ok: true, planId: "p2" }], queue);
  assert.equal(allOk.message, "2 plans approved.");
  assert.equal(allOk.tone, "info");
  assert.deepEqual(allOk.approvedIds, ["p1", "p2"]);
  assert.equal(summarizeBulkApprove(["p1"], [{ ok: true, planId: "p1" }], queue).message, "1 plan approved.");

  const partial = summarizeBulkApprove(
    ["p1", "p2", "p3"],
    [{ ok: true, planId: "p1" }, { message: "already decided", ok: false, planId: "p2" }, { ok: true, planId: "p3" }],
    queue,
  );
  assert.equal(partial.tone, "error", "a partial failure is an error, not a success");
  assert.deepEqual(partial.approvedIds, ["p1", "p3"], "only the approved plans are un-ticked");
  assert.deepEqual(partial.failedIds, ["p2"], "the failed plan stays selected");
  assert.equal(
    partial.message,
    "2 plans approved. 1 could not be approved: Mona Said (Weekly plan · 18 Oct 2026 to 24 Oct 2026). It stays selected so you can try again.",
    "the failed plan is named by employee and period",
  );

  const none = summarizeBulkApprove(["p1", "p3"], [{ ok: false, planId: "p1" }, { ok: false, planId: "p3" }], queue);
  assert.ok(none.message.startsWith("No plan was approved. 2 could not be approved: Ahmed Hassan (Weekly plan"), none.message);
  assert.ok(none.message.includes("Karim Adel (Monthly plan · 01 Oct 2026 to 31 Oct 2026)"), none.message);
  assert.ok(none.message.endsWith("They stay selected so you can try again."));
  assert.deepEqual(none.approvedIds, []);

  const unanswered = summarizeBulkApprove(["p1", "p2"], [{ ok: true, planId: "p1" }], queue);
  assert.deepEqual(unanswered.failedIds, ["p2"], "a plan the server never answered for is NOT reported as approved");
  assert.equal(unanswered.tone, "error");
  assert.ok(
    summarizeBulkApprove(["gone"], [], queue).message.includes("A plan that is no longer in your list"),
    "a plan missing from the list is still counted, with a plain name",
  );

  // --- D3/D5/D6/D7: the screens and the service use these words (read with comments removed) ---

  const workspace = stripComments(readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8"));
  assert.ok(!workspace.includes("RLS · service-role only"), "the Secured chip (an implementation detail) is gone from the plans page");
  assert.ok(!/by \{d\.actorHrId\}/.test(workspace), "the decision timeline does not print the decider's HR id");
  assert.ok(workspace.includes("decisionActorLabel(d)"), "the decision timeline prints the decider's name");
  assert.ok(!/\{p\.planKind\} \{p\.periodKey\}/.test(workspace), "queue and review titles are not the raw kind and week code");
  assert.ok(!/\{plan\.planKind\} \{plan\.periodKey\}/.test(workspace), "the visit-details title is not the raw kind and week code");
  assert.ok(workspace.includes("planHeadingLabel(p.planKind, p.periodStartDate, p.periodEndDate)"), "titles match the plan history cards");
  assert.ok(workspace.includes("planRowPartLabel(item)"), "the return-note label carries the half of the day");
  assert.ok(workspace.includes("summarizeBulkApprove("), "bulk approve reads the per-plan outcome");
  assert.ok(
    workspace.includes("throw new Error(summary.message)"),
    "a partial bulk-approve failure is shown through runAction's catch, the one place the error tone is used",
  );
  assert.ok(workspace.includes("for (const id of approvedIds) next.delete(id)"), "bulk approve un-ticks only the approved plans");
  assert.ok(!/approved, \$\{failed\} failed/.test(workspace), "the bare '2 approved, 1 failed.' message is gone");

  const requestDetail = stripComments(readFileSync("src/components/approvals-hub/plan-request-detail.tsx", "utf8"));
  assert.ok(
    requestDetail.includes('<Row label="Employee" value={detail.employeeName} />'),
    "the approval detail's Employee row is the name alone, with no HR id beside it",
  );
  assert.ok(requestDetail.includes("cairoDate(detail.submittedAt)"), "Submitted is read in Africa/Cairo with the repo helper");
  assert.ok(!requestDetail.includes('toLocaleDateString("en-GB")'), "Submitted no longer uses the platform's own time zone");

  const decisionActions = stripComments(readFileSync("src/components/approvals-hub/plan-decision-actions.tsx", "utf8"));
  assert.ok(!decisionActions.includes('.split(" ")[0]'), "the confirm button is not cut to the first word of its action");
  assert.ok(decisionActions.includes("Confirm ${SIMPLE_LABEL[action]}"), "the confirm button names the whole action");

  const service = stripComments(readFileSync("src/lib/weekly-planning/service.ts", "utf8"));
  const rawKindLines = service
    .split(/\r?\n/)
    .filter((line) => line.includes(".plan_kind}") && !line.includes("summary:"));
  assert.deepEqual(rawKindLines, [], "no notification title or message prints the raw lower-case plan kind");
  assert.ok(service.includes("metrics: planEmailMetrics(input.plan)"), "the plan email details come from the shared label helper");
  assert.ok(service.includes("actorName: decision.actorHrId"), "the workspace resolves each decider's name for the timeline");
}

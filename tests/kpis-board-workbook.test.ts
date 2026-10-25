import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { RepCallRate } from "../src/lib/crm/call-rate.ts";
import { joinKpiRows, type KpiDirectoryEntry, type KpisBoard } from "../src/lib/crm/kpis-board.ts";
import { buildKpisBoardWorkbook, hireDateCellValue, KPI_EXPORT_MARKERS } from "../src/lib/crm/kpis-board-workbook.ts";
import type { RepDoctorListRepRow } from "../src/lib/crm/rep-doctor-lists.ts";

/**
 * The KPIs board's hiring date and its XLSX export (owner, 2026-10-25: "make any rep appear with his
 * hiring date … and make me able to export xlsx very premium polish").
 *
 * Three things here would each be wrong in a way nobody could see:
 *
 *   1. the hire date has to be STAMPED by the join from the directory. The board prints whatever the
 *      row carries, so a join that forgot the field gives a board with no hire dates and no error;
 *   2. the exported hire date has to be a real DATE cell. Text that looks like a date cannot be sorted
 *      or filtered in Excel, and a manager reading the sheet would not notice until he tried;
 *   3. a rep with no figure must get the screen's own marker word in the sheet, never a 0. An exported
 *      0% reads as a rep who did nothing, and AM and PM stay two columns (owner, 2026-09-04).
 *
 * The workbook is read back cell by cell, because that is what the reader opens.
 */

function callRate(agentCrmId: number, agentHrId: string, agentName: string, am: number, pm: number): RepCallRate {
  const slice = (verified: number, target: number) => ({
    attainmentPct: Math.round((verified / 5 / target) * 100),
    campaign: 0,
    target,
    total: verified,
    totalRate: verified / 5,
    unverified: 0,
    verified,
    verifiedRate: verified / 5,
  });
  return {
    agentCrmId,
    agentHrId,
    agentName,
    am: slice(am, 2),
    campaignOnlyDays: 0,
    campaignOverLimitDays: [],
    campaignShare: 0,
    pm: slice(pm, 10),
    pharmacy: { attainmentPct: null, campaign: 0, target: null, total: 0, totalRate: 0, unverified: 0, verified: 0, verifiedRate: 0 },
    unspecified: 0,
    awaitingValidation: 0,
    workingDays: 5,
  };
}

function docList(agentCrmId: number, agentHrId: string | null, repName: string): RepDoctorListRepRow {
  return {
    actualCalls: 30,
    agentCrmId,
    agentHrId,
    campaignCalls: 0,
    coverageDueDoctors: 100,
    coveragePct: 70,
    frequencyPct: 39,
    gradeA: 0,
    gradeB: 0,
    gradeC: 0,
    hasMeasurablePlan: true,
    missedDoctors: 30,
    notDueDoctors: 0,
    offPlanDoctors: 0,
    onPlanDoctors: 39,
    overDoctors: 5,
    plannedAccounts: 0,
    plannedCalls: 100,
    plannedCallsToDate: 100,
    plannedDoctors: 100,
    plannedUnclassified: 0,
    repKey: String(agentCrmId),
    repName,
    underDoctors: 26,
    underPlannedVsGrade: 0,
    unverifiedCalls: 0,
    visitedDoctors: 70,
  };
}

function directoryEntry(hrId: string, displayName: string, hireDate?: string | null): KpiDirectoryEntry {
  return {
    hrId,
    displayName,
    lineName: "CNS",
    regionName: "Cairo",
    areaName: "Nasr City",
    managerName: "District Lead",
    jobTitle: "Medical Representative",
    ...(hireDate === undefined ? {} : { hireDate }),
  };
}

function boardOf(reps: KpisBoard["reps"]): KpisBoard {
  // Only the fields the workbook reads; the rest of a real board is the page's business.
  return {
    month: "2026-09",
    monthLabel: "September 2026",
    range: { dateFrom: "2026-09-01", dateTo: "2026-09-30", periodKey: "month", periodLabel: "Whole month" },
    workingDays: 5,
    asOf: "2026-09-30",
    scopeLabel: "Whole company",
    scopeReason: null,
    reps,
    managers: [],
    scopedReps: 3,
    kpiRules: "legacy",
    totals: { reps: reps.length, coveragePct: 70, frequencyPct: 39, amAttainmentPct: 40, pmAttainmentPct: 60 },
    kpiIndex: { overallPct: 55, method: "The average of coverage, frequency, AM and PM." },
    holidaysComplete: true,
    amTarget: 2,
    pmTarget: 10,
  } as unknown as KpisBoard;
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "richText" in value) return value.richText.map((run) => run.text).join("");
  return String(value);
}

export async function runKpisBoardWorkbookTests() {
  // ── 1. The join stamps the hire date from the directory ───────────────────────────────────────
  const rows = joinKpiRows({
    callRates: [callRate(11, "A-12", "Rep One", 4, 30)],
    docLists: [docList(11, null, "Rep One"), docList(22, "b-34", "Rep Two")],
    scope: { basis: "company", kind: "company", label: "Whole company" },
    workingDays: 5,
    directory: [directoryEntry("A-12", "Rep One", "2025-03-12"), directoryEntry("B-34", "Rep Two")],
  });
  const repOne = rows.find((row) => row.repName === "Rep One");
  const repTwo = rows.find((row) => row.repName === "Rep Two");
  assert.ok(repOne && repTwo, "both reps are on the board");
  assert.equal(repOne.hireDate, "2025-03-12", "the join carries the directory's hire date onto the rep's row");
  assert.equal(repTwo.hireDate ?? null, null, "a rep whose directory row has no hire date carries none — never another rep's");

  // The calendar day, at UTC midnight, so Excel never shifts it by Cairo's offset.
  assert.equal(hireDateCellValue("2025-03-12")?.toISOString(), "2025-03-12T00:00:00.000Z");
  assert.equal(hireDateCellValue(""), null, "an empty hire date is no date, not 1 January 1970");
  assert.equal(hireDateCellValue(null), null);

  // ── 2. The workbook, read back cell by cell ───────────────────────────────────────────────────
  const buffer = await buildKpisBoardWorkbook(boardOf(rows), "2026-10-25T09:30:00.000Z");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  assert.ok(names.includes("Medical reps") && names.includes("Managers"), `the reps and managers sheets exist (${names.join(", ")})`);

  const cover = workbook.worksheets[0];
  const coverText: string[] = [];
  cover.eachRow((row) => row.eachCell((cell) => coverText.push(cellText(cell))));
  assert.ok(
    coverText.includes("2 of 3 reps (filtered as on screen)"),
    "the cover says the file is the FILTERED board, so nobody reads two reps as the whole team",
  );

  const sheet = workbook.getWorksheet("Medical reps");
  assert.ok(sheet, "the Medical reps sheet");
  let headerRow = 0;
  sheet.eachRow((row, number) => {
    if (!headerRow && cellText(row.getCell(1)) === "Medical rep") headerRow = number;
  });
  assert.ok(headerRow > 0, "the reps table has its header row under the masthead");
  const headers = new Map<string, number>();
  sheet.getRow(headerRow).eachCell((cell, column) => headers.set(cellText(cell), column));
  const column = (header: string): number => {
    const found = headers.get(header);
    assert.ok(found, `the "${header}" column exists`);
    return found;
  };
  assert.equal(column("Hire date"), 2, "the hire date sits right beside the rep's name, as it does on screen");

  const rowOf = (name: string): ExcelJS.Row => {
    for (let number = headerRow + 1; number <= sheet.rowCount; number += 1) {
      if (cellText(sheet.getRow(number).getCell(1)) === name) return sheet.getRow(number);
    }
    assert.fail(`${name} has a row in the sheet`);
  };
  const one = rowOf("Rep One");
  const two = rowOf("Rep Two");

  const hired = one.getCell(column("Hire date"));
  assert.ok(hired.value instanceof Date, "the hire date is a real date cell, so Excel can sort and filter it");
  assert.equal(hired.value.toISOString().slice(0, 10), "2025-03-12", "and it is the right calendar day");
  assert.equal(hired.numFmt, "dd mmm yyyy", "printed as 12 Mar 2025, the way the board prints it");
  assert.equal(cellText(two.getCell(column("Hire date"))), KPI_EXPORT_MARKERS.notRecorded, "a missing hire date says so in words");

  // AM and PM: two columns, two different scores — never one blended figure.
  const amColumn = column("AM vs 2 a day");
  const pmColumn = column("PM vs 10 a day");
  assert.notEqual(amColumn, pmColumn, "AM and PM are separate columns");
  assert.equal(one.getCell(amColumn).value, 0.4, "AM is 4 proved calls against 2 a day over 5 days: 40%");
  assert.equal(one.getCell(pmColumn).value, 0.6, "PM is 30 proved calls against 10 a day over 5 days: 60%");
  assert.equal(one.getCell(amColumn).numFmt, "0%", "stored as a fraction and shown as a percentage");

  // Rep Two has a plan and no calls: the marker word, never a zero.
  assert.equal(two.getCell(amColumn).value, KPI_EXPORT_MARKERS.noCalls, "no calls is printed as words, not 0%");
  assert.equal(two.getCell(pmColumn).value, KPI_EXPORT_MARKERS.noCalls);
  assert.equal(two.getCell(column("AM verified")).value, KPI_EXPORT_MARKERS.noCalls, "and his proved counts say the same");
  assert.equal(two.getCell(column("Coverage")).value, 0.7, "his plan half still exports: 70% coverage");

  // The name column and the header stay on screen while the reader scrolls.
  const view = sheet.views[0] as { state?: string; xSplit?: number; ySplit?: number };
  assert.equal(view.state, "frozen");
  assert.equal(view.xSplit, 1, "the rep's name is frozen");
  assert.equal(view.ySplit, headerRow, "and so is the header row");
}

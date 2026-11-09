/**
 * The KPIs board as a workbook (owner, 2026-10-25: "make me able to export xlsx very premium polish").
 *
 * It writes the board the viewer is looking at — the same scope, month, period and filters, already
 * computed by `getKpisBoard` — and re-derives NOTHING. Every figure is read off the board's rows, and
 * every place the screen prints a marker instead of a number ("No plan", "No calls", "No GPS feed",
 * "Not scored yet", "No score") the sheet prints the same words, never a 0: an exported 0% is read as
 * a rep who did nothing, which is exactly what those markers exist to prevent.
 *
 * AM and PM stay two columns each, never one (owner, 2026-09-04: "Don't never get average"), and the
 * hiring date is a real date cell, so a manager can sort and filter by it in Excel.
 *
 * Wears the house identity (SATO-DIS-2026-01): the masthead, the blue header band, the hairline grid
 * and the 6% zebra. The status signal colours ONLY the percentage cells, by the board's own bands.
 *
 * FROM THE COVERAGE AND FREQUENCY TABS (owner, 2026-10-29: "Brick on the KPIs Excel export") the board
 * arrives with its doctor lists, and the file adds three things, each the screen's own:
 *   - a "Not validated yet" column on the reps sheet — the count under each rep's Coverage figure;
 *   - a "By brick" sheet — the team's brick table, `board.teamBricks`, counted as the screen counts it;
 *   - a "Doctors" sheet when a rep's list is open — his doctors narrowed by the doctor filters on screen
 *     (`filterKpiDoctors`), so a brick picked on the board is the brick in the file.
 * When the bricks could not be read the cover says so and the column prints "Not read", never a 0.
 *
 * FROM THE SAME TWO TABS, ON A BOARD OF MORE THAN ONE TEAM (premium pass, 9 Nov 2026: "group reps by
 * district manager"), a "Teams" sheet — one line per region and direct manager, the same lines the
 * Coverage screen heads its reps with, each from `kpiTeamCoverage` (the board's own team arithmetic), so
 * the teams' planned and visited add up to the cover's team coverage.
 */

import ExcelJS from "exceljs";
import type { KpiCoverageDoctor, KpiRepRow, KpisBoard } from "@/lib/crm/kpis-board";
import { kpiIndexOf } from "@/lib/crm/kpi-index";
import { groupKpiRepsByTeam, kpiTeamCoverage, type KpiCoverageTeam, type KpiTeamCoverage } from "@/lib/crm/kpi-coverage-teams";
import { KPI_MANAGER_LEVEL_LABEL, type KpiManagerRow } from "@/lib/crm/kpis-manager-rows";
import { KPI_FREQUENCY_STATUS_LABEL, kpiBrickFrequencyColumns, type KpiBrickRow } from "@/lib/crm/kpis-brick-table";
import { countActiveKpiDoctorFilter, filterKpiDoctors, kpiDoctorBrickLabel } from "@/lib/crm/kpis-doctor-filters";
import { kpiBandOf, kpiFlagLabel, kpiFlagsOf } from "@/lib/crm/kpis-filters";
import { buildHouseCoverSheet } from "@/lib/export/house-table-workbook";
import {
  HOUSE_XLSX_COLORS,
  houseBodyStyle,
  houseGeneratedRow,
  houseHeaderStyle,
  writeHouseMasthead,
} from "@/lib/export/house-xlsx-identity";
import { HOUSE_XLSX_FONT, HOUSE_XLSX_SIGNAL, type HouseXlsxSignalTone } from "@/lib/export/house-xlsx-palette";

/** The screen's own marker words — one place, so the sheet and the board can never disagree. */
export const KPI_EXPORT_MARKERS = {
  noGpsFeed: "No GPS feed",
  notScoredYet: "Not scored yet",
  noCalls: "No calls",
  noPlan: "No plan",
  noScore: "No score",
  justStarted: "Just started",
  notRecorded: "Not recorded",
  /** A count the bricks would have given, when the bricks could not be read. */
  notRead: "Not read",
  nameNotOnPlan: "Name not on the plan",
  notVisited: KPI_FREQUENCY_STATUS_LABEL["not-visited"],
} as const;

/** What the route knows about the board that the board does not say itself. */
export type KpisWorkbookOptions = {
  /** True when the export came from the Coverage or Frequency tab, so the bricks were asked for. */
  doctorLists?: boolean;
};

/** A cell value: a number with its format, a date, a marker in words, or blank. */
type Cell =
  | { kind: "pct"; value: number | null; marker: string }
  | { kind: "rate"; value: number | null; marker: string }
  | { kind: "count"; value: number }
  | { kind: "date"; value: string | null; marker?: string }
  | { kind: "text"; value: string | null };

type Column<Row> = { header: string; width: number; cell: (row: Row) => Cell };

/** `YYYY-MM-DD` as a UTC midnight Date, so Excel stores the calendar day with no timezone drift. */
export function hireDateCellValue(iso: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function signalOf(pct: number): HouseXlsxSignalTone {
  const band = kpiBandOf(pct);
  if (band === "elite" || band === "strong") return "good";
  if (band === "steady") return "warn";
  return "bad";
}

/** Why a rep has no AM/PM figure — the board's own order: no feed, then waiting, then nothing. */
function callMarker(row: KpiRepRow): string {
  if (row.noGpsFeed) return KPI_EXPORT_MARKERS.noGpsFeed;
  return row.awaitingValidation > 0 ? KPI_EXPORT_MARKERS.notScoredYet : KPI_EXPORT_MARKERS.noCalls;
}

function amPct(row: KpiRepRow): Cell {
  const value = !row.noGpsFeed && row.hasCallRate ? row.amAttainmentPct : null;
  return { kind: "pct", value, marker: callMarker(row) };
}

function pmPct(row: KpiRepRow): Cell {
  const value = !row.noGpsFeed && row.hasCallRate ? row.pmAttainmentPct : null;
  return { kind: "pct", value, marker: callMarker(row) };
}

/** A proved call figure: the number, or the same marker the percentage beside it carries. */
function proved(row: KpiRepRow, value: number | null, kind: "rate" | "count"): Cell {
  if (row.noGpsFeed || !row.hasCallRate) return { kind: "rate", value: null, marker: callMarker(row) };
  if (kind === "count") return { kind: "count", value: value ?? 0 };
  return { kind: "rate", value, marker: "" };
}

function planPct(row: KpiRepRow, value: number): Cell {
  return { kind: "pct", value: row.hasMeasurablePlan ? value : null, marker: KPI_EXPORT_MARKERS.noPlan };
}

function overallPct(row: KpiRepRow): Cell {
  const index = kpiIndexOf({
    coveragePct: row.coveragePct,
    frequencyPct: row.frequencyPct,
    hasMeasurablePlan: row.hasMeasurablePlan,
    amAttainmentPct: row.amAttainmentPct,
    pmAttainmentPct: row.pmAttainmentPct,
    hasCallRate: row.hasCallRate,
    noGpsFeed: row.noGpsFeed,
    justStarted: Boolean(row.justStarted),
  });
  // A rep too new to judge prints the board's words, never a 0% or "No score" (owner, 2026-10-26).
  if (row.justStarted) return { kind: "pct", value: null, marker: KPI_EXPORT_MARKERS.justStarted };
  return { kind: "pct", value: index.overallPct, marker: KPI_EXPORT_MARKERS.noScore };
}

function text(value: string | null | undefined): Cell {
  return { kind: "text", value: value?.trim() || null };
}

/** The reps sheet's "Not validated yet": the count, the board's words for a new rep, or "Not read". */
function notValidatedCell(row: KpiRepRow, bricksRead: boolean): Cell {
  if (row.justStarted) return { kind: "text", value: KPI_EXPORT_MARKERS.justStarted };
  if (!bricksRead) return { kind: "text", value: KPI_EXPORT_MARKERS.notRead };
  // Read, and still no count: the rep has no doctor list on the plan to count.
  if (row.notValidatedDoctors == null) return { kind: "text", value: KPI_EXPORT_MARKERS.noPlan };
  return { kind: "count", value: row.notValidatedDoctors };
}

function repColumns(board: KpisBoard, bricks: { asked: boolean; read: boolean }): Array<Column<KpiRepRow>> {
  const rules = board.kpiRules;
  const notValidated: Array<Column<KpiRepRow>> =
    bricks.asked || bricks.read
      ? [{ header: "Not validated yet", width: 11, cell: (row) => notValidatedCell(row, bricks.read) }]
      : [];
  return [
    { header: "Medical rep", width: 28, cell: (row) => text(row.repName) },
    { header: "Hire date", width: 13, cell: (row) => ({ kind: "date", value: row.hireDate ?? null }) },
    { header: "Job title", width: 20, cell: (row) => text(row.jobTitle) },
    { header: "Line", width: 16, cell: (row) => text(row.lineName) },
    { header: "Area", width: 18, cell: (row) => text(row.areaName) },
    // Region beside Manager (premium pass, 9 Nov 2026), so the file can be grouped the way the Coverage
    // screen files its reps — by region and direct manager — with a filter on two columns.
    { header: "Region", width: 18, cell: (row) => text(row.regionName) },
    { header: "Manager", width: 24, cell: (row) => text(row.managerName) },
    { header: "Coverage", width: 11, cell: (row) => planPct(row, row.coveragePct) },
    { header: "Doctors planned", width: 11, cell: (row) => ({ kind: "count", value: row.plannedDoctors }) },
    { header: "Doctors visited", width: 11, cell: (row) => ({ kind: "count", value: row.visitedDoctors }) },
    ...notValidated,
    { header: "Frequency", width: 11, cell: (row) => planPct(row, row.frequencyPct) },
    { header: `AM vs ${board.amTarget} a day`, width: 12, cell: amPct },
    { header: "AM verified", width: 10, cell: (row) => proved(row, row.amVerified, "count") },
    { header: "AM reported", width: 10, cell: (row) => ({ kind: "count", value: row.amReported }) },
    { header: "AM a day", width: 10, cell: (row) => proved(row, row.amRate, "rate") },
    { header: `PM vs ${board.pmTarget} a day`, width: 12, cell: pmPct },
    { header: "PM verified", width: 10, cell: (row) => proved(row, row.pmVerified, "count") },
    { header: "PM reported", width: 10, cell: (row) => ({ kind: "count", value: row.pmReported }) },
    { header: "PM a day", width: 10, cell: (row) => proved(row, row.pmRate, "rate") },
    { header: "Pharmacy verified", width: 11, cell: (row) => proved(row, row.pharmacyVerified, "count") },
    { header: "Pharmacy a day", width: 11, cell: (row) => proved(row, row.pharmacyRate, "rate") },
    { header: "Overall", width: 11, cell: overallPct },
    {
      header: "Flags",
      width: 34,
      cell: (row) =>
        text(
          kpiFlagsOf(row)
            .map((flag) =>
              flag === "just-started" && row.justStarted
                ? `${KPI_EXPORT_MARKERS.justStarted} · ${row.justStarted.workingDaysIn} working days in`
                : kpiFlagLabel(flag, rules),
            )
            .join(" · "),
        ),
    },
  ];
}

function managerPct(value: number | null, marker: string): Cell {
  return { kind: "pct", value, marker };
}

function managerColumns(board: KpisBoard): Array<Column<KpiManagerRow>> {
  return [
    { header: "Manager", width: 28, cell: (row) => text(row.name) },
    { header: "Role", width: 22, cell: (row) => text(row.jobTitle || KPI_MANAGER_LEVEL_LABEL[row.level]) },
    { header: "Line", width: 16, cell: (row) => text(row.lineName) },
    { header: "Area", width: 18, cell: (row) => text(row.areaName) },
    { header: "Reports to", width: 24, cell: (row) => text(row.reportsTo) },
    { header: "Reps beneath", width: 11, cell: (row) => ({ kind: "count", value: row.repsBeneath }) },
    { header: "Coverage", width: 11, cell: (row) => managerPct(row.coveragePct, KPI_EXPORT_MARKERS.noPlan) },
    { header: "Frequency", width: 11, cell: (row) => managerPct(row.frequencyPct, KPI_EXPORT_MARKERS.noPlan) },
    {
      header: `AM vs ${board.amTarget} a day`,
      width: 12,
      cell: (row) => managerPct(row.amAttainmentPct, KPI_EXPORT_MARKERS.noCalls),
    },
    { header: "AM a day", width: 10, cell: (row) => ({ kind: "rate", value: row.amRate, marker: KPI_EXPORT_MARKERS.noCalls }) },
    {
      header: `PM vs ${board.pmTarget} a day`,
      width: 12,
      cell: (row) => managerPct(row.pmAttainmentPct, KPI_EXPORT_MARKERS.noCalls),
    },
    { header: "PM a day", width: 10, cell: (row) => ({ kind: "rate", value: row.pmRate, marker: KPI_EXPORT_MARKERS.noCalls }) },
    {
      header: "Pharmacy a day",
      width: 11,
      cell: (row) => ({ kind: "rate", value: row.pharmacyRate, marker: KPI_EXPORT_MARKERS.noCalls }),
    },
    { header: "Overall", width: 11, cell: (row) => managerPct(row.overallPct, KPI_EXPORT_MARKERS.noScore) },
  ];
}

/** The By brick sheet: the screen's columns, in the board's own frequency words. */
function brickColumns(board: KpisBoard): Array<Column<KpiBrickRow>> {
  return [
    { header: "Brick", width: 30, cell: (row) => text(row.label) },
    { header: "Reps", width: 9, cell: (row) => ({ kind: "count", value: row.reps }) },
    { header: "Doctors planned", width: 11, cell: (row) => ({ kind: "count", value: row.planned }) },
    { header: "Doctors visited", width: 11, cell: (row) => ({ kind: "count", value: row.covered }) },
    {
      header: "Coverage",
      width: 11,
      cell: (row) => ({
        kind: "pct",
        value: row.planned > 0 ? Math.round((row.covered / row.planned) * 100) : null,
        marker: KPI_EXPORT_MARKERS.noPlan,
      }),
    },
    ...kpiBrickFrequencyColumns(board.kpiRules === "phoenix").map(
      (column): Column<KpiBrickRow> => ({ header: column.label, width: 11, cell: (row) => ({ kind: "count", value: column.count(row) }) }),
    ),
  ];
}

/** One line of the Teams sheet: a region and direct manager, and that team's coverage. */
type TeamLine = { team: KpiCoverageTeam<KpiRepRow>; coverage: KpiTeamCoverage };

/** The Teams sheet: the Coverage screen's team headings as columns. */
function teamColumns(board: KpisBoard): Array<Column<TeamLine>> {
  return [
    { header: "Region", width: 22, cell: (line) => text(line.team.regionName) },
    { header: "Manager", width: 26, cell: (line) => text(line.team.managerName) },
    { header: "Reps", width: 9, cell: (line) => ({ kind: "count", value: line.coverage.reps }) },
    { header: "Just started", width: 11, cell: (line) => ({ kind: "count", value: line.coverage.justStarted }) },
    { header: "Doctors planned", width: 11, cell: (line) => ({ kind: "count", value: line.coverage.planned }) },
    { header: "Doctors visited", width: 11, cell: (line) => ({ kind: "count", value: line.coverage.covered }) },
    { header: "Not reached", width: 11, cell: (line) => ({ kind: "count", value: line.coverage.notReached }) },
    {
      header: "Coverage",
      width: 11,
      cell: (line) => ({ kind: "pct", value: line.coverage.coveragePct, marker: KPI_EXPORT_MARKERS.noPlan }),
    },
    {
      header: `Reps at the ${board.coverageFloorPct}% floor`,
      width: 13,
      cell: (line) =>
        line.coverage.withPlan > 0
          ? { kind: "text", value: `${line.coverage.atFloor} of ${line.coverage.withPlan}` }
          : { kind: "text", value: KPI_EXPORT_MARKERS.noPlan },
    },
    { header: "Off plan doctors", width: 11, cell: (line) => ({ kind: "count", value: line.coverage.offPlan }) },
  ];
}

/** The open rep's doctors, as the list on screen prints each one. */
function doctorColumns(): Array<Column<KpiCoverageDoctor>> {
  return [
    { header: "Doctor", width: 30, cell: (row) => text(row.name ?? KPI_EXPORT_MARKERS.nameNotOnPlan) },
    { header: "Speciality", width: 18, cell: (row) => text(row.speciality) },
    { header: "Grade", width: 8, cell: (row) => text(row.grade) },
    { header: "Brick", width: 24, cell: (row) => text(kpiDoctorBrickLabel(row) ?? KPI_EXPORT_MARKERS.notRead) },
    { header: "Days planned", width: 10, cell: (row) => ({ kind: "count", value: row.planDates.length }) },
    { header: "First planned day", width: 13, cell: (row) => ({ kind: "date", value: row.planDates[0] ?? null }) },
    { header: "Visits", width: 9, cell: (row) => ({ kind: "count", value: row.visits }) },
    {
      header: "Last visit",
      width: 13,
      cell: (row) => ({ kind: "date", value: row.lastVisitDate, marker: KPI_EXPORT_MARKERS.notVisited }),
    },
    { header: "Verdict", width: 14, cell: (row) => text(row.frequency ? KPI_FREQUENCY_STATUS_LABEL[row.frequency.status] : null) },
  ];
}

function writeCell(cell: ExcelJS.Cell, value: Cell, zebra: boolean) {
  houseBodyStyle(cell, { zebra, size: 9.5 });
  const markerFont = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, name: HOUSE_XLSX_FONT, size: 9 };
  switch (value.kind) {
    case "pct": {
      if (value.value == null) {
        cell.value = value.marker;
        cell.font = markerFont;
        cell.alignment = { horizontal: "center", vertical: "middle" };
        return;
      }
      const tone = HOUSE_XLSX_SIGNAL[signalOf(value.value)];
      cell.value = value.value / 100;
      cell.numFmt = "0%";
      cell.font = { bold: true, color: { argb: tone.ink }, name: HOUSE_XLSX_FONT, size: 9.5 };
      cell.fill = { fgColor: { argb: tone.tint }, pattern: "solid", type: "pattern" };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      return;
    }
    case "rate": {
      if (value.value == null) {
        cell.value = value.marker || null;
        if (value.marker) cell.font = markerFont;
        cell.alignment = { horizontal: "center", vertical: "middle" };
        return;
      }
      cell.value = value.value;
      cell.numFmt = "0.00";
      cell.alignment = { horizontal: "right", vertical: "middle" };
      return;
    }
    case "count":
      cell.value = value.value;
      cell.numFmt = "#,##0";
      cell.alignment = { horizontal: "right", vertical: "middle" };
      return;
    case "date": {
      const date = hireDateCellValue(value.value);
      if (date) {
        cell.value = date;
        cell.numFmt = "dd mmm yyyy";
        cell.alignment = { horizontal: "left", vertical: "middle" };
      } else {
        cell.value = value.marker ?? KPI_EXPORT_MARKERS.notRecorded;
        cell.font = markerFont;
      }
      return;
    }
    case "text":
      if (value.value == null) {
        cell.value = KPI_EXPORT_MARKERS.notRecorded;
        cell.font = markerFont;
      } else {
        cell.value = value.value;
        cell.alignment = { vertical: "middle", wrapText: true };
      }
  }
}

function writeTableSheet<Row>(
  workbook: ExcelJS.Workbook,
  input: { sheetName: string; title: string; subtitle: string; provenance: string[]; columns: Array<Column<Row>>; rows: Row[]; empty: string },
) {
  const sheet = workbook.addWorksheet(input.sheetName, { properties: { defaultRowHeight: 18 } });
  sheet.views = [{ showGridLines: false }];
  input.columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width;
  });

  const headerRowNumber = writeHouseMasthead(workbook, sheet, {
    columns: input.columns.length,
    provenance: input.provenance,
    subtitle: input.subtitle,
    title: input.title,
  });

  const header = sheet.getRow(headerRowNumber);
  header.height = 32;
  input.columns.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = column.header;
    houseHeaderStyle(cell, { center: index > 0, size: 9.5 });
  });

  if (input.rows.length === 0) {
    sheet.mergeCells(headerRowNumber + 1, 1, headerRowNumber + 1, input.columns.length);
    const cell = sheet.getCell(headerRowNumber + 1, 1);
    cell.value = input.empty;
    cell.font = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, name: HOUSE_XLSX_FONT, size: 10 };
    return sheet;
  }

  input.rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(headerRowNumber + 1 + rowIndex);
    excelRow.height = 20;
    input.columns.forEach((column, columnIndex) => {
      writeCell(excelRow.getCell(columnIndex + 1), column.cell(row), rowIndex % 2 === 1);
    });
  });

  // The name column stays on screen while the measures scroll, and the header while the reps do.
  sheet.views = [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: headerRowNumber }];
  sheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber + input.rows.length, column: input.columns.length },
  };
  sheet.pageSetup = { fitToHeight: 0, fitToPage: true, fitToWidth: 1, orientation: "landscape", paperSize: 9 };
  return sheet;
}

function pctWords(value: number | null, marker: string): string {
  return value == null ? marker : `${value}%`;
}

/**
 * The workbook for one board. `generatedAtIso` is passed in so a test can pin the cover's time.
 */
export async function buildKpisBoardWorkbook(
  board: KpisBoard,
  generatedAtIso: string,
  options: KpisWorkbookOptions = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date(generatedAtIso);

  const window = `${board.range.dateFrom} to ${board.range.dateTo}`;
  const shown =
    board.reps.length === board.scopedReps
      ? `${board.reps.length} reps`
      : `${board.reps.length} of ${board.scopedReps} reps (filtered as on screen)`;
  const subtitle = `${board.monthLabel} · ${board.range.periodLabel} · ${board.scopeLabel}`;
  const { totals } = board;
  const bricks = { asked: Boolean(options.doctorLists), read: board.teamBricks != null };
  const detail = board.coverageDetail ?? null;
  const allDoctors = detail ? [...detail.covered, ...detail.notCovered] : [];
  const doctors = detail ? filterKpiDoctors(allDoctors, board.filters.doctor) : [];
  const doctorsShown = detail
    ? `${doctors.length} of ${allDoctors.length} doctors on ${detail.repName}'s list${
        countActiveKpiDoctorFilter(board.filters.doctor) > 0 ? ", as filtered on screen" : ""
      }`
    : null;
  const brickRows: Array<[string, string]> = bricks.read
    ? [["Bricks", "Each doctor's brick is the one the doctor's validated live photo was filed in"]]
    : bricks.asked
      ? [["Bricks", "The doctors' bricks could not be read, so this file holds no brick figures"]]
      : [];

  buildHouseCoverSheet(workbook, {
    title: "Field Force KPIs",
    subtitle,
    confidentialNote:
      "Internal — Sato Pharma field force performance. Every figure is the KPIs board's own, for the scope, period and filters it was exported with.",
    rows: [
      ["Month", board.monthLabel],
      ["Period", board.range.periodLabel],
      ["Call-rate window", `${window} · ${board.workingDays} working days`],
      ["Coverage and frequency to", board.asOf],
      ["Scope", board.scopeLabel],
      ["Reps", shown],
      ["Managers", String(board.managers.length)],
      ["Rules", board.kpiRules === "phoenix" ? "Phoenix CRM rules" : "Original CRM rules"],
      ["Team coverage", pctWords(totals.reps > 0 ? totals.coveragePct : null, KPI_EXPORT_MARKERS.noPlan)],
      ["Team frequency", pctWords(totals.reps > 0 ? totals.frequencyPct : null, KPI_EXPORT_MARKERS.noPlan)],
      [`Team AM vs ${board.amTarget} a day`, pctWords(totals.amAttainmentPct, KPI_EXPORT_MARKERS.noCalls)],
      [`Team PM vs ${board.pmTarget} a day`, pctWords(totals.pmAttainmentPct, KPI_EXPORT_MARKERS.noCalls)],
      ["Team overall", pctWords(board.kpiIndex.overallPct, KPI_EXPORT_MARKERS.noScore)],
      ["How overall is scored", board.kpiIndex.method],
      ...brickRows,
      ...(doctorsShown ? ([["Doctors", doctorsShown]] as Array<[string, string]>) : []),
      ...(board.holidaysComplete
        ? []
        : ([["Holidays", "A holiday calendar could not be read, so call rates may read low."]] as Array<[string, string]>)),
      houseGeneratedRow(generatedAtIso),
    ],
    emphasise: (key) => key === "Holidays" || (key === "Bricks" && !bricks.read),
  });

  writeTableSheet(workbook, {
    sheetName: "Medical reps",
    title: "Medical reps",
    subtitle,
    provenance: [shown],
    columns: repColumns(board, bricks),
    rows: board.reps,
    empty: board.scopeReason ?? "No medical rep matches this board.",
  });

  writeTableSheet(workbook, {
    sheetName: "Managers",
    title: "Managers",
    subtitle: `${subtitle} · each figure is the average of the rows directly beneath that manager`,
    provenance: [`${board.managers.length} managers`],
    columns: managerColumns(board),
    rows: board.managers,
    empty: "No manager sits above the reps on this board.",
  });

  if (board.teamBricks) {
    writeTableSheet(workbook, {
      sheetName: "By brick",
      title: "By brick",
      subtitle: `${subtitle} · every rep's planned doctors by the brick of the doctor's validated live photo`,
      provenance: [
        `${board.teamBricks.length} bricks · a doctor two reps both plan counts once for each, as Planned does · reps who have just started are left out`,
      ],
      columns: brickColumns(board),
      rows: board.teamBricks,
      empty: "No planned doctor on this board to put in a brick.",
    });
  }

  const teams: TeamLine[] =
    options.doctorLists && board.reps.length > 1
      ? groupKpiRepsByTeam(board.reps).map((team) => ({
          team,
          coverage: kpiTeamCoverage(
            team.members.map((member) => member.row),
            board.kpiRules,
          ),
        }))
      : [];
  if (teams.length >= 2) {
    writeTableSheet(workbook, {
      sheetName: "Teams",
      title: "Teams",
      subtitle: `${subtitle} · every rep filed under their region and direct manager`,
      provenance: [
        `${teams.length} teams · a team's coverage is its visited over its planned doctors · reps who have just started are a head and nothing else, as on the board`,
      ],
      columns: teamColumns(board),
      rows: teams,
      empty: "No team on this board.",
    });
  }

  if (detail && doctorsShown) {
    writeTableSheet(workbook, {
      sheetName: "Doctors",
      title: `Doctors · ${detail.repName}`,
      subtitle,
      provenance: [doctorsShown],
      columns: doctorColumns(),
      rows: doctors,
      empty: "No doctor on this list matches the filters on screen.",
    });
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

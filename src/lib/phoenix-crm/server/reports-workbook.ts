/**
 * Phoenix CRM — the reports pack, as one workbook (C1 of the owner's plan).
 *
 * It lives under server/ and not at the path the plan named: it imports ExcelJS and the services'
 * own view types, and phoenix-crm-boundary forbids a rule module outside server/ from touching either
 * — those modules are bundled for the phone. A workbook builder is server code by nature.
 *
 * ## House identity, not the Phoenix kit
 *
 * Phoenix CRM's reports are a MANAGER READ of the company's own field work, so this wears
 * `SATO-DIS-2026-01` like every other company document: `buildHouseCoverSheet` for the cover,
 * `writeHouseTable` for each sheet. The two exemptions from the house identity are the automated
 * payroll exports and the offer letter, and neither is this — do not "bring it into line" with the
 * Phoenix black-and-orange the screen uses.
 *
 * ## 🔴 ONE workbook, and the viewer's scope decides which SHEETS exist
 *
 * A `null` section writes NO SHEET. That is the whole access design of this file: a medical rep
 * exporting his own territory must not receive a "Where the visit was saved" tab that is empty — an
 * empty tab tells him the report exists and that he is not trusted with it, which is the disclosure
 * Golden Rule #1 forbids, only in a file he can keep. The route loads only what the viewer may read
 * and hands the rest as `null`, so the absence is real and not a filter.
 *
 * Every figure here is already computed by the services; this file formats and never recomputes. Two
 * rules it must carry across unchanged:
 *
 *   - **AM and PM are always apart**, in every sheet and every total. Never a combined column, never
 *     a slash. A reader who wants one figure is a reader about to average a call rate.
 *   - **A brick's sales never add up to the area's closing figure.** The bricks sheet carries the
 *     server's own caveat as a note under the table, in the same words the screen prints.
 */

import ExcelJS from "exceljs";

import { buildHouseCoverSheet, writeHouseTable, type CellValue, type TableColumn } from "@/lib/export/house-table-workbook";
import { houseGeneratedRow } from "@/lib/export/house-xlsx-identity";

import type { AdoptionView } from "@/lib/phoenix-crm/server/adoption";
import type { BrickCoverageView } from "@/lib/phoenix-crm/server/brick-report";
import type { ExceptionsView } from "@/lib/phoenix-crm/server/exceptions";
import type {
  CoverageReportView,
  ManagerReportView,
  PlanReportView,
  VisitLocationReportView,
  VisitsReportView,
} from "@/lib/phoenix-crm/server/reports";

/**
 * Every section the pack can hold. A `null` is a section this viewer may not read, and it writes no
 * sheet at all — see the header for why an empty tab would be worse than a missing one.
 */
export type ReportsPackInput = {
  /** Who it is for and over what, printed on the cover so a saved file can never be misread later. */
  viewerName: string;
  periodText: string;
  scopeText: string;
  includeTest: boolean;
  generatedAtIso: string;
  visits: VisitsReportView | null;
  plan: PlanReportView | null;
  coverage: CoverageReportView | null;
  managers: ManagerReportView | null;
  locations: VisitLocationReportView | null;
  exceptions: ExceptionsView | null;
  adoption: AdoptionView | null;
  bricks: BrickCoverageView | null;
};

const COUNT = "#,##0";
const PERCENT = "0.0";

function pct(value: number | null): CellValue {
  return value === null ? "—" : value;
}

function column(label: string, options: { numFmt?: string; right?: boolean; width?: number } = {}): TableColumn {
  return { label, ...options };
}

const NAME = column("", { width: 26 });

/** A counted column: right-aligned, thousands-separated, narrow. */
function counted(label: string, width = 11): TableColumn {
  return { label, numFmt: COUNT, right: true, width };
}

function percentColumn(label: string, width = 11): TableColumn {
  return { label, numFmt: PERCENT, right: true, width };
}

// ── The sheets ──────────────────────────────────────────────────────────────────────────────────

function writeVisits(workbook: ExcelJS.Workbook, view: VisitsReportView): void {
  const sheet = workbook.addWorksheet("Visits per day");
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  writeHouseTable(sheet, 1, {
    // AM and PM are six columns, never three: a combined column is the thing the call-rate golden
    // rule exists to prevent, and a workbook is exactly where someone would add one "for convenience".
    columns: [
      { ...NAME, label: "Rep" },
      column("Territory", { width: 22 }),
      column("Line", { width: 16 }),
      counted("Days out"),
      counted("AM visits"),
      counted("AM double"),
      counted("AM chain"),
      counted("PM visits"),
      counted("PM double"),
      counted("PM chain"),
      counted("Off-plan waiting", 16),
    ],
    note:
      "Off-plan visits waiting for a decision are counted BESIDE the visits, never inside them — a day that reads low only "
      + "because three visits are with the manager must say so.",
    rows: view.rows.map((row) => [
      row.repName,
      row.territoryName,
      row.lineName ?? "—",
      row.visitDays,
      row.am.visits,
      row.am.doubleVisits,
      row.am.chainVisits,
      row.pm.visits,
      row.pm.doubleVisits,
      row.pm.chainVisits,
      row.am.unplannedWaiting + row.pm.unplannedWaiting,
    ]),
    title: `Visits per rep · ${view.period.from} to ${view.period.to}`,
    totals: [
      "All",
      "",
      "",
      "",
      view.totals.AM.visits,
      view.totals.AM.doubleVisits,
      view.totals.AM.chainVisits,
      view.totals.PM.visits,
      view.totals.PM.doubleVisits,
      view.totals.PM.chainVisits,
      view.totals.AM.unplannedWaiting + view.totals.PM.unplannedWaiting,
    ],
  });
}

function writePlan(workbook: ExcelJS.Workbook, view: PlanReportView): void {
  const sheet = workbook.addWorksheet("Plan against actual");
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Territory" },
      column("Rep", { width: 22 }),
      counted("AM planned"),
      counted("AM visited"),
      counted("AM missed"),
      percentColumn("AM kept %"),
      counted("PM planned"),
      counted("PM visited"),
      counted("PM missed"),
      percentColumn("PM kept %"),
      counted("Off-plan"),
    ],
    note:
      view.runningDay === null
        ? "Plan kept counts a planned customer visited on the planned day, on a visit that was itself planned."
        : `${view.runningDay} is today: its planned customers can still be visited, so "missed" is not final for that day.`,
    rows: view.rows.map((row) => [
      row.territoryName,
      row.repName ?? "No rep",
      row.am.planned,
      row.am.visitedPlanned,
      row.am.missed,
      pct(row.am.keptPct),
      row.pm.planned,
      row.pm.visitedPlanned,
      row.pm.missed,
      pct(row.pm.keptPct),
      row.am.unplanned + row.pm.unplanned,
    ]),
    title: `Plan against actual · ${view.period.from} to ${view.period.to}`,
    totals: [
      "All",
      "",
      view.totals.AM.planned,
      view.totals.AM.visitedPlanned,
      view.totals.AM.missed,
      pct(view.totals.AM.keptPct),
      view.totals.PM.planned,
      view.totals.PM.visitedPlanned,
      view.totals.PM.missed,
      pct(view.totals.PM.keptPct),
      view.totals.AM.unplanned + view.totals.PM.unplanned,
    ],
  });
}

function writeCoverage(workbook: ExcelJS.Workbook, view: CoverageReportView): void {
  const sheet = workbook.addWorksheet("Coverage and frequency");
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Territory" },
      column("Rep", { width: 22 }),
      counted("AM on list"),
      counted("AM covered"),
      percentColumn("AM coverage %", 14),
      percentColumn("AM frequency %", 15),
      counted("PM on list"),
      counted("PM covered"),
      percentColumn("PM coverage %", 14),
      percentColumn("PM frequency %", 15),
    ],
    note: "Coverage is customers seen at least once; frequency is those seen exactly their grade's target. The two disagree by design.",
    rows: view.rows.map((row) => [
      row.territoryName,
      row.repName ?? "No rep",
      row.am.customers,
      row.am.covered,
      pct(row.am.coveragePct),
      pct(row.am.frequencyPct),
      row.pm.customers,
      row.pm.covered,
      pct(row.pm.coveragePct),
      pct(row.pm.frequencyPct),
    ]),
    title: `Coverage and frequency · ${view.month.month}`,
    totals: [
      "All",
      "",
      view.totals.AM.customers,
      view.totals.AM.covered,
      pct(view.totals.AM.coveragePct),
      pct(view.totals.AM.frequencyPct),
      view.totals.PM.customers,
      view.totals.PM.covered,
      pct(view.totals.PM.coveragePct),
      pct(view.totals.PM.frequencyPct),
    ],
  });
}

function writeManagers(workbook: ExcelJS.Workbook, view: ManagerReportView): void {
  const sheet = workbook.addWorksheet("Double and chain visits");
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Manager" },
      column("Title", { width: 24 }),
      column("Line", { width: 16 }),
      counted("Double"),
      counted("Chain"),
      counted("Senior chain", 14),
      counted("Days out"),
      counted("Reps"),
      counted("AM visits"),
      counted("PM visits"),
    ],
    note: "A manager with no double or chain visit in the period is listed too — the absence is the finding.",
    rows: view.rows.map((row) => [
      row.name,
      row.title,
      row.lineName ?? "—",
      row.doubleVisits,
      row.chainVisits,
      row.seniorChainVisits,
      row.daysOut,
      row.reps,
      row.amVisits,
      row.pmVisits,
    ]),
    title: `Double and chain visits per manager · ${view.period.from} to ${view.period.to}`,
  });
}

function writeLocations(workbook: ExcelJS.Workbook, view: VisitLocationReportView): void {
  const sheet = workbook.addWorksheet("Where the visit was saved");
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  writeHouseTable(sheet, 1, {
    columns: [
      column("Day", { width: 13 }),
      { ...NAME, label: "Rep" },
      column("Customer", { width: 28 }),
      column("List", { width: 7 }),
      column("Place", { width: 26 }),
      column("Where the place is", { width: 26 }),
      column("Distance", { right: true, width: 13 }),
      column("Off plan", { width: 10 }),
    ],
    note:
      view.rows.length < view.total
        ? `The ${view.rows.length} farthest of ${view.total} visits in the period. The summary above the table on screen is measured over all of them.`
        : "Every visit in the period, farthest first.",
    rows: view.rows.map((row) => [
      row.visitDate,
      row.repName,
      row.customerName,
      row.listType,
      row.placeLabel ?? "No place saved",
      row.placeWhere ?? "—",
      row.distanceText,
      row.isUnplanned ? "Yes" : "",
    ]),
    title: `Where the visit was saved · ${view.period.from} to ${view.period.to}`,
  });
}

function writeExceptions(workbook: ExcelJS.Workbook, view: ExceptionsView): void {
  const sheet = workbook.addWorksheet("Needs you");
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Territory" },
      column("Rep", { width: 22 }),
      column("Line", { width: 16 }),
      column("What", { width: 30 }),
      column("Where it stands", { width: 34 }),
    ],
    // A territory with nothing wrong is ABSENT — the same rule the board runs on. In a workbook that
    // needs saying out loud, because a reader counting rows would otherwise read a short sheet as a
    // failed export rather than as a good week.
    note:
      `Only the territories that need a manager, worst first, one line each. A territory with nothing wrong is ABSENT — `
      + `a short sheet is the good outcome. The last full field day is ${view.lastFieldDay}.`,
    rows: view.rows.map((row) => [row.territoryName, row.repName ?? "No rep", row.lineName ?? "—", row.label, row.detail ?? "—"]),
    title: "Needs you today",
  });
}

function writeBricks(workbook: ExcelJS.Workbook, view: BrickCoverageView): void {
  const sheet = workbook.addWorksheet("Coverage against sales");
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Brick" },
      column("Territory", { width: 22 }),
      column("Area", { width: 18 }),
      column("Standing", { width: 28 }),
      counted("AM on list"),
      counted("AM called on", 14),
      counted("PM on list"),
      counted("PM called on", 14),
      counted("Visits"),
      counted("Booked on it", 16),
    ],
    // 🔴 The server's own sentence, verbatim. A workbook leaves the building, so this is the one
    // place the caveat MUST travel with the figures rather than living beside them on a screen.
    note: `${view.caveat}${view.salesMonths.length > 0 ? ` Sales cover ${view.salesMonths.join(", ")}.` : " No distributor file has landed for these months yet."}`,
    rows: view.rows.map((row) => [
      row.brickName,
      row.territoryName,
      row.areaName ?? "—",
      row.status,
      row.am,
      row.amVisited,
      row.pm,
      row.pmVisited,
      row.visits,
      row.sales,
    ]),
    title: `Coverage against sales, per brick · ${view.period.from} to ${view.period.to}`,
    totals: ["All bricks", "", "", "", "", "", "", "", "", view.summary.brickSales],
  });
}

function writeAdoption(workbook: ExcelJS.Workbook, view: AdoptionView): void {
  const sheet = workbook.addWorksheet("Who has started");
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Territory" },
      column("Rep", { width: 22 }),
      column("Line", { width: 16 }),
      column("Where it has got to", { width: 30 }),
      counted("Days open"),
      column("First visit", { width: 14 }),
      column("Overdue", { width: 10 }),
    ],
    note:
      "Nothing is left out: a territory doing fine is the good news, and one whose line has not opened is the other half of "
      + "the same question. A territory counts as never opened until something is entered — a validation, a drop, or a visit — "
      + `and a line gets ${view.graceDays} days before that is called overdue.`,
    rows: view.rows.map((row) => [
      row.territoryName,
      row.repName ?? "No rep",
      row.lineName ?? "—",
      row.label,
      // 🔴 An em dash, never 0: an undated line is "we do not know", and a zero would read as "today".
      row.daysOpen === null ? "—" : row.daysOpen,
      row.firstVisitOn ?? "None yet",
      row.overdue ? "Yes" : "",
    ]),
    title: `Who has started · as at ${view.cairoToday}`,
  });
}

// ── The pack ────────────────────────────────────────────────────────────────────────────────────

/** The sheets this pack would hold, in order — used by the cover and by the test. */
export function packSections(input: ReportsPackInput): string[] {
  return [
    input.exceptions ? "Needs you" : null,
    input.visits ? "Visits per day" : null,
    input.plan ? "Plan against actual" : null,
    input.coverage ? "Coverage and frequency" : null,
    input.bricks ? "Coverage against sales" : null,
    input.managers ? "Double and chain visits" : null,
    input.locations ? "Where the visit was saved" : null,
    input.adoption ? "Who has started" : null,
  ].filter((name): name is string => name !== null);
}

export async function buildPhoenixCrmReportsWorkbook(input: ReportsPackInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sections = packSections(input);

  buildHouseCoverSheet(workbook, {
    confidentialNote:
      "Phoenix CRM field reporting. It names individual employees and their work, so it is shared only with the managers "
      + "above them.",
    rows: [
      ["Prepared for", input.viewerName],
      ["Period", input.periodText],
      ["Scope", input.scopeText],
      ["Sheets", sections.length > 0 ? sections.join(" · ") : "None — nothing in scope to report"],
      ["Entries", input.includeTest ? "Includes the Super Admin's test entries" : "Real entries only"],
      houseGeneratedRow(input.generatedAtIso),
    ],
    subtitle: "Counted from what the field force enters in Phoenix CRM. AM and PM are always counted apart.",
    title: "Phoenix CRM · Field reports",
  });

  // The order the cover promises. A section the viewer may not read is null and writes NO sheet —
  // an empty tab would tell him the report exists and that he is not trusted with it.
  if (input.exceptions) writeExceptions(workbook, input.exceptions);
  if (input.visits) writeVisits(workbook, input.visits);
  if (input.plan) writePlan(workbook, input.plan);
  if (input.coverage) writeCoverage(workbook, input.coverage);
  if (input.bricks) writeBricks(workbook, input.bricks);
  if (input.managers) writeManagers(workbook, input.managers);
  if (input.locations) writeLocations(workbook, input.locations);
  if (input.adoption) writeAdoption(workbook, input.adoption);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

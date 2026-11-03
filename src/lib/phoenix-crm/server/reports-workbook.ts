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
 * ## 🔴 A report is NAMED once, in `report-guide.ts`
 *
 * `SECTION_TITLES` is read for all three places a report's name appears here — the worksheet tab,
 * the heading inside the sheet, and `packSections`, which is what the COVER promises. Spelling one
 * out by hand is how a rename reaches the screen and not the download, and how a cover comes to
 * promise a tab the workbook does not contain; `exceptions` had already drifted that way. The one
 * deliberate exception is the visits sheet's heading, marked where it sits.
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
 *   - **Units of different products are never added** (the owner's standing rule). The samples sheet
 *     has no total row: a quantity is summed within its own product only, and what is counted across
 *     items is VISITS.
 *
 * The four insight boards of 2026-10-02 — grade against capacity, what the field heard, missing stock,
 * samples by month — are manager sections like the screen's, and each carries its screen's own words:
 * list size and never coverage, counts and never a rate, a shelf and never a stock balance.
 */

import ExcelJS from "exceljs";

import { buildHouseCoverSheet, writeHouseTable, type CellValue, type HouseTableInput, type TableColumn } from "@/lib/export/house-table-workbook";
import { houseGeneratedRow } from "@/lib/export/house-xlsx-identity";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";

import { weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { capacityVerdictText, gradeTargetsText, type ListCapacity } from "@/lib/phoenix-crm/capacity-board";
import {
  dailyPlanActivityText,
  dailyPlanCustomerNotes,
  dailyPlanDayIsEmpty,
  dailyPlanStateLabel,
  dailyPlanVisitText,
  type DailyPlanCustomer,
  type DailyPlanReportView,
} from "@/lib/phoenix-crm/daily-plan-report";
import { brickStatusLabel } from "@/lib/phoenix-crm/brick-report";
import { HEARD_BASIS_TEXT, heardTallyText, type HeardRow } from "@/lib/phoenix-crm/field-heard";
import { objectionCustomerRows } from "@/lib/phoenix-crm/objections-by-customer";
import { LEAVE_UNREAD_NOTE } from "@/lib/phoenix-crm/plan-leave";
import { SECTION_TITLES } from "@/lib/phoenix-crm/report-guide";
import { PHOENIX_CRM_WEEKDAY_NAMES } from "@/lib/phoenix-crm/timings";
import type { AdoptionView } from "@/lib/phoenix-crm/server/adoption";
import type { BrickCoverageView } from "@/lib/phoenix-crm/server/brick-report";
import type { ExceptionsView } from "@/lib/phoenix-crm/server/exceptions";
import type { CapacityBoardView, FieldHeardView, MissingStockView, ObjectionsByCustomerView, SamplesReportView } from "@/lib/phoenix-crm/server/insight-reports";
import type {
  CoverageReportView,
  CustomerFrequencyReportView,
  ManagerReportView,
  PlanReportView,
  TrackingSheetReportView,
  VisitLocationReportView,
  VisitsReportView,
} from "@/lib/phoenix-crm/server/reports";
import type { TeamCalendarView } from "@/lib/phoenix-crm/server/team-calendar";

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
  /** One territory's plan, day by day — null (no sheet) unless ONE territory was read. */
  dailyPlan: DailyPlanReportView | null;
  coverage: CoverageReportView | null;
  /** Per CUSTOMER, so null unless one territory was chosen — see the export route. */
  frequency: CustomerFrequencyReportView | null;
  tracking: TrackingSheetReportView | null;
  calendar: TeamCalendarView | null;
  managers: ManagerReportView | null;
  locations: VisitLocationReportView | null;
  exceptions: ExceptionsView | null;
  adoption: AdoptionView | null;
  bricks: BrickCoverageView | null;
  /** The four insight boards of 2026-10-02 — manager sections, null (no sheet) for anyone else. */
  capacity: CapacityBoardView | null;
  /** A manager's whole report; for a product or marketing manager, his own products and nothing else. */
  heard: FieldHeardView | null;
  stock: MissingStockView | null;
  samples: SamplesReportView | null;
  /** A manager section (owner, 2026-11-03), null (no sheet) for anyone else. */
  objections: ObjectionsByCustomerView | null;
};

const COUNT = "#,##0";
const PERCENT = "0.0";
const ONE_DECIMAL = "0.0";

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
  const sheet = workbook.addWorksheet(SECTION_TITLES.visits);
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  writeHouseTable(sheet, 1, {
    // AM and PM are eight columns, never four: a combined column is the thing the call-rate golden
    // rule exists to prevent, and a workbook is exactly where someone would add one "for convenience"
    // — which is exactly what the off-plan column was until 2026-10-02.
    columns: [
      { ...NAME, label: "Rep" },
      column("Territory", { width: 22 }),
      column("Line", { width: 16 }),
      counted("Days out"),
      counted("AM visits"),
      counted("AM double"),
      counted("AM chain"),
      counted("AM off-plan waiting", 18),
      counted("PM visits"),
      counted("PM double"),
      counted("PM chain"),
      counted("PM off-plan waiting", 18),
    ],
    note:
      "Off-plan visits waiting for a decision are counted BESIDE the visits, never inside them — a day that reads low only "
      + "because three visits are with the manager must say so. AM and PM are apart in every column, this one included: a "
      + "single off-plan figure was the one place this sheet added them.",
    rows: view.rows.map((row) => [
      row.repName,
      row.territoryName,
      row.lineName ?? "—",
      row.visitDays,
      row.am.visits,
      row.am.doubleVisits,
      row.am.chainVisits,
      row.am.unplannedWaiting,
      row.pm.visits,
      row.pm.doubleVisits,
      row.pm.chainVisits,
      row.pm.unplannedWaiting,
    ]),
    // 🔴 THE ONE HEADING THAT IS NOT `SECTION_TITLES`, AND MUST NOT BECOME IT. The report is called
    // "Visits per day" because that is what a reader chooses it for; the SHEET is a row per REP over
    // the days chosen, so "per rep" is what its heading says. Both are right, and pointing this at
    // the title would relabel the rows. `tests/phoenix-crm-reports-export.test.ts` allows exactly
    // this one and refuses any other raw name.
    title: `Visits per rep · ${view.period.from} to ${view.period.to}`,
    totals: [
      "All",
      "",
      "",
      "",
      view.totals.AM.visits,
      view.totals.AM.doubleVisits,
      view.totals.AM.chainVisits,
      view.totals.AM.unplannedWaiting,
      view.totals.PM.visits,
      view.totals.PM.doubleVisits,
      view.totals.PM.chainVisits,
      view.totals.PM.unplannedWaiting,
    ],
  });
}

function writePlan(workbook: ExcelJS.Workbook, view: PlanReportView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.plan);
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Territory" },
      column("Rep", { width: 22 }),
      counted("AM planned"),
      counted("AM visited"),
      counted("AM missed"),
      counted("AM on leave"),
      percentColumn("AM kept %"),
      counted("AM off-plan", 14),
      counted("PM planned"),
      counted("PM visited"),
      counted("PM missed"),
      counted("PM on leave"),
      percentColumn("PM kept %"),
      counted("PM off-plan", 14),
    ],
    note: [
      view.runningDay === null
        ? "Plan kept counts a planned customer visited on the planned day, on a visit that was itself planned."
        : `${view.runningDay} is today: its planned customers can still be visited, so "missed" is not final for that day.`,
      // The screen's own rule, written into the file that leaves the building without the screen.
      "A customer planned on a day HR approved the rep's leave, and not seen, is on leave: never missed, and not in planned.",
      // 🔴 AM and PM apart in every column. Off-plan was the one place this sheet added them.
      "AM and PM are apart in every column, off-plan included.",
      view.leaveUnread ? LEAVE_UNREAD_NOTE : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" "),
    rows: view.rows.map((row) => [
      row.territoryName,
      row.repName ?? "No rep",
      row.am.planned,
      row.am.visitedPlanned,
      row.am.missed,
      row.am.onLeave,
      pct(row.am.keptPct),
      row.am.unplanned,
      row.pm.planned,
      row.pm.visitedPlanned,
      row.pm.missed,
      row.pm.onLeave,
      pct(row.pm.keptPct),
      row.pm.unplanned,
    ]),
    title: `${SECTION_TITLES.plan} · ${view.period.from} to ${view.period.to}`,
    totals: [
      "All",
      "",
      view.totals.AM.planned,
      view.totals.AM.visitedPlanned,
      view.totals.AM.missed,
      view.totals.AM.onLeave,
      pct(view.totals.AM.keptPct),
      view.totals.AM.unplanned,
      view.totals.PM.planned,
      view.totals.PM.visitedPlanned,
      view.totals.PM.missed,
      view.totals.PM.onLeave,
      pct(view.totals.PM.keptPct),
      view.totals.PM.unplanned,
    ],
  });
}

/**
 * The daily plan: one territory's plan, a row for every planned customer, day by day (owner,
 * 2026-09-30). A day with nobody on it keeps a row of its own, so a gap shows rather than vanishing.
 * AM and PM stay apart as the List column on every row, and the sheet carries no total at all — it is
 * a listing, not a measure; plan against actual is the measure.
 */
function writeDailyPlan(workbook: ExcelJS.Workbook, view: DailyPlanReportView): void {
  const territory = view.territory;
  if (!territory) return;
  const sheet = workbook.addWorksheet(SECTION_TITLES.daily);
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  const rows: CellValue[][] = [];
  for (const day of view.days) {
    const sent = day.state === "submitted" || day.state === "approved" || day.state === "returned";
    // The screen's own rule (DayHeader in daily-plan-report.tsx): a day with nothing on it carries no plan
    // state and no "sent late" — "Not sent before the day" beside a day nobody planned anything for reads
    // as a failure about that day. Its row still says so in words, below; the test marker stays.
    const planned = !dailyPlanDayIsEmpty(day);
    const plan =
      [
        planned && day.state !== "none" ? dailyPlanStateLabel(day.state) : null,
        planned && sent && day.submittedLate ? "sent late" : null,
        // The screen's "On leave" pill: HR approved his leave for the day (`plan-leave.ts`).
        day.onLeave ? "on leave" : null,
        day.isTest ? "test entries" : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · ") || "—";
    const dayCells: CellValue[] = [
      day.date,
      PHOENIX_CRM_WEEKDAY_NAMES[weekdayOfIsoDay(day.date)],
      plan,
      day.startsText ?? "—",
      day.activities.length > 0 ? day.activities.map(dailyPlanActivityText).join("; ") : "—",
    ];
    const customers: Array<[string, DailyPlanCustomer]> = [
      ...day.am.map((customer): [string, DailyPlanCustomer] => ["AM", customer]),
      ...day.pm.map((customer): [string, DailyPlanCustomer] => ["PM", customer]),
    ];
    if (customers.length === 0) {
      // Word for word the screen's line under a day with no customer on it, without its full stop.
      const nothing = day.state === "none" ? "No plan for this week" : planned ? "No customer planned this day" : "Nothing planned this day";
      rows.push([...dayCells, "—", nothing, "", "", "", "", "", "", "", "", ""]);
      continue;
    }
    for (const [listType, customer] of customers) {
      rows.push([
        ...dayCells,
        listType,
        customer.name,
        customer.grade ?? "—",
        customer.speciality ?? "—",
        // The rep's own typed phone (owner, 2026-09-30); "—" until he gives one.
        customer.phone ?? "—",
        customer.brick ?? "—",
        customer.area ?? "—",
        [customer.placeLabel, customer.address].filter((part): part is string => Boolean(part)).join(" · ") || "—",
        customer.hoursText,
        dailyPlanVisitText(customer.status, customer.visitedMinute),
        dailyPlanCustomerNotes(customer).join(" · "),
      ]);
    }
  }
  writeHouseTable(sheet, 1, {
    columns: [
      column("Day", { width: 12 }),
      column("Weekday", { width: 11 }),
      column("Plan", { width: 24 }),
      column("Starts", { width: 30 }),
      column("Other activities", { width: 28 }),
      column("List", { width: 7 }),
      { ...NAME, label: "Customer", width: 28 },
      column("Grade", { width: 7 }),
      column("Speciality", { width: 18 }),
      column("Phone", { width: 15 }),
      column("Brick", { width: 16 }),
      column("Area", { width: 16 }),
      column("Address", { width: 32 }),
      column("Hours that day", { width: 22 }),
      column("Status", { width: 17 }),
      column("Notes", { width: 34 }),
    ],
    note: [
      "A day that has passed shows the plan as it stood when that day ended; today and the days ahead show it as it is now. "
        + "Visited means a visit to the customer was saved that day. Friday holds no plan and is left out. "
        + "On a day HR approved the rep's leave, a customer not seen reads On leave, never Not visited.",
      view.leaveUnread ? LEAVE_UNREAD_NOTE : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" "),
    rows,
    title: `${SECTION_TITLES.daily} · ${territory.name} · ${territory.repName ?? "No rep"} · ${view.period.from} to ${view.period.to}`,
  });
}

function writeCoverage(workbook: ExcelJS.Workbook, view: CoverageReportView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.coverage);
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
    title: `${SECTION_TITLES.coverage} · ${view.month.month}`,
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

/**
 * Frequency per customer — the two comparisons in their own columns, side by side and never added.
 *
 * 🔴 THE TARGET COLUMN IS PHOENIX CRM'S OWN `grade_targets`, the same number the screen shows and
 * the same one coverage divides by. A workbook that quoted a different table would be the version
 * that outlives the screen and gets forwarded.
 */
function writeFrequency(workbook: ExcelJS.Workbook, view: CustomerFrequencyReportView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.frequency);
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Customer" },
      column("List", { width: 8 }),
      column("Grade", { width: 8 }),
      counted("Visits"),
      counted("Grade target", 13),
      column("Against the grade", { width: 19 }),
      counted("Planned"),
      counted("Planned on leave", 17),
      counted("Against the plan", 17),
    ],
    note: [
      "Two comparisons, kept apart: the grade's monthly number from Phoenix CRM's own settings, and how often they were "
        + "placed on a plan that was actually sent. Over the grade is a deviation too, never a bonus.",
      // The screen's own rule, written into the file that leaves the building without the screen.
      "A planning on a day HR approved the rep's leave, when the customer was not seen that day, is Planned on leave and never counted against the plan.",
      view.leaveUnread ? LEAVE_UNREAD_NOTE : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" "),
    rows: view.rows.map((row) => [
      row.name,
      row.listType,
      row.grade ?? "No grade",
      row.visits,
      row.gradeTarget === null ? "—" : row.gradeTarget,
      row.gradeVerdict,
      row.planned,
      row.plannedOnLeave,
      row.againstPlan,
    ]),
    title: `${SECTION_TITLES.frequency} · ${view.seat?.territoryName ?? "one territory"} · ${view.month.month}`,
    totals: ["All", "", "", "", "", `${view.totals.under} under · ${view.totals.onTarget} on · ${view.totals.over} over`, "", "", ""],
  });
}

/**
 * The tracking sheet — customer down the side, every day of the month across.
 *
 * 🔴 THE SPACING NOTE IS ONLY HERE WHEN THE SERVICE COMPUTED IT. A rep's own pack comes back with
 * every note null and `showsSpacing` false, so the column is left out entirely rather than printed
 * empty: a blank column headed "The shape of the month" tells him a judgement exists and that he
 * is not being shown it, which is the disclosure Golden rule #1 forbids.
 */
function writeTracking(workbook: ExcelJS.Workbook, view: TrackingSheetReportView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.tracking);
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  const dayColumns = view.days.map((day) => column(String(Number(day.slice(8, 10))).padStart(2, "0"), { width: 4 }));
  writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Customer" },
      ...dayColumns,
      counted("Days seen", 11),
      ...(view.showsSpacing ? [column("The shape of the month", { width: 40 })] : []),
    ],
    note: "A mark is a day a countable visit landed. Two visits to one customer on one day mark that day once.",
    rows: view.rows.map((row) => {
      const marked = new Set(row.days);
      return [
        row.name,
        ...view.days.map((day) => (marked.has(day) ? "Y" : "")),
        row.days.length,
        ...(view.showsSpacing ? [row.spacing ?? ""] : []),
      ];
    }),
    title: `${SECTION_TITLES.tracking} · ${view.seat?.territoryName ?? "one territory"} · ${view.month.month}`,
  });
}

/**
 * The team calendar — a person a row, a day a column, and the day's SHAPE in the cell.
 *
 * 🔴 THE CELL IS A WORD, NEVER A FIGURE, for the same reason the screen's is: on a both-halves day
 * a single number is AM + PM added, and every count of visits is reported apart. The three totals
 * sit in their own columns at the end.
 */
const CALENDAR_CELL: Record<string, string> = {
  activity: "Act",
  am: "AM",
  both: "AM+PM",
  leave: "Leave",
  none: "",
  pm: "PM",
  rest: "F",
};

/**
 * What the calendar's tab is called, which depends on WHOSE month it holds.
 *
 * 🔴 ONE FUNCTION, THREE CALLERS, AND THAT IS THE POINT OF IT. The name is written in three
 * places — the worksheet tab, the heading inside it, and `packSections`, which is what the COVER
 * promises — and a cover naming a tab the workbook does not contain is a file that reads as
 * broken to whoever opens it. Deriving all three from here is what stops a rename reaching two.
 *
 * A rep has read this calendar since 2026-10-01, scoped to himself, so "Team calendar" on his own
 * download names something he does not have and cannot see. `scope` comes from the service, which
 * takes it from the access predicate rather than from the row count — a district manager down to
 * one rep still gets "Team calendar", because it is still his team.
 */
export function calendarSheetName(view: Pick<TeamCalendarView, "scope"> | null | undefined): string {
  return view?.scope === "own" ? "Your month" : "Team calendar";
}

function writeCalendar(workbook: ExcelJS.Workbook, view: TeamCalendarView): void {
  const sheet = workbook.addWorksheet(calendarSheetName(view));
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Person" },
      column("Territory", { width: 24 }),
      column("Under", { width: 20 }),
      ...view.days.map((day) => column(String(Number(day.slice(8, 10))).padStart(2, "0"), { width: 6 })),
      counted("AM"),
      counted("PM"),
      counted("Pharmacies", 12),
    ],
    note:
      "Each cell says which halves of the day were worked — AM, PM, AM+PM — or why it was blank: F for Friday, Leave "
      + "from HR's own rows, Act for a recorded day activity. Pharmacies are counted apart and never colour a day."
      + (view.rows.some((row) => row.kind === "manager")
        ? " A manager's row is the days they worked — their own single visits and the visits they joined a rep on — and the"
          + " totals at the foot count the reps' rows only."
        : ""),
    rows: view.rows.map((row) => [
      row.person,
      row.territory,
      row.manager ?? "—",
      ...row.days.map((day) => CALENDAR_CELL[day.shape] ?? ""),
      row.totals.am,
      row.totals.pm,
      row.totals.pharmacies,
    ]),
    title: `${calendarSheetName(view)} · ${view.month}`,
    totals: ["All", "", "", ...view.days.map(() => ""), view.totals.am, view.totals.pm, view.totals.pharmacies],
  });
}

function writeManagers(workbook: ExcelJS.Workbook, view: ManagerReportView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.managers);
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
    title: `${SECTION_TITLES.managers} per manager · ${view.period.from} to ${view.period.to}`,
  });
}

function writeLocations(workbook: ExcelJS.Workbook, view: VisitLocationReportView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.locations);
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
    title: `${SECTION_TITLES.locations} · ${view.period.from} to ${view.period.to}`,
  });
}

function writeExceptions(workbook: ExcelJS.Workbook, view: ExceptionsView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.exceptions);
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
    note: [
      "Only the territories that need a manager, worst first, one line each. A territory with nothing wrong is ABSENT —"
      + " a short sheet is the good outcome.",
      view.lastWorkingDay === null
        ? "No working day has finished yet, so nothing is said about any one day."
        : `The last working day is ${view.lastWorkingDay}; working days are Saturday to Wednesday, with the national holidays out.`,
      // 🔴 It travels WITH the figures: a workbook leaves the building without the screen's warning.
      view.holidaysUnread
        ? "The national holiday calendar could not be read when this was built, so a public holiday may still be counted as a"
          + " working day and a call rate may read low."
        : null,
      // A rep signed off all week is listed at the BOTTOM as "On leave", never as a failure — the
      // territory is uncovered, which is worth seeing, but nobody owes a chase for it.
      view.onLeave.length > 0
        ? "Territories whose rep has approved leave all week are listed last as \"On leave\": uncovered, but nothing to chase."
        : null,
      view.leaveUnread ? LEAVE_UNREAD_NOTE : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" "),
    rows: [
      ...view.rows.map((row) => [row.territoryName, row.repName ?? "No rep", row.lineName ?? "—", row.label, row.detail ?? "—"]),
      ...view.onLeave.map((row) => [row.territoryName, row.repName ?? "No rep", row.lineName ?? "—", row.label, row.detail]),
    ],
    title: SECTION_TITLES.exceptions,
  });
}

function writeBricks(workbook: ExcelJS.Workbook, view: BrickCoverageView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.bricks);
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
      // 🔴 The screen's own words, from the shared map — never `row.status`, which printed the raw
      // key `sales-no-list` at a manager in the column the screen reads "Sells here, nobody on the
      // list". A workbook leaves the building without the screen that could explain a key.
      brickStatusLabel(row.status),
      row.am,
      row.amVisited,
      row.pm,
      row.pmVisited,
      row.visits,
      row.sales,
    ]),
    title: `${SECTION_TITLES.bricks}, per brick · ${view.period.from} to ${view.period.to}`,
    totals: ["All bricks", "", "", "", "", "", "", "", "", view.summary.brickSales],
  });
}

function writeAdoption(workbook: ExcelJS.Workbook, view: AdoptionView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.adoption);
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
    title: `${SECTION_TITLES.adoption} · as at ${view.cairoToday}`,
  });
}

// ── The four insight boards of 2026-10-02 ─────────────────────────────────────────────────────────

function capacityCells(capacity: ListCapacity, listType: "AM" | "PM"): CellValue[] {
  return [
    capacity.customers,
    capacity.grades.A,
    capacity.grades.B,
    capacity.grades.C,
    capacity.required,
    capacity.perDayNeeded === null ? "—" : capacity.perDayNeeded,
    capacityVerdictText(capacity, listType),
    capacity.notValidated,
  ];
}

function capacityColumns(listType: "AM" | "PM"): TableColumn[] {
  return [
    counted(`${listType} on list`),
    counted(`${listType} grade A`),
    counted(`${listType} grade B`),
    counted(`${listType} grade C`),
    counted(`${listType} visits a month`, 14),
    { label: `${listType} a day`, numFmt: ONE_DECIMAL, right: true, width: 10 },
    column(`${listType} against the month`, { width: 20 }),
    counted(`${listType} not validated yet`, 16),
  ];
}

/**
 * Grade against capacity — what each territory's LIST asks of a month against what the month's field
 * days hold. The screen's own caveat travels with the figures: list size, never coverage, and a
 * customer not validated yet counts with the grade iReports360 carried over.
 */
function writeCapacity(workbook: ExcelJS.Workbook, view: CapacityBoardView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.capacity);
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  const { fieldDays, perDay, summary } = view;
  writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Territory" },
      column("Rep", { width: 22 }),
      column("Line", { width: 14 }),
      column("List read from", { width: 15 }),
      ...capacityColumns("PM"),
      ...capacityColumns("AM"),
    ],
    note: [
      `The size of each list, not its coverage: a customer not validated yet is counted with the grade iReports360 carried over `
        + `(${summary.notValidated.AM} AM · ${summary.notValidated.PM} PM of them here), while coverage on the plan review counts validated customers only.`,
      `${view.month.month} holds ${fieldDays.PM} PM days and ${fieldDays.AM} AM days: Saturday to Wednesday hold both, Thursday holds AM only, Friday holds nothing.`,
      fieldDays.holidays.length > 0
        ? `Public holidays taken out: ${fieldDays.holidays.map((holiday) => `${holiday.day} (${holiday.name})`).join(", ")}.`
        : "No public holiday falls on a field day this month.",
      `Each grade's visits a month, from Settings: ${gradeTargetsText(view.gradeTargets, "PM")}; ${gradeTargetsText(view.gradeTargets, "AM")}.`,
      `A day holds ${perDay.PM.target} PM at the call rate and ${perDay.PM.cap} at most; ${perDay.AM.target} AM at the call rate and ${perDay.AM.cap} at most.`,
      "The verdict is about the list's size against the month, never about the rep. A grade changes only on the List, by the district manager.",
    ].join(" "),
    rows: view.rows.map((row) => [
      row.territoryName,
      row.repName ?? "No rep",
      row.lineName ?? "—",
      row.listSource === "reference" ? "iReports360" : "Phoenix",
      ...capacityCells(row.pm, "PM"),
      ...capacityCells(row.am, "AM"),
    ]),
    title: `${SECTION_TITLES.capacity} · ${view.month.month}`,
  });
}

function objectionsText(row: HeardRow): string {
  return row.byObjection.map((entry) => `${entry.label} — ${heardTallyText(entry)}`).join(" · ") || "—";
}

function heardGrainTable(title: string, label: string, rows: ReadonlyArray<HeardRow>): HouseTableInput {
  return {
    columns: [
      { ...NAME, label },
      counted("AM visits"),
      counted("PM visits"),
      counted("AM objections", 14),
      counted("PM objections", 14),
      column("What customers objected to", { width: 40 }),
      column("Products discussed", { width: 40 }),
    ],
    rows: rows.map((row) => [
      row.label,
      row.visits.am,
      row.visits.pm,
      row.objections.am,
      row.objections.pm,
      objectionsText(row),
      row.products.map((product) => `${product.name} ${heardTallyText(product)}`).join(" · ") || "—",
    ]),
    title,
  };
}

/**
 * What the field heard — the products discussed and the objections customers raised, by product, by
 * speciality and (for the team) by area, AM and PM apart, and what was said in the rep's words. Counts
 * only: no rate, no figure of visits where nothing was objected to, and no row per rep or territory.
 * A product or marketing manager's sheet is his own products, company-wide, with no area.
 */
function writeHeard(workbook: ExcelJS.Workbook, view: FieldHeardView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.heard);
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  const period = `${view.period.from} to ${view.period.to}`;
  const own = view.products;
  const ownText = own
    ? own.basis === "every"
      ? "Your products, company-wide: every product — your sales scope is the whole company."
      : `Your products, company-wide: ${own.names.join(", ") || "none"} — ${HEARD_BASIS_TEXT[own.basis]}.`
    : null;
  const nothing = view.totals.visits.am === 0 && view.totals.visits.pm === 0;
  let next = writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Product" },
      counted("AM discussed", 13),
      counted("PM discussed", 13),
      counted("AM objections", 14),
      counted("PM objections", 14),
      column("What customers objected to", { width: 44 }),
    ],
    note: [
      ownText ? `${ownText} Never by area and never by rep.` : "It reads the line chosen or the whole scope, never one territory: one territory is one rep.",
      nothing ? "Nothing heard in these days yet: the report fills as visits are saved." : null,
      "Counts only: no rate, no figure of visits where nothing was objected to, and nothing per rep. A visit records one "
        + "objection beside the products discussed on it, so an objection counts against every product discussed on that visit.",
    ]
      .filter((part): part is string => part !== null)
      .join(" "),
    rows: view.byProduct.map((row) => [row.label, row.visits.am, row.visits.pm, row.objections.am, row.objections.pm, objectionsText(row)]),
    title: `${SECTION_TITLES.heard}, by product · ${period}`,
  });
  next = writeHouseTable(sheet, next + 1, heardGrainTable(`By speciality · ${period}`, "Speciality", view.bySpeciality));
  // The area grain is the team's only — a place, never the rep who works it — and a product or
  // marketing manager's report has none at all.
  if (view.byArea) next = writeHouseTable(sheet, next + 1, heardGrainTable(`By area · ${period}`, "Area", view.byArea));

  const withArea = view.byArea !== null;
  const notes = view.byProduct.flatMap((row) => row.notes.map((note) => ({ ...note, product: row.label })));
  if (notes.length > 0) {
    writeHouseTable(sheet, next + 1, {
      columns: [
        column("Day", { width: 13 }),
        column("List", { width: 7 }),
        { ...NAME, label: "Product" },
        column("Objection", { width: 24 }),
        column("Speciality", { width: 18 }),
        ...(withArea ? [column("Area", { width: 16 })] : []),
        column("What was said", { width: 56 }),
      ],
      note: "In the rep's own words, newest first under each product — and never the rep's name.",
      rows: notes.map((note) => [
        note.visitDate,
        note.listType,
        note.product,
        note.objectionLabel,
        note.speciality ?? "—",
        ...(withArea ? [note.area ?? "—"] : []),
        note.note,
      ]),
      title: "What was said",
    });
  }
}

/**
 * Missing stock — each pharmacy's LATEST answer for each product, the answer the customer's own card
 * shows. What was on the shelf: never a sales figure and never a stock balance, and a pharmacy is
 * counted as a pharmacy.
 */
function writeStock(workbook: ExcelJS.Workbook, view: MissingStockView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.stock);
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  const { summary } = view;
  const next = writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Product" },
      column("Pharmacy", { width: 26 }),
      column("Territory", { width: 22 }),
      column("Last said, Cairo", { width: 17 }),
      counted("Visits asked", 12),
      column("Chase promised", { width: 15 }),
    ],
    note:
      `Each pharmacy's last answer for each product in these days — the same answer the customer's own card shows. `
      + `${summary.pharmacies} pharmacies answered; ${summary.gaps} pharmacy and product pairs were last said to be missing, `
      + `across ${summary.productsShort} products. What was on the shelf: never a sales figure and never a stock balance. `
      + "A pharmacy is counted as a pharmacy, never inside AM or PM.",
    rows: view.products.flatMap((product) =>
      product.missing.map((entry) => [
        product.product,
        entry.pharmacy,
        entry.territoryName,
        cairoDateTimeSortable(entry.lastReportedAt),
        entry.reports,
        entry.chasePromised ? "Yes" : "",
      ]),
    ),
    title: `${SECTION_TITLES.stock} · ${view.period.from} to ${view.period.to}`,
  });
  if (view.chases.length > 0) {
    writeHouseTable(sheet, next + 1, {
      columns: [
        column("Visit day", { width: 13 }),
        column("By", { width: 13 }),
        { ...NAME, label: "Customer" },
        column("List", { width: 7 }),
        column("Territory", { width: 22 }),
        column("Pharmacy", { width: 26 }),
      ],
      note: "Every visit whose next step was to chase the pharmacy stock, the soonest first. A promise, never a mark against anybody.",
      rows: view.chases.map((chase) => [
        chase.visitDate,
        chase.dueOn ?? "No day given",
        chase.customerName,
        chase.listType,
        chase.territoryName,
        chase.pharmacy ?? "Not named on the visit",
      ]),
      title: "Chase the pharmacy stock",
    });
  }
}

/**
 * Samples by month — what was handed over, a product (or material) a row, AM and PM apart. 🔴 NO TOTAL
 * ROW: units of different products are never added, so what is counted across items is VISITS.
 */
function writeSamples(workbook: ExcelJS.Workbook, view: SamplesReportView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.samples);
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  const next = writeHouseTable(sheet, 1, {
    columns: [{ ...NAME, label: "Item" }, column("Kind", { width: 13 }), counted("AM left"), counted("PM left")],
    note:
      "Each product and each material on its own row, AM and PM apart. Units of different products are never added together, "
      + "so there is no total row. A record of what was handed over, as each visit saved it — never a stock: no balance, "
      + "nothing subtracted, and nothing set against what was issued.",
    rows: view.items.map((item) => [item.label, item.kind === "sample" ? "Free sample" : "Material", item.am, item.pm]),
    title: `${SECTION_TITLES.samples} · ${view.month.month}`,
  });
  writeHouseTable(sheet, next + 1, {
    columns: [
      { ...NAME, label: "Territory" },
      column("Rep", { width: 22 }),
      column("Line", { width: 14 }),
      counted("AM visits that left samples", 15),
      counted("PM visits that left samples", 15),
      counted("AM visits that left materials", 15),
      counted("PM visits that left materials", 15),
      column("What was left", { width: 48 }),
    ],
    note: "Every territory chosen, including the ones that left nothing this month. A visit that left both samples and materials is counted in both columns.",
    rows: view.territories.map((row) => [
      row.territoryName,
      row.repName ?? "No rep",
      row.lineName ?? "—",
      row.visitsWithSamples.am,
      row.visitsWithSamples.pm,
      row.visitsWithMaterials.am,
      row.visitsWithMaterials.pm,
      row.items.map((item) => `${item.label} — ${heardTallyText(item)}`).join(" · ") || "Nothing this month",
    ]),
    title: `${SECTION_TITLES.samples}, by territory · ${view.month.month}`,
  });
}

/**
 * Each rep's customers and what they objected to (owner, 2026-11-03): by name, rep then customer, and never
 * by a count. Counts only, so no percentage, rate, rank or score, and a rep carries no total of his own.
 */
function writeObjections(workbook: ExcelJS.Workbook, view: ObjectionsByCustomerView): void {
  const sheet = workbook.addWorksheet(SECTION_TITLES.objections);
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  const period = `${view.period.from} to ${view.period.to}`;
  const rows = objectionCustomerRows(view);
  const next = writeHouseTable(sheet, 1, {
    columns: [
      { ...NAME, label: "Rep" },
      column("Territory", { width: 22 }),
      column("Customer", { width: 26 }),
      column("Speciality", { width: 18 }),
      column("Objection", { width: 26 }),
      counted("AM"),
      counted("PM"),
    ],
    note: [
      rows.length === 0 ? "Nothing objected to in these days." : null,
      "The objection is the customer's and never a mark against the rep. Counts only, sorted by name: no percentage, no rate, no rank and no score.",
    ]
      .filter((part): part is string => part !== null)
      .join(" "),
    rows: rows.flatMap((row) =>
      row.objections.map((objection) => [row.repName, row.territories.join(", ") || "—", row.customerName, row.speciality ?? "—", objection.label, objection.am, objection.pm]),
    ),
    title: `${SECTION_TITLES.objections} · ${period}`,
  });
  if (rows.length === 0) return;
  writeHouseTable(sheet, next + 1, {
    columns: [
      { ...NAME, label: "Rep" },
      column("Customer", { width: 26 }),
      column("Objection", { width: 26 }),
      column("Day", { width: 13 }),
      column("List", { width: 7 }),
      column("Products discussed", { width: 34 }),
      column("The rep's note", { width: 56 }),
    ],
    note: "Every visit behind the counts above, the newest first under each objection.",
    rows: rows.flatMap((row) =>
      row.objections.flatMap((objection) =>
        objection.visits.map((visit) => [row.repName, row.customerName, objection.label, visit.visitDate, visit.listType, visit.products.join(", ") || "—", visit.note ?? "—"]),
      ),
    ),
    title: `The visits · ${period}`,
  });
}

// ── The pack ────────────────────────────────────────────────────────────────────────────────────

/** The sheets this pack would hold, in order — used by the cover and by the test. */
export function packSections(input: ReportsPackInput): string[] {
  return [
    input.exceptions ? SECTION_TITLES.exceptions : null,
    input.visits ? SECTION_TITLES.visits : null,
    input.plan ? SECTION_TITLES.plan : null,
    input.dailyPlan?.territory ? SECTION_TITLES.daily : null,
    input.coverage ? SECTION_TITLES.coverage : null,
    input.frequency ? SECTION_TITLES.frequency : null,
    input.tracking ? SECTION_TITLES.tracking : null,
    // Through the same function the sheet itself uses, or the cover promises a tab that the
    // workbook does not contain the moment the two names diverge.
    input.calendar ? calendarSheetName(input.calendar) : null,
    input.bricks ? SECTION_TITLES.bricks : null,
    input.managers ? SECTION_TITLES.managers : null,
    input.locations ? SECTION_TITLES.locations : null,
    input.adoption ? SECTION_TITLES.adoption : null,
    // The four insight boards of 2026-10-02, in the screen's order.
    input.capacity ? SECTION_TITLES.capacity : null,
    input.heard ? SECTION_TITLES.heard : null,
    input.stock ? SECTION_TITLES.stock : null,
    input.samples ? SECTION_TITLES.samples : null,
    input.objections ? SECTION_TITLES.objections : null,
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
  if (input.dailyPlan) writeDailyPlan(workbook, input.dailyPlan);
  if (input.coverage) writeCoverage(workbook, input.coverage);
  if (input.frequency) writeFrequency(workbook, input.frequency);
  if (input.tracking) writeTracking(workbook, input.tracking);
  if (input.calendar) writeCalendar(workbook, input.calendar);
  if (input.bricks) writeBricks(workbook, input.bricks);
  if (input.managers) writeManagers(workbook, input.managers);
  if (input.locations) writeLocations(workbook, input.locations);
  if (input.adoption) writeAdoption(workbook, input.adoption);
  if (input.capacity) writeCapacity(workbook, input.capacity);
  if (input.heard) writeHeard(workbook, input.heard);
  if (input.stock) writeStock(workbook, input.stock);
  if (input.samples) writeSamples(workbook, input.samples);
  if (input.objections) writeObjections(workbook, input.objections);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

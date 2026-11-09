/**
 * District Managers' Plans as a workbook (owner, 9 Nov 2026: the premium pass on My Team's Reports), in the house
 * identity (SATO-DIS-2026-01: the masthead, the blue header band, the hairline grid and the 6% zebra), as the Weekly
 * Sheet's and Visits — Yesterday and Today's exports are.
 *
 * It re-derives nothing: every figure is read off the report `loadDistrictManagersPlans` built and the functions in
 * `district-plans-summary.ts`, the same ones the screen prints, so the file and the screen cannot disagree.
 *
 *   - A week that is not sent is one row that says so, with when it was due — never its draft.
 *   - A sent week nobody decided before its Thursday passed reads "Ended before it was approved", never "Waiting".
 *   - A vacant seat is a row that says so, with no figures — never a manager or a rep with zeros.
 *   - A chain visit is a neutral column on the Half-days sheet, never a reason on "To look at" (owner, 2026-10-24).
 *   - The file always holds every seat. The screen's filter narrows what is listed there, never what is exported.
 */

import ExcelJS from "exceljs";

import { cairoDate, cairoDateTime } from "@/lib/format/cairo-datetime";
import { buildHouseCoverSheet, writeHouseTable, type CellValue } from "@/lib/export/house-table-workbook";
import { houseGeneratedAt, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";
import { managerSlotKindLabel } from "@/lib/phoenix-crm/manager-plan-rules";
import { regionManagerTitle } from "@/lib/phoenix-crm/region-manager-groups";
import type { DistrictManagersPlans } from "@/lib/phoenix-crm/server/manager-plan-bookings";
import {
  DISTRICT_PLAN_ATTENTION_LABEL,
  DISTRICT_PLAN_KINDS,
  DISTRICT_PLAN_KIND_LABEL,
  DISTRICT_PLAN_REP_WEEK_LABEL,
  DISTRICT_PLAN_STATE_LABEL,
  DISTRICT_CUSTOMER_GRADE_LABEL,
  DISTRICT_NO_SPECIALITY,
  districtCustomerAShare,
  districtCustomerCountLine,
  districtCustomerRepeatedLine,
  districtPlansCustomerRows,
  districtPlansCustomerTicks,
  districtPlanHalves,
  districtPlansAttention,
  districtPlansChainVisits,
  districtPlansRepsAlone,
  districtPlansTeamLine,
  districtPlansTeamTotals,
  districtPlanSentLine,
  districtPlanShortDay,
  districtPlanWeekFigures,
  districtPlanWeekPositionLine,
  districtRepLeaveLine,
  districtRepManagersLine,
  isDistrictPlanSentState,
} from "@/lib/phoenix-crm/server/district-plans-summary";

export const DISTRICT_PLANS_WORKBOOK_SHEETS = ["Cover", "Managers", "Half-days", "Customers", "Reps", "To look at"] as const;

function dayLabel(iso: string): string {
  return cairoDate(`${iso}T12:00:00Z`);
}

/** The workbook's file name: one per week, so one week's download never overwrites another's. */
export function districtPlansWorkbookFileName(report: Pick<DistrictManagersPlans, "weekStart">): string {
  return `district-manager-plans-${report.weekStart}.xlsx`;
}

export async function buildDistrictPlansWorkbook(report: DistrictManagersPlans, generatedAtIso: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(generatedAtIso);
  const label = `Week of ${dayLabel(report.weekStart)} to ${dayLabel(report.weekEnd)}`;
  const subtitle = `District Managers' Plans · ${label}`;
  const provenance = [houseGeneratedAt(generatedAtIso), label];
  const totals = districtPlansTeamTotals(report);

  buildHouseCoverSheet(workbook, {
    confidentialNote: "Internal — for the Regional Sales Manager and the district managers.",
    rows: [
      ["Week", label],
      ["Where the week stands", districtPlanWeekPositionLine(report)],
      ["District manager seats", `${report.weeks.length} · ${totals.managers} with somebody in them · ${totals.vacantManagerSeats} vacant`],
      ["Weeks sent", `${totals.sent} of ${totals.managers}`],
      ["Approved", String(totals.byState.approved)],
      ["Waiting for a decision", String(totals.byState.waiting)],
      ["Ended before it was approved", String(totals.byState.ended)],
      ["Not sent", String(totals.notSent)],
      ["Sent late", String(totals.late)],
      ["Half-days planned", `${totals.halves} · ${DISTRICT_PLAN_KINDS.filter((kind) => totals.byKind[kind] > 0).map((kind) => `${totals.byKind[kind]} ${DISTRICT_PLAN_KIND_LABEL[kind].toLowerCase()}`).join(" · ") || "none"}`],
      ["Reps a manager is with", `${totals.repsWithAManager} of ${totals.reps} reps in seats · ${totals.vacantRepSeats} vacant rep seats`],
      ["In one line", districtPlansTeamLine(totals)],
      ["Reading", "Only sent weeks are shown; a draft is never read. A chain visit — two managers with one rep the same day — is information, never a problem."],
      ...(report.leaveUnread ? ([["Leave", "Approved leave could not be read when this file was made, so nobody is marked on leave."]] as Array<[string, string]>) : []),
    ],
    subtitle,
    title: "District Managers' Plans",
  });

  // Managers — one row per district manager seat.
  const managerSheet = workbook.addWorksheet("Managers", { properties: { defaultRowHeight: 18 } });
  managerSheet.views = [{ showGridLines: false }];
  const managerStart = writeHouseMasthead(workbook, managerSheet, { columns: 16, provenance, subtitle, title: "Managers" });
  const managerRows: CellValue[][] = report.weeks.map((week) => {
    const figures = districtPlanWeekFigures(week, report.weekStart);
    if (figures.state === "vacant") {
      return [week.regionName, "Seat is vacant", week.districtName, DISTRICT_PLAN_STATE_LABEL.vacant, "", "", "", "", "", "", "", "", "", figures.repsInTeam, figures.vacantSeats, ""];
    }
    return [
      week.regionName,
      week.managerName,
      week.districtName,
      week.statusText,
      week.dueOn ? dayLabel(week.dueOn) : "",
      week.submittedAt ? cairoDateTime(week.submittedAt) : "",
      figures.sent ? (week.submittedLate ? "Yes" : "No") : "",
      figures.sent ? figures.halves : "",
      figures.sent ? figures.byKind.with_rep : "",
      figures.sent ? figures.byKind.admin : "",
      figures.sent ? figures.halves - figures.byKind.with_rep - figures.byKind.admin : "",
      figures.sent ? figures.openHalves : "",
      figures.sent ? figures.repsWith : "",
      figures.repsInTeam,
      figures.vacantSeats,
      figures.leaveDays,
    ];
  });
  const managerNext = writeHouseTable(managerSheet, managerStart, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 24 },
      { label: "District", width: 20 },
      { label: "Week", width: 26 },
      { label: "Due", width: 12 },
      { label: "Sent", width: 18 },
      { label: "Late", width: 7 },
      { label: "Half-days", right: true, width: 10 },
      { label: "With a rep", right: true, width: 10 },
      { label: "Admin", right: true, width: 8 },
      { label: "Other", right: true, width: 8 },
      { label: "Not planned", right: true, width: 11 },
      { label: "Reps gone with", right: true, width: 14 },
      { label: "Reps in team", right: true, width: 11 },
      { label: "Vacant rep seats", right: true, width: 13 },
      { label: "Manager's leave days", right: true, width: 14 },
    ],
    note: "Figures are for sent weeks only. Not planned counts Saturday to Thursday half-days with nothing in them and the manager not on leave.",
    rows: managerRows.length > 0 ? managerRows : [["No district manager seat under you", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]],
    title: "Every district manager seat",
    totals: ["The whole team", `${totals.managers} managers`, "", `${totals.sent} sent`, "", "", String(totals.late), totals.halves, totals.byKind.with_rep, totals.byKind.admin, totals.halves - totals.byKind.with_rep - totals.byKind.admin, totals.openHalves, "", totals.reps, totals.vacantRepSeats, ""],
  });

  // Half-days — one row per planned half of every sent week.
  const halfSheet = workbook.addWorksheet("Half-days", { properties: { defaultRowHeight: 18 } });
  halfSheet.views = [{ showGridLines: false }];
  const halfStart = writeHouseMasthead(workbook, halfSheet, { columns: 12, provenance, subtitle, title: "Half-days" });
  const halfRows: CellValue[][] = report.weeks.flatMap((week) => {
    if (!isDistrictPlanSentState(districtPlanWeekFigures(week, report.weekStart).state)) return [];
    return districtPlanHalves(week).map(({ day, half }) => [
      week.regionName,
      week.managerName,
      day.dateText,
      half.half,
      managerSlotKindLabel(half.kind),
      half.text,
      half.repName ?? "",
      half.repOnLeave ? "On leave" : half.repWeekState ? DISTRICT_PLAN_REP_WEEK_LABEL[half.repWeekState] : "",
      half.customers.length,
      half.goneCustomers,
      half.customers.join(" · "),
      half.chainVisits.join(" · "),
    ]);
  });
  writeHouseTable(halfSheet, halfStart, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 22 },
      { label: "Day", width: 22 },
      { label: "Half", width: 6 },
      { label: "Kind", width: 18 },
      { label: "Plan", width: 30 },
      { label: "Rep", width: 22 },
      { label: "Rep's day", width: 13 },
      { label: "Customers", right: true, width: 10 },
      { label: "No longer on file", right: true, width: 14 },
      { label: "Customers ticked", width: 48 },
      { label: "Chain visit", width: 48 },
    ],
    note: "Every planned half of every sent week. A chain visit names another manager with the same rep that day — information only.",
    rows: halfRows.length > 0 ? halfRows : [["No sent week this week", "", "", "", "", "", "", "", "", "", "", ""]],
    title: `Every planned half-day · ${halfRows.length}`,
  });

  // Customers — whom they will visit: one line per manager, then one row per tick of every sent week.
  const customerSheet = workbook.addWorksheet("Customers", { properties: { defaultRowHeight: 18 } });
  customerSheet.views = [{ showGridLines: false }];
  const customerStart = writeHouseMasthead(workbook, customerSheet, { columns: 10, provenance, subtitle, title: "Customers" });
  const { rows: mixRows, team: teamMix } = districtPlansCustomerRows(report);
  const mixRow = (regionName: string, managerName: string, mix: typeof teamMix): CellValue[] => [
    regionName,
    managerName,
    mix.ticked,
    mix.distinct,
    mix.byGrade.A,
    mix.byGrade.B,
    mix.byGrade.C,
    mix.byGrade.none,
    mix.gone,
    districtCustomerAShare(mix) ?? "",
  ];
  const customerNext = writeHouseTable(customerSheet, customerStart, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 24 },
      { label: "Ticks", right: true, width: 8 },
      { label: "Different customers", right: true, width: 16 },
      { label: "A", right: true, width: 6 },
      { label: "B", right: true, width: 6 },
      { label: "C", right: true, width: 6 },
      { label: "No grade", right: true, width: 10 },
      { label: "No longer on file", right: true, width: 14 },
      { label: "A share of the graded, %", right: true, width: 18 },
    ],
    note: "A customer ticked on two half-days is two ticks and one customer; the grades count customers. Sent weeks only.",
    rows: mixRows.length > 0 ? mixRows.map(({ mix, week }) => mixRow(week.regionName, week.managerName, mix)) : [["No sent week this week", "", "", "", "", "", "", "", "", ""]],
    title: `Whom they will visit · ${districtCustomerCountLine(teamMix)}`,
    totals: mixRow("The whole team", "", teamMix),
  }) + 1;
  const repeatedRows: CellValue[][] = mixRows.flatMap(({ mix, week }) => {
    const line = districtCustomerRepeatedLine(mix);
    return line ? [[week.regionName, week.managerName, line]] : [];
  });
  const ticksStart = writeHouseTable(customerSheet, customerNext, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 24 },
      { label: "Customers ticked on more than one half-day", width: 90 },
    ],
    rows: repeatedRows.length > 0 ? repeatedRows : [["None", "", ""]],
    title: `Ticked more than once · ${repeatedRows.length}`,
  }) + 1;
  const tickRows: CellValue[][] = districtPlansCustomerTicks(report).map(({ customer, day, half, week }) => [
    week.regionName,
    week.managerName,
    day.dateText,
    half.half,
    half.repName ?? half.text,
    customer.name,
    DISTRICT_CUSTOMER_GRADE_LABEL[customer.grade ?? "none"],
    customer.speciality?.trim() || DISTRICT_NO_SPECIALITY,
    customer.ownList ? "Manager's own list" : "Rep's list",
    customer.gone ? "No longer on file" : "On file",
  ]);
  writeHouseTable(customerSheet, ticksStart, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 22 },
      { label: "Day", width: 22 },
      { label: "Half", width: 6 },
      { label: "With", width: 24 },
      { label: "Customer", width: 28 },
      { label: "Grade", width: 9 },
      { label: "Speciality", width: 20 },
      { label: "List", width: 18 },
      { label: "On file", width: 16 },
    ],
    rows: tickRows.length > 0 ? tickRows : [["No customer ticked", "", "", "", "", "", "", "", "", ""]],
    title: `Every customer ticked · ${tickRows.length}`,
  });

  // Reps — every rep seat under each district manager, and who is with them.
  const repSheet = workbook.addWorksheet("Reps", { properties: { defaultRowHeight: 18 } });
  repSheet.views = [{ showGridLines: false }];
  const repStart = writeHouseMasthead(workbook, repSheet, { columns: 8, provenance, subtitle, title: "Reps" });
  const repRows: CellValue[][] = report.weeks.flatMap((week) =>
    week.reps.map((rep) =>
      rep.vacant
        ? [week.regionName, week.managerName, "Seat is vacant", rep.territory, "", "", "", ""]
        : [
            week.regionName,
            week.managerName,
            rep.name,
            rep.territory,
            DISTRICT_PLAN_REP_WEEK_LABEL[rep.weekState],
            districtRepLeaveLine(rep, report.weekStart) ?? "",
            districtRepManagersLine(rep),
            rep.managerHalves,
          ],
    ),
  );
  writeHouseTable(repSheet, repStart, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 22 },
      { label: "Rep", width: 24 },
      { label: "Territory", width: 22 },
      { label: "Rep's own week", width: 14 },
      { label: "Leave", width: 26 },
      { label: "Managers with the rep this week", width: 44 },
      { label: "Half-days with a manager", right: true, width: 18 },
    ],
    note: "Every manager kind's sent half-days count, so a rep the Regional Sales Manager goes with is not alone.",
    rows: repRows.length > 0 ? repRows : [["No rep seat under you", "", "", "", "", "", "", ""]],
    title: `Every rep seat · ${repRows.length}`,
  });

  // To look at — the reasons, the reps no manager is with, and the chain visits apart.
  const lookSheet = workbook.addWorksheet("To look at", { properties: { defaultRowHeight: 18 } });
  lookSheet.views = [{ showGridLines: false }];
  let lookRow = writeHouseMasthead(workbook, lookSheet, { columns: 4, provenance, subtitle, title: "To look at" });
  const attention = districtPlansAttention(report);
  lookRow = writeHouseTable(lookSheet, lookRow, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 24 },
      { label: "Reason", width: 26 },
      { label: "What it says", width: 90 },
    ],
    note: "Plain facts, never a judgement. A chain visit is never a reason; it is listed apart below.",
    rows: attention.length > 0 ? attention.map((item) => [item.week.regionName, item.week.managerName, DISTRICT_PLAN_ATTENTION_LABEL[item.reason], item.line]) : [["Nothing", "", "", ""]],
    title: `Weeks to look at · ${attention.length}`,
  }) + 1;
  const alone = districtPlansRepsAlone(report);
  const aloneRows: CellValue[][] = alone.flatMap((entry) => entry.reps.map((rep) => [entry.week.regionName, entry.week.managerName, rep.name, rep.territory]));
  lookRow = writeHouseTable(lookSheet, lookRow, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 24 },
      { label: "Rep", width: 26 },
      { label: "Territory", width: 90 },
    ],
    note: "Reps in a seat that no manager of any kind is with this week. A rep on leave all six field days is left out.",
    rows: aloneRows.length > 0 ? aloneRows : [["Nobody", "", "", ""]],
    title: `Reps no manager is with this week · ${aloneRows.length}`,
  }) + 1;
  const chains = districtPlansChainVisits(report);
  writeHouseTable(lookSheet, lookRow, {
    columns: [
      { label: "Day", width: 14 },
      { label: "District manager", width: 24 },
      { label: "Rep", width: 26 },
      { label: "Chain visit", width: 90 },
    ],
    note: "Two managers with one rep the same day. Information only — never a clash.",
    rows: chains.length > 0 ? chains.map((chain) => [`${districtPlanShortDay(chain.date)} ${chain.half}`, regionManagerTitle(chain.week.regionName, chain.week.managerName), chain.repName, chain.lines.join(" · ")]) : [["None this week", "", "", ""]],
    title: `Chain visits · ${chains.length}`,
  });

  // The per-week sentence for every manager, under the managers table — what the screen prints under each heading.
  const sentRows: CellValue[][] = report.weeks.map((week) => [week.regionName, week.managerName, districtPlanSentLine(week, cairoDateTime)]);
  writeHouseTable(managerSheet, managerNext + 1, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 24 },
      { label: "The week in one line", width: 90 },
    ],
    rows: sentRows.length > 0 ? sentRows : [["", "", ""]],
    title: "Sent, late and decided",
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

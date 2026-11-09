import ExcelJS from "exceljs";

import { buildHouseCoverSheet, writeHouseTable, type CellValue } from "@/lib/export/house-table-workbook";
import { houseGeneratedAt, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";
import {
  isManagerFieldDay,
  managerGlanceAShare,
  managerGlanceCustomerLine,
  managerGlanceDistrictLine,
  managerGlanceDistrictWho,
  managerGlanceGrade,
  managerGlanceGradeLine,
  managerGlanceGridRow,
  managerGlanceKindLabel,
  managerGlanceKindsLine,
  managerGlanceOpenLine,
  managerGlancePeopleLine,
  managerGlancePlannedLine,
  managerGlanceRepeatedLine,
  managerGlanceScopeWords,
  managerSavedSlot,
  managerWeekGlance,
  MANAGER_GLANCE_OPEN_WORDS,
  MANAGER_GLANCE_PASSED_WORDS,
} from "@/lib/phoenix-crm/manager-week-glance";
import type { ManagerBoardSlot, ManagerPlanBoardView } from "@/lib/phoenix-crm/view-types";

/**
 * A manager's own week as Excel (premium pass of Plan your week in Phoenix CRM, owner, 2026-11-09) — the week the
 * board shows, saved half-days only, in the house identity. Every figure is `manager-week-glance.ts`'s, so the file
 * and the screen can never disagree. Four sheets: Cover, Half-days (every half of every field day, an empty one
 * included, so the file reads as the week), Customers (one row per tick) and People (the district managers, the reps
 * and the managers the week goes with, and the district managers it does not).
 */

export const MANAGER_WEEK_WORKBOOK_SHEETS = ["Cover", "Week", "Half-days", "Customers", "People"] as const;

/** One file per manager and week, so one download never overwrites another. */
export function managerWeekWorkbookFileName(view: Pick<ManagerPlanBoardView, "weekStart" | "manager">): string {
  const who = (view.manager?.name ?? "manager")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
  return `week-plan-${who || "manager"}-${view.weekStart}.xlsx`;
}

/** The areas a half is spent in, by name — one, or the ticked ones joined; a vacant one says so. */
function areasOf(slot: ManagerBoardSlot): string {
  if (slot.tickedAreas.length > 0) return slot.tickedAreas.map((area) => (area.vacant ? `${area.name} (vacant)` : area.name)).join(" · ");
  return slot.areaName ?? "";
}

/** Who a half is spent with: the rep, the district manager or the senior manager. */
function withOf(slot: ManagerBoardSlot): string {
  if (slot.kind === "with_rep") return slot.repName ?? "";
  if (slot.kind === "with_dm") return slot.dmName ?? "No district manager on the seat";
  if (slot.kind === "with_senior") return slot.seniorName ? `${slot.seniorName}${slot.seniorTitle ? ` · ${slot.seniorTitle}` : ""}` : "";
  return "";
}

export async function buildManagerWeekWorkbook(view: ManagerPlanBoardView, generatedAtIso: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(generatedAtIso);
  const glance = managerWeekGlance(view);
  const words = managerGlanceScopeWords(view);
  const first = view.days[0]?.dateText ?? view.weekStart;
  const last = view.days[view.days.length - 1]?.dateText ?? view.weekStart;
  const weekLabel = `Week of ${first} to ${last}`;
  const who = view.manager ? `${view.manager.name} · ${view.manager.place}` : "Your week";
  const subtitle = `Weekly plan · ${who} · ${weekLabel}`;
  const provenance = [houseGeneratedAt(generatedAtIso), weekLabel];
  const plan = view.plan;
  const grades = managerGlanceGradeLine(glance.customers);
  const share = managerGlanceAShare(glance.customers);

  buildHouseCoverSheet(workbook, {
    confidentialNote: "Internal — for the manager and the managers who approve the week.",
    rows: [
      ["Manager", who],
      ["Week", weekLabel],
      ["Where the week stands", plan?.statusLabel ?? "Not started"],
      ["Sent", plan?.sentText ? `${plan.sentText}${plan.submittedLate ? ` · late, due ${plan.dueText}` : ""}` : `Not sent · due ${plan?.dueText ?? "Thursday 23:55"}`],
      ["Half-days planned", managerGlancePlannedLine(glance)],
      ["Still to plan", `${managerGlanceOpenLine(glance)}${glance.openHalves.length > 0 ? ` (${glance.openHalves.map((entry) => entry.name).join(" · ")})` : ""}`],
      ["Days planned", `${glance.daysPlanned} of ${glance.fieldDays} field days`],
      ["By kind", managerGlanceKindsLine(view, glance)],
      ...(view.scopes.length > 0
        ? ([
            [words.title, glance.districts.length > 0 ? glance.districts.map((district) => district.name).join(" · ") : "None yet"],
            ["Not in the week", glance.districtsNotIn.length > 0 ? glance.districtsNotIn.join(" · ") : "None"],
          ] as Array<[string, string]>)
        : []),
      ["Reps the week goes with", managerGlancePeopleLine(glance.reps) ?? "None"],
      ["Managers the week goes with", managerGlancePeopleLine(glance.managers) ?? "None"],
      ["Customers", managerGlanceCustomerLine(glance.customers)],
      ...(grades ? ([["By grade", `${grades}${share !== null ? ` · ${share}% of the graded are A` : ""}`]] as Array<[string, string]>) : []),
      ...(managerGlanceRepeatedLine(glance.customers) ? ([["Repeated", managerGlanceRepeatedLine(glance.customers) as string]] as Array<[string, string]>) : []),
      ["Reading", "The saved week as it stands when this file was made; a half-day typed and not saved is not in it. A holiday holds no plan."],
    ],
    subtitle,
    title: "Weekly plan",
  });

  // Week — the screen's grid: a row per day, its word, then Morning and Afternoon, as the glance shows them.
  const weekSheet = workbook.addWorksheet("Week", { properties: { defaultRowHeight: 18 } });
  weekSheet.views = [{ showGridLines: false }];
  const weekTop = writeHouseMasthead(workbook, weekSheet, { columns: 4, provenance, subtitle, title: "Week" });
  writeHouseTable(weekSheet, weekTop, {
    columns: [
      { label: "Day", width: 24 },
      { label: "Stands", width: 14 },
      { label: "Morning", width: 56 },
      { label: "Afternoon", width: 56 },
    ],
    note: "The week as the glance shows it: the saved summary of each half, or what an empty one reads.",
    rows: glance.rows.length > 0 ? glance.rows.map((row): CellValue[] => managerGlanceGridRow(row)) : [["No day this week", "", "", ""]],
    title: `${managerGlancePlannedLine(glance)} · ${managerGlanceOpenLine(glance)}`,
  });

  // Half-days — every half of every field day, an empty one included, and one line per holiday.
  const halfSheet = workbook.addWorksheet("Half-days", { properties: { defaultRowHeight: 18 } });
  halfSheet.views = [{ showGridLines: false }];
  const halfStart = writeHouseMasthead(workbook, halfSheet, { columns: 10, provenance, subtitle, title: "Half-days" });
  const halfRows: CellValue[][] = view.days.flatMap((day): CellValue[][] => {
    if (!isManagerFieldDay(day)) return [[day.dateText, "", day.holiday ? "Holiday" : "No field day", day.holiday ? `${day.holiday} · no plan` : "", "", "", "", "", "", ""]];
    return day.halves.map((half) => {
      const slot = managerSavedSlot(day, half);
      if (!slot || !slot.kind) return [day.dateText, half, "", day.passed ? MANAGER_GLANCE_PASSED_WORDS : MANAGER_GLANCE_OPEN_WORDS, "", "", "", "", "", ""];
      return [
        day.dateText,
        half,
        managerGlanceKindLabel(view, slot.kind),
        slot.summary ?? slot.kindLabel ?? "",
        slot.scopeName ?? "",
        withOf(slot),
        slot.kind === "admin" ? (slot.activityLabel ?? "") : areasOf(slot),
        slot.customers.length,
        slot.customers.map((customer) => customer.name).join(" · "),
        slot.note ?? "",
      ];
    });
  });
  writeHouseTable(halfSheet, halfStart, {
    columns: [
      { label: "Day", width: 24 },
      { label: "Half", width: 6 },
      { label: "Kind", width: 26 },
      { label: "What", width: 40 },
      { label: words.column, width: 32 },
      { label: "With", width: 26 },
      { label: "Area or activity", width: 28 },
      { label: "Customers", right: true, width: 10 },
      { label: "Customers by name", width: 60 },
      { label: "Note", width: 40 },
    ],
    note: "Every half of every field day. A half with nothing saved says so; a passed one cannot be planned any more.",
    rows: halfRows.length > 0 ? halfRows : [["No field day this week", "", "", "", "", "", "", "", "", ""]],
    title: `${managerGlancePlannedLine(glance)} · ${managerGlanceOpenLine(glance)}`,
  });

  // Customers — one row per tick of the saved week.
  const customerSheet = workbook.addWorksheet("Customers", { properties: { defaultRowHeight: 18 } });
  customerSheet.views = [{ showGridLines: false }];
  const customerStart = writeHouseMasthead(workbook, customerSheet, { columns: 8, provenance, subtitle, title: "Customers" });
  const tickRows: CellValue[][] = view.days.flatMap((day) =>
    isManagerFieldDay(day)
      ? day.halves.flatMap((half) =>
          (managerSavedSlot(day, half)?.customers ?? []).map((customer): CellValue[] => {
            const grade = managerGlanceGrade(customer.grade);
            return [
              day.dateText,
              half,
              customer.name,
              grade === "none" ? "No grade" : grade,
              customer.speciality?.trim() || "No speciality",
              customer.own ? "Manager's own list" : "Rep's list",
              customer.flagLabel ?? "",
              withOf(managerSavedSlot(day, half) as ManagerBoardSlot),
            ];
          }),
        )
      : [],
  );
  writeHouseTable(customerSheet, customerStart, {
    columns: [
      { label: "Day", width: 24 },
      { label: "Half", width: 6 },
      { label: "Customer", width: 30 },
      { label: "Grade", width: 9 },
      { label: "Speciality", width: 22 },
      { label: "List", width: 20 },
      { label: "Flag", width: 30 },
      { label: "With", width: 26 },
    ],
    note: "A customer ticked on two half-days is two rows and one customer.",
    rows: tickRows.length > 0 ? tickRows : [["No customer ticked", "", "", "", "", "", "", ""]],
    title: `Whom the week visits · ${managerGlanceCustomerLine(glance.customers)}`,
  });

  // People — the district managers, the reps and the managers the week goes with.
  const peopleSheet = workbook.addWorksheet("People", { properties: { defaultRowHeight: 18 } });
  peopleSheet.views = [{ showGridLines: false }];
  let peopleRow = writeHouseMasthead(workbook, peopleSheet, { columns: 4, provenance, subtitle, title: "People" });
  // One width per column for every table on the sheet: a name or district, who, a count, the half-days.
  const peopleColumns = (first: string, second: string, fourth: string) => [
    { label: first, width: 40 },
    { label: second, width: 26 },
    { label: "Half-days", right: true, width: 10 },
    { label: fourth, width: 60 },
  ];
  if (view.scopes.length > 0) {
    const districtRows: CellValue[][] = [
      ...glance.districts.map((district): CellValue[] => [district.name, managerGlanceDistrictWho(district), district.halves, managerGlanceDistrictLine(district)]),
      ...glance.districtsNotIn.map((name): CellValue[] => [name, "", 0, "Not in the week"]),
    ];
    peopleRow =
      writeHouseTable(peopleSheet, peopleRow, {
        columns: peopleColumns(words.column, words.column === "Region" ? "Planned with" : "District manager", "In the week"),
        note: words.note,
        rows: districtRows,
        title: `${words.title} · ${glance.districts.length} of ${view.scopes.length}`,
      }) + 1;
  }
  const peopleRows: CellValue[][] = [
    ...glance.reps.map((person): CellValue[] => [person.name, "Rep", person.halves, person.halfNames.join(" · ")]),
    ...glance.managers.map((person): CellValue[] => [person.name, "Manager", person.halves, person.halfNames.join(" · ")]),
  ];
  writeHouseTable(peopleSheet, peopleRow, {
    columns: peopleColumns("Name", "Who", "Which half-days"),
    rows: peopleRows.length > 0 ? peopleRows : [["Nobody yet", "", "", ""]],
    title: `Who the week goes with · ${glance.reps.length} ${glance.reps.length === 1 ? "rep" : "reps"} · ${glance.managers.length} ${glance.managers.length === 1 ? "manager" : "managers"}`,
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

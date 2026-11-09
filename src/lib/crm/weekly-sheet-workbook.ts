/**
 * The Weekly Sheet as a workbook — the screen the Regional Sales Manager reads, in the house identity
 * (SATO-DIS-2026-01: the masthead, the blue header band, the hairline grid and the 6% zebra). It re-derives
 * nothing: every figure is read off the sheet `loadWeeklySheet` built, and every grade and every sentence off
 * `weekly-sheet-summary.ts`, the arithmetic the screen reads (premium pass, 9 Nov 2026).
 *
 * Five sheets: Cover (the week, the targets, the team in figures), Districts (one row per region and district
 * manager), Reps, Accounts, and To look at. "Met" and "Below" are words; a week still running says "So far"; an
 * account whose comments name no doctor prints "No doctors written in the comment", never a 0. The file always holds
 * every seat, whatever filter the screen was on.
 */

import ExcelJS from "exceljs";

import { DOCTOR_FAMILY_LABEL } from "@/lib/crm/account-doctor-notes";
import type { WeeklySheet } from "@/lib/crm/weekly-sheet";
import {
  WEEKLY_SHEET_ACCOUNT_STATE_LABEL,
  WEEKLY_SHEET_ACCOUNT_STATES,
  WEEKLY_SHEET_NO_DOCTORS,
  weeklySheetAccountResult,
  weeklySheetAccountShortLine,
  weeklySheetAccountsInOrder,
  weeklySheetAttention,
  weeklySheetAttentionEmptyLine,
  weeklySheetDepthLine,
  weeklySheetGapWords,
  weeklySheetMetCaption,
  weeklySheetPosition,
  weeklySheetPositionLine,
  weeklySheetRepVerdicts,
  weeklySheetSpecialityGapLine,
  weeklySheetTargetLine,
  weeklySheetTeamTotals,
  weeklySheetTotals,
  weeklySheetUnmeasuredLine,
} from "@/lib/crm/weekly-sheet-summary";
import { buildHouseCoverSheet, writeHouseTable, type CellValue } from "@/lib/export/house-table-workbook";
import { houseGeneratedAt, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";

/** The file's name: the week's Saturday. */
export function weeklySheetWorkbookFileName(sheet: Pick<WeeklySheet, "weekStart">): string {
  return `weekly-sheet-${sheet.weekStart}.xlsx`;
}

function addSheet(workbook: ExcelJS.Workbook, name: string) {
  const sheet = workbook.addWorksheet(name, { properties: { defaultRowHeight: 18 } });
  sheet.views = [{ showGridLines: false }];
  return sheet;
}

export async function buildWeeklySheetWorkbook(sheet: WeeklySheet, generatedAtIso: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(generatedAtIso);
  const position = weeklySheetPosition(sheet);
  const team = weeklySheetTeamTotals(sheet);
  const subtitle = `Weekly Sheet · ${sheet.label}`;
  const provenance = [houseGeneratedAt(generatedAtIso), sheet.label];

  buildHouseCoverSheet(workbook, {
    confidentialNote: "Internal — for the Regional Sales Manager and the district managers.",
    rows: [
      ["Week", sheet.label],
      ["Where the week stands", weeklySheetPositionLine(position)],
      ["Target", weeklySheetTargetLine()],
      ["Account depth", weeklySheetDepthLine()],
      ["Seats", `${team.seats} · ${team.measured} measured${weeklySheetUnmeasuredLine(team) ? ` · ${weeklySheetUnmeasuredLine(team)}` : ""}`],
      ["PM visits", `${team.pm} of ${team.pmTarget} · ${weeklySheetMetCaption(team.pmByVerdict, team.measured, position)}`],
      ["AM visits", `${team.am} of ${team.amTarget} · ${weeklySheetMetCaption(team.amByVerdict, team.measured, position)}`],
      ["Both targets met", position === "ahead" ? "Not started" : `${team.bothMet} of ${team.measured}`],
      ["Pharmacies", String(team.pharmacies)],
      ["Waiting for validation", team.waiting > 0 ? `${team.waiting} visits, counted in no figure` : "None"],
      ["AM accounts", `${team.accounts} · ${WEEKLY_SHEET_ACCOUNT_STATES.map((state) => `${WEEKLY_SHEET_ACCOUNT_STATE_LABEL[state]} ${team.byAccountState[state]}`).join(" · ")}`],
      ["Short most often", weeklySheetSpecialityGapLine(team) ?? "None short"],
      ...(sheet.targetsUncertain ? ([["Note", "The holiday calendar or approved leave could not be read, so a target may be one day too high"]] as Array<[string, string]>) : []),
    ],
    subtitle,
    title: "Weekly Sheet",
  });

  // ── Districts — one row per region and district manager, the whole district's figures ──────────
  const districtSheet = addSheet(workbook, "Districts");
  const districtStart = writeHouseMasthead(workbook, districtSheet, { columns: 11, provenance, subtitle, title: "Districts" });
  const districtRows: CellValue[][] = sheet.districts.map((district) => {
    const totals = weeklySheetTotals(district.reps, position);
    return [
      district.regionName,
      district.managerName,
      totals.seats - totals.vacant,
      totals.vacant,
      totals.pm,
      totals.pmTarget,
      totals.am,
      totals.amTarget,
      position === "ahead" ? "" : `${totals.bothMet} of ${totals.measured}`,
      totals.accounts,
      totals.byAccountState.met,
    ];
  });
  writeHouseTable(districtSheet, districtStart, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 24 },
      { label: "Reps", right: true, width: 8 },
      { label: "Vacant seats", right: true, width: 10 },
      { label: "PM", right: true, width: 8 },
      { label: "PM target", right: true, width: 10 },
      { label: "AM", right: true, width: 8 },
      { label: "AM target", right: true, width: 10 },
      { label: "Both targets met", width: 14 },
      { label: "AM accounts", right: true, width: 11 },
      { label: "3 of each", right: true, width: 10 },
    ],
    note: "Each row is the whole district: a vacant seat is counted apart and in no grade.",
    rows: districtRows,
    totals: ["Team", "", team.seats - team.vacant, team.vacant, team.pm, team.pmTarget, team.am, team.amTarget, position === "ahead" ? "" : `${team.bothMet} of ${team.measured}`, team.accounts, team.byAccountState.met],
    title: "Every region and district manager",
  });

  // ── Reps ───────────────────────────────────────────────────────────────────────────────────────
  const repSheet = addSheet(workbook, "Reps");
  const repStart = writeHouseMasthead(workbook, repSheet, { columns: 17, provenance, subtitle, title: "Reps" });
  const repRows: CellValue[][] = sheet.districts.flatMap((district) =>
    district.reps.map((rep) => {
      const verdicts = weeklySheetRepVerdicts(rep, position);
      return [
        district.regionName,
        district.managerName,
        rep.person,
        rep.territory,
        rep.vacant ? "" : rep.workingDays,
        rep.vacant ? "" : rep.leaveDays,
        rep.pm,
        rep.vacant ? "" : rep.pmTarget,
        verdicts.pm,
        weeklySheetGapWords(rep.pm, rep.pmTarget, verdicts.pm) ?? "",
        rep.am,
        rep.vacant ? "" : rep.amTarget,
        verdicts.am,
        weeklySheetGapWords(rep.am, rep.amTarget, verdicts.am) ?? "",
        rep.pharmacies,
        rep.waiting,
        `${rep.accountsMet} of ${rep.accounts.length}`,
      ];
    }),
  );
  writeHouseTable(repSheet, repStart, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 24 },
      { label: "Rep", width: 26 },
      { label: "Territory", width: 22 },
      { label: "Working days", right: true, width: 10 },
      { label: "Leave days", right: true, width: 9 },
      { label: "PM", right: true, width: 8 },
      { label: "PM target", right: true, width: 10 },
      { label: "PM result", width: 14 },
      { label: "PM gap", width: 11 },
      { label: "AM", right: true, width: 8 },
      { label: "AM target", right: true, width: 10 },
      { label: "AM result", width: 14 },
      { label: "AM gap", width: 11 },
      { label: "Pharmacies", right: true, width: 11 },
      { label: "Waiting for validation", right: true, width: 12 },
      { label: "Accounts with 3 of each", width: 14 },
    ],
    note: "A visit waiting for validation is real work counted in no figure. A week still running reads “So far”, never “Below”.",
    rows: repRows,
    title: "PM, AM and Pharmacies",
  });

  // ── Accounts ───────────────────────────────────────────────────────────────────────────────────
  const accountSheet = addSheet(workbook, "Accounts");
  const accountStart = writeHouseMasthead(workbook, accountSheet, { columns: 11, provenance, subtitle, title: "Accounts" });
  // Region and district manager on every row (owner, 2026-11-09), as on the Reps sheet; short accounts first.
  const accountRows: CellValue[][] = sheet.districts.flatMap((district) =>
    district.reps.flatMap((rep) =>
      weeklySheetAccountsInOrder(rep.accounts).map((account) => [
        district.regionName,
        district.managerName,
        rep.person,
        account.name,
        account.visits,
        account.depth.noDoctorsWritten ? WEEKLY_SHEET_NO_DOCTORS : account.depth.pediatrics,
        account.depth.noDoctorsWritten ? "" : account.depth.internal,
        account.depth.noDoctorsWritten ? "" : account.depth.ent,
        account.depth.noDoctorsWritten ? "" : account.depth.named,
        weeklySheetAccountResult(account.depth),
        weeklySheetAccountShortLine(account.depth) ?? "",
      ]),
    ),
  );
  writeHouseTable(accountSheet, accountStart, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 24 },
      { label: "Rep", width: 26 },
      { label: "Account", width: 34 },
      { label: "Visits", right: true, width: 8 },
      { label: DOCTOR_FAMILY_LABEL.pediatrics, right: true, width: 14 },
      { label: DOCTOR_FAMILY_LABEL.internal, right: true, width: 22 },
      { label: DOCTOR_FAMILY_LABEL.ent, right: true, width: 8 },
      { label: "Doctors named", right: true, width: 13 },
      { label: "3 of each", width: 18 },
      { label: "What it needs", width: 40 },
    ],
    note: "Doctors are counted from the AM visit comments, each person once for the week.",
    rows: accountRows,
    title: "Doctors of each speciality inside every AM account",
  });

  // ── To look at ─────────────────────────────────────────────────────────────────────────────────
  const attentionSheet = addSheet(workbook, "To look at");
  const attentionStart = writeHouseMasthead(workbook, attentionSheet, { columns: 5, provenance, subtitle, title: "To look at" });
  const items = weeklySheetAttention(sheet);
  writeHouseTable(attentionSheet, attentionStart, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 24 },
      { label: "Rep", width: 26 },
      { label: "Territory", width: 22 },
      { label: "What to look at", width: 70 },
    ],
    note: items.length === 0 ? weeklySheetAttentionEmptyLine(position) : "Most reasons first, then the larger PM gap.",
    rows: items.map((item) => [item.district.regionName, item.district.managerName, item.rep.person, item.rep.territory, item.reasons.map((entry) => entry.words).join(" · ")]),
    title: "Reps to look at",
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

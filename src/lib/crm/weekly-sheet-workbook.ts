/**
 * The Weekly Sheet as a workbook — the screen the Regional Sales Manager reads, in the house identity
 * (SATO-DIS-2026-01: the masthead, the blue header band, the hairline grid and the 6% zebra). It re-derives
 * nothing: every figure is read off the sheet `loadWeeklySheet` built. "Met" and "Below" are words; an account
 * whose comments name no doctor prints "No doctors written in the comment", never a 0.
 */

import ExcelJS from "exceljs";

import { DOCTOR_FAMILY_LABEL } from "@/lib/crm/account-doctor-notes";
import { weeklySheetResult, type WeeklySheet } from "@/lib/crm/weekly-sheet";
import { buildHouseCoverSheet, writeHouseTable, type CellValue } from "@/lib/export/house-table-workbook";
import { houseGeneratedAt, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";

const NO_DOCTORS = "No doctors written in the comment";

function result(met: boolean): string {
  return met ? "Met" : "Below";
}

export async function buildWeeklySheetWorkbook(sheet: WeeklySheet, generatedAtIso: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(generatedAtIso);
  const reps = sheet.districts.flatMap((district) => district.reps);
  buildHouseCoverSheet(workbook, {
    confidentialNote: "Internal — for the Regional Sales Manager and the district managers.",
    rows: [
      ["Week", sheet.label],
      ["Target", "10 PM and 2 AM per working day — 50 PM and 10 AM in a full week; leave and national holidays come out of the target"],
      ["Account depth", "At least 3 doctors of each speciality — Pediatrics, Internal Medicine / GP, ENT — read from the AM visit comments"],
      ["Reps", String(reps.length)],
      ...(sheet.targetsUncertain ? ([["Note", "The holiday calendar or approved leave could not be read, so a target may be one day too high"]] as Array<[string, string]>) : []),
    ],
    subtitle: `Weekly Sheet · ${sheet.label}`,
    title: "Weekly Sheet",
  });

  const repSheet = workbook.addWorksheet("Reps", { properties: { defaultRowHeight: 18 } });
  repSheet.views = [{ showGridLines: false }];
  const repStart = writeHouseMasthead(workbook, repSheet, { columns: 11, provenance: [houseGeneratedAt(generatedAtIso), sheet.label], subtitle: `Weekly Sheet · ${sheet.label}`, title: "Reps" });
  const repRows: CellValue[][] = sheet.districts.flatMap((district) =>
    district.reps.map((rep) => [
      district.managerName,
      rep.person,
      rep.territory,
      rep.workingDays,
      rep.pm,
      rep.vacant ? "" : rep.pmTarget,
      weeklySheetResult(rep.pm, rep.pmTarget, rep.vacant),
      rep.am,
      rep.vacant ? "" : rep.amTarget,
      weeklySheetResult(rep.am, rep.amTarget, rep.vacant),
      rep.pharmacies,
    ]),
  );
  writeHouseTable(repSheet, repStart, {
    columns: [
      { label: "District manager", width: 24 },
      { label: "Rep", width: 26 },
      { label: "Territory", width: 22 },
      { label: "Working days", right: true, width: 10 },
      { label: "PM", right: true, width: 8 },
      { label: "PM target", right: true, width: 10 },
      { label: "PM result", width: 10 },
      { label: "AM", right: true, width: 8 },
      { label: "AM target", right: true, width: 10 },
      { label: "AM result", width: 10 },
      { label: "Pharmacies", right: true, width: 11 },
    ],
    rows: repRows,
    title: "PM, AM and Pharmacies",
  });

  const accountSheet = workbook.addWorksheet("Accounts", { properties: { defaultRowHeight: 18 } });
  accountSheet.views = [{ showGridLines: false }];
  const accountStart = writeHouseMasthead(workbook, accountSheet, { columns: 8, provenance: [houseGeneratedAt(generatedAtIso), sheet.label], subtitle: `Weekly Sheet · ${sheet.label}`, title: "Accounts" });
  const accountRows: CellValue[][] = reps.flatMap((rep) =>
    rep.accounts.map((account) => [
      rep.person,
      account.name,
      account.visits,
      account.depth.noDoctorsWritten ? NO_DOCTORS : account.depth.pediatrics,
      account.depth.noDoctorsWritten ? "" : account.depth.internal,
      account.depth.noDoctorsWritten ? "" : account.depth.ent,
      account.depth.named,
      result(account.depth.met),
    ]),
  );
  writeHouseTable(accountSheet, accountStart, {
    columns: [
      { label: "Rep", width: 26 },
      { label: "Account", width: 34 },
      { label: "Visits", right: true, width: 8 },
      { label: DOCTOR_FAMILY_LABEL.pediatrics, right: true, width: 14 },
      { label: DOCTOR_FAMILY_LABEL.internal, right: true, width: 22 },
      { label: DOCTOR_FAMILY_LABEL.ent, right: true, width: 8 },
      { label: "Doctors named", right: true, width: 13 },
      { label: "3 of each", width: 10 },
    ],
    note: "Doctors are counted from the AM visit comments, each person once for the week.",
    rows: accountRows,
    title: "Doctors of each speciality inside every AM account",
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

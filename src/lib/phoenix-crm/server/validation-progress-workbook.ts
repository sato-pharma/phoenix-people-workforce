/**
 * Doctor list validation, by medical rep — as a workbook, in the house identity (SATO-DIS-2026-01: the masthead, the
 * blue header band, the hairline grid and the 6% zebra), the same dress as Visits — Yesterday and Today.
 *
 * It re-derives nothing: every figure is read off the report `buildValidationProgress` made, the same one the page
 * prints. The file is built on the press of the button, from a fresh read, so it always reflects the system as it is.
 *
 *   Cover          — what the file is, when it was read, the company's totals.
 *   Reps           — one row per rep seat: hire date, total list, validated, not validated, tried and blocked, never tried.
 *   Not validated  — every doctor still waiting, with the days the rep tried and was blocked (each day once).
 */

import ExcelJS from "exceljs";

import { buildHouseCoverSheet, F, writeHouseTable, type CellValue } from "@/lib/export/house-table-workbook";
import { houseGeneratedAt, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";
import { VACANT_SEAT_NAME, validatedShare, type ValidationProgressReport } from "@/lib/phoenix-crm/validation-progress-rules";

export const VALIDATION_PROGRESS_SHEETS = ["Cover", "Reps", "Not validated"] as const;

/** A calendar day as an Excel date serial, so the column sorts and filters as dates (never display text). */
export function excelDaySerial(iso: string | null): number | string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!match) return "";
  return (Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

const DAY_FORMAT = "dd mmm yyyy";

function day(iso: string | null): number | string {
  return excelDaySerial(iso);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** One file per Cairo day, so today's download never overwrites yesterday's. */
export function validationProgressFileName(generatedAtIso: string): string {
  const cairoDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(generatedAtIso));
  return `doctor-list-validation-${cairoDay}.xlsx`;
}

export async function buildValidationProgressWorkbook(report: ValidationProgressReport, generatedAtIso: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(generatedAtIso);
  const subtitle = "Doctor list validation by medical rep · AM and PM lists";
  const provenance = [houseGeneratedAt(generatedAtIso), "Read live from Phoenix CRM"];
  const { totals } = report;

  buildHouseCoverSheet(workbook, {
    confidentialNote: "Internal — for the Super Admin and the SFE Manager.",
    rows: [
      ["Reps", String(totals.reps)],
      ["Vacant seats with a list", String(totals.vacantSeats)],
      ["Doctors on the lists", String(totals.total)],
      ["Validated", `${totals.validated} (${percent(totals.total === 0 ? 0 : totals.validated / totals.total)})`],
      ["Not validated", String(totals.notValidated)],
      ["Not validated — tried and was blocked", String(totals.triedBlocked)],
      ["Not validated — never tried", String(totals.neverTried)],
      ["The list", "A rep's AM and PM doctors on the list: validated, or waiting to be validated at the clinic. Dropped doctors and pharmacies are not counted — a pharmacy is never validated."],
      ["Blocked", "A validation try for that doctor that Phoenix CRM refused — the location, the nameplate, the timetable or the Google Maps listing. Each day is counted once, however many tries were refused on it."],
      ["Not linked to a doctor", "A refusal the phone sent before a doctor was chosen (a blocked location or camera, a new capture) cannot be filed against one doctor. It is counted on the rep's row apart."],
    ],
    subtitle,
    title: "Doctor list validation",
  });

  // Reps — one row per rep seat.
  const repSheet = workbook.addWorksheet("Reps", { properties: { defaultRowHeight: 18 } });
  const repStart = writeHouseMasthead(workbook, repSheet, { columns: 14, provenance, subtitle, title: "Reps" });
  // The header row stays in sight while the list scrolls, and the rep's name while it scrolls sideways.
  repSheet.views = [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: repStart + 1 }];
  const repColumns = [
    { label: "Medical rep", width: 28 },
    { label: "Hiring date", width: 13, numFmt: DAY_FORMAT },
    { label: "Line", width: 14 },
    { label: "Area", width: 20 },
    { label: "District manager", width: 26 },
    { label: "Total list", right: true, width: 10 },
    { label: "AM", right: true, width: 7 },
    { label: "PM", right: true, width: 7 },
    { label: "Validated", right: true, width: 10 },
    { label: "Not validated", right: true, width: 11 },
    { label: "Not validated — tried and was blocked", right: true, width: 15 },
    { label: "Not validated — never tried", right: true, width: 13 },
    { label: "Validated %", right: true, width: 11, numFmt: "0%", dataBar: true },
    { label: "Days blocked with no doctor named", right: true, width: 14 },
  ];
  const firstRepRow = repStart + 2;
  const repRows: CellValue[][] = report.reps.map((rep, index) => {
    const at = firstRepRow + index;
    return [
      rep.repName,
      rep.vacant ? "" : day(rep.hireDate),
      rep.lineName,
      rep.areaName,
      rep.managerName,
      rep.total,
      rep.am,
      rep.pm,
      rep.validated,
      rep.notValidated,
      rep.triedBlocked,
      rep.neverTried,
      F(`IF(F${at}=0,0,I${at}/F${at})`, validatedShare(rep)),
      rep.unlinkedBlockedDays,
    ];
  });
  const lastRepRow = firstRepRow + repRows.length - 1;
  const sum = (letter: string, value: number) => F(`SUM(${letter}${firstRepRow}:${letter}${lastRepRow})`, value);
  const totalAt = lastRepRow + 1;
  writeHouseTable(repSheet, repStart, {
    columns: repColumns,
    note: "A vacant seat keeps its list and has no hiring date. During a handover both people are named and the earlier hiring date is shown.",
    rows: repRows,
    title: "Each rep's doctor list",
    totals: [
      "Total",
      "",
      "",
      "",
      "",
      sum("F", totals.total),
      sum("G", report.reps.reduce((all, rep) => all + rep.am, 0)),
      sum("H", report.reps.reduce((all, rep) => all + rep.pm, 0)),
      sum("I", totals.validated),
      sum("J", totals.notValidated),
      sum("K", totals.triedBlocked),
      sum("L", totals.neverTried),
      F(`IF(F${totalAt}=0,0,I${totalAt}/F${totalAt})`, totals.total === 0 ? 0 : totals.validated / totals.total),
      "",
    ],
  });
  if (repRows.length > 0) repSheet.autoFilter = { from: { row: repStart + 1, column: 1 }, to: { row: lastRepRow, column: repColumns.length } };

  // Not validated — every doctor still waiting.
  const doctorSheet = workbook.addWorksheet("Not validated", { properties: { defaultRowHeight: 18 } });
  const doctorStart = writeHouseMasthead(workbook, doctorSheet, { columns: 15, provenance, subtitle, title: "Not validated" });
  doctorSheet.views = [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: doctorStart + 1 }];
  const doctorColumns = [
    { label: "Medical rep", width: 26 },
    { label: "Hiring date", width: 13, numFmt: DAY_FORMAT },
    { label: "Line", width: 13 },
    { label: "Area", width: 18 },
    { label: "District manager", width: 24 },
    { label: "Doctor", width: 30 },
    { label: "List", width: 7 },
    { label: "Speciality", width: 18 },
    { label: "Grade", width: 7 },
    { label: "Days tried and blocked", right: true, width: 12 },
    { label: "Tries refused", right: true, width: 10 },
    { label: "First blocked day", width: 13, numFmt: DAY_FORMAT },
    { label: "Last blocked day", width: 13, numFmt: DAY_FORMAT },
    { label: "Why it was refused (tries)", width: 44 },
    { label: "Tried by", width: 24 },
  ];
  writeHouseTable(doctorSheet, doctorStart, {
    columns: doctorColumns,
    note: "Days tried and blocked: the different days a validation try for this doctor was refused. 0 means it was never tried.",
    rows: report.doctors.map((doctor) => [
      doctor.repName,
      doctor.repName === VACANT_SEAT_NAME ? "" : day(doctor.hireDate),
      doctor.lineName,
      doctor.areaName,
      doctor.managerName,
      doctor.doctor,
      doctor.listType,
      doctor.speciality,
      doctor.grade,
      doctor.blockedDays,
      doctor.refusedTries,
      day(doctor.firstBlockedDay),
      day(doctor.lastBlockedDay),
      doctor.reasons,
      doctor.triedBy,
    ]),
    title: "Doctors not validated yet",
  });
  if (report.doctors.length > 0) {
    doctorSheet.autoFilter = { from: { row: doctorStart + 1, column: 1 }, to: { row: doctorStart + 1 + report.doctors.length, column: doctorColumns.length } };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

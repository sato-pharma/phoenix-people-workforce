/**
 * Doctor list validation, by medical rep — as a workbook, in the house identity (SATO-DIS-2026-01: the masthead, the
 * blue header band, the hairline grid and the 6% zebra), the same dress as Visits — Yesterday and Today.
 *
 * It re-derives nothing: every figure is read off the report `buildValidationProgress` made, the same one the page
 * prints. The file is built on the press of the button, from a fresh read, so it always reflects the system as it is.
 *
 *   Cover              — what the file is, when it was read, for which line, the company's totals.
 *   Reps               — one row per rep seat: hiring date, days since hire, new starter, the list and its validation,
 *                        the last validation day.
 *   District managers  — each district manager's reps together.
 *   Not validated      — every doctor still waiting, with the days the rep tried and was blocked (each day once).
 */

import ExcelJS from "exceljs";

import { buildHouseCoverSheet, F, writeHouseTable, type CellValue, type TableColumn } from "@/lib/export/house-table-workbook";
import { houseGeneratedAt, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";
import { NEW_STARTER_DAYS, VACANT_SEAT_NAME, validatedShare, type ValidationProgressReport } from "@/lib/phoenix-crm/validation-progress-rules";

export const VALIDATION_PROGRESS_SHEETS = ["Cover", "Reps", "District managers", "Not validated"] as const;

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

/** The Excel column letter of a 0-based index (0 → A, 26 → AA). */
function letter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

type Column = TableColumn;

/** The letter of the column with this label, so a formula never points at a column that moved. */
function columnLetter(columns: readonly Column[], label: string): string {
  const index = columns.findIndex((column) => column.label === label);
  if (index === -1) throw new Error(`No column "${label}"`);
  return letter(index);
}

/** One file per Cairo day (and per line when narrowed), so today's download never overwrites yesterday's. */
export function validationProgressFileName(generatedAtIso: string, line: string | null = null): string {
  const cairoDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(generatedAtIso));
  const lineSlug = line ? `${line.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-` : "";
  return `doctor-list-validation-${lineSlug}${cairoDay}.xlsx`;
}

export async function buildValidationProgressWorkbook(report: ValidationProgressReport, generatedAtIso: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(generatedAtIso);
  const lineWords = report.line ?? "Every line";
  const subtitle = `Doctor list validation by medical rep · AM and PM lists · ${lineWords}`;
  const provenance = [houseGeneratedAt(generatedAtIso), "Read live from Phoenix CRM"];
  const { totals } = report;
  const newStarters = report.reps.filter((rep) => rep.newStarter).length;

  buildHouseCoverSheet(workbook, {
    confidentialNote: "Internal — for the Super Admin and the SFE Manager.",
    rows: [
      ["Line", lineWords],
      ["Reps", String(totals.reps)],
      [`New starters (under ${NEW_STARTER_DAYS} days)`, String(newStarters)],
      ["Vacant seats with a list", String(totals.vacantSeats)],
      ["Doctors on the lists", String(totals.total)],
      ["Validated", `${totals.validated} (${percent(totals.total === 0 ? 0 : totals.validated / totals.total)})`],
      ["Not validated", String(totals.notValidated)],
      ["Not validated — tried and was blocked", String(totals.triedBlocked)],
      ["Not validated — never tried", String(totals.neverTried)],
      ["The list", "A rep's AM and PM doctors on the list: validated, or waiting to be validated at the clinic. Dropped doctors and pharmacies are not counted — a pharmacy is never validated."],
      ["Blocked", "A validation try for that doctor that Phoenix CRM refused — the location, the nameplate, the timetable or the Google Maps listing. Each day is counted once, however many tries were refused on it."],
      ["New starter", `A rep hired fewer than ${NEW_STARTER_DAYS} days before the day of this file, counted from the hiring date on file.`],
      ["Last validation", "The latest day a doctor on the rep's list was validated."],
      ["Not linked to a doctor", "A refusal the phone sent before a doctor was chosen (a blocked location or camera, a new capture) cannot be filed against one doctor. It is counted on the rep's row apart."],
    ],
    subtitle,
    title: "Doctor list validation",
  });

  // Reps — one row per rep seat.
  const repColumns: Column[] = [
    { label: "Medical rep", width: 28 },
    { label: "Hiring date", width: 13, numFmt: DAY_FORMAT },
    { label: "Days since hire", right: true, width: 10 },
    { label: "New starter", width: 9 },
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
    { label: "Last validation", width: 13, numFmt: DAY_FORMAT },
    { label: "Days blocked with no doctor named", right: true, width: 14 },
  ];
  const repSheet = workbook.addWorksheet("Reps", { properties: { defaultRowHeight: 18 } });
  const repStart = writeHouseMasthead(workbook, repSheet, { columns: repColumns.length, provenance, subtitle, title: "Reps" });
  // The header row stays in sight while the list scrolls, and the rep's name while it scrolls sideways.
  repSheet.views = [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: repStart + 1 }];
  const repLetter = (label: string) => columnLetter(repColumns, label);
  const [totalCol, validatedCol] = [repLetter("Total list"), repLetter("Validated")];
  const firstRepRow = repStart + 2;
  const repRows: CellValue[][] = report.reps.map((rep, index) => {
    const at = firstRepRow + index;
    return [
      rep.repName,
      rep.vacant ? "" : day(rep.hireDate),
      rep.vacant || rep.daysSinceHire === null ? "" : rep.daysSinceHire,
      rep.newStarter ? "Yes" : "",
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
      F(`IF(${totalCol}${at}=0,0,${validatedCol}${at}/${totalCol}${at})`, validatedShare(rep)),
      day(rep.lastValidatedDay),
      rep.unlinkedBlockedDays,
    ];
  });
  const lastRepRow = firstRepRow + repRows.length - 1;
  const repTotalAt = lastRepRow + 1;
  const repSum = (label: string, value: number) => {
    const at = repLetter(label);
    return F(`SUM(${at}${firstRepRow}:${at}${lastRepRow})`, value);
  };
  writeHouseTable(repSheet, repStart, {
    columns: repColumns,
    note: `A vacant seat keeps its list and has no hiring date. During a handover both people are named and the earlier hiring date is shown. A new starter was hired fewer than ${NEW_STARTER_DAYS} days ago.`,
    rows: repRows,
    title: "Each rep's doctor list",
    totals: [
      "Total",
      "",
      "",
      String(newStarters),
      "",
      "",
      "",
      repSum("Total list", totals.total),
      repSum("AM", report.reps.reduce((all, rep) => all + rep.am, 0)),
      repSum("PM", report.reps.reduce((all, rep) => all + rep.pm, 0)),
      repSum("Validated", totals.validated),
      repSum("Not validated", totals.notValidated),
      repSum("Not validated — tried and was blocked", totals.triedBlocked),
      repSum("Not validated — never tried", totals.neverTried),
      F(`IF(${totalCol}${repTotalAt}=0,0,${validatedCol}${repTotalAt}/${totalCol}${repTotalAt})`, totals.total === 0 ? 0 : totals.validated / totals.total),
      "",
      "",
    ],
  });
  if (repRows.length > 0) repSheet.autoFilter = { from: { row: repStart + 1, column: 1 }, to: { row: lastRepRow, column: repColumns.length } };

  // District managers — each manager's reps together.
  const managerColumns: Column[] = [
    { label: "District manager", width: 28 },
    { label: "Line", width: 14 },
    { label: "Reps", right: true, width: 7 },
    { label: "New starters", right: true, width: 9 },
    { label: "Vacant seats", right: true, width: 9 },
    { label: "Total list", right: true, width: 10 },
    { label: "Validated", right: true, width: 10 },
    { label: "Not validated", right: true, width: 11 },
    { label: "Not validated — tried and was blocked", right: true, width: 15 },
    { label: "Not validated — never tried", right: true, width: 13 },
    { label: "Validated %", right: true, width: 11, numFmt: "0%", dataBar: true },
    { label: "Last validation", width: 13, numFmt: DAY_FORMAT },
  ];
  const managerSheet = workbook.addWorksheet("District managers", { properties: { defaultRowHeight: 18 } });
  const managerStart = writeHouseMasthead(workbook, managerSheet, { columns: managerColumns.length, provenance, subtitle, title: "District managers" });
  managerSheet.views = [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: managerStart + 1 }];
  const managerLetter = (label: string) => columnLetter(managerColumns, label);
  const [mTotalCol, mValidatedCol] = [managerLetter("Total list"), managerLetter("Validated")];
  const firstManagerRow = managerStart + 2;
  const managerRows: CellValue[][] = report.managers.map((manager, index) => {
    const at = firstManagerRow + index;
    return [
      manager.managerName,
      manager.lineName,
      manager.reps,
      manager.newStarters,
      manager.vacantSeats,
      manager.total,
      manager.validated,
      manager.notValidated,
      manager.triedBlocked,
      manager.neverTried,
      F(`IF(${mTotalCol}${at}=0,0,${mValidatedCol}${at}/${mTotalCol}${at})`, validatedShare(manager)),
      day(manager.lastValidatedDay),
    ];
  });
  const lastManagerRow = firstManagerRow + managerRows.length - 1;
  const managerTotalAt = lastManagerRow + 1;
  const managerSum = (label: string, value: number) => {
    const at = managerLetter(label);
    return F(`SUM(${at}${firstManagerRow}:${at}${lastManagerRow})`, value);
  };
  const managerTotal = (pick: (row: (typeof report.managers)[number]) => number) => report.managers.reduce((all, row) => all + pick(row), 0);
  writeHouseTable(managerSheet, managerStart, {
    columns: managerColumns,
    note: "Each district manager's rep seats, with the same counts as the Reps sheet. Seats with no district manager are grouped by line.",
    rows: managerRows,
    title: "Each district manager's reps",
    totals: [
      "Total",
      "",
      managerSum("Reps", managerTotal((row) => row.reps)),
      managerSum("New starters", managerTotal((row) => row.newStarters)),
      managerSum("Vacant seats", managerTotal((row) => row.vacantSeats)),
      managerSum("Total list", totals.total),
      managerSum("Validated", totals.validated),
      managerSum("Not validated", totals.notValidated),
      managerSum("Not validated — tried and was blocked", totals.triedBlocked),
      managerSum("Not validated — never tried", totals.neverTried),
      F(`IF(${mTotalCol}${managerTotalAt}=0,0,${mValidatedCol}${managerTotalAt}/${mTotalCol}${managerTotalAt})`, totals.total === 0 ? 0 : totals.validated / totals.total),
      "",
    ],
  });
  if (managerRows.length > 0) {
    managerSheet.autoFilter = { from: { row: managerStart + 1, column: 1 }, to: { row: lastManagerRow, column: managerColumns.length } };
  }

  // Not validated — every doctor still waiting.
  const doctorColumns: Column[] = [
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
  const doctorSheet = workbook.addWorksheet("Not validated", { properties: { defaultRowHeight: 18 } });
  const doctorStart = writeHouseMasthead(workbook, doctorSheet, { columns: doctorColumns.length, provenance, subtitle, title: "Not validated" });
  doctorSheet.views = [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: doctorStart + 1 }];
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

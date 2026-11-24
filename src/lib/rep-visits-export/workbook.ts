/**
 * The rep visits export as a workbook — the layout the owner reviewed on Ebtissam Alaa's case (24 Nov 2026),
 * drawn from what `server.ts` loaded. Eight sheets, in this order:
 *
 *   Daily visits · Area bricks · Repeat visits · Visits per day · All visits · Every day · Doctors by brick · Doctor list
 *
 * 🔴 "Every day" IS A REAL EXCEL TABLE (owner: "in everyday tab in must be formated as a table bec i will pivot
 * it") — one header row, no merged cell, a value in every row, a Visits column of 1 on a visit and 0 on the day's
 * record row, so Sum of Visits in a pivot counts visits only.
 *
 * 🔴 "Visits per day" LISTS EVERY DAY OF THE RANGE (owner: "add all month days and mention vacation no records
 * meeting etc") — a day with no visit is a row with its day type and its record, never left out.
 *
 * Owner, 24 Nov 2026: "add a cover sheet name area line salary hiring date birth of date and age" — the Cover comes
 * first. Its salary figures are the employee record's own, read as stored; nothing here derives a salary.
 *
 * The rep is named, never "her" or "his": the file is about whoever was chosen.
 */

import ExcelJS from "exceljs";

import {
  ageOn,
  dayRecord,
  daysBetween,
  dayType,
  isConcernDayType,
  isWeeklyOff,
  gridDayLabel,
  locationLabel,
  longDay,
  monthLabel,
  monthsOfRange,
  monthlyNumber,
  repeatColourOf,
  repeatColours,
  repeatCountOf,
  repeatCounts,
  savedAtText,
  shortDay,
  standing,
  isCovered,
  visitKindLabel,
  visitsByDay,
  weekdayShort,
  type ExportDoctor,
  type ExportVisit,
  type RepVisitsExportData,
  type Standing,
} from "@/lib/rep-visits-export/rules";

export const REP_VISITS_WORKBOOK_SHEETS = [
  "Cover",
  "Daily visits",
  "Area bricks",
  "Repeat visits",
  "Visits per day",
  "All visits",
  "Every day",
  "Doctors by brick",
  "Doctor list",
] as const;

const NAVY = "0A527D";
const MUTED = "5A6B7C";
const GRID = "B9C7D4";
const GREEN = "1E7B34";
const RED = "B3261E";
const AMBER = "9A5B00";
const INK = "1A1A1A";
const WHITE = "FFFFFF";
const SHADE_OFF = "F2F2F2";
const SHADE_DAY = "E8EEF4";
const SHADE_HEAD = "D9E1EA";
const DASH = "–";
const MONEY = `#,##0;-#,##0;"${DASH}"`;

type Cell = ExcelJS.Cell;
type Value = string | number | Date | null;

const argb = (hex: string) => ({ argb: `FF${hex}` });
const thin = { style: "thin" as const, color: argb(GRID) };
const BOX: Partial<ExcelJS.Borders> = { top: thin, left: thin, bottom: thin, right: thin };
const TOP_RULE: Partial<ExcelJS.Borders> = { top: { style: "medium", color: argb(NAVY) }, left: thin, bottom: thin, right: thin };
const CENTRE: Partial<ExcelJS.Alignment> = { horizontal: "center", vertical: "middle", wrapText: true };
const LEFT: Partial<ExcelJS.Alignment> = { horizontal: "left", vertical: "middle", wrapText: true };
const RIGHT: Partial<ExcelJS.Alignment> = { horizontal: "right", vertical: "middle", wrapText: true };

function fill(cell: Cell, hex: string): void {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: argb(hex) };
}
function font(cell: Cell, options: { bold?: boolean; italic?: boolean; size?: number; color?: string }): void {
  cell.font = { name: "Calibri", size: options.size ?? 11, bold: options.bold, italic: options.italic, color: argb(options.color ?? INK) };
}
function put(sheet: ExcelJS.Worksheet, row: number, col: number, value: Value, align: Partial<ExcelJS.Alignment> = CENTRE): Cell {
  const cell = sheet.getCell(row, col);
  cell.value = value;
  cell.border = BOX;
  cell.alignment = align;
  return cell;
}
function head(sheet: ExcelJS.Worksheet, row: number, col: number, value: string, options: { bg?: string; fg?: string; size?: number; bold?: boolean } = {}): Cell {
  const cell = put(sheet, row, col, value);
  fill(cell, options.bg ?? NAVY);
  font(cell, { bold: options.bold ?? true, color: options.fg ?? WHITE, size: options.size ?? 10 });
  return cell;
}
function title(sheet: ExcelJS.Worksheet, text: string, size = 13): void {
  const cell = sheet.getCell(1, 1);
  cell.value = text;
  font(cell, { bold: true, size, color: NAVY });
}
function note(sheet: ExcelJS.Worksheet, row: number, text: string, lastCol: number, height = 38): void {
  const cell = sheet.getCell(row, 1);
  cell.value = text;
  font(cell, { size: 9, color: MUTED });
  cell.alignment = { wrapText: true, vertical: "top" };
  if (lastCol > 1) sheet.mergeCells(row, 1, row, lastCol);
  sheet.getRow(row).height = height;
}
function widths(sheet: ExcelJS.Worksheet, values: number[]): void {
  values.forEach((width, index) => (sheet.getColumn(index + 1).width = width));
}
function frozen(sheet: ExcelJS.Worksheet, xSplit: number, ySplit: number): void {
  sheet.views = [{ state: "frozen", xSplit, ySplit, showGridLines: false }];
}
function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}
function columnLetter(col: number): string {
  let out = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

type Context = {
  data: RepVisitsExportData;
  days: string[];
  months: Array<{ month: string; days: string[] }>;
  byDay: Map<string, ExportVisit[]>;
  counts: Map<string, number>;
  colours: Map<string, string>;
  rangeText: string;
};

const colourOf = (ctx: Context, visit: ExportVisit) => repeatColourOf(ctx.colours, ctx.counts, visit);
const visitsOn = (ctx: Context, day: string) => ctx.byDay.get(day) ?? [];
const typeOf = (ctx: Context, day: string) => dayType(day, visitsOn(ctx, day), ctx.data.days, ctx.data.today);
const recordOf = (ctx: Context, day: string) => dayRecord(day, visitsOn(ctx, day), ctx.data.days, ctx.data.today);

// ── Cover ───────────────────────────────────────────────────────────────────────────────────────────

function coverSheet(book: ExcelJS.Workbook, ctx: Context): void {
  const sheet = book.addWorksheet("Cover");
  const { rep } = ctx.data;
  title(sheet, `${rep.name} · visits, bricks and doctors · ${ctx.rangeText}`);
  note(sheet, 2, "Read from Phoenix Workforce on the day the file was made. Salary figures are the employee record's, EGP a month.", 2, 20);
  const age = ageOn(rep.birthDate, ctx.data.today);
  const rows: Array<[string, Value, string?]> = [
    ["Name", rep.name],
    ["Job title", rep.role],
    ["Area", rep.areaName || DASH],
    ["Line", rep.line || DASH],
    ["Hiring date", rep.hireDate ? dateOf(rep.hireDate) : "Not on the record", "d mmmm yyyy"],
    ["Date of birth", rep.birthDate ? dateOf(rep.birthDate) : "Not on the record", "d mmmm yyyy"],
    ["Age", age === null ? "Not on the record" : `${age} years`],
    ["Base salary", rep.salary.base ?? "Not on the record", MONEY],
    ["Basic salary", rep.salary.basic ?? "Not on the record", MONEY],
    ["Gross salary", rep.salary.gross ?? "Not on the record", MONEY],
    ["Net salary", rep.salary.net ?? "Not on the record", MONEY],
    ["Period", `${longDay(ctx.data.from)} to ${longDay(ctx.data.to)}`],
    ["Visits recorded", ctx.data.visits.length],
  ];
  let row = 4;
  for (const [label, value, format] of rows) {
    const a = put(sheet, row, 1, label, RIGHT);
    font(a, { bold: true, color: NAVY, size: 10 });
    fill(a, SHADE_DAY);
    const b = put(sheet, row, 2, value, LEFT);
    font(b, { bold: label === "Name", size: label === "Name" ? 12 : 11 });
    if (format && typeof value !== "string") b.numFmt = format;
    sheet.getRow(row).height = 22;
    row += 1;
  }
  widths(sheet, [22, 48]);
  sheet.views = [{ showGridLines: false }];
  sheet.pageSetup = { ...pageSetup("portrait", 9), fitToHeight: 1 };
}

// ── Daily visits: one column per day ────────────────────────────────────────────────────────────────

const ORDINAL: Record<number, string> = { 1: "1ST PM VISIT SAVE AT TIME", 2: "2ND PM VISIT", 3: "3RD PM VISIT" };

function dailyVisitsSheet(book: ExcelJS.Workbook, ctx: Context): void {
  const sheet = book.addWorksheet("Daily visits");
  const { rep } = ctx.data;
  title(sheet, `${rep.name} · ${rep.role} · ${rep.line} · ${rep.areaName} · visits ${ctx.rangeText}`);
  const intro = sheet.getCell(2, 1);
  intro.value =
    "Times are when each visit was saved, Cairo time; a visit brought over from the old CRM kept no time. A coloured cell is a customer " +
    "visited more than once in that month; every cell in the same colour is the same customer (see the Repeat visits sheet). The last " +
    "row is the day's record from the system. Every visit saved is listed, including visits still waiting for a decision.";
  font(intro, { italic: true, size: 9, color: MUTED });

  const HR = 4;
  const maxPm = Math.max(10, ...[...ctx.byDay.values()].map((visits) => visits.filter((v) => v.list === "PM").length));
  const labels = [
    "AM START TIME",
    "AM END TIME",
    "NUMBER OF AM VISITS",
    "NUMBER OF PM VISITS",
    ...Array.from({ length: maxPm }, (_, k) => ORDINAL[k + 1] ?? String(k + 1)),
    "DAY RECORD",
  ];
  put(sheet, HR, 1, "");
  labels.forEach((label, i) => {
    const cell = put(sheet, HR + 1 + i, 1, label, { horizontal: "right", vertical: "middle" });
    font(cell, { bold: true, color: NAVY, size: 10 });
  });

  const visitCell = (cell: Cell, visit: ExportVisit) => {
    cell.value = `${savedAtText(visit)}\n${visit.customerName}`;
    const colour = colourOf(ctx, visit);
    if (colour) fill(cell, colour);
  };

  ctx.days.forEach((day, index) => {
    const col = index + 2;
    const off = isWeeklyOff(day);
    const top = head(sheet, HR, col, gridDayLabel(day), { bg: off ? SHADE_HEAD : NAVY, fg: off ? NAVY : WHITE, size: 11 });
    top.alignment = CENTRE;
    const visits = visitsOn(ctx, day);
    const am = visits.filter((v) => v.list === "AM");
    const pm = visits.filter((v) => v.list !== "AM");
    const r = HR + 1;
    for (let k = 0; k < labels.length; k += 1) {
      const cell = put(sheet, r + k, col, null);
      if (off) fill(cell, SHADE_OFF);
    }
    if (am.length) {
      visitCell(sheet.getCell(r, col), am[0]);
      visitCell(sheet.getCell(r + 1, col), am[am.length - 1]);
    }
    if (!(off && visits.length === 0) && day <= ctx.data.today) {
      sheet.getCell(r + 2, col).value = am.length;
      sheet.getCell(r + 3, col).value = pm.length;
    }
    for (const k of [2, 3]) font(sheet.getCell(r + k, col), { bold: true, color: NAVY });
    pm.forEach((visit, k) => visitCell(sheet.getCell(r + 4 + k, col), visit));
    const record = sheet.getCell(r + labels.length - 1, col);
    record.value = recordOf(ctx, day).join("\n");
    font(record, { size: 8, italic: true, color: MUTED });
  });

  sheet.getColumn(1).width = 33;
  for (let col = 2; col <= ctx.days.length + 1; col += 1) sheet.getColumn(col).width = 15;
  sheet.getRow(HR).height = 20;
  labels.forEach((label, i) => (sheet.getRow(HR + 1 + i).height = label.startsWith("NUMBER") ? 20 : 34));
  sheet.getRow(HR + labels.length).height = 70;

  // The month summary under the grid.
  const tr = HR + labels.length + 2;
  [...ctx.months.map((m) => monthLabel(m)), "All"].forEach((label, k) => head(sheet, tr, 2 + k, label, { size: 11 }));
  const scopes = [...ctx.months.map((m) => m.month), null];
  const inScope = (month: string | null) => (month ? ctx.data.visits.filter((v) => v.day.startsWith(month)) : ctx.data.visits);
  const rows: Array<[string, (visits: ExportVisit[], month: string | null) => number]> = [
    ["TOTAL AM VISITS", (visits) => visits.filter((v) => v.list === "AM").length],
    ["TOTAL PM VISITS", (visits) => visits.filter((v) => v.list !== "AM").length],
    ["DAYS WITH VISITS", (visits) => new Set(visits.map((v) => v.day)).size],
    [
      "CUSTOMERS SEEN TWICE OR MORE IN THE MONTH",
      (_visits, month) => [...ctx.counts].filter(([key, count]) => count > 1 && (month === null || key.startsWith(month))).length,
    ],
  ];
  rows.forEach(([label, count], i) => {
    const cell = put(sheet, tr + 1 + i, 1, label, RIGHT);
    font(cell, { bold: true, color: NAVY });
    scopes.forEach((month, k) => font(put(sheet, tr + 1 + i, 2 + k, count(inScope(month), month)), { bold: true }));
  });
  sheet.getRow(tr + 4).height = 30;
  frozen(sheet, 1, HR);
  sheet.pageSetup = { ...pageSetup("landscape", 8), fitToHeight: 1, fitToWidth: Math.max(1, Math.ceil(ctx.days.length / 15)), printTitlesColumn: "A:A" };
}

// ── Area bricks: the published closing's sales on each brick, by month ──────────────────────────────

function areaBricksSheet(book: ExcelJS.Workbook, ctx: Context): void {
  const sheet = book.addWorksheet("Area bricks");
  const { rep, brickSales } = ctx.data;
  const months = brickSales.months;
  const lastCol = Math.max(3, months.length + 2);
  title(sheet, `${rep.areaName} · ${rep.line} — sales by brick, from the published Monthly Closing`);
  note(
    sheet,
    2,
    months.length
      ? "Egyptian pounds, from the published Monthly Closing, for the month before the range and each month in it that its line has " +
          "published. A month not published yet has no figure here. A brick's figure is what pharmacies on that brick bought, placed on the " +
          "brick by the customer's address; wholesaler and store sales spread over the area are not tied to one brick and are not in this table."
      : "No month in this range has a published Monthly Closing for this line yet, so there are no brick sales to show.",
    lastCol,
  );
  if (!months.length) {
    widths(sheet, [40, 16, 16]);
    sheet.views = [{ showGridLines: false }];
    sheet.pageSetup = pageSetup("portrait", 9);
    return;
  }
  const H = 4;
  head(sheet, H, 1, "BRICK");
  months.forEach((month, k) => head(sheet, H, 2 + k, longDay(`${month}-01`).split(" ").slice(1).join(" ")));
  head(sheet, H, months.length + 2, "Monthly average");
  sheet.getRow(H).height = 30;

  const doctorsOn = new Map<string, number>();
  for (const doctor of ctx.data.doctors) if (doctor.status === "active" && doctor.brickId) doctorsOn.set(doctor.brickId, (doctorsOn.get(doctor.brickId) ?? 0) + 1);
  const own = brickSales.bricks.filter((brick) => !rep.areaCode || brick.areaCode === rep.areaCode);
  const totals: Record<string, number> = {};
  let row = H + 1;
  for (const brick of own) {
    const label = brick.current ? brick.brickName : `${brick.brickName} (no longer a brick in force)`;
    const cell = put(sheet, row, 1, label, RIGHT);
    font(cell, { color: brick.current ? INK : MUTED });
    let sum = 0;
    months.forEach((month, k) => {
      const value = Math.round(brick.byMonth[month] ?? 0);
      sum += value;
      totals[month] = (totals[month] ?? 0) + value;
      const c = put(sheet, row, 2 + k, value);
      c.numFmt = MONEY;
    });
    const avg = put(sheet, row, months.length + 2, Math.round(sum / months.length));
    avg.numFmt = MONEY;
    font(avg, { bold: true });
    sheet.getRow(row).height = 22;
    row += 1;
  }
  const label = put(sheet, row, 1, `SOLD ON ${rep.areaName.toUpperCase()} BRICKS`, RIGHT);
  font(label, { bold: true, color: NAVY });
  label.border = TOP_RULE;
  let grand = 0;
  months.forEach((month, k) => {
    grand += totals[month] ?? 0;
    const c = put(sheet, row, 2 + k, totals[month] ?? 0);
    c.numFmt = MONEY;
    c.border = TOP_RULE;
    font(c, { bold: true, color: NAVY });
  });
  const avg = put(sheet, row, months.length + 2, Math.round(grand / months.length));
  avg.numFmt = MONEY;
  avg.border = TOP_RULE;
  font(avg, { bold: true, color: NAVY });
  row += 2;
  note(sheet, row, "A dash means no sales that month. Doctors on each brick are counted on the Doctors by brick sheet.", lastCol, 30);
  widths(sheet, [40, ...months.map(() => 16), 16]);
  frozen(sheet, 1, H);
  sheet.pageSetup = { ...pageSetup("portrait", 9), fitToHeight: 1 };
}

// ── Repeat visits ───────────────────────────────────────────────────────────────────────────────────

function repeatVisitsSheet(book: ExcelJS.Workbook, ctx: Context): void {
  const sheet = book.addWorksheet("Repeat visits");
  title(sheet, `Customers visited more than once in the same month, ${ctx.rangeText} — the colour matches the Daily visits sheet`, 12);
  ["Colour", "Month", "Customer", "List", "Speciality", "Visits", "Dates and times"].forEach((h, j) => head(sheet, 3, j + 1, h, { size: 11 }));
  let row = 4;
  for (const month of ctx.months) {
    const seen = new Map<string, ExportVisit>();
    for (const visit of ctx.data.visits) {
      if (visit.day.startsWith(month.month) && repeatCountOf(ctx.counts, visit) > 1 && !seen.has(visit.customerKey)) seen.set(visit.customerKey, visit);
    }
    for (const [key, first] of seen) {
      const visits = ctx.data.visits.filter((v) => v.customerKey === key && v.day.startsWith(month.month));
      const when = visits.map((v) => `${shortDay(v.day)} ${savedAtText(v)}`).join(" · ");
      const values: Value[] = ["", monthLabel(month), first.customerName, first.list, first.speciality ?? "", visits.length, when];
      values.forEach((value, j) => put(sheet, row, j + 1, value, j === 2 || j === 6 ? LEFT : CENTRE));
      const colour = ctx.colours.get(key);
      if (colour) fill(sheet.getCell(row, 1), colour);
      row += 1;
    }
  }
  widths(sheet, [9, 14, 30, 7, 20, 8, 70]);
  frozen(sheet, 0, 3);
  if (row > 4) sheet.autoFilter = `A3:G${row - 1}`;
  sheet.pageSetup = { ...pageSetup("landscape", 9), printTitlesRow: "3:3" };
}

// ── Visits per day: every day of the range ──────────────────────────────────────────────────────────

function visitsPerDaySheet(book: ExcelJS.Workbook, ctx: Context): void {
  const sheet = book.addWorksheet("Visits per day");
  title(sheet, `Visits per day, AM and PM, with each day's record · ${ctx.rangeText}`, 12);
  ["Date", "Day", "AM", "PM", "Total", "Day type", "Day record"].forEach((h, j) => head(sheet, 3, j + 1, h, { size: 11 }));
  let row = 4;
  const totalRow = (values: Value[], grand: boolean) => {
    values.forEach((value, j) => {
      const cell = put(sheet, row, j + 1, value, j < 5 ? CENTRE : LEFT);
      cell.border = TOP_RULE;
      font(cell, { bold: true, color: NAVY, size: grand ? 11 : 11 });
      if (grand) fill(cell, SHADE_HEAD);
    });
    row += 1;
  };
  for (const month of ctx.months) {
    for (const day of month.days) {
      const visits = visitsOn(ctx, day);
      const am = visits.filter((v) => v.list === "AM").length;
      const type = typeOf(ctx, day);
      const record = recordOf(ctx, day).join(" · ");
      const values: Value[] = [dateOf(day), weekdayShort(day), am, visits.length - am, visits.length, type, record];
      const off = isWeeklyOff(day);
      values.forEach((value, j) => {
        const cell = put(sheet, row, j + 1, value, j >= 5 ? LEFT : CENTRE);
        if (off) fill(cell, SHADE_OFF);
        if (j >= 2 && j <= 4 && value === 0) font(cell, { color: MUTED });
      });
      sheet.getCell(row, 1).numFmt = "d-mmm-yyyy";
      font(sheet.getCell(row, 5), { bold: true, color: visits.length ? NAVY : MUTED });
      font(sheet.getCell(row, 6), { bold: true, size: 9, color: isConcernDayType(type) ? RED : visits.length ? GREEN : MUTED });
      font(sheet.getCell(row, 7), { size: 9, color: MUTED });
      sheet.getRow(row).height = record.length < 70 ? 18 : 30;
      row += 1;
    }
    const visits = ctx.data.visits.filter((v) => v.day.startsWith(month.month));
    const am = visits.filter((v) => v.list === "AM").length;
    const withVisits = new Set(visits.map((v) => v.day)).size;
    totalRow([`${monthLabel(month)} total`, "", am, visits.length - am, visits.length, `${withVisits} days with visits of ${month.days.length}`, ""], false);
  }
  const am = ctx.data.visits.filter((v) => v.list === "AM").length;
  const withVisits = new Set(ctx.data.visits.map((v) => v.day)).size;
  totalRow(["Grand Total", "", am, ctx.data.visits.length - am, ctx.data.visits.length, `${withVisits} days with visits of ${ctx.days.length}`, ""], true);
  widths(sheet, [14, 6, 6, 6, 7, 24, 70]);
  frozen(sheet, 0, 3);
  sheet.pageSetup = { ...pageSetup("portrait", 9), printTitlesRow: "3:3" };
}

// ── All visits, and the visit columns Every day repeats ────────────────────────────────────────────

const VISIT_HEADERS = [
  "Date",
  "Day",
  "Saved at",
  "List",
  "Customer",
  "Speciality",
  "Grade",
  "Brick",
  "Visit type",
  "Out of plan",
  "Metres from the place",
  "Location check",
  "Where it was recorded",
  "Repeat in the month",
];

function visitValues(ctx: Context, visit: ExportVisit): Value[] {
  const repeat = repeatCountOf(ctx.counts, visit);
  return [
    dateOf(visit.day),
    weekdayShort(visit.day),
    savedAtText(visit),
    visit.list,
    visit.customerName,
    visit.speciality ?? "",
    visit.grade ?? DASH,
    visit.brickName ?? "No brick yet",
    visitKindLabel(visit.kind),
    visit.unplanned ? "Yes" : "No",
    visit.distanceMeters ?? "Not measured",
    locationLabel(visit.locationFlag),
    visit.copiedFromOldCrm ? "Old CRM" : "Phoenix",
    repeat > 1 ? `Yes · ${repeat} visits` : "",
  ];
}

/** Colours and flags on a visit row; `at` maps a visit column (0-based, as in VISIT_HEADERS) to the sheet's column. */
function markVisit(sheet: ExcelJS.Worksheet, row: number, ctx: Context, visit: ExportVisit, at: (index: number) => number): void {
  const colour = colourOf(ctx, visit);
  if (colour) {
    fill(sheet.getCell(row, at(4)), colour);
    fill(sheet.getCell(row, at(13)), colour);
  }
  if (visit.locationFlag === "far") font(sheet.getCell(row, at(11)), { bold: true, color: RED });
  else if (visit.locationFlag === "no_place") font(sheet.getCell(row, at(11)), { color: AMBER });
  if (visit.unplanned) font(sheet.getCell(row, at(9)), { bold: true, color: AMBER });
  if (visit.copiedFromOldCrm) font(sheet.getCell(row, at(12)), { color: MUTED });
}

function allVisitsSheet(book: ExcelJS.Workbook, ctx: Context): void {
  const sheet = book.addWorksheet("All visits");
  VISIT_HEADERS.forEach((h, j) => head(sheet, 1, j + 1, h, { size: 9 }));
  sheet.getRow(1).height = 30;
  ctx.data.visits.forEach((visit, index) => {
    const row = index + 2;
    visitValues(ctx, visit).forEach((value, j) => put(sheet, row, j + 1, value, j === 4 || j === 5 ? LEFT : CENTRE));
    sheet.getCell(row, 1).numFmt = "d-mmm";
    markVisit(sheet, row, ctx, visit, (i) => i + 1);
  });
  widths(sheet, [9, 6, 9, 6, 28, 18, 6, 14, 15, 8, 11, 18, 11, 13]);
  frozen(sheet, 0, 1);
  sheet.autoFilter = `A1:${columnLetter(VISIT_HEADERS.length)}${Math.max(2, ctx.data.visits.length + 1)}`;
  sheet.pageSetup = { ...pageSetup("landscape", 9), printTitlesRow: "1:1" };
}

// ── Every day: the Excel table ──────────────────────────────────────────────────────────────────────

export const EVERY_DAY_HEADERS = [
  "Date",
  "Day",
  "Month",
  "Row",
  "Visits",
  "Saved at or day start",
  "List",
  "Customer",
  "Speciality",
  "Grade",
  "Brick",
  "Visit type",
  "Out of plan",
  "Metres from the place",
  "Location check",
  "Where it was recorded",
  "Repeat in the month",
  "Day type",
  "Day record",
] as const;

export function everyDayRows(data: RepVisitsExportData): Value[][] {
  return buildEveryDay(contextOf(data)).map((entry) => entry.values);
}

type EveryDayRow = { values: Value[]; day: string; visit: ExportVisit | null };

function buildEveryDay(ctx: Context): EveryDayRow[] {
  const out: EveryDayRow[] = [];
  for (const day of ctx.days) {
    const visits = visitsOn(ctx, day);
    const type = typeOf(ctx, day);
    const record = recordOf(ctx, day).join(" · ");
    const monthFirst = dateOf(`${day.slice(0, 7)}-01`);
    const am = visits.filter((v) => v.list === "AM").length;
    out.push({
      day,
      visit: null,
      values: [
        dateOf(day),
        weekdayShort(day),
        monthFirst,
        "Day record",
        0,
        ctx.data.days.starts.get(day) ?? "",
        "",
        visits.length ? `${visits.length} visits · AM ${am} · PM ${visits.length - am}` : "No visits",
        "",
        "",
        "",
        "",
        "",
        null,
        "",
        "",
        "",
        type,
        record,
      ],
    });
    for (const visit of visits) {
      const v = visitValues(ctx, visit);
      out.push({ day, visit, values: [...v.slice(0, 2), monthFirst, "Visit", 1, ...v.slice(2), type, record] });
    }
  }
  return out;
}

function everyDaySheet(book: ExcelJS.Workbook, ctx: Context): void {
  const sheet = book.addWorksheet("Every day");
  const rows = buildEveryDay(ctx);
  sheet.addTable({
    name: "EveryDay",
    ref: "A1",
    headerRow: true,
    totalsRow: false,
    style: { theme: "TableStyleLight1", showRowStripes: false, showColumnStripes: false },
    columns: EVERY_DAY_HEADERS.map((name) => ({ name, filterButton: true })),
    rows: rows.map((entry) => entry.values),
  });
  EVERY_DAY_HEADERS.forEach((_, j) => {
    const cell = sheet.getCell(1, j + 1);
    cell.border = BOX;
    cell.alignment = CENTRE;
    fill(cell, NAVY);
    font(cell, { bold: true, color: WHITE, size: 9 });
  });
  sheet.getRow(1).height = 30;
  rows.forEach((entry, index) => {
    const row = index + 2;
    const off = isWeeklyOff(entry.day);
    for (let col = 1; col <= EVERY_DAY_HEADERS.length; col += 1) {
      const cell = sheet.getCell(row, col);
      cell.border = BOX;
      if (entry.visit) {
        cell.alignment = col === 8 || col === 9 || col === 19 ? LEFT : CENTRE;
      } else {
        cell.alignment = col === 8 || col === 18 || col === 19 ? LEFT : CENTRE;
        fill(cell, off ? SHADE_OFF : SHADE_DAY);
        font(cell, { bold: true, color: NAVY, size: 9 });
      }
    }
    sheet.getCell(row, 1).numFmt = "d-mmm-yyyy";
    sheet.getCell(row, 3).numFmt = "mmm yyyy";
    const type = String(entry.values[17]);
    if (entry.visit) {
      markVisit(sheet, row, ctx, entry.visit, (i) => (i < 2 ? i + 1 : i + 4));
      for (const col of [4, 16, 18, 19]) font(sheet.getCell(row, col), { size: 8, color: MUTED });
    } else {
      const hasVisits = visitsOn(ctx, entry.day).length > 0;
      font(sheet.getCell(row, 8), { bold: true, size: 9, color: hasVisits ? NAVY : RED });
      font(sheet.getCell(row, 18), { bold: true, size: 9, color: isConcernDayType(type) ? RED : hasVisits ? GREEN : MUTED });
      font(sheet.getCell(row, 19), { size: 9, color: NAVY });
    }
  });
  widths(sheet, [12, 6, 9, 10, 7, 10, 5, 28, 18, 6, 13, 15, 8, 10, 17, 11, 12, 20, 55]);
  frozen(sheet, 0, 1);
  sheet.pageSetup = { ...pageSetup("landscape", 9), printTitlesRow: "1:1" };
}

// ── Doctors by brick, and the doctor list ───────────────────────────────────────────────────────────

const STANDING_COLOUR: Record<Standing, string> = { "Not visited": RED, Behind: AMBER, "On number": GREEN, Over: MUTED, Visited: GREEN };

function monthVisits(ctx: Context): Map<string, number> {
  const out = new Map<string, number>();
  for (const visit of ctx.data.visits) {
    const key = `${visit.customerKey}|${visit.day.slice(0, 7)}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

function gradeNumbersText(ctx: Context): string {
  const parts: string[] = [];
  for (const list of ["PM", "AM", "Pharmacy"]) {
    const grades = ctx.data.gradeTargets[list];
    if (!grades) continue;
    const named = Object.entries(grades)
      .filter(([, n]) => typeof n === "number" && n > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([grade, n]) => `grade ${grade} ${n}`);
    if (named.length) parts.push(`${list} ${named.join(", ")}`);
  }
  return parts.length ? parts.join("; ") : "none is set";
}

type BrickLine = { brickId: string | null; brickName: string; areaCode: string | null; areaName: string };

function brickLines(ctx: Context, approved: ExportDoctor[]): BrickLine[] {
  const { rep, brickSales } = ctx.data;
  const lines = new Map<string, BrickLine>();
  const areaNameOf = (code: string | null, name: string | null) =>
    code && rep.areaCode && code === rep.areaCode ? `${rep.areaName} (the rep's area)` : (name ?? code ?? "No area");
  for (const doctor of approved) {
    const key = doctor.brickId ?? "none";
    if (!lines.has(key)) {
      lines.set(key, {
        brickId: doctor.brickId,
        brickName: doctor.brickName ?? "No brick yet",
        areaCode: doctor.areaCode,
        areaName: areaNameOf(doctor.areaCode, doctor.areaName),
      });
    }
  }
  for (const brick of brickSales.bricks) {
    if (!brick.current || lines.has(brick.brickId) || (rep.areaCode && brick.areaCode !== rep.areaCode)) continue;
    lines.set(brick.brickId, { brickId: brick.brickId, brickName: brick.brickName, areaCode: brick.areaCode, areaName: areaNameOf(brick.areaCode, null) });
  }
  const count = (line: BrickLine) => approved.filter((d) => (d.brickId ?? "none") === (line.brickId ?? "none")).length;
  const own = (line: BrickLine) => (rep.areaCode && line.areaCode === rep.areaCode ? 0 : 1);
  return [...lines.values()].sort((a, b) => own(a) - own(b) || count(b) - count(a) || a.brickName.localeCompare(b.brickName));
}

function doctorsByBrickSheet(book: ExcelJS.Workbook, ctx: Context): void {
  const sheet = book.addWorksheet("Doctors by brick");
  const { rep, brickSales } = ctx.data;
  const months = ctx.months;
  const salesMonths = brickSales.months;
  const approved = ctx.data.doctors.filter((d) => d.status === "active");
  const visits = monthVisits(ctx);
  const ncol = 6 + 4 * months.length + salesMonths.length;
  const salesOf = new Map(brickSales.bricks.map((b) => [b.brickId, b.byMonth]));

  title(sheet, `${rep.name} · the doctor list by brick, and how it is covered each month`);
  const partMonths = months.filter((m) => /\d/.test(monthLabel(m)));
  note(
    sheet,
    2,
    `The approved list is ${approved.length} doctors and hospitals, each on the brick of its validated place. The company's monthly visit ` +
      `number: ${gradeNumbersText(ctx)}; a grade with no number counts as covered after one visit. ` +
      (partMonths.length ? `${partMonths.map((m) => monthLabel(m)).join(" and ")} ${partMonths.length > 1 ? "are part months" : "is a part month"}, read against the full monthly number. ` : "") +
      (salesMonths.length ? "Brick sales are from the published closing, in EGP." : "No month has a published closing yet, so there are no brick sales."),
    Math.max(ncol, 2),
  );

  const HR1 = 4;
  const HR2 = 5;
  const groups: Array<[number, number, string]> = [
    [1, 2, "BRICK"],
    [3, 6, "APPROVED DOCTORS"],
  ];
  months.forEach((m, k) => groups.push([7 + 4 * k, 10 + 4 * k, monthLabel(m).toUpperCase()]));
  if (salesMonths.length) groups.push([ncol - salesMonths.length + 1, ncol, "BRICK SALES (EGP)"]);
  for (const [c1, c2, label] of groups) {
    head(sheet, HR1, c1, label, { size: 9 });
    for (let c = c1 + 1; c <= c2; c += 1) head(sheet, HR1, c, "", { size: 9 });
    if (c2 > c1) sheet.mergeCells(HR1, c1, HR1, c2);
  }
  const subs = [
    "Brick",
    "Territory",
    "AM",
    "PM",
    "Grade A",
    "Grade B",
    ...months.flatMap(() => ["On number or over", "Behind", "Not visited", "Covered"]),
    ...salesMonths.map((m) => longDay(`${m}-01`).split(" ")[1]),
  ];
  subs.forEach((s, j) => head(sheet, HR2, j + 1, s, { bg: SHADE_HEAD, fg: NAVY, size: 9 }));
  sheet.getRow(HR2).height = 30;

  type Tally = { n: number; am: number; pm: number; ga: number; gb: number; on: number[]; behind: number[]; none: number[] };
  const blank = (): Tally => ({ n: 0, am: 0, pm: 0, ga: 0, gb: 0, on: months.map(() => 0), behind: months.map(() => 0), none: months.map(() => 0) });
  const ownTally = blank();
  const otherTally = blank();
  const allTally = blank();

  const writeCounts = (row: number, values: Value[], n: number, total: boolean) => {
    values.forEach((value, j) => {
      const cell = put(sheet, row, j + 1, value);
      if (total) {
        cell.border = TOP_RULE;
        font(cell, { bold: true, color: j === 0 ? NAVY : INK });
      }
    });
    months.forEach((_, k) => {
      const c0 = 7 + 4 * k;
      const covered = sheet.getCell(row, c0 + 3);
      if (covered.value === null || n === 0) {
        covered.value = DASH;
        font(covered, { color: MUTED });
      } else {
        covered.numFmt = "0%";
        const share = Number(covered.value);
        font(covered, { bold: true, color: share >= 0.8 ? GREEN : share >= 0.5 ? AMBER : RED });
      }
      if (!total) {
        if (sheet.getCell(row, c0 + 1).value) font(sheet.getCell(row, c0 + 1), { bold: true, color: AMBER });
        if (sheet.getCell(row, c0 + 2).value) font(sheet.getCell(row, c0 + 2), { bold: true, color: RED });
      }
    });
  };

  let row = HR2 + 1;
  const lines = brickLines(ctx, approved);
  for (const line of lines) {
    const doctors = approved.filter((d) => (d.brickId ?? "none") === (line.brickId ?? "none"));
    const tallies = [allTally, rep.areaCode && line.areaCode === rep.areaCode ? ownTally : otherTally];
    const values: Value[] = [
      line.brickName,
      line.areaName,
      doctors.filter((d) => d.list === "AM").length,
      doctors.filter((d) => d.list === "PM").length,
      doctors.filter((d) => d.grade === "A").length,
      doctors.filter((d) => d.grade === "B").length,
    ];
    for (const t of tallies) {
      t.n += doctors.length;
      t.am += Number(values[2]);
      t.pm += Number(values[3]);
      t.ga += Number(values[4]);
      t.gb += Number(values[5]);
    }
    months.forEach((m, k) => {
      const standings = doctors.map((d) => standing(visits.get(`${d.customerKey}|${m.month}`) ?? 0, monthlyNumber(ctx.data.gradeTargets, d)));
      const on = standings.filter(isCovered).length;
      const behind = standings.filter((s) => s === "Behind").length;
      const none = standings.filter((s) => s === "Not visited").length;
      values.push(on, behind, none, doctors.length ? on / doctors.length : null);
      for (const t of tallies) {
        t.on[k] += on;
        t.behind[k] += behind;
        t.none[k] += none;
      }
    });
    const sales = line.brickId ? salesOf.get(line.brickId) : undefined;
    for (const month of salesMonths) values.push(Math.round(sales?.[month] ?? 0));
    writeCounts(row, values, doctors.length, false);
    const brickCell = sheet.getCell(row, 1);
    font(brickCell, { bold: true, color: NAVY });
    brickCell.alignment = RIGHT;
    font(sheet.getCell(row, 2), { size: 8, color: rep.areaCode && line.areaCode !== rep.areaCode ? RED : MUTED });
    for (let j = 3; j <= 6 + 4 * months.length; j += 1) {
      const cell = sheet.getCell(row, j);
      if (cell.value === 0) {
        cell.value = DASH;
        font(cell, { color: MUTED });
      }
    }
    for (let j = ncol - salesMonths.length + 1; j <= ncol; j += 1) sheet.getCell(row, j).numFmt = MONEY;
    if (!doctors.length && 6 + 4 * months.length > 3) {
      for (let j = 3; j <= 6 + 4 * months.length; j += 1) sheet.getCell(row, j).value = null;
      const none = sheet.getCell(row, 3);
      none.value = "no approved doctor on this brick";
      font(none, { size: 8, bold: true, color: RED });
      sheet.mergeCells(row, 3, row, 6 + 4 * months.length);
    }
    sheet.getRow(row).height = 20;
    row += 1;
  }

  const totalRow = (label: string, t: Tally) => {
    const values: Value[] = [label, "", t.am, t.pm, t.ga, t.gb];
    months.forEach((_, k) => values.push(t.on[k], t.behind[k], t.none[k], t.n ? t.on[k] / t.n : null));
    for (let j = 0; j < salesMonths.length; j += 1) values.push(null);
    writeCounts(row, values, t.n, true);
    sheet.getCell(row, 1).alignment = RIGHT;
    sheet.mergeCells(row, 1, row, 2);
    sheet.getRow(row).height = 22;
    row += 1;
  };
  if (otherTally.n > 0) {
    totalRow(`ON ${rep.areaName.toUpperCase()} BRICKS`, ownTally);
    totalRow("ON OTHER AREAS' BRICKS", otherTally);
  }
  totalRow(`ALL ${approved.length} APPROVED`, allTally);
  row += 1;

  const plain = (label: string, text: string) => {
    const a = put(sheet, row, 1, label, { horizontal: "right", vertical: "top", wrapText: true });
    font(a, { bold: true, color: NAVY });
    const b = put(sheet, row, 2, text, { wrapText: true, vertical: "top" });
    if (ncol > 2) {
      for (let c = 3; c <= ncol; c += 1) sheet.getCell(row, c).border = BOX;
      sheet.mergeCells(row, 2, row, ncol);
    }
    void b;
    sheet.getRow(row).height = 30;
    row += 1;
  };
  const pending = ctx.data.doctors.filter((d) => d.status === "pending");
  const outside = ctx.data.doctors.filter((d) => d.status === "outside");
  const seen = (d: ExportDoctor, month: string) => (visits.get(`${d.customerKey}|${month}`) ?? 0) > 0;
  plain(
    "NOT VALIDATED YET",
    pending.length
      ? `${pending.length} more doctors are still waiting for their place to be validated, so they have no brick yet ` +
          `(${pending.filter((d) => d.list === "AM").length} AM, ${pending.filter((d) => d.list === "PM").length} PM; ` +
          `${pending.filter((d) => d.grade === "A").length} grade A). Visited: ` +
          months.map((m) => `${pending.filter((d) => seen(d, m.month)).length} in ${monthLabel(m)}`).join(", ") +
          `; ${pending.filter((d) => months.every((m) => !seen(d, m.month))).length} never visited in the range.`
      : "None.",
  );
  plain(
    "OUTSIDE THE LIST",
    outside.length
      ? `${outside.length} doctors met and validated at the door, waiting to be admitted to the list (${outside.map((d) => d.name).join(", ")}).`
      : "None.",
  );
  row += 1;

  const findings: string[] = [];
  if (approved.length) {
    if (otherTally.n > 0) {
      findings.push(
        `${otherTally.n} of the ${approved.length} approved doctors (${Math.floor((otherTally.n * 100) / approved.length)}%) sit on bricks of another area, ` +
          `so their sales are not in ${rep.areaName}'s closing figure.`,
      );
    }
    const empty = lines.filter((l) => rep.areaCode && l.areaCode === rep.areaCode && !approved.some((d) => d.brickId === l.brickId));
    const lastSales = salesMonths[salesMonths.length - 1];
    if (lastSales) {
      const top = [...brickSales.bricks]
        .filter((b) => !rep.areaCode || b.areaCode === rep.areaCode)
        .sort((a, b) => (b.byMonth[lastSales] ?? 0) - (a.byMonth[lastSales] ?? 0))[0];
      if (top && (top.byMonth[lastSales] ?? 0) > 0 && !approved.some((d) => d.brickId === top.brickId)) {
        findings.push(`${top.brickName}, the brick that sold most in ${longDay(`${lastSales}-01`).split(" ")[1]} (${Math.round(top.byMonth[lastSales] ?? 0).toLocaleString("en-US")} EGP), has no approved doctor.`);
      }
    }
    if (empty.length) findings.push(`Bricks of ${rep.areaName} with no approved doctor: ${empty.map((l) => l.brickName).join("، ")}.`);
    findings.push(
      "Covered: " + months.map((m, k) => `${monthLabel(m)} ${allTally.on[k]} of ${approved.length} (${Math.floor((allTally.on[k] * 100) / approved.length)}%)`).join("; ") + ".",
    );
  }
  if (findings.length) {
    font(Object.assign(sheet.getCell(row, 1), { value: "WHAT IT SHOWS" }), { bold: true, color: NAVY, size: 11 });
    row += 1;
    for (const finding of findings) {
      const cell = sheet.getCell(row, 1);
      cell.value = `◆  ${finding}`;
      font(cell, { size: 10 });
      cell.alignment = { wrapText: true, vertical: "top" };
      if (ncol > 1) sheet.mergeCells(row, 1, row, ncol);
      sheet.getRow(row).height = 30;
      row += 1;
    }
  }
  widths(sheet, [16, 17, 7, 7, 7, 7, ...months.flatMap(() => [9, 9, 9, 9]), ...salesMonths.map(() => 10)]);
  frozen(sheet, 2, HR2);
  sheet.pageSetup = { ...pageSetup("landscape", 8), fitToHeight: 1 };
}

const STATUS_LABEL: Record<ExportDoctor["status"], string> = {
  active: "Approved",
  pending: "Not validated yet",
  outside: "Outside, waiting to be admitted",
};

function doctorListSheet(book: ExcelJS.Workbook, ctx: Context): void {
  const sheet = book.addWorksheet("Doctor list");
  const { rep } = ctx.data;
  const months = ctx.months;
  const visits = monthVisits(ctx);
  const lastVisit = new Map<string, string>();
  for (const visit of ctx.data.visits) lastVisit.set(visit.customerKey, visit.day);
  const headers = ["Brick", "Territory", "List", "Grade", "Doctor or hospital", "Speciality", "Status", "Monthly number"];
  for (const m of months) headers.push(`Visits ${monthLabel(m, true)}`, monthLabel(m, true));
  headers.push("Last visit");
  headers.forEach((h, j) => head(sheet, 1, j + 1, h, { size: 9 }));
  sheet.getRow(1).height = 30;

  const approved = ctx.data.doctors.filter((d) => d.status === "active");
  const brickOrder = new Map(brickLines(ctx, approved).map((line, index) => [line.brickId ?? "none", index]));
  const statusOrder = { active: 0, outside: 1, pending: 2 } as const;
  const doctors = [...ctx.data.doctors].sort(
    (a, b) =>
      statusOrder[a.status] - statusOrder[b.status] ||
      (brickOrder.get(a.brickId ?? "none") ?? 99) - (brickOrder.get(b.brickId ?? "none") ?? 99) ||
      a.list.localeCompare(b.list) ||
      (a.grade ?? "Z").localeCompare(b.grade ?? "Z") ||
      a.name.localeCompare(b.name),
  );
  doctors.forEach((doctor, index) => {
    const row = index + 2;
    const need = doctor.status === "active" ? monthlyNumber(ctx.data.gradeTargets, doctor) : null;
    const last = lastVisit.get(doctor.customerKey);
    const otherArea = Boolean(rep.areaCode && doctor.areaCode && doctor.areaCode !== rep.areaCode);
    const values: Value[] = [
      doctor.brickName ?? "No brick yet",
      doctor.areaCode ? (doctor.areaCode === rep.areaCode ? `${rep.areaName} (the rep's area)` : (doctor.areaName ?? doctor.areaCode)) : DASH,
      doctor.list,
      doctor.grade ?? DASH,
      doctor.name,
      doctor.speciality ?? "",
      STATUS_LABEL[doctor.status],
      need ?? DASH,
    ];
    const standings: Standing[] = [];
    for (const m of months) {
      const count = visits.get(`${doctor.customerKey}|${m.month}`) ?? 0;
      const value = doctor.status === "active" ? standing(count, need) : count ? "Visited" : "Not visited";
      values.push(count, value);
      standings.push(value);
    }
    values.push(last ? dateOf(last) : "Never");
    values.forEach((value, j) => put(sheet, row, j + 1, value, j === 4 || j === 5 ? LEFT : CENTRE));
    const lastCell = sheet.getCell(row, values.length);
    if (last) lastCell.numFmt = "d mmm yyyy";
    else font(lastCell, { bold: true, color: RED });
    standings.forEach((value, k) => {
      font(sheet.getCell(row, 10 + 2 * k), { bold: true, size: 9, color: STANDING_COLOUR[value] ?? MUTED });
      if (sheet.getCell(row, 9 + 2 * k).value === 0) font(sheet.getCell(row, 9 + 2 * k), { color: MUTED });
    });
    font(sheet.getCell(row, 2), { size: 9, color: otherArea ? RED : MUTED });
    if (doctor.status !== "active") font(sheet.getCell(row, 7), { size: 9, color: AMBER });
  });
  widths(sheet, [13, 18, 5, 6, 28, 18, 16, 9, ...months.flatMap(() => [7, 11]), 12]);
  frozen(sheet, 0, 1);
  sheet.autoFilter = `A1:${columnLetter(headers.length)}${Math.max(2, doctors.length + 1)}`;
  sheet.pageSetup = { ...pageSetup("landscape", 9), printTitlesRow: "1:1" };
}

// ── The book ────────────────────────────────────────────────────────────────────────────────────────

function pageSetup(orientation: "portrait" | "landscape", paperSize: number): Partial<ExcelJS.PageSetup> {
  return {
    orientation,
    paperSize: paperSize as ExcelJS.PageSetup["paperSize"],
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
  };
}

function contextOf(data: RepVisitsExportData): Context {
  const visits = [...data.visits].sort((a, b) => a.day.localeCompare(b.day) || (a.time ?? "").localeCompare(b.time ?? ""));
  const sorted = { ...data, visits };
  const from = longDay(data.from).split(" ");
  const to = longDay(data.to);
  return {
    data: sorted,
    days: daysBetween(data.from, data.to),
    months: monthsOfRange(data.from, data.to),
    byDay: visitsByDay(visits),
    counts: repeatCounts(visits),
    colours: repeatColours(visits),
    rangeText: `${from[0]} ${from[1]}${data.from.slice(0, 4) === data.to.slice(0, 4) ? "" : ` ${from[2]}`} – ${to}`,
  };
}

export async function buildRepVisitsWorkbook(data: RepVisitsExportData): Promise<Buffer> {
  const ctx = contextOf(data);
  const book = new ExcelJS.Workbook();
  book.creator = "Phoenix Workforce";
  book.created = new Date();
  coverSheet(book, ctx);
  dailyVisitsSheet(book, ctx);
  areaBricksSheet(book, ctx);
  repeatVisitsSheet(book, ctx);
  visitsPerDaySheet(book, ctx);
  allVisitsSheet(book, ctx);
  everyDaySheet(book, ctx);
  doctorsByBrickSheet(book, ctx);
  doctorListSheet(book, ctx);
  for (const sheet of book.worksheets) {
    if (!sheet.views?.length) sheet.views = [{ showGridLines: false }];
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

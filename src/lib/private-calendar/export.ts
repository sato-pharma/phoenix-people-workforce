import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import type { PrivateCalendarEmployeeOption, PrivateCalendarSeverity, PrivateCalendarWorkspace } from "@/lib/private-calendar/logic";
import { privateCalendarItemOccursOn, privateCalendarSourceLabels } from "@/lib/private-calendar/logic";

// Phoenix-identity export for the private calendar.
// Every calendar day of the month gets exactly one row in a single table — never
// split across a separate "Exceptions" table/sheet — so an employee's whole month
// reads as one clear, continuous list. Days with no recognized item fall back to
// that day's exception (if any) or a plain "-" (non-workday / nothing to report).
// Columns: Date · Day · [Employee, team exports only] · Source · Activity · Status · Time · Detail
//
// This module holds no filter rules of its own: it renders exactly the items and exceptions the
// workspace carries, and re-deriving the screen's filter predicate here would be a second copy of
// it, free to drift from the one the calendar applies.
//
// KNOWN GAP, not fixed here: the caller does not hand it a filtered workspace either. The export
// link in src/components/employee-portal/private-calendar.tsx passes only year/month/employeeHrId/
// view/actualOnly, while source, status, employee, department, line, exception-only, the search
// box and the hidden-source toggles all live in client state and never reach
// /api/private-calendar/export. So the sheet is always the UNFILTERED month. Closing that means
// carrying those filters on the export URL and applying them where the workspace is built — a
// change to the component and the route, not to this file.

const X = {
  slate900: "FF0F172A",
  slate700: "FF334155",
  slate500: "FF64748B",
  slate200: "FFE2E8F0",
  slate50: "FFF8FAFC",
  white: "FFFFFFFF",
  orange500: "FFF97316",
  orange100: "FFFFEDD5",
  orangeLine: "FFF8B56B",
  emerald: "FFECFDF5",
  emeraldText: "FF047857",
  amber: "FFFFFBEB",
  amberText: "FFB45309",
  red: "FFFEF2F2",
  redText: "FFB91C1C",
  sky: "FFF0F9FF",
  skyText: "FF0369A1",
} as const;

function fill(color: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb: color } };
}

function thinGrid(): ExcelJS.Borders {
  const side = { style: "thin" as const, color: { argb: X.orangeLine } };
  return { top: side, left: side, bottom: side, right: side } as ExcelJS.Borders;
}

function severityFill(severity: string): { fill: string; text: string } {
  if (severity === "danger") return { fill: X.red, text: X.redText };
  if (severity === "warning") return { fill: X.amber, text: X.amberText };
  if (severity === "success") return { fill: X.emerald, text: X.emeraldText };
  if (severity === "neutral") return { fill: X.slate50, text: X.slate500 };
  return { fill: X.sky, text: X.skyText };
}

function compact(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function asciiSafe(v: unknown): string {
  return compact(v)
    .replace(/[•·]/g, "-").replace(/[—–]/g, "-").replace(/…/g, "...").replace(/[""]/g, '"')
    .replace(/['']/g, "'").replace(/[^\x20-\x7E]/g, "");
}

function formatDayDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}

function formatDayName(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" }).format(d);
}

function formatStamp(date: Date): string {
  return date.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

type ExportDayRow = {
  date: string;
  dayLabel: string;
  detail: string;
  employeeHrId: string;
  employeeName: string;
  severity: PrivateCalendarSeverity | "neutral";
  source: string;
  status: string;
  time: string;
  title: string;
};

function monthDatesFromWeeks(weeks: PrivateCalendarWorkspace["weeks"]): string[] {
  const dates = new Set<string>();
  for (const week of weeks) {
    for (const cell of week) {
      if (cell.inMonth && cell.date) dates.add(cell.date);
    }
  }
  return Array.from(dates).sort();
}

function exportEmployees(workspace: PrivateCalendarWorkspace): PrivateCalendarEmployeeOption[] {
  if (workspace.viewMode === "team" && workspace.teamSummary.length > 0) {
    return [...workspace.teamSummary].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
  return [workspace.selectedEmployee];
}

// One row per calendar day per employee — every day of the month is represented,
// not just days with a recognized item, and exceptions are folded straight into
// that day's row instead of living in a separate table.
//
// Day membership goes through privateCalendarItemOccursOn, the same start..end test the on-screen
// month grid uses, so a multi-day item lands on every day it covers. Matching on startDate alone put
// a 4-day vacation or a multi-day Eid on its first day only and left the remaining days reading "-",
// i.e. "nothing to report" — and this sheet is the artifact HR keeps.
function buildExportRows(workspace: PrivateCalendarWorkspace): ExportDayRow[] {
  const dates = monthDatesFromWeeks(workspace.weeks);
  const employees = exportEmployees(workspace);
  const multiEmployee = employees.length > 1;
  const rows: ExportDayRow[] = [];

  for (const employee of employees) {
    for (const date of dates) {
      const dayItems = workspace.items.filter(
        (item) => privateCalendarItemOccursOn(item, date) && (!multiEmployee || item.employeeHrId === employee.hrId),
      );
      const dayExceptions = workspace.exceptions.filter(
        (exception) => exception.date === date && (!multiEmployee || exception.employeeHrId === employee.hrId),
      );

      if (dayItems.length > 0) {
        rows.push({
          date,
          dayLabel: formatDayName(date),
          detail: dayItems
            .map((item) => [compact(item.description), ...item.detailLines].filter(Boolean).join(" . "))
            .filter(Boolean)
            .join(" || "),
          employeeHrId: employee.hrId,
          employeeName: employee.fullName,
          severity: dayItems.some((item) => item.severity === "danger")
            ? "danger"
            : dayItems.some((item) => item.severity === "warning")
              ? "warning"
              : dayItems[0].severity,
          source: dayItems.map((item) => privateCalendarSourceLabels[item.source] ?? item.source).join(" + "),
          status: dayItems.map((item) => compact(item.status ?? "")).filter(Boolean).join(" | "),
          time: dayItems.map((item) => compact(item.time ?? "")).filter(Boolean).join(" | "),
          title: dayItems.map((item) => compact(item.title)).join(" | "),
        });
        continue;
      }

      if (dayExceptions.length > 0) {
        rows.push({
          date,
          dayLabel: formatDayName(date),
          detail: dayExceptions.map((exception) => compact(exception.description)).join(" || "),
          employeeHrId: employee.hrId,
          employeeName: employee.fullName,
          severity: dayExceptions[0].severity,
          source: "-",
          status: "",
          time: "",
          title: dayExceptions.map((exception) => compact(exception.title)).join(" | "),
        });
        continue;
      }

      rows.push({
        date,
        dayLabel: formatDayName(date),
        detail: "",
        employeeHrId: employee.hrId,
        employeeName: employee.fullName,
        severity: "neutral",
        source: "-",
        status: "",
        time: "",
        title: "-",
      });
    }
  }

  return rows;
}

export async function buildPrivateCalendarWorkbook(
  workspace: PrivateCalendarWorkspace,
  generatedAt: Date = new Date(),
): Promise<ExcelJS.Buffer> {
  const { summary, selectedEmployee, year, month } = workspace;
  const monthLabel = new Date(Date.UTC(year, month - 1, 1))
    .toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });
  const rows = buildExportRows(workspace);
  const multiEmployee = exportEmployees(workspace).length > 1;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Phoenix Workforce";
  wb.created = generatedAt;

  // ── Calendar sheet — every day of the month, one row each, in a single table ──
  const ws = wb.addWorksheet("Calendar", { pageSetup: { orientation: "landscape", fitToPage: true } });

  const COLS = [
    { header: "Date", key: "date", width: 15 },
    { header: "Day", key: "day", width: 8 },
    ...(multiEmployee ? [{ header: "Employee", key: "employee", width: 30 }] : []),
    { header: "Source", key: "source", width: 18 },
    { header: "Activity", key: "title", width: 36 },
    { header: "Status", key: "status", width: 20 },
    { header: "Time", key: "time", width: 14 },
    { header: "Detail", key: "detail", width: 60 },
  ];
  ws.columns = COLS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const sourceColIndex = COLS.findIndex((c) => c.key === "source") + 1;

  // Brand band
  ws.mergeCells(1, 1, 1, COLS.length);
  const brandCell = ws.getCell(1, 1);
  const brandSubject = multiEmployee ? "Team" : `${selectedEmployee.fullName} (${selectedEmployee.hrId})`;
  brandCell.value = `Phoenix Workforce — Private Calendar — ${monthLabel} — ${brandSubject}`;
  brandCell.fill = fill(X.slate900);
  brandCell.font = { bold: true, color: { argb: X.white }, size: 11 };
  brandCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(1).height = 28;

  // Stamp row
  ws.mergeCells(2, 1, 2, COLS.length);
  const stampCell = ws.getCell(2, 1);
  stampCell.value = `Generated ${formatStamp(generatedAt)}`;
  stampCell.fill = fill(X.orange500);
  stampCell.font = { bold: true, color: { argb: X.white }, size: 9 };
  stampCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(2).height = 18;

  // Column headers
  const headerRow = ws.getRow(3);
  headerRow.height = 22;
  COLS.forEach((col, i) => {
    const cell = ws.getCell(3, i + 1);
    cell.value = col.header;
    cell.fill = fill(X.slate900);
    cell.font = { bold: true, color: { argb: X.orange500 }, size: 9 };
    cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    cell.border = thinGrid();
  });

  // Data rows — one per calendar day (per employee, for team exports), never split into another table
  rows.forEach((dayRow, idx) => {
    const row = ws.addRow({
      date: formatDayDate(dayRow.date),
      day: dayRow.dayLabel,
      ...(multiEmployee ? { employee: `${dayRow.employeeName} (${dayRow.employeeHrId})` } : {}),
      source: dayRow.source,
      title: dayRow.title,
      status: dayRow.status,
      time: dayRow.time,
      detail: dayRow.detail,
    });
    const tone = severityFill(dayRow.severity);
    const isAlt = idx % 2 === 1;
    row.height = 18;
    row.eachCell((cell) => {
      cell.fill = fill(isAlt ? X.slate50 : X.white);
      cell.font = { size: 9, color: { argb: X.slate700 } };
      cell.alignment = { vertical: "middle", horizontal: "left", indent: 1, wrapText: false };
      cell.border = thinGrid();
    });
    // Tint source cell by severity
    const sourceCell = row.getCell(sourceColIndex);
    sourceCell.fill = fill(tone.fill);
    sourceCell.font = { size: 9, bold: true, color: { argb: tone.text } };
  });

  // ── Summary sheet ────────────────────────────────────────────────────────
  const wsSum = wb.addWorksheet("Summary");
  wsSum.columns = [{ header: "Source", width: 24 }, { header: "Count", width: 10 }];
  wsSum.mergeCells(1, 1, 1, 2);
  const sumBrand = wsSum.getCell(1, 1);
  sumBrand.value = `Summary — ${monthLabel}`;
  sumBrand.fill = fill(X.slate900);
  sumBrand.font = { bold: true, color: { argb: X.orange500 }, size: 11 };
  sumBrand.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  wsSum.getRow(1).height = 26;
  Object.entries(summary).forEach(([source, count]) => {
    const label = source === "total" ? "TOTAL" : (privateCalendarSourceLabels[source as keyof typeof privateCalendarSourceLabels] ?? source);
    const row = wsSum.addRow([label, count]);
    row.height = 18;
    row.eachCell((c) => {
      c.font = source === "total" ? { bold: true, size: 9, color: { argb: X.slate900 } } : { size: 9, color: { argb: X.slate700 } };
      c.alignment = { vertical: "middle", indent: 1 };
      c.border = thinGrid();
    });
  });

  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------

export async function buildPrivateCalendarPdf(
  workspace: PrivateCalendarWorkspace,
  generatedAt: Date = new Date(),
): Promise<Uint8Array> {
  const { selectedEmployee, year, month } = workspace;
  const monthLabel = new Date(Date.UTC(year, month - 1, 1))
    .toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });
  const rows = buildExportRows(workspace);
  const multiEmployee = exportEmployees(workspace).length > 1;

  const doc = await PDFDocument.create();
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const pageW = 841.89; // A4 landscape
  const pageH = 595.28;
  const margin = 36;
  const rowH = 16;
  // Every day of the month is one row of this single table (headers repeat per page,
  // but it is still one continuous table — never a separate exceptions table).
  const headers = multiEmployee
    ? ["Date", "Day", "Employee", "Source", "Activity", "Status", "Time", "Detail"]
    : ["Date", "Day", "Source", "Activity", "Status", "Time", "Detail"];
  const colWidths = multiEmployee ? [62, 26, 110, 58, 150, 80, 50, 0] : [68, 30, 64, 180, 90, 54, 0]; // last col fills remaining
  const totalFixed = colWidths.slice(0, -1).reduce((a, b) => a + b, 0);
  colWidths[colWidths.length - 1] = pageW - margin * 2 - totalFixed;

  function addPage() {
    const page = doc.addPage([pageW, pageH]);
    let y = pageH - margin;

    // brand band
    const brandSubject = multiEmployee ? "Team" : `${selectedEmployee.fullName} (${selectedEmployee.hrId})`;
    page.drawRectangle({ x: margin, y: y - 22, width: pageW - margin * 2, height: 22, color: rgb(0.059, 0.09, 0.165) });
    page.drawText(asciiSafe(`Phoenix Workforce | Private Calendar | ${monthLabel} | ${brandSubject}`), {
      x: margin + 6, y: y - 15, size: 8, font: boldFont, color: rgb(1, 1, 1),
    });
    y -= 24;

    // stamp
    page.drawRectangle({ x: margin, y: y - 14, width: pageW - margin * 2, height: 14, color: rgb(0.976, 0.451, 0.086) });
    page.drawText(asciiSafe(`Generated ${formatStamp(generatedAt)}`), {
      x: margin + 6, y: y - 10, size: 7, font, color: rgb(1, 1, 1),
    });
    y -= 16;

    // col headers
    let x = margin;
    page.drawRectangle({ x: margin, y: y - rowH, width: pageW - margin * 2, height: rowH, color: rgb(0.059, 0.09, 0.165) });
    headers.forEach((h, i) => {
      page.drawText(asciiSafe(h), { x: x + 3, y: y - rowH + 4, size: 7, font: boldFont, color: rgb(0.976, 0.451, 0.086) });
      x += colWidths[i];
    });
    y -= rowH + 2;
    return { page, y: y };
  }

  let { page, y } = addPage();

  for (const dayRow of rows) {
    if (y < margin + rowH * 2) {
      const next = addPage();
      page = next.page;
      y = next.y;
    }
    const cols = multiEmployee
      ? [
          formatDayDate(dayRow.date),
          dayRow.dayLabel,
          `${dayRow.employeeName} (${dayRow.employeeHrId})`,
          dayRow.source,
          dayRow.title,
          dayRow.status,
          dayRow.time,
          dayRow.detail,
        ]
      : [formatDayDate(dayRow.date), dayRow.dayLabel, dayRow.source, dayRow.title, dayRow.status, dayRow.time, dayRow.detail];
    const bgColor = dayRow.severity === "danger" ? rgb(0.996, 0.949, 0.949)
      : dayRow.severity === "warning" ? rgb(1, 0.984, 0.922)
      : dayRow.severity === "success" ? rgb(0.929, 0.992, 0.965)
      : dayRow.severity === "neutral" ? rgb(0.973, 0.980, 0.988)
      : rgb(0.941, 0.973, 1);
    page.drawRectangle({ x: margin, y: y - rowH + 2, width: pageW - margin * 2, height: rowH, color: bgColor });
    let x = margin;
    cols.forEach((val, i) => {
      const maxW = colWidths[i] - 6;
      const text = asciiSafe(val);
      const truncated = text.length > 0 ? text.slice(0, Math.floor(maxW / 4.5)) : "";
      page.drawText(truncated, { x: x + 3, y: y - rowH + 5, size: 7, font, color: rgb(0.2, 0.25, 0.33) });
      x += colWidths[i];
    });
    y -= rowH;
  }

  return doc.save();
}

import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import type { PrivateCalendarWorkspace } from "@/lib/private-calendar/logic";
import { privateCalendarSourceLabels } from "@/lib/private-calendar/logic";

// Phoenix-identity export for the private calendar.
// Columns: Date · Day · Source · Title · Status · Time · Detail

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

export async function buildPrivateCalendarWorkbook(
  workspace: PrivateCalendarWorkspace,
  generatedAt: Date = new Date(),
): Promise<ExcelJS.Buffer> {
  const { items, exceptions, summary, selectedEmployee, year, month } = workspace;
  const monthLabel = new Date(Date.UTC(year, month - 1, 1))
    .toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });

  const wb = new ExcelJS.Workbook();
  wb.creator = "Phoenix Workforce";
  wb.created = generatedAt;

  // ── Items sheet ──────────────────────────────────────────────────────────
  const ws = wb.addWorksheet("Calendar", { pageSetup: { orientation: "landscape", fitToPage: true } });

  const COLS = [
    { header: "Date", key: "date", width: 15 },
    { header: "Day", key: "day", width: 8 },
    { header: "Source", key: "source", width: 16 },
    { header: "Title", key: "title", width: 36 },
    { header: "Status", key: "status", width: 20 },
    { header: "Time", key: "time", width: 14 },
    { header: "Detail", key: "detail", width: 60 },
  ];
  ws.columns = COLS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  // Brand band
  ws.mergeCells(1, 1, 1, COLS.length);
  const brandCell = ws.getCell(1, 1);
  brandCell.value = `Phoenix Workforce — Private Calendar — ${monthLabel} — ${selectedEmployee.fullName} (${selectedEmployee.hrId})`;
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

  // Data rows
  const sorted = [...items].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.title.localeCompare(b.title));
  sorted.forEach((item, idx) => {
    const row = ws.addRow({
      date: formatDayDate(item.startDate),
      day: formatDayName(item.startDate),
      source: privateCalendarSourceLabels[item.source] ?? item.source,
      title: compact(item.title),
      status: compact(item.status),
      time: compact(item.time),
      detail: [compact(item.description), ...item.detailLines].filter(Boolean).join(" · "),
    });
    const tone = severityFill(item.severity);
    const isAlt = idx % 2 === 1;
    row.height = 18;
    row.eachCell((cell) => {
      cell.fill = fill(isAlt ? X.slate50 : X.white);
      cell.font = { size: 9, color: { argb: X.slate700 } };
      cell.alignment = { vertical: "middle", horizontal: "left", indent: 1, wrapText: false };
      cell.border = thinGrid();
    });
    // Tint source cell by severity
    const sourceCell = row.getCell(3);
    sourceCell.fill = fill(tone.fill);
    sourceCell.font = { size: 9, bold: true, color: { argb: tone.text } };
  });

  // ── Exceptions sheet ─────────────────────────────────────────────────────
  if (exceptions.length > 0) {
    const wsEx = wb.addWorksheet("Exceptions");
    wsEx.columns = [
      { header: "Date", key: "date", width: 15 },
      { header: "Title", key: "title", width: 36 },
      { header: "Description", key: "desc", width: 60 },
      { header: "Severity", key: "sev", width: 12 },
    ];
    wsEx.mergeCells(1, 1, 1, 4);
    const exBrand = wsEx.getCell(1, 1);
    exBrand.value = `Exceptions — ${monthLabel}`;
    exBrand.fill = fill(X.slate900);
    exBrand.font = { bold: true, color: { argb: X.orange500 }, size: 11 };
    exBrand.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    wsEx.getRow(1).height = 26;
    const exHeader = wsEx.getRow(2);
    exHeader.height = 20;
    ["Date", "Title", "Description", "Severity"].forEach((h, i) => {
      const c = wsEx.getCell(2, i + 1);
      c.value = h;
      c.fill = fill(X.slate900);
      c.font = { bold: true, color: { argb: X.orange500 }, size: 9 };
      c.border = thinGrid();
    });
    [...exceptions].sort((a, b) => a.date.localeCompare(b.date)).forEach((ex) => {
      const row = wsEx.addRow({ date: formatDayDate(ex.date), title: compact(ex.title), desc: compact(ex.description), sev: ex.severity });
      row.height = 18;
      row.eachCell((c) => {
        c.font = { size: 9, color: { argb: X.slate700 } };
        c.alignment = { vertical: "middle", indent: 1 };
        c.border = thinGrid();
      });
    });
  }

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
  const { items, exceptions, selectedEmployee, year, month } = workspace;
  const monthLabel = new Date(Date.UTC(year, month - 1, 1))
    .toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });

  const doc = await PDFDocument.create();
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const pageW = 841.89; // A4 landscape
  const pageH = 595.28;
  const margin = 36;
  const rowH = 16;
  const colWidths = [68, 30, 64, 180, 90, 54, 0]; // last col fills remaining
  const totalFixed = colWidths.slice(0, -1).reduce((a, b) => a + b, 0);
  colWidths[colWidths.length - 1] = pageW - margin * 2 - totalFixed;

  function addPage() {
    const page = doc.addPage([pageW, pageH]);
    let y = pageH - margin;

    // brand band
    page.drawRectangle({ x: margin, y: y - 22, width: pageW - margin * 2, height: 22, color: rgb(0.059, 0.09, 0.165) });
    page.drawText(asciiSafe(`Phoenix Workforce | Private Calendar | ${monthLabel} | ${selectedEmployee.fullName} (${selectedEmployee.hrId})`), {
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
    const headers = ["Date", "Day", "Source", "Title", "Status", "Time", "Detail"];
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

  const sorted = [...items].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.title.localeCompare(b.title));
  for (const item of sorted) {
    if (y < margin + rowH * 2) {
      const next = addPage();
      page = next.page;
      y = next.y;
    }
    const cols = [
      formatDayDate(item.startDate),
      formatDayName(item.startDate),
      privateCalendarSourceLabels[item.source] ?? item.source,
      compact(item.title),
      compact(item.status ?? ""),
      compact(item.time ?? ""),
      [compact(item.description ?? ""), ...item.detailLines].filter(Boolean).join(" · "),
    ];
    const bgColor = item.severity === "danger" ? rgb(0.996, 0.949, 0.949)
      : item.severity === "warning" ? rgb(1, 0.984, 0.922)
      : item.severity === "success" ? rgb(0.929, 0.992, 0.965)
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

  // Exceptions appendix
  if (exceptions.length > 0) {
    const next = addPage();
    page = next.page;
    y = next.y;
    page.drawText("EXCEPTIONS", { x: margin, y, size: 9, font: boldFont, color: rgb(0.059, 0.09, 0.165) });
    y -= 14;
    for (const ex of [...exceptions].sort((a, b) => a.date.localeCompare(b.date))) {
      if (y < margin + rowH) { const next2 = addPage(); page = next2.page; y = next2.y; }
      page.drawText(asciiSafe(`${formatDayDate(ex.date)} — ${ex.title} — ${ex.description}`), {
        x: margin + 3, y, size: 7, font, color: rgb(0.4, 0.1, 0.1),
      });
      y -= rowH;
    }
  }

  return doc.save();
}

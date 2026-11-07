// Recruitment — the interview calendar's week as a file: a PDF or an Excel workbook.
//
// The owner, 2026-09-18: "export PDF export to Excel ... the most important that I click on name
// the CV appear even in the export so I think PDF will be more applicable but if Excel is okay".
// So in BOTH files every candidate's name is a link, and the link opens that interview on the
// calendar with the CV already up. The link needs a Phoenix sign-in and the calendar's own access
// check: a file forwarded to someone the calendar was never shared with opens nothing.
//
// THE LAYOUT IS THE OWNER'S SHEET, which he sent as the example: a week grid, the days across the
// top with their dates, a row every half hour, zebra rows. Then, because a grid cell has room for a
// name and little else, a plain list of the week's interviews follows it with the rest.
//
// A HALF HOUR CAN HOLD TWO INTERVIEWS. The grid gives each one its own line in the cell rather than
// joining them into one string, so each name keeps its own link — a cell has one hyperlink in Excel,
// so there the slot's row is split into as many rows as its busiest day needs.
//
// The workbook wears the house identity, SATO-DIS-2026-01 v1.0: ink, not fills, except the 6% zebra.
// The PDF wears the HR PREMIUM identity on top of it (owner, 2026-10-13: ticked "change to the
// premium look" on the review page) — frame, watermark, centred masthead, running foot — and is
// landscape by nature, so it uses the premium sheet turned on its side.
// This module is pure — no database, no browser; the route owns Chromium.

import ExcelJS from "exceljs";

import { systemLegalEntity } from "@/config/system-settings";
import {
  HOUSE_XLSX_COLORS,
  houseBodyStyle,
  houseHeaderStyle,
  writeHouseMasthead,
} from "@/lib/export/house-xlsx-identity";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import {
  PREMIUM_COMPANY_DOCUMENT_BRAND,
  PREMIUM_IDENTITY_CSS,
  premiumMasthead,
  premiumPageChrome,
  premiumSheetCss,
} from "@/lib/hiring-pack/premium-identity";
import {
  PLATFORM_LABEL,
  interviewCalendarHref,
  interviewOutcomeLabels,
  type InterviewBooking,
} from "@/lib/recruitment/interview-calendar-types";
import {
  formatDayLong,
  formatDuration,
  formatShortDate,
  formatTimeOfDay,
  formatTimeRange,
  formatWeekOf,
  formatWeekRange,
  slotFor,
  slotStarts,
  weekDays,
  weekStartFor,
  weekdayName,
} from "@/lib/recruitment/interview-calendar-week";

export type InterviewCalendarExportFormat = "pdf" | "xlsx";

export function isInterviewCalendarExportFormat(value: unknown): value is InterviewCalendarExportFormat {
  return value === "pdf" || value === "xlsx";
}

export type InterviewCalendarExportModel = {
  weekStart: string;
  weekLabel: string;
  weekOfLabel: string;
  generatedAtLabel: string;
  days: Array<{ key: string; weekday: string; dateLabel: string }>;
  /** Every half-hour row, with the interviews that START inside it, per day. */
  slots: Array<{ minutes: number; label: string; perDay: InterviewBooking[][] }>;
  /** The week's interviews in time order — the list under the grid. */
  bookings: InterviewBooking[];
  /** Interviews that start outside the 9-to-5 grid: listed, never dropped. */
  offGrid: InterviewBooking[];
  origin: string;
};

/** Cairo local, the way every Phoenix document states when it was made. */
function cairoStamp(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "long",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(date);
}

function byTime(left: InterviewBooking, right: InterviewBooking): number {
  return left.dateKey === right.dateKey
    ? left.startMinutes - right.startMinutes || left.candidateName.localeCompare(right.candidateName)
    : left.dateKey.localeCompare(right.dateKey);
}

export function buildInterviewCalendarExportModel(input: {
  weekStart: string;
  bookings: readonly InterviewBooking[];
  /** The week's sessions — accepted so the route can pass the week as it is read; each booked slot already names its session. */
  sessions?: readonly unknown[];
  now: Date;
  origin: string;
}): InterviewCalendarExportModel {
  const weekStart = weekStartFor(input.weekStart);
  const dayKeys = weekDays(weekStart);
  const bookings = [...input.bookings].sort(byTime);
  const starts = slotStarts();

  const slots = starts.map((minutes) => ({
    label: formatTimeOfDay(minutes),
    minutes,
    perDay: dayKeys.map((day) =>
      bookings.filter((booking) => booking.dateKey === day && slotFor(booking.startMinutes) === minutes),
    ),
  }));
  const placed = new Set(slots.flatMap((slot) => slot.perDay.flat().map((booking) => booking.id)));

  return {
    bookings,
    days: dayKeys.map((key) => ({ dateLabel: formatShortDate(key), key, weekday: weekdayName(key) })),
    generatedAtLabel: cairoStamp(input.now),
    offGrid: bookings.filter((booking) => !placed.has(booking.id)),
    origin: input.origin.replace(/\/+$/, ""),
    slots,
    weekLabel: formatWeekRange(weekStart),
    weekOfLabel: formatWeekOf(weekStart),
    weekStart,
  };
}

/** Where a name in the file goes: this interview, on the calendar, with its CV open. */
export function bookingLink(model: Pick<InterviewCalendarExportModel, "origin" | "weekStart">, booking: InterviewBooking): string {
  return `${model.origin}${interviewCalendarHref({ open: booking.id, weekStart: model.weekStart })}`;
}

/** "interview-calendar-20-24-september-2026.pdf". Names, never codes. */
export function interviewCalendarFilename(model: InterviewCalendarExportModel, format: InterviewCalendarExportFormat): string {
  const slug = model.weekLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `interview-calendar-${slug}.${format}`;
}

function cellLine(booking: InterviewBooking): string {
  const bits = [formatTimeOfDay(booking.startMinutes), formatDuration(booking.durationMinutes), PLATFORM_LABEL[booking.platform]];
  // The interviewer and the area/line an interview is for (owner, 2026-09-26) — readable from outside.
  if (booking.interviewerName) bits.push(booking.interviewerName);
  if (booking.line) bits.push(booking.line);
  if (booking.area) bits.push(booking.area);
  // The role THIS interview is for (owner, 2026-10-15) — beside the area and the line, and named so
  // it can never be read as either of them. Nobody named one: the words are simply absent — no dash,
  // no "—", nothing a reader could take for an answer.
  if (booking.jobTitle) bits.push(`Role: ${booking.jobTitle}`);
  // A slot in a session says so: its candidates share the session's one meeting.
  if (booking.sessionTitle) bits.push(booking.sessionTitle);
  // How it went, once the interviewer has said (owner, 2026-09-20). Ink only — no fill, per the house identity.
  if (booking.outcome) bits.push(`Outcome: ${interviewOutcomeLabels[booking.outcome]}`);
  return bits.join(" · ");
}

// ── Excel ────────────────────────────────────────────────────────────────────────────────────────

const GRID_COLUMNS = 6; // time + Sunday..Thursday

export async function buildInterviewCalendarWorkbook(model: InterviewCalendarExportModel): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  // ── Sheet 1: the week, as the owner's sheet lays it out ────────────────────────────────────
  const grid = workbook.addWorksheet("Week", {
    pageSetup: { fitToHeight: 0, fitToPage: true, fitToWidth: 1, orientation: "landscape", paperSize: 9 },
    properties: { defaultRowHeight: 18 },
  });
  grid.views = [{ showGridLines: false, state: "frozen", ySplit: 5, xSplit: 1 }];
  grid.getColumn(1).width = 12;
  for (let column = 2; column <= GRID_COLUMNS; column += 1) grid.getColumn(column).width = 30;

  let row = writeHouseMasthead(workbook, grid, {
    columns: GRID_COLUMNS,
    provenance: [`Generated ${model.generatedAtLabel} (Cairo)`, `${model.bookings.length} interview${model.bookings.length === 1 ? "" : "s"}`],
    subtitle: `${model.weekOfLabel} · ${model.weekLabel} · Every day, 9:00 AM to 5:00 PM. Click a name to open the CV.`,
    title: "Interview Calendar",
  });

  // The day header: weekday over date, the way the owner's sheet heads its columns.
  const header = grid.getRow(row);
  header.height = 32;
  header.getCell(1).value = "Time";
  houseHeaderStyle(header.getCell(1), { center: true });
  model.days.forEach((day, index) => {
    const cell = header.getCell(index + 2);
    cell.value = `${day.weekday}\n${day.dateLabel}`;
    houseHeaderStyle(cell, { center: true });
  });
  row += 1;

  model.slots.forEach((slot, slotIndex) => {
    const depth = Math.max(1, ...slot.perDay.map((list) => list.length));
    const zebra = slotIndex % 2 === 1;
    for (let line = 0; line < depth; line += 1) {
      const excelRow = grid.getRow(row + line);
      excelRow.height = 30;
      const timeCell = excelRow.getCell(1);
      if (line === 0) timeCell.value = slot.label;
      houseBodyStyle(timeCell, { zebra });
      timeCell.alignment = { horizontal: "center", vertical: "middle" };
      timeCell.font = { ...timeCell.font, bold: true, color: { argb: HOUSE_XLSX_COLORS.deep } };

      slot.perDay.forEach((list, dayIndex) => {
        const cell = excelRow.getCell(dayIndex + 2);
        houseBodyStyle(cell, { zebra });
        const booking = list[line];
        if (!booking) return;
        cell.value = {
          hyperlink: bookingLink(model, booking),
          text: `${booking.candidateName}\n${cellLine(booking)}`,
          tooltip: `Open ${booking.candidateName}'s CV in Phoenix`,
        };
        cell.font = { color: { argb: HOUSE_XLSX_COLORS.blue }, name: cell.font?.name, size: 10, underline: true };
        cell.alignment = { vertical: "middle", wrapText: true };
      });
    }
    if (depth > 1) grid.mergeCells(row, 1, row + depth - 1, 1);
    row += depth;
  });

  if (model.bookings.length === 0) {
    row += 1;
    grid.mergeCells(row, 1, row, GRID_COLUMNS);
    grid.getCell(row, 1).value = "No interviews are booked this week.";
    grid.getCell(row, 1).font = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, size: 10 };
  }

  // ── Sheet 2: the list, with everything the grid has no room for ────────────────────────────
  const list = workbook.addWorksheet("Interviews", {
    pageSetup: { fitToHeight: 0, fitToPage: true, fitToWidth: 1, orientation: "landscape", paperSize: 9 },
    properties: { defaultRowHeight: 18 },
  });
  list.views = [{ showGridLines: false, state: "frozen", ySplit: 4 }];
  // "Role" is the job THIS interview is for; "Applied for" is what the candidate's own record says.
  // Two different facts, so two columns — and the widths are re-weighted to make room for the new one
  // rather than letting `fitToPage` shrink the printed type.
  const listColumns: Array<{ label: string; width: number }> = [
    { label: "Day", width: 22 },
    { label: "Time", width: 20 },
    { label: "Candidate", width: 28 },
    { label: "Role", width: 24 },
    { label: "Applied for", width: 22 },
    { label: "Where", width: 11 },
    { label: "Zoom link", width: 30 },
    { label: "Outcome", width: 16 },
    { label: "Notes", width: 34 },
  ];
  listColumns.forEach((column, index) => {
    list.getColumn(index + 1).width = column.width;
  });
  let listRow = writeHouseMasthead(workbook, list, {
    columns: listColumns.length,
    provenance: [`Generated ${model.generatedAtLabel} (Cairo)`],
    subtitle: `${model.weekLabel} · every interview this week, in time order. Click a name to open the CV.`,
    title: "Interviews this week",
  });
  const listHeader = list.getRow(listRow);
  listHeader.height = 22;
  listColumns.forEach((column, index) => {
    listHeader.getCell(index + 1).value = column.label;
    houseHeaderStyle(listHeader.getCell(index + 1));
  });
  listRow += 1;

  model.bookings.forEach((booking, index) => {
    const excelRow = list.getRow(listRow);
    const zebra = index % 2 === 1;
    const values: Array<ExcelJS.CellValue> = [
      formatDayLong(booking.dateKey),
      formatTimeRange(booking.startMinutes, booking.durationMinutes),
      { hyperlink: bookingLink(model, booking), text: booking.candidateName, tooltip: `Open ${booking.candidateName}'s CV in Phoenix` },
      // Blank when nobody named a role — an empty cell, never a placeholder that reads as data.
      booking.jobTitle ?? "",
      booking.candidateJobTitle ?? "",
      PLATFORM_LABEL[booking.platform],
      booking.zoomJoinUrl ? { hyperlink: booking.zoomJoinUrl, text: booking.zoomJoinUrl } : booking.platform === "zoom" ? "No link yet" : "",
      booking.outcome ? interviewOutcomeLabels[booking.outcome] : "",
      booking.notes ?? "",
    ];
    values.forEach((value, column) => {
      const cell = excelRow.getCell(column + 1);
      cell.value = value;
      houseBodyStyle(cell, { zebra });
      cell.alignment = { vertical: "top", wrapText: true };
      if (value && typeof value === "object" && "hyperlink" in value) {
        cell.font = { color: { argb: HOUSE_XLSX_COLORS.blue }, name: cell.font?.name, size: 10, underline: true };
      }
    });
    listRow += 1;
  });
  if (model.bookings.length === 0) {
    list.getCell(listRow, 1).value = "No interviews are booked this week.";
    list.getCell(listRow, 1).font = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, size: 10 };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

// ── PDF ──────────────────────────────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The calendar's own dress, under the premium sheet: square edges everywhere, the grid carried by
 * hairlines and the 6% zebra, names in Brand Blue because they are links. Wrapping, never an ellipsis.
 *
 * The sheet itself — `@page`, the padding that keeps content clear of the frame and the running
 * foot, and the fixed chrome — comes from `premiumSheetCss`, so a page of the grid and a page of
 * the list sit exactly where every other premium paper's content does.
 */
const CALENDAR_CSS = `
  :root {
    --phx-doc-deep:  ${HOUSE_COLORS.deep};
    --phx-doc-blue:  ${HOUSE_COLORS.blue};
    --phx-doc-light: ${HOUSE_COLORS.light};
    --phx-doc-tint:  ${HOUSE_COLORS.tint};
    --phx-doc-hair:  ${HOUSE_COLORS.hair};
    --phx-doc-muted: ${HOUSE_COLORS.muted};
    --phx-doc-body:  ${HOUSE_COLORS.body};
  }
  ${premiumSheetCss(".cal", "landscape")}
  ${PREMIUM_IDENTITY_CSS}
  * { box-sizing: border-box; border-radius: 0 !important; }
  body { margin: 0; color: var(--phx-doc-body); font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 8pt; line-height: 1.24; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { padding: .9mm 1.4mm; text-align: start; vertical-align: top; overflow-wrap: anywhere; }
  .grid { margin-top: 2.4mm; }
  .grid th { color: var(--phx-doc-deep); font-size: 7.4pt; font-weight: 700; text-align: center; border-top: .7pt solid var(--phx-doc-deep); border-bottom: .5pt solid var(--phx-doc-hair); border-inline-start: .5pt solid var(--phx-doc-hair); }
  .grid th:first-child { border-inline-start: 0; }
  .grid th span { display: block; color: var(--phx-doc-muted); font-size: 6.8pt; font-weight: 600; }
  .grid td { height: 8mm; border-bottom: .5pt solid var(--phx-doc-hair); border-inline-start: .5pt solid var(--phx-doc-hair); }
  .grid td.time { border-inline-start: 0; color: var(--phx-doc-deep); font-weight: 700; text-align: center; vertical-align: middle; white-space: nowrap; }
  .grid tbody tr:nth-child(even) td { background: var(--phx-doc-tint); }
  .slot { display: block; margin: 0 0 .8mm; padding-inline-start: 1.4mm; border-inline-start: .6mm solid var(--phx-doc-light); }
  .slot:last-child { margin-bottom: 0; }
  a.name { color: var(--phx-doc-blue); font-weight: 700; text-decoration: underline; }
  .slot .meta { display: block; color: var(--phx-doc-muted); font-size: 6.8pt; }
  h2 { margin: 4mm 0 1.2mm; color: var(--phx-doc-deep); font-size: 10.5pt; font-weight: 700; break-after: avoid; }
  .list thead th { color: var(--phx-doc-deep); font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; border-top: .7pt solid var(--phx-doc-deep); border-bottom: .5pt solid var(--phx-doc-hair); }
  .list tbody tr:nth-child(even) { background: var(--phx-doc-tint); }
  .list td { border-bottom: .5pt solid var(--phx-doc-hair); }
  .muted { color: var(--phx-doc-muted); font-size: 7pt; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .empty { margin: 4mm 0; padding: 3mm; border: .5pt solid var(--phx-doc-hair); color: var(--phx-doc-muted); text-align: center; }
  .note { margin: 2.4mm 0 0; color: var(--phx-doc-muted); font-size: 7pt; }
`;

export function buildInterviewCalendarPdfHtml(model: InterviewCalendarExportModel): string {
  const name = (booking: InterviewBooking) =>
    `<a class="name" href="${escapeHtml(bookingLink(model, booking))}">${escapeHtml(booking.candidateName)}</a>`;

  const gridRows = model.slots
    .map(
      (slot) => `<tr><td class="time">${escapeHtml(slot.label)}</td>${slot.perDay
        .map(
          (list) =>
            `<td>${list
              .map(
                (booking) =>
                  `<span class="slot">${name(booking)}<span class="meta">${escapeHtml(cellLine(booking))}</span></span>`,
              )
              .join("")}</td>`,
        )
        .join("")}</tr>`,
    )
    .join("");

  const listRows = model.bookings
    .map(
      (booking) => `<tr>
        <td>${escapeHtml(formatDayLong(booking.dateKey))}</td>
        <td>${escapeHtml(formatTimeRange(booking.startMinutes, booking.durationMinutes))}</td>
        <td>${name(booking)}${
          // What the candidate's own record says they applied for — printed only when it is NOT the
          // role this interview is for, exactly as the calendar's own panel does it, so the same
          // words never appear twice on one row.
          booking.candidateJobTitle && booking.candidateJobTitle !== booking.jobTitle
            ? `<br><span class="muted">Applied for ${escapeHtml(booking.candidateJobTitle)}</span>`
            : ""
        }</td>
        <td>${booking.jobTitle ? escapeHtml(booking.jobTitle) : ""}</td>
        <td>${escapeHtml(PLATFORM_LABEL[booking.platform])}${
          booking.zoomJoinUrl
            ? `<br><a class="muted" href="${escapeHtml(booking.zoomJoinUrl)}">Zoom link</a>`
            : booking.platform === "zoom"
              ? `<br><span class="muted">No link yet</span>`
              : ""
        }</td>
        <td>${booking.outcome ? escapeHtml(interviewOutcomeLabels[booking.outcome]) : ""}</td>
        <td>${booking.notes ? escapeHtml(booking.notes) : ""}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(`Interview Calendar — ${model.weekLabel}`)}</title>
<style>${CALENDAR_CSS}</style></head>
<body>
<main class="cal">
${premiumMasthead({
  compact: true,
  legalNameAr: systemLegalEntity.legalNameAr,
  legalNameEn: systemLegalEntity.legalNameEn,
  orientation: "landscape",
  subtitles: [{ lang: "en", text: `${model.weekOfLabel} · ${model.weekLabel} · generated ${model.generatedAtLabel} (Cairo)` }],
  title: "Interview Calendar",
  titleLang: "en",
})}
<table class="grid">
  <colgroup><col style="width:10%">${model.days.map(() => `<col style="width:18%">`).join("")}</colgroup>
  <thead><tr><th>Time</th>${model.days
    .map((day) => `<th>${escapeHtml(day.weekday)}<span>${escapeHtml(day.dateLabel)}</span></th>`)
    .join("")}</tr></thead>
  <tbody>${gridRows}</tbody>
</table>
<p class="note">Click a candidate's name to open their CV in Phoenix. You need to be signed in, and the calendar must be shared with you.</p>
<h2 class="pm-shead">Interviews this week</h2>
${
  model.bookings.length === 0
    ? `<p class="empty">No interviews are booked this week.</p>`
    : `<table class="list">
  <colgroup><col style="width:14%"><col style="width:13%"><col style="width:20%"><col style="width:15%"><col style="width:11%"><col style="width:11%"><col style="width:16%"></colgroup>
  <thead><tr><th>Day</th><th>Time</th><th>Candidate</th><th>Role</th><th>Where</th><th>Outcome</th><th>Notes</th></tr></thead>
  <tbody>${listRows}</tbody>
</table>`
}
${premiumPageChrome({
  brand: PREMIUM_COMPANY_DOCUMENT_BRAND,
  department: `Interview Calendar · ${model.weekLabel}`,
  orientation: "landscape",
})}
</main>
</body></html>`;
}

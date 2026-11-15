import ExcelJS from "exceljs";

import { systemLegalEntity } from "@/config/system-settings";
import {
  HOUSE_DOCUMENT_STANDARD,
  HOUSE_XLSX_COLORS,
  houseBodyStyle,
  houseCairoDateTime,
  houseGeneratedAt,
  houseHeaderStyle,
  writeHouseMasthead,
} from "@/lib/export/house-xlsx-identity";
import { HOUSE_XLSX_FONT } from "@/lib/export/house-xlsx-palette";
import { HOUSE_COLORS, HOUSE_IDENTITY_CSS, HOUSE_MARK_SRC } from "@/lib/hiring-pack/house-identity";
import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import {
  CEO_APPROVAL_LISTED_AS_LABEL,
  summarizeCeoApprovals,
  type CeoApprovalsRange,
  type MarketingCeoApprovalRow,
  type MarketingCeoApprovals,
} from "@/lib/marketing-requests/ceo-approvals";

// ─────────────────────────────────────────────────────────────────────────────
// CEO Approvals — the exports (owner, 2026-11-15: "export selected in a very premium polished XLSX
// and PDF"). Both carry EXACTLY the ticked rows of the range on screen, re-read on the server: the
// browser names which requests (and the note typed beside each), never a value, a status or a date.
//
// Both wear the house identity SATO-DIS-2026-01: the on-light mark, the provenance block, the brand
// rule, the house blues. The workbook takes the spreadsheet's own treatment (blue header band, hair
// grid, 6% zebra — `house-xlsx-identity.ts`); the PDF keeps the paper's ink rule — rules and type, the
// zebra the only fill. The totals are `summarizeCeoApprovals` over the same rows, so the file and the
// page's tiles can never disagree.
// ─────────────────────────────────────────────────────────────────────────────

export type CeoApprovalsExportFormat = "xlsx" | "pdf";

/** One request in the export, in screen order, with the note the sender typed beside it (if any). */
export type CeoApprovalsExportRow = { note: string; row: MarketingCeoApprovalRow };

/** A guard against a hand-made body, not a business limit: a period never holds anything near it. */
export const CEO_APPROVALS_EXPORT_MAX_ROWS = 2000;
const MAX_NOTE_CHARS = 300;

function cleanNote(value: unknown): string {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE_CHARS);
}

export function parseCeoApprovalsExportFormat(value: unknown): CeoApprovalsExportFormat | null {
  return value === "xlsx" || value === "pdf" ? value : null;
}

/**
 * Which of the range's rows to export: the posted ids, kept in the page's order (oldest approval
 * first). An id that is not in the range is dropped — the browser cannot add a request — and an empty
 * pick is refused with a sentence, not answered with an empty file.
 */
export function pickCeoApprovalsExportRows(raw: unknown, rowsInRange: readonly MarketingCeoApprovalRow[]): CeoApprovalsExportRow[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("Tick at least one request to export.");
  if (raw.length > CEO_APPROVALS_EXPORT_MAX_ROWS) throw new Error(`One export carries at most ${CEO_APPROVALS_EXPORT_MAX_ROWS} requests.`);
  const notes = new Map<string, string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const requestId = String((item as { requestId?: unknown }).requestId ?? "").trim();
    if (requestId) notes.set(requestId, cleanNote((item as { note?: unknown }).note));
  }
  const picked = rowsInRange.filter((row) => notes.has(row.requestId)).map((row) => ({ note: notes.get(row.requestId) ?? "", row }));
  if (picked.length === 0) throw new Error("None of the ticked requests is in this period any more. Show the report again, then export.");
  return picked;
}

// ── Shared wording ──────────────────────────────────────────────────────────

function dateOnlyLabel(day: string | null | undefined): string {
  const text = String(day ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(
    new Date(`${text}T00:00:00Z`),
  );
}

export function ceoApprovalsRangeLabel(range: CeoApprovalsRange): string {
  return `${dateOnlyLabel(range.from)} to ${dateOnlyLabel(range.to)}`;
}

export function ceoApprovalsExportFileName(range: CeoApprovalsRange, format: CeoApprovalsExportFormat): string {
  return `CEO Approvals ${range.from} to ${range.to}.${format}`;
}

const money = (value: number): string => Math.round(value).toLocaleString("en-US");

function statusLine(row: MarketingCeoApprovalRow): string {
  if (row.financeState === "executed") {
    const by = row.executedByName ? ` by ${row.executedByName}` : "";
    const at = row.executedAtIso ? ` · ${houseCairoDateTime(row.executedAtIso)}` : "";
    return `Executed${by}${at}`;
  }
  return row.financeLabel;
}

function payDateLine(row: MarketingCeoApprovalRow): string {
  const label = dateOnlyLabel(row.payDate);
  if (!label) return "Not set";
  return row.payDateOverdue ? `${label} · passed, not paid` : label;
}

function approvalLine(row: MarketingCeoApprovalRow): string {
  const at = houseCairoDateTime(row.approvedAtIso);
  return row.approvedOnBehalfBy ? `${at} · pressed by ${row.approvedOnBehalfBy}` : at;
}

export type CeoApprovalsExportInput = {
  exportedByName: string;
  generatedAtIso: string;
  picked: readonly CeoApprovalsExportRow[];
  report: Pick<MarketingCeoApprovals, "includeCarriedOver" | "range" | "rows">;
};

function scopeLine(input: CeoApprovalsExportInput): string {
  return input.report.includeCarriedOver
    ? "Marketing requests the CEO approved in these dates, with earlier approvals Finance has not paid yet"
    : "Marketing requests the CEO approved in these dates";
}

// ── The workbook ────────────────────────────────────────────────────────────

type SheetColumn = {
  align?: "left" | "right" | "center";
  label: string;
  money?: boolean;
  value: (item: CeoApprovalsExportRow, index: number) => string | number;
  width: number;
};

function sheetColumns(input: CeoApprovalsExportInput): SheetColumn[] {
  const anyNote = input.picked.some((item) => item.note);
  const columns: SheetColumn[] = [
    { align: "center", label: "#", value: (_item, index) => index + 1, width: 5 },
    { label: "Request code", value: ({ row }) => row.requestCode, width: 16 },
    { label: "Customer", value: ({ row }) => row.customerName, width: 32 },
    { label: "Requester", value: ({ row }) => row.requesterName, width: 24 },
    { label: "Line", value: ({ row }) => row.lineName, width: 14 },
    { label: "Activity", value: ({ row }) => row.requestType, width: 24 },
    { align: "right", label: "Value (EGP)", money: true, value: ({ row }) => Math.round(row.estimatedCost), width: 14 },
    { label: "CEO approval (Cairo)", value: ({ row }) => approvalLine(row), width: 24 },
  ];
  if (input.report.includeCarriedOver) {
    columns.push({ label: "Listed as", value: ({ row }) => CEO_APPROVAL_LISTED_AS_LABEL[row.listedAs], width: 22 });
  }
  columns.push(
    { label: "Live report status", value: ({ row }) => row.statusLabel, width: 18 },
    { label: "Finance", value: ({ row }) => statusLine(row), width: 30 },
    { label: "Pay date", value: ({ row }) => payDateLine(row), width: 20 },
  );
  if (anyNote) columns.push({ label: "Note", value: ({ note }) => note, width: 36 });
  return columns;
}

/** The ticked rows as one house-style sheet: masthead, the four figures, the table, a live total. */
export async function buildCeoApprovalsWorkbook(input: CeoApprovalsExportInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemLegalEntity.legalNameEn;
  workbook.created = new Date(input.generatedAtIso);
  workbook.title = `CEO Approvals ${ceoApprovalsRangeLabel(input.report.range)}`;

  const sheet = workbook.addWorksheet("CEO Approvals", {
    pageSetup: {
      fitToHeight: 0,
      fitToPage: true,
      fitToWidth: 1,
      margins: { bottom: 0.5, footer: 0.25, header: 0.25, left: 0.4, right: 0.4, top: 0.5 },
      orientation: "landscape",
      paperSize: 9,
    },
    properties: { defaultRowHeight: 18 },
    views: [{ showGridLines: false }],
  });
  sheet.headerFooter.oddFooter = `&L&8${HOUSE_DOCUMENT_STANDARD} · CEO Approvals&R&8Page &P of &N`;

  const columns = sheetColumns(input);
  columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width;
  });

  const totals = summarizeCeoApprovals(input.picked.map(({ row }) => row));
  let next = writeHouseMasthead(workbook, sheet, {
    columns: columns.length,
    provenance: [
      houseGeneratedAt(input.generatedAtIso),
      `Exported by ${input.exportedByName}`,
      `${totals.count} request${totals.count === 1 ? "" : "s"}`,
    ],
    subtitle: `${scopeLine(input)} · ${ceoApprovalsRangeLabel(input.report.range)}`,
    title: "CEO Approvals",
  });

  // The four figures, as the page's tiles say them — label over value, ruled, no fill.
  next += 1;
  const figures: Array<[string, string, string]> = [
    ["Selected", String(totals.count), totals.carriedOverCount ? `${totals.carriedOverCount} carried over` : "approved in these dates"],
    ["Total value (EGP)", money(totals.totalValue), "requested value of the selected"],
    ["Executed by Finance (EGP)", money(totals.executedValue), `${totals.executedCount} request${totals.executedCount === 1 ? "" : "s"} paid out`],
    [
      "Not yet executed (EGP)",
      money(totals.waitingValue),
      `${totals.waitingCount} still open${totals.overdueCount ? ` · ${totals.overdueCount} past pay date` : ""}`,
    ],
  ];
  const span = Math.max(1, Math.floor(columns.length / figures.length));
  figures.forEach(([label, value, hint], index) => {
    const first = index * span + 1;
    const last = index === figures.length - 1 ? columns.length : first + span - 1;
    for (const [offset, text, font] of [
      [0, label.toUpperCase(), { bold: true, color: { argb: HOUSE_XLSX_COLORS.muted }, name: HOUSE_XLSX_FONT, size: 8 }],
      [1, value, { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 16 }],
      [2, hint, { color: { argb: HOUSE_XLSX_COLORS.muted }, name: HOUSE_XLSX_FONT, size: 8 }],
    ] as const) {
      const rowNumber = next + offset;
      if (last > first) sheet.mergeCells(rowNumber, first, rowNumber, last);
      const cell = sheet.getCell(rowNumber, first);
      cell.value = text;
      cell.font = font;
      cell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
      cell.border = {
        left: { style: "thick", color: { argb: HOUSE_XLSX_COLORS.light } },
        ...(offset === 2 ? { bottom: { style: "hair", color: { argb: HOUSE_XLSX_COLORS.hair } } } : {}),
      };
    }
    sheet.getRow(next + 1).height = 26;
  });
  next += 4;

  const headerRowNumber = next;
  const header = sheet.getRow(headerRowNumber);
  header.height = 30;
  columns.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = column.label;
    houseHeaderStyle(cell, { center: column.align === "center" || column.align === "right" });
  });

  input.picked.forEach((item, index) => {
    const row = sheet.getRow(headerRowNumber + 1 + index);
    columns.forEach((column, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      cell.value = column.value(item, index);
      houseBodyStyle(cell, { zebra: index % 2 === 1 });
      cell.alignment = { horizontal: column.align ?? "left", vertical: "top", wrapText: true };
      if (column.money) cell.numFmt = "#,##0";
    });
    if (item.row.payDateOverdue) {
      const payIndex = columns.findIndex((column) => column.label === "Pay date");
      if (payIndex >= 0) row.getCell(payIndex + 1).font = { bold: true, color: { argb: "FFB91C1C" }, name: HOUSE_XLSX_FONT, size: 10 };
    }
  });

  // The total is a live SUM over the value column, so an edited cell still adds up.
  const totalRowNumber = headerRowNumber + 1 + input.picked.length;
  const totalRow = sheet.getRow(totalRowNumber);
  totalRow.height = 22;
  const valueIndex = columns.findIndex((column) => column.money);
  columns.forEach((_column, index) => {
    const cell = totalRow.getCell(index + 1);
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 10 };
    cell.border = {
      bottom: { style: "double", color: { argb: HOUSE_XLSX_COLORS.deep } },
      top: { style: "medium", color: { argb: HOUSE_XLSX_COLORS.deep } },
    };
    cell.alignment = { vertical: "middle" };
  });
  totalRow.getCell(2).value = `Total of ${totals.count} selected`;
  if (valueIndex >= 0) {
    const letter = sheet.getColumn(valueIndex + 1).letter;
    const cell = totalRow.getCell(valueIndex + 1);
    cell.value = { formula: `SUM(${letter}${headerRowNumber + 1}:${letter}${totalRowNumber - 1})`, result: Math.round(totals.totalValue) };
    cell.numFmt = "#,##0";
    cell.alignment = { horizontal: "right", vertical: "middle" };
  }
  const afterValue = Math.min(columns.length, valueIndex + 2);
  totalRow.getCell(afterValue).value = `Executed ${money(totals.executedValue)} · not yet executed ${money(totals.waitingValue)}`;

  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: headerRowNumber }];
  sheet.autoFilter = { from: { column: 1, row: headerRowNumber }, to: { column: columns.length, row: totalRowNumber - 1 } };
  sheet.pageSetup.printTitlesRow = `${headerRowNumber}:${headerRowNumber}`;

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ── The PDF ─────────────────────────────────────────────────────────────────

/** The A4-landscape document Chromium prints. Pure, so the test can read what the PDF will say. */
export function renderCeoApprovalsHtml(input: CeoApprovalsExportInput): string {
  const totals = summarizeCeoApprovals(input.picked.map(({ row }) => row));
  const carry = input.report.includeCarriedOver;
  const anyNote = input.picked.some((item) => item.note);
  const range = ceoApprovalsRangeLabel(input.report.range);

  const head = [
    `<th class="n">#</th>`,
    `<th>Request</th>`,
    `<th>Customer</th>`,
    `<th>Requester · line · activity</th>`,
    `<th class="r">Value (EGP)</th>`,
    `<th>CEO approval</th>`,
    carry ? `<th>Listed as</th>` : "",
    `<th>Status</th>`,
    `<th>Pay date</th>`,
    anyNote ? `<th>Note</th>` : "",
  ].join("");

  const colgroup = (() => {
    const widths = [4, 9, 16, 18, 8, 11, ...(carry ? [10] : []), 15, 9, ...(anyNote ? [14] : [])];
    const sum = widths.reduce((a, b) => a + b, 0);
    return widths.map((width) => `<col style="width:${((width / sum) * 100).toFixed(2)}%">`).join("");
  })();

  const body = input.picked
    .map(({ note, row }, index) => {
      const approval = `${escapeHtml(houseCairoDateTime(row.approvedAtIso))}${row.approvedOnBehalfBy ? `<small>pressed by ${escapeHtml(row.approvedOnBehalfBy)}</small>` : ""}`;
      const listed = carry
        ? `<td><span class="tag${row.listedAs === "carried_over" ? " tag--carry" : ""}">${escapeHtml(CEO_APPROVAL_LISTED_AS_LABEL[row.listedAs])}</span></td>`
        : "";
      const pay = dateOnlyLabel(row.payDate);
      return `<tr>
        <td class="n">${index + 1}</td>
        <td class="code">${escapeHtml(row.requestCode)}</td>
        <td dir="auto" class="strong">${escapeHtml(row.customerName)}</td>
        <td><span class="strong">${escapeHtml(row.requesterName)}</span><small>${escapeHtml(row.lineName)} · <bdi>${escapeHtml(row.requestType)}</bdi></small></td>
        <td class="r strong">${money(row.estimatedCost)}</td>
        <td>${approval}</td>
        ${listed}
        <td><span class="strong">${escapeHtml(row.statusLabel)}</span><small>${escapeHtml(statusLine(row))}</small></td>
        <td>${pay ? escapeHtml(pay) : "Not set"}${row.payDateOverdue ? `<small class="late">Passed, not paid</small>` : ""}</td>
        ${anyNote ? `<td dir="auto">${escapeHtml(note)}</td>` : ""}
      </tr>`;
    })
    .join("");

  const figures: Array<[string, string, string]> = [
    ["Selected", String(totals.count), totals.carriedOverCount ? `${totals.carriedOverCount} carried over` : "approved in these dates"],
    ["Total value", `EGP ${money(totals.totalValue)}`, "requested value of the selected"],
    ["Executed by Finance", `EGP ${money(totals.executedValue)}`, `${totals.executedCount} request${totals.executedCount === 1 ? "" : "s"} paid out`],
    [
      "Not yet executed",
      `EGP ${money(totals.waitingValue)}`,
      `${totals.waitingCount} still open${totals.overdueCount ? ` · ${totals.overdueCount} past pay date` : ""}`,
    ],
  ];
  const figureHtml = figures
    .map(([label, value, hint]) => `<div class="fig"><p class="fig__l">${escapeHtml(label)}</p><p class="fig__v">${escapeHtml(value)}</p><p class="fig__h">${escapeHtml(hint)}</p></div>`)
    .join("");

  const totalSpan = 4;
  const afterValue = (carry ? 1 : 0) + 3 + (anyNote ? 1 : 0);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CEO Approvals ${escapeHtml(range)}</title>
<style>
${HOUSE_IDENTITY_CSS}
@page { size: A4 landscape; margin: 12mm 11mm 14mm; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; }
body { color: ${HOUSE_COLORS.body}; font-family: Aptos, "Segoe UI", "Noto Sans", "Noto Sans Arabic", Arial, sans-serif; font-size: 8.4pt; line-height: 1.35; }
.lh__title { text-align: left; padding: 3mm 0 2.5mm; }
.lh__title h1 { font-family: "Aptos Display", Aptos, "Segoe UI", Arial, sans-serif; font-size: 18pt; letter-spacing: .2pt; }
.figs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4mm; margin: 1mm 0 4.5mm; }
.fig { border-left: 1.2mm solid ${HOUSE_COLORS.light}; padding: .6mm 0 .8mm 3mm; border-bottom: .5pt solid ${HOUSE_COLORS.hair}; }
.fig__l { margin: 0; color: ${HOUSE_COLORS.muted}; font-size: 6.6pt; font-weight: 700; letter-spacing: .9pt; text-transform: uppercase; }
.fig__v { margin: .6mm 0 0; color: ${HOUSE_COLORS.deep}; font-size: 14pt; font-weight: 700; font-variant-numeric: tabular-nums; }
.fig__h { margin: .3mm 0 0; color: ${HOUSE_COLORS.muted}; font-size: 7pt; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead { display: table-header-group; }
th { color: ${HOUSE_COLORS.deep}; font-size: 6.8pt; font-weight: 700; letter-spacing: .6pt; text-transform: uppercase; text-align: left;
  padding: 1.6mm 1.4mm; border-top: 1pt solid ${HOUSE_COLORS.deep}; border-bottom: 1pt solid ${HOUSE_COLORS.deep}; vertical-align: bottom; }
td { padding: 1.5mm 1.4mm; border-bottom: .5pt solid ${HOUSE_COLORS.hair}; vertical-align: top; overflow-wrap: anywhere; }
tbody tr:nth-child(even) td { background: ${HOUSE_COLORS.tint}; }
tr { break-inside: avoid; page-break-inside: avoid; }
td small { display: block; margin-top: .4mm; color: ${HOUSE_COLORS.muted}; font-size: 7pt; }
.n { text-align: center; color: ${HOUSE_COLORS.muted}; }
.r { text-align: right; font-variant-numeric: tabular-nums; }
.strong { font-weight: 700; color: ${HOUSE_COLORS.ink}; }
.code { font-family: Consolas, "Courier New", monospace; font-size: 7.6pt; color: ${HOUSE_COLORS.deep}; }
.tag { display: inline-block; padding: .2mm 1.2mm; border: .5pt solid ${HOUSE_COLORS.deep}; color: ${HOUSE_COLORS.deep}; font-size: 6.6pt; font-weight: 700; }
.tag--carry { border-style: dashed; color: #92400E; border-color: #92400E; }
.late { color: #B91C1C !important; font-weight: 700; }
tfoot td { border-top: 1.2pt solid ${HOUSE_COLORS.deep}; border-bottom: 2.4pt double ${HOUSE_COLORS.deep}; color: ${HOUSE_COLORS.deep}; font-weight: 700; padding-top: 2mm; padding-bottom: 2mm; background: #fff; }
.foot { margin-top: 4mm; display: flex; justify-content: space-between; gap: 6mm; color: ${HOUSE_COLORS.muted}; font-size: 6.8pt; }
</style></head>
<body>
  <header class="lh">
    <div class="lh__mark"><img src="${HOUSE_MARK_SRC}" alt="${escapeHtml(systemLegalEntity.legalNameEn)}"></div>
    <div class="lh__id"><strong>${escapeHtml(HOUSE_DOCUMENT_STANDARD)}</strong>${escapeHtml(houseGeneratedAt(input.generatedAtIso))}<br>Exported by ${escapeHtml(input.exportedByName)}</div>
  </header>
  <div class="lh__rule"></div>
  <div class="lh__title"><h1>CEO Approvals</h1><p>${escapeHtml(scopeLine(input))} · ${escapeHtml(range)}</p></div>
  <section class="figs">${figureHtml}</section>
  <table>
    <colgroup>${colgroup}</colgroup>
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr>
      <td colspan="${totalSpan}">Total of ${totals.count} selected</td>
      <td class="r">${money(totals.totalValue)}</td>
      <td colspan="${afterValue}">Executed ${money(totals.executedValue)} · not yet executed ${money(totals.waitingValue)}</td>
    </tr></tfoot>
  </table>
  <div class="foot"><span>${escapeHtml(systemLegalEntity.legalNameEn)} · Marketing · CEO Approvals</span><span>Values are the requested amounts in Egyptian pounds. Times are Cairo.</span></div>
</body></html>`;
}

/** The PDF itself, printed by the repo's one Chromium. Throws ChromiumUnavailableError when it cannot run. */
export async function renderCeoApprovalsPdf(input: CeoApprovalsExportInput): Promise<Uint8Array> {
  const [{ inlineLocalAssets }, { withChromiumPage }] = await Promise.all([
    import("@/lib/hiring-pack/paper-artwork"),
    import("@/lib/pdf/chromium"),
  ]);
  const { html } = inlineLocalAssets(renderCeoApprovalsHtml(input));
  return withChromiumPage(async (page) => {
    await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
    await page.emulateMediaType("print");
    await page.evaluate(
      "(async () => { try { await document.fonts.ready; } catch {} "
        + "await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); })()",
    );
    const bytes = await page.pdf({
      displayHeaderFooter: true,
      footerTemplate: `<div style="width:100%;padding:0 11mm;font-family:Arial,sans-serif;font-size:7px;color:${HOUSE_COLORS.muted};display:flex;justify-content:space-between;"><span>${escapeHtml(HOUSE_DOCUMENT_STANDARD)} · CEO Approvals</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
      headerTemplate: "<div></div>",
      landscape: true,
      preferCSSPageSize: true,
      printBackground: true,
      timeout: 30_000,
    });
    return bytes;
  });
}

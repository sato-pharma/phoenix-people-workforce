// Monthly Marketing Functions — the Excel file, in HER layout and HER colours.
//
// 🔒 Her workbook is the design (owner, 2026-11-10: "same colors same wording"), so this sheet is
// exempt from the house document identity exactly as the other owner-handed exports are: the same five
// columns (M · Item Description (please specify the product) · Due Date · Status/ mid month ·
// Status/ end of month), the category cell merged down its band in bold with her parenthesis, every
// cell of a band in her fill, "creation" in red, thin borders all round. One title line sits above her
// header row to say whose month it is. No data validation and no conditional formatting: those are
// the parts ExcelJS writes in a shape Excel repairs.

import ExcelJS from "exceljs";

import { monthTitle, shortDateLabel } from "./months";
import type { FieldActivityLine, MarketingFunctionItem, MarketingMonthSheet } from "./types";
import {
  FIELD_VISIT_TYPE_LABELS,
  MARKETING_FUNCTION_CATEGORIES,
  MARKETING_FUNCTION_COLUMNS,
  MARKETING_FUNCTION_EMPHASIS_COLOR,
  MARKETING_FUNCTION_ORIGIN_LABELS,
  MARKETING_FUNCTION_STATUS_LABELS,
  MARKETING_FUNCTIONS_TITLE,
  MARKETING_MONTH_STATUS_LABELS,
  type MarketingFunctionCategory,
  type MarketingFunctionStatus,
} from "./vocabulary";

/** Her sheet left this many blank rows under each category; the export keeps at least as many. */
const MIN_BAND_ROWS = 2;
const HEADER_ROW = 3;

function argb(hex: string): string {
  return `FF${hex.replace("#", "").toUpperCase()}`;
}

const THIN = { style: "thin" as const, color: { argb: "FF000000" } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

function fill(cell: ExcelJS.Cell, hex: string) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(hex) } };
}

function statusText(status: MarketingFunctionStatus | null, note: string | null): string {
  const label = status ? MARKETING_FUNCTION_STATUS_LABELS[status] : "";
  if (label && note) return `${label} — ${note}`;
  return label || note || "";
}

function descriptionText(item: MarketingFunctionItem): string {
  const product = item.product ? `${item.product}: ` : "";
  const origin = item.origin === "actual" ? ` (${MARKETING_FUNCTION_ORIGIN_LABELS.actual})` : "";
  return `${product}${item.description}${origin}`;
}

function categoryRichText(category: MarketingFunctionCategory): ExcelJS.CellRichTextValue {
  const bold = { bold: true, name: "Calibri", size: 11, color: { argb: "FF000000" } };
  const parts: ExcelJS.RichText[] = [{ text: `${category.title} `, font: { ...bold, size: 12 } }];
  if (category.emphasis && category.detail.includes(category.emphasis)) {
    const [before, after] = category.detail.split(category.emphasis);
    parts.push({ text: before, font: bold });
    parts.push({ text: category.emphasis, font: { ...bold, color: { argb: argb(MARKETING_FUNCTION_EMPHASIS_COLOR) } } });
    parts.push({ text: after, font: bold });
  } else {
    parts.push({ text: category.detail, font: bold });
  }
  return { richText: parts };
}

type BandRow = { description: string; dueDate: string; mid: string; end: string };

function bandRows(sheet: MarketingMonthSheet, category: MarketingFunctionCategory): BandRow[] {
  const rows: BandRow[] = sheet.items
    .filter((item) => item.categoryKey === category.key)
    .map((item) => ({
      description: descriptionText(item),
      dueDate: shortDateLabel(item.dueDate),
      mid: statusText(item.statusMid, item.noteMid),
      end: statusText(item.statusEnd, item.noteEnd),
    }));
  if (category.key === "field") {
    rows.push(
      ...sheet.fieldActivity.map((line: FieldActivityLine) => ({
        description: `${FIELD_VISIT_TYPE_LABELS[line.visitType]} visit with ${line.repName} (field visit feedback signed)`,
        dueDate: shortDateLabel(line.visitDate),
        mid: "",
        end: MARKETING_FUNCTION_STATUS_LABELS.done,
      })),
    );
  }
  while (rows.length < MIN_BAND_ROWS) rows.push({ description: "", dueDate: "", mid: "", end: "" });
  return rows;
}

export function marketingFunctionsFileName(sheet: Pick<MarketingMonthSheet, "authorName" | "monthKey">): string {
  const who = sheet.authorName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "product-manager";
  return `marketing-functions-${who}-${sheet.monthKey}.xlsx`;
}

export async function buildMarketingFunctionsWorkbook(sheet: MarketingMonthSheet): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix";
  const title = monthTitle(sheet.monthKey);
  // Her tab was named for the month ("December").
  const worksheet = workbook.addWorksheet(title.split(" ")[0] ?? title, {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    views: [{ state: "frozen", ySplit: HEADER_ROW }],
  });
  worksheet.columns = [{ width: 30 }, { width: 62 }, { width: 18 }, { width: 24 }, { width: 24 }];

  const status = sheet.month ? MARKETING_MONTH_STATUS_LABELS[sheet.month.status] : MARKETING_MONTH_STATUS_LABELS.draft;
  worksheet.mergeCells(1, 1, 1, 5);
  const titleCell = worksheet.getCell(1, 1);
  titleCell.value = `${MARKETING_FUNCTIONS_TITLE} · ${sheet.authorName} · ${title} · ${status}`;
  titleCell.font = { bold: true, name: "Calibri", size: 14 };
  titleCell.alignment = { vertical: "middle" };
  worksheet.getRow(1).height = 24;

  const header = worksheet.getRow(HEADER_ROW);
  header.height = 36;
  const heads: Array<ExcelJS.CellValue> = [
    MARKETING_FUNCTION_COLUMNS.category,
    {
      richText: [
        { text: `${MARKETING_FUNCTION_COLUMNS.description} `, font: { bold: true, name: "Calibri", size: 14 } },
        { text: MARKETING_FUNCTION_COLUMNS.descriptionDetail, font: { bold: true, name: "Calibri", size: 11 } },
      ],
    },
    MARKETING_FUNCTION_COLUMNS.dueDate,
    MARKETING_FUNCTION_COLUMNS.statusMid,
    MARKETING_FUNCTION_COLUMNS.statusEnd,
  ];
  heads.forEach((value, index) => {
    const cell = header.getCell(index + 1);
    cell.value = value;
    if (typeof value === "string") cell.font = { bold: true, name: "Calibri", size: 14 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = BORDER;
  });

  let rowNumber = HEADER_ROW + 1;
  for (const category of MARKETING_FUNCTION_CATEGORIES) {
    const rows = bandRows(sheet, category);
    const first = rowNumber;
    for (const band of rows) {
      const row = worksheet.getRow(rowNumber);
      const values = [null, band.description, band.dueDate, band.mid, band.end];
      for (let column = 1; column <= 5; column += 1) {
        const cell = row.getCell(column);
        if (column > 1) cell.value = values[column - 1];
        fill(cell, column === 3 && category.dueDateFill ? category.dueDateFill : category.fill);
        cell.border = BORDER;
        cell.alignment = { vertical: "middle", wrapText: true, horizontal: column === 3 ? "center" : "left" };
        if (column > 1) cell.font = { name: "Calibri", size: 11 };
      }
      rowNumber += 1;
    }
    const last = rowNumber - 1;
    if (last > first) worksheet.mergeCells(first, 1, last, 1);
    const categoryCell = worksheet.getCell(first, 1);
    categoryCell.value = categoryRichText(category);
    categoryCell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  }

  if (sheet.month?.reviewedAt) {
    const row = worksheet.getRow(rowNumber + 1);
    worksheet.mergeCells(rowNumber + 1, 1, rowNumber + 1, 5);
    row.getCell(1).value = `Reviewed by ${sheet.month.reviewedByName ?? "the reviewer"}${sheet.month.reviewNote ? `: ${sheet.month.reviewNote}` : ""}`;
    row.getCell(1).font = { italic: true, name: "Calibri", size: 11 };
  }

  return (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
}

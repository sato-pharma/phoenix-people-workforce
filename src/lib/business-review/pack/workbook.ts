// The Sales Review pack — the workbook.
//
// Reads the pack model and writes it. It computes NO figure and names NO section: both come from
// `model.ts`, so the workbook a manager downloads and the PDF he downloads a minute later cannot
// disagree in front of his own manager.
//
// THE HOUSE IDENTITY, `SATO-DIS-2026-01 v1.0`, with the ink rule relaxed for the bands — the
// owner's decision on 2026-09-26, the same exemption the premium closing workbook and the spotlight
// sheet already hold. So a filled title band and filled column headers are allowed here; the 6%
// zebra row is the house's and stays exactly that.
//
// 🔴 THIS IS NOT THE AUTOMATED PAYROLL EXPORT AND MUST NOT BORROW ITS LOOK. Those stay Phoenix
// black-and-orange by a separate standing rule; this is a company-facing document and wears the
// company's identity.
//
// COLUMN WIDTHS ARE MEASURED FROM THE CONTENT, not guessed. A number that renders as `####` is a
// figure the reader cannot see, which is worse than a wide column.

import ExcelJS from "exceljs";

import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";

import type { PackSection, SalesReviewPack } from "./model";

/** ARGB, as ExcelJS wants it, from the house hex. */
const argb = (hex: string) => `FF${hex.replace("#", "").toUpperCase()}`;
const DEEP = argb(HOUSE_COLORS.deep);
const BLUE = argb(HOUSE_COLORS.blue);
const TINT = argb(HOUSE_COLORS.tint);
const HAIR = argb(HOUSE_COLORS.hair);
const BODY = argb(HOUSE_COLORS.body);
const MUTED = argb(HOUSE_COLORS.muted);
const WHITE = "FFFFFFFF";

const HAIRLINE = { color: { argb: HAIR }, style: "thin" as const };
const BOX = { bottom: HAIRLINE, left: HAIRLINE, right: HAIRLINE, top: HAIRLINE };

/**
 * A sheet name Excel will actually accept: 31 characters, and none of `[]:*?/\`.
 *
 * Truncating silently is how two sections collapse onto one name and the second write throws, so
 * the index is appended rather than the name simply cut.
 */
function sheetName(title: string, index: number): string {
  const cleaned = title.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim() || "Section";
  const suffix = ` ${index + 1}`;
  return cleaned.length + suffix.length <= 31 ? cleaned + suffix : cleaned.slice(0, 31 - suffix.length) + suffix;
}

function writeSection(book: ExcelJS.Workbook, pack: SalesReviewPack, section: PackSection, index: number) {
  const sheet = book.addWorksheet(sheetName(section.title, index), {
    views: [{ state: "frozen", ySplit: 4 }],
  });
  const width = section.columns.length;

  // ── the band ──
  sheet.mergeCells(1, 1, 1, width);
  const band = sheet.getCell(1, 1);
  band.value = section.title;
  band.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 14 };
  band.fill = { fgColor: { argb: DEEP }, pattern: "solid", type: "pattern" };
  band.alignment = { horizontal: "left", vertical: "middle" };
  sheet.getRow(1).height = 26;

  sheet.mergeCells(2, 1, 2, width);
  const subtitle = sheet.getCell(2, 1);
  subtitle.value = `${pack.subject.title} · ${pack.subject.windowLabel}`;
  subtitle.font = { bold: true, color: { argb: BODY }, name: "Calibri", size: 10 };

  // ── the note: every honesty rule the screen carries travels here ──
  sheet.mergeCells(3, 1, 3, width);
  const note = sheet.getCell(3, 1);
  note.value = section.note;
  note.font = { color: { argb: MUTED }, italic: true, name: "Calibri", size: 9 };
  note.alignment = { vertical: "top", wrapText: true };
  sheet.getRow(3).height = 28;

  // ── headings ──
  const head = sheet.getRow(4);
  section.columns.forEach((label, i) => {
    const cell = head.getCell(i + 1);
    cell.value = label;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10 };
    cell.fill = { fgColor: { argb: BLUE }, pattern: "solid", type: "pattern" };
    cell.alignment = { horizontal: section.align[i] === "right" ? "right" : "left", wrapText: true };
    cell.border = BOX;
  });
  head.height = 22;

  // ── body ──
  section.rows.forEach((row, r) => {
    const line = sheet.getRow(5 + r);
    row.forEach((value, i) => {
      const cell = line.getCell(i + 1);
      cell.value = value;
      cell.font = { color: { argb: BODY }, name: "Calibri", size: 10 };
      cell.alignment = { horizontal: section.align[i] === "right" ? "right" : "left", wrapText: true };
      cell.border = BOX;
      // The house zebra, and nothing else filled.
      if (r % 2 === 1) cell.fill = { fgColor: { argb: TINT }, pattern: "solid", type: "pattern" };
      if (typeof value === "number") cell.numFmt = Number.isInteger(value) ? "#,##0" : "#,##0.0";
    });
  });

  // ── widths, measured ──
  section.columns.forEach((label, i) => {
    let longest = label.length;
    for (const row of section.rows) {
      const value = row[i];
      const text = value == null ? "" : typeof value === "number" ? value.toLocaleString("en-US") : String(value);
      if (text.length > longest) longest = text.length;
    }
    sheet.getColumn(i + 1).width = Math.min(46, Math.max(12, longest + 2));
  });
}

/**
 * One sheet per section, plus a cover that states the subject, the window and what the window
 * holds — because a pack read without its coverage note is a set of figures with no span.
 */
export async function renderPackWorkbook(pack: SalesReviewPack): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.creator = "Phoenix Workforce";
  book.created = new Date(pack.generatedAt);

  const cover = book.addWorksheet("Cover", { views: [{ state: "frozen", ySplit: 0 }] });
  cover.mergeCells(1, 1, 1, 6);
  const title = cover.getCell(1, 1);
  title.value = "Sales Review";
  title.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 18 };
  title.fill = { fgColor: { argb: DEEP }, pattern: "solid", type: "pattern" };
  title.alignment = { horizontal: "left", vertical: "middle" };
  cover.getRow(1).height = 34;

  const facts: [string, string][] = [
    ["Subject", pack.subject.title],
    ["Window", pack.subject.windowLabel],
    ["Sections", pack.sections.map((s) => s.title).join(" · ") || "None chosen"],
    ["What the window holds", pack.coverageNote],
    // Africa/Cairo: the only time the owner reads, and the house rule for every timestamp.
    [
      "Generated",
      new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Africa/Cairo",
      }).format(new Date(pack.generatedAt)) + " Cairo",
    ],
  ];
  facts.forEach(([label, value], i) => {
    const row = cover.getRow(3 + i);
    const key = row.getCell(1);
    key.value = label;
    key.font = { bold: true, color: { argb: BODY }, name: "Calibri", size: 10 };
    cover.mergeCells(3 + i, 2, 3 + i, 6);
    const cell = row.getCell(2);
    cell.value = value;
    cell.font = { color: { argb: BODY }, name: "Calibri", size: 10 };
    cell.alignment = { vertical: "top", wrapText: true };
    row.height = label === "What the window holds" ? 64 : 18;
  });
  cover.getColumn(1).width = 24;
  for (let i = 2; i <= 6; i += 1) cover.getColumn(i).width = 18;

  pack.sections.forEach((section, i) => writeSection(book, pack, section, i));

  const out = await book.xlsx.writeBuffer();
  return Buffer.from(out);
}

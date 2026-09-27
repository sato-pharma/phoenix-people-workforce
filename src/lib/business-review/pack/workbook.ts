// The Sales Review pack — the workbook.
//
// Reads the pack model and writes it. It computes NO figure and names NO section: both come from
// `model.ts`, so the workbook a manager downloads and the PDF he downloads a minute later cannot
// disagree in front of his own manager.
//
// ── DRESSED LIKE THE PDF AND THE DECK ────────────────────────────────────────────────────────────
//
// The three files ship together and must read as one document. This wears the same house identity
// `SATO-DIS-2026-01 v1.0` the PDF and the deck take, with the ink rule relaxed for the crest band and
// the fills — the owner's decision on 2026-09-26, the same exemption the premium closing workbook and
// the Spotlight sheet hold. The cover carries the reversed mark on a near-black crest, the section
// sheets a deep title band over a brand-blue header row, and the 6% zebra is the house's and stays
// exactly that.
//
// 🔴 THIS IS NOT THE AUTOMATED PAYROLL EXPORT AND MUST NOT BORROW ITS LOOK. Those stay Phoenix
// black-and-orange by a separate standing rule; this is a company-facing document and wears the
// company's identity.
//
// COLUMN WIDTHS ARE MEASURED FROM THE CONTENT, not guessed. A number that renders as `####` is a
// figure the reader cannot see, which is worse than a wide column.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import ExcelJS from "exceljs";

import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";

import type { PackSection, SalesReviewPack } from "./model";

/** ARGB, as ExcelJS wants it, from the house hex. */
const argb = (hex: string) => `FF${hex.replace("#", "").toUpperCase()}`;
const DEEP = argb(HOUSE_COLORS.deep);
const BLUE = argb(HOUSE_COLORS.blue);
const LIGHT = argb(HOUSE_COLORS.light);
const TINT = argb(HOUSE_COLORS.tint);
const HAIR = argb(HOUSE_COLORS.hair);
const BODY = argb(HOUSE_COLORS.body);
const MUTED = argb(HOUSE_COLORS.muted);
const WHITE = "FFFFFFFF";
// The crest band — near-black, so a blue mark does not flatten against a blue ground.
const CREST = "FF0E1720";

const FONT = "Calibri";
const HAIRLINE = { color: { argb: HAIR }, style: "thin" as const };

/**
 * The record foot every sheet prints — the issuer, the window, the page and the document standard,
 * so a page printed loose still says whose it is and where it sits. `&K` sets the muted ink; the
 * three anchors (&L/&C/&R) match the PDF and the deck's three-part foot.
 */
function printFooter(windowLabel: string): string {
  const c = HOUSE_COLORS.muted.replace("#", "").toUpperCase();
  return (
    `&L&"Calibri"&8&K${c}Sato Pharma  ·  Sales Review` +
    `&C&"Calibri"&8&K${c}${windowLabel}   ·   Page &P of &N` +
    `&R&"Calibri"&8&K${c}SATO-DIS-2026-01 v1.0`
  );
}

/** Landscape, fit to one page wide — the tables are wide and a split column prints unreadable. */
function pageSetup(): Partial<ExcelJS.PageSetup> {
  return {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 },
  };
}

/** The reversed mark, read once. Null when the file cannot be read → the cover keeps its wordmark. */
let logoBuf: Buffer | null | undefined;
function crestLogo(): Buffer | null {
  if (logoBuf === undefined) {
    try {
      logoBuf = readFileSync(join(process.cwd(), "public", "brand", "sato-pharma-logo.png"));
    } catch {
      logoBuf = null;
    }
  }
  return logoBuf;
}

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

function writeSection(book: ExcelJS.Workbook, pack: SalesReviewPack, section: PackSection, index: number, total: number) {
  const sheet = book.addWorksheet(sheetName(section.title, index), {
    views: [{ state: "frozen", ySplit: 5 }],
    pageSetup: pageSetup(),
    headerFooter: { oddFooter: printFooter(pack.subject.windowLabel), evenFooter: printFooter(pack.subject.windowLabel) },
  });
  const width = section.columns.length;

  // ── the deep title band ──
  sheet.mergeCells(1, 1, 1, width);
  const band = sheet.getCell(1, 1);
  band.value = section.title;
  band.font = { bold: true, color: { argb: WHITE }, name: FONT, size: 15 };
  band.fill = { fgColor: { argb: DEEP }, pattern: "solid", type: "pattern" };
  band.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  sheet.getRow(1).height = 30;

  // ── the brand seam, a thin light rule under the band ──
  sheet.mergeCells(2, 1, 2, width);
  sheet.getCell(2, 1).fill = { fgColor: { argb: LIGHT }, pattern: "solid", type: "pattern" };
  sheet.getRow(2).height = 3;

  // ── the eyebrow: which section, and whose document ──
  sheet.mergeCells(3, 1, 3, width);
  const eyebrow = sheet.getCell(3, 1);
  eyebrow.value = `SECTION ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}   ·   SATO PHARMA · SALES REVIEW · ${pack.subject.windowLabel}`;
  eyebrow.font = { bold: true, color: { argb: BLUE }, name: FONT, size: 8 };
  eyebrow.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  sheet.getRow(3).height = 16;

  // ── the note: every honesty rule the screen carries travels here ──
  sheet.mergeCells(4, 1, 4, width);
  const note = sheet.getCell(4, 1);
  note.value = section.note;
  note.font = { color: { argb: MUTED }, italic: true, name: FONT, size: 9 };
  note.alignment = { horizontal: "left", indent: 1, vertical: "top", wrapText: true };
  sheet.getRow(4).height = 30;

  // ── headings ──
  const head = sheet.getRow(5);
  section.columns.forEach((label, i) => {
    const cell = head.getCell(i + 1);
    cell.value = label.toUpperCase();
    cell.font = { bold: true, color: { argb: WHITE }, name: FONT, size: 9 };
    cell.fill = { fgColor: { argb: BLUE }, pattern: "solid", type: "pattern" };
    cell.alignment = { horizontal: section.align[i] === "right" ? "right" : "left", vertical: "middle", wrapText: true };
    cell.border = { bottom: { color: { argb: DEEP }, style: "medium" } };
  });
  head.height = 22;

  // ── body ──
  section.rows.forEach((row, r) => {
    const line = sheet.getRow(6 + r);
    row.forEach((value, i) => {
      const cell = line.getCell(i + 1);
      cell.value = value;
      cell.font = { color: { argb: BODY }, name: FONT, size: 10 };
      cell.alignment = { horizontal: section.align[i] === "right" ? "right" : "left", vertical: "middle", wrapText: true };
      cell.border = { bottom: HAIRLINE };
      // The house zebra, and nothing else filled.
      if (r % 2 === 1) cell.fill = { fgColor: { argb: TINT }, pattern: "solid", type: "pattern" };
      if (typeof value === "number") cell.numFmt = Number.isInteger(value) ? "#,##0" : "#,##0.0";
    });
    line.height = 18;
  });
  // Close the table with a deep rule under the last row.
  const lastRow = sheet.getRow(6 + Math.max(0, section.rows.length - 1));
  for (let i = 1; i <= width; i += 1) {
    lastRow.getCell(i).border = { bottom: { color: { argb: DEEP }, style: "medium" } };
  }

  // ── widths, measured ──
  section.columns.forEach((label, i) => {
    let longest = label.length;
    for (const row of section.rows) {
      const value = row[i];
      const text = value == null ? "" : typeof value === "number" ? value.toLocaleString("en-US") : String(value);
      if (text.length > longest) longest = text.length;
    }
    sheet.getColumn(i + 1).width = Math.min(46, Math.max(12, longest + 3));
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

  const cover = book.addWorksheet("Cover", {
    views: [{ showGridLines: false }],
    pageSetup: pageSetup(),
    headerFooter: { oddFooter: printFooter(pack.subject.windowLabel), evenFooter: printFooter(pack.subject.windowLabel) },
  });
  for (let i = 1; i <= 6; i += 1) cover.getColumn(i).width = i === 1 ? 22 : 17;

  // ── the crest band, with the reversed mark laid over it ──
  cover.mergeCells(1, 1, 1, 6);
  cover.getCell(1, 1).fill = { fgColor: { argb: CREST }, pattern: "solid", type: "pattern" };
  cover.getRow(1).height = 46;
  const logo = crestLogo();
  if (logo) {
    const imageId = book.addImage({ buffer: logo, extension: "png" });
    // Height ~40px keeps the mark inside the 46px band; the aspect (401:158) sets the width.
    const h = 38;
    cover.addImage(imageId, { tl: { col: 0.25, row: 0.12 }, ext: { width: Math.round(h * (401 / 158)), height: h } });
  } else {
    const mark = cover.getCell(1, 1);
    mark.value = "SATO PHARMA";
    mark.font = { bold: true, color: { argb: WHITE }, name: FONT, size: 16 };
    mark.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  }
  // the brand seam
  cover.mergeCells(2, 1, 2, 6);
  cover.getCell(2, 1).fill = { fgColor: { argb: LIGHT }, pattern: "solid", type: "pattern" };
  cover.getRow(2).height = 4;

  const eyebrow = cover.getCell(4, 1);
  eyebrow.value = "SALES REVIEW";
  eyebrow.font = { bold: true, color: { argb: BLUE }, name: FONT, size: 11 };

  cover.mergeCells(5, 1, 5, 6);
  const subject = cover.getCell(5, 1);
  subject.value = pack.subject.title;
  subject.font = { bold: true, color: { argb: DEEP }, name: FONT, size: 26 };
  cover.getRow(5).height = 36;

  const window = cover.getCell(6, 1);
  window.value = pack.subject.windowLabel;
  window.font = { bold: true, color: { argb: LIGHT }, name: FONT, size: 14 };
  cover.getRow(6).height = 22;

  const facts: [string, string][] = [
    ["What the window holds", pack.coverageNote],
    ["In this pack", pack.sections.map((s, i) => `${String(i + 1).padStart(2, "0")}  ${s.title}`).join("\n") || "None chosen"],
    // Africa/Cairo: the only time the owner reads, and the house rule for every timestamp.
    [
      "Generated",
      new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Africa/Cairo",
      }).format(new Date(pack.generatedAt)) + " Cairo  ·  Review, not a payout record.",
    ],
    ["Document", "SATO-DIS-2026-01 v1.0"],
  ];
  let row = 8;
  facts.forEach(([label, value]) => {
    const key = cover.getCell(row, 1);
    key.value = label.toUpperCase();
    key.font = { bold: true, color: { argb: MUTED }, name: FONT, size: 8 };
    key.alignment = { horizontal: "left", vertical: "top" };
    cover.mergeCells(row, 2, row, 6);
    const cell = cover.getCell(row, 2);
    cell.value = value;
    cell.font = { color: { argb: BODY }, name: FONT, size: 10 };
    cell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    const lines = String(value).split("\n").length;
    cover.getRow(row).height = label === "What the window holds" ? 64 : label === "In this pack" ? Math.max(24, lines * 14) : 20;
    row += 2;
  });

  pack.sections.forEach((section, i) => writeSection(book, pack, section, i, pack.sections.length));

  const out = await book.xlsx.writeBuffer();
  return Buffer.from(out);
}

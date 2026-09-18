// The downloadable Phoenix universal upload template — the workbook half of
// `phoenix-template.ts` (which holds the layout, the engine profile and the distributor detector).
//
// Same "god-mode" shape as the targets template: the user picks friendly NAMES from dropdowns and
// the code columns fill themselves through in-sheet VLOOKUPs, so nobody has to know a distributor
// code or a product code to file a month of sales. Split out from the recognizer's module so the
// embedded brand image and the reference-sheet builder never load on the upload path.

import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import { PHOENIX_RAIL_MARK_PNG_BASE64 } from "@/lib/export/phoenix-pdf-assets";
import { phoenixBandHeader } from "@/lib/export/phoenix-xlsx-style";
import {
  PHOENIX_TEMPLATE_COL,
  PHOENIX_TEMPLATE_COLUMNS,
  PHOENIX_TEMPLATE_DISTRIBUTORS_SHEET,
  PHOENIX_TEMPLATE_PRODUCTS_SHEET,
  PHOENIX_TEMPLATE_SHEET,
  type TemplateDistributorOption,
} from "@/lib/sales/normalizer/phoenix-template";
import { BLACK, MUTED, ORANGE, SLATE, UNITS_FMT, WHITE, ZEBRA, gridBorder } from "@/lib/sales/sales-workbook-kit";

const INPUT_HEADER_FILL = ORANGE; // "you fill these"
const AUTO_HEADER_FILL = "FF475569"; // slate-600 — "auto, don't touch"
const HELPER_HEADER_FILL = "FF0F766E"; // teal-700 — "yours, the system ignores it"
const INPUT_CELL_FILL = "FFFEF9E7"; // soft amber
const AUTO_CELL_FILL = "FFF1F5F9"; // soft slate
const HELPER_CELL_FILL = "FFF0FDFA"; // soft teal
const REF_HEADER_FILL = "FFFFF7ED"; // warm light-orange (reference sheet headers)

const BANNER_ROWS = 2;
const HEADER_ROW = BANNER_ROWS + 1; // = 3
const FIRST_DATA_ROW = HEADER_ROW + 1; // = 4

/**
 * Rows wired with dropdowns + auto-code formulas. A real month runs far past this, which is fine:
 * a row pasted below the block still codes, because the engine resolves the product by NAME and the
 * recognizer reads the distributor by NAME. The Read Me says so in those words.
 */
export const PHOENIX_TEMPLATE_PREWIRED_ROWS = 1000;

export type TemplateProductOption = { productCode: string; productName: string; line: string };

/** Quote a sheet name for a formula reference. */
const q = (name: string) => `'${name.replace(/'/g, "''")}'`;

/**
 * Build the branded Phoenix universal template.
 *
 * `distributors` and `products` drive the two dropdowns and the two VLOOKUP columns; when either is
 * empty the sheet still renders (with an empty list), so a masters outage degrades to a usable blank
 * form rather than a failed download.
 */
export async function buildPhoenixTemplateWorkbook(input: {
  distributors: readonly TemplateDistributorOption[];
  products: readonly TemplateProductOption[];
  now?: Date;
}): Promise<ExcelJS.Buffer> {
  const distributors = [...input.distributors].sort((a, b) => a.distributorName.localeCompare(b.distributorName));
  const products = [...input.products].sort((a, b) => a.productName.localeCompare(b.productName));

  const wb = new ExcelJS.Workbook();
  wb.creator = systemIdentity.appName;
  wb.company = systemIdentity.appName;
  wb.created = input.now ?? new Date();

  const ws = wb.addWorksheet(PHOENIX_TEMPLATE_SHEET, { views: [{ state: "frozen", xSplit: 0, ySplit: HEADER_ROW }] });
  ws.columns = PHOENIX_TEMPLATE_COLUMNS.map((col, i) => ({ key: `c${i}`, width: col.width }));

  // ── Brand banner (rows 1-2). buildHeaderMap scans for the richest header row, so a banner is safe.
  const lastColLetter = ws.getColumn(PHOENIX_TEMPLATE_COLUMNS.length).letter;
  ws.mergeCells(`A1:${lastColLetter}1`);
  const title = ws.getCell("A1");
  title.value = `${systemIdentity.appName} — Sales upload template`;
  title.font = { bold: true, color: { argb: ORANGE }, name: "Calibri", size: 16 };
  title.alignment = { vertical: "middle", horizontal: "left", indent: 5 };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  ws.getRow(1).height = 30;

  ws.mergeCells(`A2:${lastColLetter}2`);
  const sub = ws.getCell("A2");
  sub.value =
    "One distributor per file · pick the distributor and the product by name — the codes fill in automatically · the two Helper columns are yours";
  sub.font = { italic: true, color: { argb: MUTED }, name: "Calibri", size: 10 };
  sub.alignment = { vertical: "middle", horizontal: "left", indent: 5 };
  sub.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  ws.getRow(2).height = 18;

  try {
    const imageId = wb.addImage({ base64: PHOENIX_RAIL_MARK_PNG_BASE64, extension: "png" });
    ws.addImage(imageId, { tl: { col: 0.12, row: 0.12 }, ext: { width: 40, height: 40 }, editAs: "oneCell" });
  } catch {
    // Emblem is decorative — never block the download if the image fails to embed.
  }

  // ── Header row: input columns orange, auto columns slate, helper columns teal.
  const headerRow = ws.getRow(HEADER_ROW);
  PHOENIX_TEMPLATE_COLUMNS.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: col.kind === "auto" ? AUTO_HEADER_FILL : col.kind === "helper" ? HELPER_HEADER_FILL : INPUT_HEADER_FILL },
    };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: ORANGE } } };
    cell.note = col.note;
  });
  headerRow.height = 30;

  // ── The pre-wired block. ExcelJS formulae carry NO leading "=".
  const distCodeFx = (r: number) =>
    `IF($A${r}="","",IFERROR(VLOOKUP($A${r},${q(PHOENIX_TEMPLATE_DISTRIBUTORS_SHEET)}!$A:$B,2,FALSE),""))`;
  const productCodeFx = (r: number) =>
    `IF($H${r}="","",IFERROR(VLOOKUP($H${r},${q(PHOENIX_TEMPLATE_PRODUCTS_SHEET)}!$A:$C,2,FALSE),""))`;

  const lastRow = FIRST_DATA_ROW + PHOENIX_TEMPLATE_PREWIRED_ROWS - 1;
  for (let r = FIRST_DATA_ROW; r <= lastRow; r += 1) {
    ws.getCell(r, PHOENIX_TEMPLATE_COL.distributorCode).value = { formula: distCodeFx(r), result: "" };
    ws.getCell(r, PHOENIX_TEMPLATE_COL.productCode).value = { formula: productCodeFx(r), result: "" };
    PHOENIX_TEMPLATE_COLUMNS.forEach((col, ci) => {
      const cell = ws.getCell(r, ci + 1);
      cell.border = gridBorder();
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: col.kind === "auto" ? AUTO_CELL_FILL : col.kind === "helper" ? HELPER_CELL_FILL : INPUT_CELL_FILL },
      };
      cell.font = { color: { argb: col.kind === "auto" ? MUTED : SLATE }, name: "Calibri", size: 10.5, italic: col.kind === "auto" };
      cell.alignment = { vertical: "middle", horizontal: ci + 1 === PHOENIX_TEMPLATE_COL.quantity ? "right" : "left" };
    });
    ws.getCell(r, PHOENIX_TEMPLATE_COL.quantity).numFmt = UNITS_FMT;
    // Text, so a customer code with leading zeros survives the paste ("0001502731" stays itself).
    ws.getCell(r, PHOENIX_TEMPLATE_COL.customerCode).numFmt = "@";
    ws.getCell(r, PHOENIX_TEMPLATE_COL.invoiceDate).numFmt = "dd-mm-yyyy";
  }

  // ── Dropdowns. Per-cell (not range-level): that is the form proven in production by the targets
  // template, and ExcelJS's range API is not in its type definitions here.
  const listDV = (formula: string, promptTitle: string, prompt: string): ExcelJS.DataValidation => ({
    type: "list",
    allowBlank: true,
    formulae: [formula],
    showErrorMessage: true,
    errorTitle: "Not in the list",
    error: "Pick a value from the dropdown list.",
    showInputMessage: true,
    promptTitle,
    prompt,
  });
  const distributorDV = listDV(
    `${q(PHOENIX_TEMPLATE_DISTRIBUTORS_SHEET)}!$A$2:$A$${1 + Math.max(distributors.length, 1)}`,
    "Distributor",
    "Pick the distributor — the code fills in automatically. One distributor per file.",
  );
  const productDV = listDV(
    `${q(PHOENIX_TEMPLATE_PRODUCTS_SHEET)}!$A$2:$A$${1 + Math.max(products.length, 1)}`,
    "Product",
    "Pick the product — the code fills in automatically.",
  );
  for (let r = FIRST_DATA_ROW; r <= lastRow; r += 1) {
    ws.getCell(r, PHOENIX_TEMPLATE_COL.distributorName).dataValidation = distributorDV;
    ws.getCell(r, PHOENIX_TEMPLATE_COL.productName).dataValidation = productDV;
  }
  ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: HEADER_ROW, column: PHOENIX_TEMPLATE_COLUMNS.length } };

  // ── Reference sheets. Their headers are DELIBERATELY not the Sales sheet's header names, so
  // pickBestSheet can never mistake a lookup tab for the data tab.
  writeReferenceSheet(
    wb.addWorksheet(PHOENIX_TEMPLATE_DISTRIBUTORS_SHEET),
    ["Distributor", "Code"],
    [34, 16],
    distributors.map((d) => [d.distributorName, d.distributorCode]),
  );
  writeReferenceSheet(
    wb.addWorksheet(PHOENIX_TEMPLATE_PRODUCTS_SHEET),
    ["Product", "Code", "Line"],
    [34, 14, 20],
    products.map((p) => [p.productName, p.productCode, p.line]),
  );

  buildReadMe(wb, distributors.length, products.length);

  return wb.xlsx.writeBuffer();
}

/** A branded reference sheet: light header row 1, zebra body from row 2 (VLOOKUP-friendly). */
function writeReferenceSheet(
  sheet: ExcelJS.Worksheet,
  headers: string[],
  widths: number[],
  rows: (string | number)[][],
): void {
  headers.forEach((h, i) => {
    sheet.getColumn(i + 1).width = widths[i] ?? 16;
    const cell = sheet.getCell(1, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: BLACK }, name: "Calibri", size: 10.5 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: REF_HEADER_FILL } };
    cell.alignment = { vertical: "middle", horizontal: i === 0 ? "left" : "center" };
    cell.border = gridBorder();
  });
  rows.forEach((cells, ri) => {
    const excelRow = sheet.getRow(2 + ri);
    cells.forEach((value, ci) => {
      const cell = excelRow.getCell(ci + 1);
      cell.value = value;
      cell.font = { color: { argb: SLATE }, name: "Calibri", size: 10.5 };
      cell.alignment = { vertical: "middle", horizontal: ci === 0 ? "left" : "center" };
      cell.border = gridBorder();
      if (ri % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
    });
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/** The branded "Read Me" cover: brand band + how-to steps + column reference. */
function buildReadMe(wb: ExcelJS.Workbook, distributorCount: number, productCount: number): void {
  const ref = wb.addWorksheet("Read Me");
  ref.getColumn(1).width = 22;
  ref.getColumn(2).width = 104;
  phoenixBandHeader(ref, 2, "Sales upload template — how to use", "One layout for every distributor · pick names, codes fill themselves");

  const lines: Array<{ text: string; heading?: boolean }> = [
    { text: "" },
    { text: "Fill the amber columns. The grey columns fill themselves. The teal columns are yours.", heading: true },
    { text: "   1.  Distributor Name   — pick from the dropdown. Distributor Code fills in automatically. ONE distributor per file." },
    { text: "   2.  Invoice Date       — the date on the invoice (DD-MM-YYYY). The month decides which period the sale is booked in." },
    { text: "   3.  Customer Code      — the distributor's own code for the pharmacy or customer." },
    { text: "   4.  Customer Name      — the customer's name as the distributor writes it." },
    { text: "   5.  Customer Address   — the address. This is the first thing the system reads when it works out the brick." },
    { text: "   6.  Territory / Area   — optional. The distributor's own area text, when the file has one." },
    { text: "   7.  Product Name       — pick from the dropdown. Product Code fills in automatically." },
    { text: "   8.  Quantity           — units sold. Value is computed as units x factory price, exactly as for every other distributor." },
    { text: "   9.  Helper 1, Helper 2 — yours to use for anything (invoice number, branch, a note). The system keeps them with the row and ignores them." },
    { text: "" },
    { text: "Then upload it on Sales > Source Normalizer, choosing 'Phoenix template' instead of a distributor name.", heading: true },
    { text: "From that moment it behaves exactly like any distributor's own file: the system analyses it, shows you the customers," },
    { text: "products and territories it could not place, you map them once, and you download the coded file or import the month." },
    { text: "" },
    { text: "Rules the upload enforces:", heading: true },
    { text: "   •  Distributor Name, Invoice Date, Customer Code, Customer Name, Customer Address, Product Name and Quantity are obligatory." },
    { text: "   •  One distributor per file — a second distributor in the same sheet is refused, because a batch is one distributor per month." },
    { text: "   •  Type nothing into the grey Distributor Code / Product Code columns; they are formulas, and they are what the file is read by." },
    { text: "   •  Blank rows are ignored, so you never need to delete the spare ones." },
    { text: "" },
    { text: `About ${PHOENIX_TEMPLATE_PREWIRED_ROWS.toLocaleString("en-US")} rows come ready with the dropdowns and the auto-code formulas.`, heading: true },
    { text: "A longer month is fine: paste the extra rows underneath. As long as Distributor Name and Product Name are filled," },
    { text: "those rows are read correctly too — the system matches the product by NAME first and the code only as a fallback." },
    { text: "" },
    { text: `The '${PHOENIX_TEMPLATE_DISTRIBUTORS_SHEET}' tab lists ${distributorCount.toLocaleString("en-US")} distributors and the '${PHOENIX_TEMPLATE_PRODUCTS_SHEET}' tab lists ${productCount.toLocaleString("en-US")} products.`, heading: true },
    { text: "They feed the dropdowns and the auto-fill. Don't rename either tab, or the automatic codes stop working." },
  ];
  let r = 4;
  for (const line of lines) {
    const cell = ref.getCell(r, 2);
    cell.value = line.text;
    cell.font = line.heading
      ? { bold: true, color: { argb: BLACK }, name: "Calibri", size: 10.5 }
      : { color: { argb: SLATE }, name: "Calibri", size: 10.5 };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    r += 1;
  }

  // Column reference table.
  r += 1;
  const colHead1 = ref.getCell(r, 1);
  colHead1.value = "Column";
  const colHead2 = ref.getCell(r, 2);
  colHead2.value = "Meaning";
  for (const cell of [colHead1, colHead2]) {
    cell.font = { bold: true, color: { argb: BLACK }, name: "Calibri", size: 10.5 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: REF_HEADER_FILL } };
    cell.border = gridBorder();
    cell.alignment = { vertical: "middle", horizontal: "left" };
  }
  r += 1;
  for (const col of PHOENIX_TEMPLATE_COLUMNS) {
    const label = ref.getCell(r, 1);
    label.value = col.header;
    label.font = {
      bold: true,
      color: { argb: col.kind === "auto" ? SLATE : col.kind === "helper" ? HELPER_HEADER_FILL : "FFB45309" },
      name: "Calibri",
      size: 10,
    };
    label.alignment = { vertical: "middle", horizontal: "left" };
    label.border = gridBorder();
    const meaning = ref.getCell(r, 2);
    meaning.value = col.note;
    meaning.font = { color: { argb: SLATE }, name: "Calibri", size: 10 };
    meaning.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    meaning.border = gridBorder();
    r += 1;
  }
}

// Targets upload template + parser for the 42-area seat model. One target per
// (period, line, area, product).
//
// "God-mode" smart template: the user picks friendly NAMES from dropdowns and every
// code / line / unit-price / value auto-fills via in-sheet formulas —
//   • Product Name (dropdown) → Product Code, Line, Unit Price
//   • Area Name (dropdown)    → Area Code
//   • Target Units (typed)    → Target Value = Units × Unit Price
// The grey "auto" columns are what the upload reads, so they stay live formulas.
//
// Upload stays 100% compatible: parseTargetsWorkbook maps by header NAME (Period,
// Line, Area Code, Product Code, Target Value, Target Units) and now scans every sheet
// for the header row, so the friendly-name columns and a top brand banner are ignored.
// Phoenix identity via the shared workbook kit (brand band, black/orange palette,
// Calibri, embedded rail-mark). Mirrors the Sales Queue / ROI export house style.
import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import { PHOENIX_RAIL_MARK_PNG_BASE64 } from "@/lib/export/phoenix-pdf-assets";
import { phoenixBandHeader } from "@/lib/export/phoenix-xlsx-style";
import {
  BLACK,
  ORANGE,
  WHITE,
  SLATE,
  MUTED,
  ZEBRA,
  UNITS_FMT,
  gridBorder,
  sanitizeSheetName,
} from "@/lib/sales/sales-workbook-kit";
import type { TargetInputRow } from "@/lib/sales/monthly-targets";

// ── Palette (house kit + a few soft form-fills) ───────────────────────────────
const VALUE_FMT = "#,##0"; // EGP target value — integer, house convention
const PRICE_FMT = "#,##0.00"; // unit factory price — 2 dp
const INPUT_HEADER_FILL = ORANGE; // "you fill these"
const AUTO_HEADER_FILL = "FF475569"; // slate-600 — "auto, don't touch"
const INPUT_CELL_FILL = "FFFEF9E7"; // soft amber
const AUTO_CELL_FILL = "FFF1F5F9"; // soft slate
const SAMPLE_CELL_FILL = "FFECFDF5"; // soft green (example rows)
const SAMPLE_TEXT = "FF166534";
const REF_HEADER_FILL = "FFFFF7ED"; // warm light-orange (reference sheet headers)

const PREWIRED_ROWS = 200; // 42 areas × up to a few products, with headroom

/** Blank rows kept below a laid-out block so a row can always be added by hand. */
const SPARE_ROWS = 40;
const BANNER_ROWS = 2; // row1 brand title, row2 subtitle
const HEADER_ROW = BANNER_ROWS + 1; // = 3
const FIRST_DATA_ROW = HEADER_ROW + 1; // = 4

type Kind = "input" | "auto";
type ColDef = { header: string; kind: Kind; width: number; numFmt?: string; note: string };

// Display order only — the parser maps by header name, not position. The friendly-name
// columns (Product Name, Area Name) and Unit Price are IGNORED by the parser; it reads
// Product Code / Line / Area Code / Target Units / Target Value.
const COLUMNS: ColDef[] = [
  { header: "Period", kind: "input", width: 12, note: "Target month as YYYY-MM. Pick from the dropdown." },
  { header: "Product Name", kind: "input", width: 24, note: "Pick the product — Product Code, Line and Unit Price fill in automatically." },
  { header: "Product Code", kind: "auto", width: 14, note: "AUTO from Product Name — do not type. This is what the upload reads." },
  { header: "Line", kind: "auto", width: 14, note: "AUTO from Product Name — do not type." },
  { header: "Area Name", kind: "input", width: 28, note: "Pick the area — Area Code fills in automatically." },
  { header: "Area Code", kind: "auto", width: 12, note: "AUTO from Area Name — do not type. This is what the upload reads." },
  { header: "Target Units", kind: "input", width: 13, numFmt: UNITS_FMT, note: "Type the unit target. Target Value = Units × Unit Price." },
  { header: "Unit Price", kind: "auto", width: 13, numFmt: PRICE_FMT, note: "AUTO factory price (EGP) — do not type." },
  { header: "Target Value", kind: "auto", width: 16, numFmt: VALUE_FMT, note: "AUTO = Units × Unit Price (EGP). To set a value-only target, type a number over this cell." },
];
// 1-based column indexes derived from COLUMNS order.
const COL = { period: 1, productName: 2, productCode: 3, line: 4, areaName: 5, areaCode: 6, units: 7, unitPrice: 8, value: 9 } as const;

const HEADER_KEY: Record<string, keyof Omit<TargetInputRow, "rowNumber">> = {
  period: "period",
  line: "line",
  areacode: "area",
  area: "area",
  productcode: "product",
  product: "product",
  targetvalue: "targetValue",
  value: "targetValue",
  targetunits: "targetUnits",
  units: "targetUnits",
};

function headerKey(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export type TargetTemplateArea = { areaCode: string; areaName: string; regionCode: string | null };
export type TargetTemplateProduct = { productCode: string; productName: string; factoryPrice: number | null };

const REGION_LABELS: Record<string, string> = {
  AB: "Alex-BHR", CA: "Cairo", D1: "Delta 1", D2: "Delta 2", GZ: "Giza", SH: "Sharkia", UE: "Upper Egypt", OT: "Others",
};

/**
 * A region code's display name, including a line-specific district split (Anti Infective's
 * `UE-1`/`UE-2` Upper Egypt districts) that REGION_LABELS has no entry for. Strips the trailing
 * `-<digits>` to find the family's label and reattaches the district number ("UE-1" -> "Upper
 * Egypt 1"), rather than hardcoding every split code by hand — a future line-specific split adds
 * no new entry here, the same way it needs none in `au_v_line_area_map`.
 */
function regionLabelFor(regionCode: string): string {
  const district = /^([A-Z]+)-(\d+)$/.exec(regionCode);
  if (district) {
    const familyLabel = REGION_LABELS[district[1]];
    if (familyLabel) return `${familyLabel} ${district[2]}`;
  }
  return REGION_LABELS[regionCode] ?? regionCode;
}

/** Months dropdown: current month + the next 17 (built from a caller-supplied "now"). */
function buildMonths(now: Date): string[] {
  const out: string[] = [];
  const year = now.getFullYear();
  const month = now.getMonth();
  for (let i = 0; i < 18; i += 1) {
    const d = new Date(year, month + i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/**
 * Generate the smart, Phoenix-branded targets template for one line. `products` and
 * `areas` drive the dropdowns + auto-fill; when empty the sheet still renders (blank
 * dropdowns). Returns an .xlsx ArrayBuffer.
 */
export async function generateTargetsTemplate(opts?: {
  lineLabel?: string;
  areas?: ReadonlyArray<TargetTemplateArea>;
  products?: ReadonlyArray<TargetTemplateProduct>;
  /**
   * The months the sheet is laid out for — one row per (period × area × product). A month, a
   * quarter or a semester, chosen on the page. Omitted (or empty) keeps the old two-example
   * behaviour, which is what any caller that has not asked for a span still expects.
   */
  periods?: ReadonlyArray<string>;
  /**
   * Existing targets, keyed `${period}|${areaCode}|${productCode}`. Present = the POPULATED
   * download: the same sheet with the numbers already in it, so a month can be edited in Excel
   * and uploaded back rather than re-typed from nothing.
   */
  existing?: ReadonlyMap<string, { targetUnits: number | null; targetValue: number | null }>;
  /**
   * The factory price of a product IN A MONTH (product-period-price.ts). A price can differ by month —
   * Saginko is 111.15 through 2026-09 and 170.52 from 2026-10 — and `target_value` is STORED while the
   * sales it is divided into are priced per month, so a target valued at the wrong month's price
   * inflates achievement (53% for Saginko). Every row is priced at its OWN Period, in the cached
   * figures and in the sheet's formula, so a semester laid out across October still values October
   * at 170.52. Absent, every row takes the product's `factoryPrice`, as before.
   */
  priceFor?: (productCode: string, period: string) => number | null;
  now?: Date;
}): Promise<ArrayBuffer> {
  const lineLabel = opts?.lineLabel?.trim() || "All lines";
  const areas = opts?.areas ?? [];
  const products = opts?.products ?? [];
  const priceIn = (product: TargetTemplateProduct | undefined, period: string): number | null => {
    if (!product) return null;
    const dated = opts?.priceFor?.(product.productCode, period);
    return dated != null && dated > 0 ? dated : (product.factoryPrice ?? null);
  };
  // The dropdown offers the rolling 18 months PLUS every month this sheet was laid out for, so a
  // populated download of a past month still validates against its own Period cells.
  const months = [...new Set([...(opts?.periods ?? []), ...buildMonths(opts?.now ?? new Date())])].sort();

  const wb = new ExcelJS.Workbook();
  wb.creator = systemIdentity.appName;
  wb.company = systemIdentity.appName;
  wb.created = opts?.now ?? new Date();

  const prodSheetName = sanitizeSheetName(`Products (${lineLabel})`);
  const areaSheetName = sanitizeSheetName(`Areas (${lineLabel})`);
  const listsSheetName = "Lists";
  const q = (name: string) => `'${name.replace(/'/g, "''")}'`;

  // ── Sheet 1 — Targets (must remain the first tab; parser also scans for it) ──
  const ws = wb.addWorksheet("Targets", { views: [{ state: "frozen", ySplit: HEADER_ROW }] });
  ws.columns = COLUMNS.map((col, i) => ({ key: `c${i}`, width: col.width }));

  // Brand banner (rows 1-2). The parser scans for the header row, so this is safe.
  const lastColLetter = ws.getColumn(COLUMNS.length).letter;
  ws.mergeCells(`A1:${lastColLetter}1`);
  const title = ws.getCell("A1");
  title.value = `${systemIdentity.appName} — Field Targets`;
  title.font = { bold: true, color: { argb: ORANGE }, name: "Calibri", size: 16 };
  title.alignment = { vertical: "middle", horizontal: "left", indent: 5 };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  ws.getRow(1).height = 30;

  ws.mergeCells(`A2:${lastColLetter}2`);
  const sub = ws.getCell("A2");
  sub.value = `${lineLabel} · pick Product & Area names — codes, line, price and value fill in automatically · Target Value = Units × Unit Price`;
  sub.font = { italic: true, color: { argb: MUTED }, name: "Calibri", size: 10 };
  sub.alignment = { vertical: "middle", horizontal: "left", indent: 5 };
  sub.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  ws.getRow(2).height = 18;

  try {
    const imageId = wb.addImage({ base64: PHOENIX_RAIL_MARK_PNG_BASE64, extension: "png" });
    ws.addImage(imageId, { tl: { col: 0.12, row: 0.12 }, ext: { width: 40, height: 40 }, editAs: "oneCell" });
  } catch {
    // Emblem is decorative — never block the export if the image fails to embed.
  }

  // Column headers (row 3): input columns orange, auto columns slate.
  const headerRow = ws.getRow(HEADER_ROW);
  COLUMNS.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: col.kind === "input" ? INPUT_HEADER_FILL : AUTO_HEADER_FILL } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: ORANGE } } };
    cell.note = col.note;
  });
  headerRow.height = 28;

  // Formula builders (ExcelJS formulae carry NO leading "=").
  const codeFx = (r: number) => `IF($B${r}="","",IFERROR(VLOOKUP($B${r},${q(prodSheetName)}!$A:$D,2,FALSE),""))`;
  const lineFx = (r: number) => `IF($B${r}="","",IFERROR(VLOOKUP($B${r},${q(prodSheetName)}!$A:$D,3,FALSE),""))`;
  // The price of THIS row's product in THIS row's Period, from the dated table on Lists (C:D, keyed
  // "Product Name|YYYY-MM"); a month missing from it falls back to the Products tab's price.
  const priceFx = (r: number) =>
    `IF($B${r}="","",IFERROR(VLOOKUP($B${r}&"|"&$A${r},${q(listsSheetName)}!$C:$D,2,FALSE),IFERROR(VLOOKUP($B${r},${q(prodSheetName)}!$A:$D,4,FALSE),"")))`;
  const areaFx = (r: number) => `IF($E${r}="","",IFERROR(VLOOKUP($E${r},${q(areaSheetName)}!$A:$C,2,FALSE),""))`;
  const valueFx = (r: number) => `IF(OR($G${r}="",$H${r}=""),"",$G${r}*$H${r})`;

  // ── The data block ──────────────────────────────────────────────────────────
  //
  // With a span (`periods`) the sheet is LAID OUT: one row for every period × area × product, with
  // Period, Product and Area already filled, so the whole job is typing a column of units. The
  // populated download is the same layout with `existing` written into it, which is what makes the
  // sheet round-trip — download, edit, upload — instead of being a blank form.
  //
  // Without a span it keeps the two green examples it always had. Both shapes upload identically:
  // `parseTargetsWorkbook` maps by header NAME and ignores blank rows.
  type Planned = { period: string; product?: TargetTemplateProduct; area?: TargetTemplateArea; units: number | null; value: number | null; sample: boolean };
  const planned: Planned[] = [];
  const spanMonths = (opts?.periods ?? []).filter((period) => typeof period === "string" && period.trim() !== "");

  if (spanMonths.length > 0) {
    for (const period of spanMonths) {
      for (const area of areas) {
        for (const product of products) {
          const stored = opts?.existing?.get(`${period}|${area.areaCode}|${product.productCode.toUpperCase()}`);
          planned.push({
            period,
            product,
            area,
            units: stored?.targetUnits ?? null,
            value: stored?.targetValue ?? null,
            sample: false,
          });
        }
      }
    }
  } else {
    if (products[0] && areas[0]) planned.push({ period: months[0], product: products[0], area: areas[0], units: 1000, value: null, sample: true });
    if (products[Math.min(1, products.length - 1)] && areas[Math.min(1, areas.length - 1)]) {
      planned.push({
        period: months[0],
        product: products[Math.min(1, products.length - 1)],
        area: areas[Math.min(1, areas.length - 1)],
        units: 500,
        value: null,
        sample: true,
      });
    }
  }

  // Spare blank rows below the block, so a row can always be added by hand.
  const dataRows = Math.max(PREWIRED_ROWS, planned.length + SPARE_ROWS);

  for (let i = 0; i < dataRows; i += 1) {
    const r = FIRST_DATA_ROW + i;
    const sample = planned[i];
    const price = sample ? priceIn(sample.product, sample.period) : null;
    // A value-only target (units unknown) must survive the round trip, so the Target Value cell
    // carries the stored number as a LITERAL rather than the units × price formula.
    const valueIsLiteral = !!sample && sample.units == null && sample.value != null;
    const resultOf = {
      code: sample?.product?.productCode ?? "",
      line: sample ? lineLabel : "",
      area: sample?.area?.areaCode ?? "",
      price: price ?? "",
      value: sample && sample.units != null && price != null ? sample.units * price : (sample?.value ?? ""),
    };
    // Input cells (literal on planned rows, blank otherwise).
    if (sample) {
      ws.getCell(r, COL.period).value = sample.period;
      ws.getCell(r, COL.productName).value = sample.product?.productName ?? "";
      ws.getCell(r, COL.areaName).value = sample.area?.areaName ?? "";
      if (sample.units != null) ws.getCell(r, COL.units).value = sample.units;
    }
    // Auto cells (formulas; sample rows carry a cached result so they read correct pre-recalc).
    ws.getCell(r, COL.productCode).value = { formula: codeFx(r), result: resultOf.code };
    ws.getCell(r, COL.line).value = { formula: lineFx(r), result: resultOf.line };
    ws.getCell(r, COL.areaCode).value = { formula: areaFx(r), result: resultOf.area };
    ws.getCell(r, COL.unitPrice).value = { formula: priceFx(r), result: resultOf.price };
    ws.getCell(r, COL.value).value = valueIsLiteral
      ? sample.value
      : { formula: valueFx(r), result: resultOf.value };

    // Per-cell styling + number formats.
    COLUMNS.forEach((col, ci) => {
      const cell = ws.getCell(r, ci + 1);
      cell.border = gridBorder();
      if (col.numFmt) cell.numFmt = col.numFmt;
      cell.alignment = { vertical: "middle", horizontal: ci + 1 === COL.productName || ci + 1 === COL.areaName ? "left" : "center" };
      if (sample?.sample) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SAMPLE_CELL_FILL } };
        cell.font = { color: { argb: SAMPLE_TEXT }, name: "Calibri", size: 10, italic: col.kind === "auto" };
      } else {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: col.kind === "input" ? INPUT_CELL_FILL : AUTO_CELL_FILL } };
        cell.font = { color: { argb: col.kind === "auto" ? MUTED : SLATE }, name: "Calibri", size: 10.5, italic: col.kind === "auto" };
      }
    });
  }

  // Dropdowns across the whole data block.
  const lastRow = FIRST_DATA_ROW + dataRows - 1;
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
  const periodDV = listDV(`${q(listsSheetName)}!$A$2:$A$${1 + months.length}`, "Target month", "Pick the target month (YYYY-MM).");
  const productDV = listDV(`${q(prodSheetName)}!$A$2:$A$${1 + Math.max(products.length, 1)}`, "Product", "Pick the product — code, line and price auto-fill.");
  const areaDV = listDV(`${q(areaSheetName)}!$A$2:$A$${1 + Math.max(areas.length, 1)}`, "Area", "Pick the area — area code auto-fills.");
  for (let r = FIRST_DATA_ROW; r <= lastRow; r += 1) {
    ws.getCell(r, COL.period).dataValidation = periodDV;
    ws.getCell(r, COL.productName).dataValidation = productDV;
    ws.getCell(r, COL.areaName).dataValidation = areaDV;
  }

  // ── Reference sheets (feed the dropdowns + VLOOKUP). Name-first for VLOOKUP. ──
  writeReferenceSheet(
    wb.addWorksheet(prodSheetName),
    ["Product Name", "Product Code", "Line", "Unit Price (EGP)"],
    [24, 14, 12, 16],
    products.map((p) => [p.productName, p.productCode, lineLabel, p.factoryPrice ?? ""]),
    [undefined, undefined, undefined, PRICE_FMT],
  );
  writeReferenceSheet(
    wb.addWorksheet(areaSheetName),
    ["Area Name", "Area Code", "Region"],
    [28, 12, 14],
    areas.map((a) => [a.areaName, a.areaCode, a.regionCode ? regionLabelFor(a.regionCode) : ""]),
    [undefined, undefined, undefined],
  );
  const listsWs = wb.addWorksheet(listsSheetName);
  writeReferenceSheet(listsWs, ["Target Month"], [16], months.map((m) => [m]), ["@"]);
  // Beside the months, every product's price in every month the sheet offers — what the Unit Price
  // formula reads, so a row's price follows its Period whichever month the dropdown is set to.
  writeReferenceSheet(
    listsWs,
    ["Price Key", "Unit Price (EGP)"],
    [30, 16],
    products.flatMap((product) => months.map((month) => [`${product.productName}|${month}`, priceIn(product, month) ?? ""])),
    ["@", PRICE_FMT],
    3,
  );

  // ── Read Me (branded how-to + column reference) ──
  buildReadMe(wb, lineLabel);

  return wb.xlsx.writeBuffer();
}

/** A branded reference sheet: black header row 1, zebra body from row 2 (VLOOKUP-friendly). */
function writeReferenceSheet(
  sheet: ExcelJS.Worksheet,
  headers: string[],
  widths: number[],
  rows: (string | number)[][],
  numFmts: (string | undefined)[],
  /** 1-based column the table starts in, so a second table can sit beside the first. */
  startColumn = 1,
): void {
  headers.forEach((h, i) => {
    sheet.getColumn(startColumn + i).width = widths[i] ?? 16;
    const cell = sheet.getCell(1, startColumn + i);
    cell.value = h;
    cell.font = { bold: true, color: { argb: BLACK }, name: "Calibri", size: 10.5 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: REF_HEADER_FILL } };
    cell.alignment = { vertical: "middle", horizontal: i === 0 ? "left" : "center" };
    cell.border = gridBorder();
  });
  rows.forEach((cells, ri) => {
    const excelRow = sheet.getRow(2 + ri);
    cells.forEach((value, ci) => {
      const cell = excelRow.getCell(startColumn + ci);
      cell.value = value;
      if (numFmts[ci]) cell.numFmt = numFmts[ci] as string;
      cell.font = { color: { argb: SLATE }, name: "Calibri", size: 10.5 };
      cell.alignment = { vertical: "middle", horizontal: ci === 0 ? "left" : "center" };
      cell.border = gridBorder();
      if (ri % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
    });
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/** The branded "Read Me" cover: brand band + how-to steps + column reference. */
function buildReadMe(wb: ExcelJS.Workbook, lineLabel: string): void {
  const ref = wb.addWorksheet("Read Me");
  ref.getColumn(1).width = 4;
  ref.getColumn(2).width = 104;
  phoenixBandHeader(ref, 2, "Field Targets — how to use", `${lineLabel} · pick names, everything else auto-fills`);

  const lines: Array<{ text: string; heading?: boolean }> = [
    { text: "" },
    { text: "You only fill the amber columns — the grey columns fill themselves:", heading: true },
    { text: "   1.  Period        — pick the target month (YYYY-MM) from the dropdown." },
    { text: "   2.  Product Name  — pick from the dropdown. Product Code, Line and Unit Price fill in automatically." },
    { text: "   3.  Area Name     — pick from the dropdown. Area Code fills in automatically." },
    { text: "   4.  Target Units  — type the units. Target Value (EGP) computes automatically = Units × Unit Price." },
    { text: "" },
    { text: "The grey columns (Product Code, Line, Area Code, Unit Price, Target Value) are AUTO — leave them as formulas.", heading: true },
    { text: "They are exactly what the system reads on upload, so keep them intact." },
    { text: "" },
    { text: "Value-only target? Type a number straight over the grey Target Value cell for that row — everything else still works." },
    { text: "The two GREEN example rows show a filled target — replace them with your real numbers or delete them." },
    { text: `About ${PREWIRED_ROWS} rows are pre-wired; blank rows are ignored on upload, so just fill the amber columns row by row.` },
    { text: "" },
    { text: "Rules (enforced on upload):", heading: true },
    { text: "   •  Targets attach to the AREA (not the person): a vacant area still carries its target; a new hire inherits it." },
    { text: "   •  Only the canonical 42-area model is accepted. Unknown line / area / product rows are REJECTED, never auto-created." },
    { text: "   •  Confidential products cannot carry a field target and are not listed in the dropdown." },
    { text: "" },
    { text: `Reference tabs: 'Products (${lineLabel})' and 'Areas (${lineLabel})' feed the dropdowns and auto-fill; 'Lists' holds the months.`, heading: true },
    { text: "Don't rename these tabs, or the auto-fill formulas will break." },
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
  for (const col of COLUMNS) {
    ref.getCell(r, 1).value = col.header;
    ref.getCell(r, 1).font = { bold: true, color: { argb: col.kind === "input" ? "FFB45309" : SLATE }, name: "Calibri", size: 10 };
    ref.getCell(r, 1).border = gridBorder();
    ref.getCell(r, 1).alignment = { vertical: "top", horizontal: "left" };
    ref.getCell(r, 2).value = `${col.kind === "auto" ? "AUTO · " : ""}${col.note}`;
    ref.getCell(r, 2).font = { color: { argb: SLATE }, name: "Calibri", size: 10 };
    ref.getCell(r, 2).border = gridBorder();
    ref.getCell(r, 2).alignment = { vertical: "top", horizontal: "left", wrapText: true };
    r += 1;
  }
}

/** Parse an uploaded targets workbook into raw input rows (validated later, map-or-reject). */
export async function parseTargetsWorkbook(buffer: ArrayBuffer): Promise<TargetInputRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  // Find the first worksheet + header row that maps Period + Area + Product. This tolerates
  // a brand banner above the header, extra sheets, and any sheet order — while still finding
  // a legacy row-1 header on the first sheet exactly as before.
  let found: { ws: ExcelJS.Worksheet; headerRow: number; colOf: Partial<Record<keyof Omit<TargetInputRow, "rowNumber">, number>> } | null = null;
  for (const ws of wb.worksheets) {
    const scanTo = Math.min(20, ws.rowCount || 0);
    for (let r = 1; r <= scanTo; r += 1) {
      const colOf: Partial<Record<keyof Omit<TargetInputRow, "rowNumber">, number>> = {};
      ws.getRow(r).eachCell((cell, colNumber) => {
        const key = HEADER_KEY[headerKey(cell.value)];
        if (key && colOf[key] === undefined) colOf[key] = colNumber;
      });
      if (colOf.period !== undefined && colOf.area !== undefined && colOf.product !== undefined) {
        found = { ws, headerRow: r, colOf };
        break;
      }
    }
    if (found) break;
  }
  if (!found) return [];
  const { ws, headerRow, colOf } = found;

  const cellText = (row: ExcelJS.Row, col: number | undefined): string => {
    if (col === undefined) return "";
    const value = row.getCell(col).value;
    if (value == null) return "";
    if (typeof value === "object") {
      const obj = value as unknown as Record<string, unknown>;
      // Formula cell with a cached result (Excel-saved, or our sample rows).
      if ("result" in obj) return String(obj.result ?? "").trim();
      if ("text" in obj) return String(obj.text ?? "").trim();
      if ("richText" in obj && Array.isArray(obj.richText)) {
        return (obj.richText as Array<{ text?: unknown }>).map((part) => part.text ?? "").join("").trim();
      }
      // A formula whose cached result is empty ("") is dropped on write, leaving just the
      // formula — treat it (and any other object shape) as blank, never "[object Object]".
      return "";
    }
    return String(value).trim();
  };
  const cellNum = (row: ExcelJS.Row, col: number | undefined): number | null => {
    const text = cellText(row, col);
    if (text === "") return null;
    const parsed = Number(text.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  };

  const rows: TargetInputRow[] = [];
  const lastRow = ws.rowCount;
  for (let rowNumber = headerRow + 1; rowNumber <= lastRow; rowNumber += 1) {
    const row = ws.getRow(rowNumber);
    const period = cellText(row, colOf.period);
    const line = cellText(row, colOf.line);
    const area = cellText(row, colOf.area);
    const product = cellText(row, colOf.product);
    if (!period && !line && !area && !product) continue; // blank row
    rows.push({
      rowNumber,
      period,
      line,
      area,
      product,
      targetUnits: cellNum(row, colOf.targetUnits),
      targetValue: cellNum(row, colOf.targetValue),
    });
  }
  return rows;
}

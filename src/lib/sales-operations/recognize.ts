// Sales Operations Module — recognition spine.
//
// THE single place that classifies an uploaded distributor workbook for the new module. Mirrors the
// prime directive of the old recognizer: a file recognized here is recognized everywhere (analyze,
// commit, diagnostics all call this). Recognition-only — it reads masters + the dictionary but never
// imports the persistence layer, keeping the import graph acyclic.
//
// The DISPATCH is pure (`recognizeGrid`: grid + template + crosswalks → result) so it is fully
// unit-testable with an in-memory grid; the async wrapper just loads ExcelJS + masters + crosswalks.

import ExcelJS from "exceljs";

import { loadSalesOperationsCrosswalks } from "@/lib/sales-operations/crosswalks";
import { getDistributorTemplate, listDistributorTemplates } from "@/lib/sales-operations/dictionary";
import {
  cellText,
  detectHeaderRow,
  dominantPeriodFrom,
  normalizeSheet,
  type Cell,
  type CellRow,
} from "@/lib/sales-operations/normalize";
import {
  computeOfficeAllocation,
  parseOfficePivot,
  type OfficeBrickShare,
  type OfficeRegionShare,
} from "@/lib/sales-operations/office";
import type { Crosswalks, DistributorTemplate, NormalizeResult } from "@/lib/sales-operations/types";

// Bump when recognition behavior changes; stamped onto lineage so a batch records which engine ran.
export const SALES_OPS_ENGINE_VERSION = "2026.06-ops-1";

export type HeaderGroup = "product" | "qty" | "brick-key" | "date";

export type SalesOpsRecognizeResult =
  | {
      status: "ok";
      distributorCode: string;
      distributorName: string;
      result: NormalizeResult;
      period: string | null;
      hasDateColumn: boolean;
      regionOnly: boolean;
      brickLookup: DistributorTemplate["brickLookup"];
      // Office-only advisory fields
      nationalProducts?: string[];
      nationalUnits?: number;
    }
  | { status: "header_error"; distributorCode: string; distributorName: string; missingGroups: HeaderGroup[]; fingerprintWarning?: { likelyCode: string; likelyName: string } }
  | { status: "coded_sheet"; distributorCode: string; distributorName: string };

const HEADER_KEY = (value: unknown) => String(value ?? "").trim().toLowerCase();

// Convert an ExcelJS worksheet into the engine's plain CellRow grid, preserving Date/number cells so
// date parsing and numeric reads work. Formula/richText cells collapse to their result/text.
export function sheetToGrid(sheet: ExcelJS.Worksheet | undefined): CellRow[] {
  if (!sheet) return [];
  const grid: CellRow[] = [];
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const cells: CellRow = [];
    const max = Math.max(row.cellCount, sheet.columnCount);
    for (let c = 1; c <= max; c += 1) {
      cells.push(cellValue(row.getCell(c).value));
    }
    grid.push(cells);
  }
  return grid;
}

function cellValue(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "object") {
    const obj = value as { text?: unknown; result?: unknown; richText?: { text?: string }[] };
    if (Array.isArray(obj.richText)) return obj.richText.map((part) => part.text ?? "").join("");
    if (obj.result !== undefined && obj.result !== null) return obj.result as Cell;
    if (obj.text !== undefined && obj.text !== null) return String(obj.text);
  }
  return String(value);
}

// Phoenix-branded CODED sheets carry "Product ID" / "Distrub ID" / "Region ID"; raw distributor
// exports never do. Running a coded sheet through the normalizer produces garbage — reject it.
export function detectCodedSheet(rows: CellRow[]): boolean {
  const indicators = new Set(["product id", "distrub id", "region id", "brick id"]);
  const limit = Math.min(rows.length, 5);
  for (let r = 0; r < limit; r += 1) {
    let hits = 0;
    for (const cell of rows[r] ?? []) if (indicators.has(HEADER_KEY(cellText(cell)))) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

function detectedHeaderSet(rows: CellRow[], template: DistributorTemplate): Set<string> {
  const headerRow = rows[detectHeaderRow(rows, template)] ?? [];
  const set = new Set<string>();
  for (const cell of headerRow) {
    const key = HEADER_KEY(cellText(cell));
    if (key) set.add(key);
  }
  return set;
}

function hasAny(headerSet: Set<string>, headers: string[] | undefined): boolean {
  return (headers ?? []).some((h) => headerSet.has(HEADER_KEY(h)));
}

// Per-distributor header validation for the row strategies: only the mandatory keys are required
// (product, qty, brick key, and date when the channel is dated). Plus wrong-distributor fingerprint.
export function validateHeaders(
  rows: CellRow[],
  template: DistributorTemplate,
  allTemplates: DistributorTemplate[],
): { valid: boolean; missingGroups: HeaderGroup[]; fingerprintWarning?: { likelyCode: string; likelyName: string } } {
  const headerSet = detectedHeaderSet(rows, template);
  const missing: HeaderGroup[] = [];

  const hasProduct = hasAny(headerSet, template.productNameHeaders) || hasAny(headerSet, template.productCodeHeaders);
  if (!hasProduct) missing.push("product");
  if (!hasAny(headerSet, template.qtyHeaders)) missing.push("qty");
  const brickKeyHeaders = template.brickLookup === "brick-name" ? template.brickNameHeaders : template.customerCodeHeaders;
  if (!hasAny(headerSet, brickKeyHeaders)) missing.push("brick-key");
  if (template.hasDateColumn && !hasAny(headerSet, template.dateHeaders)) missing.push("date");

  // Fingerprint: if another template's signature columns score higher than the selected one, warn.
  const score = (t: DistributorTemplate) => (t.fingerprintHeaders ?? []).filter((h) => headerSet.has(HEADER_KEY(h))).length;
  const selfScore = score(template);
  let best: { code: string; name: string; n: number } | null = null;
  for (const t of allTemplates) {
    if (t.code === template.code) continue;
    const n = score(t);
    if (n >= 2 && n > selfScore && (!best || n > best.n)) best = { code: t.code, name: t.name, n };
  }

  return {
    valid: missing.length === 0,
    missingGroups: missing,
    fingerprintWarning: best ? { likelyCode: best.code, likelyName: best.name } : undefined,
  };
}

export type RecognizeGridInput = {
  rows: CellRow[];
  template: DistributorTemplate;
  maps: Crosswalks;
  allTemplates?: DistributorTemplate[];
  // For date-less channels (ChemiPharm, Office): the period chosen on the upload screen.
  period?: string;
  // Office allocation contribution base for the period (loaded from committed sales).
  officeRegionShare?: OfficeRegionShare[];
  officeBrickShare?: OfficeBrickShare[];
};

// Pure dispatch: classify + normalize an in-memory grid. No I/O — unit-testable.
export function recognizeGrid(input: RecognizeGridInput): SalesOpsRecognizeResult {
  const { rows, template, maps } = input;
  const allTemplates = input.allTemplates ?? listDistributorTemplates();
  const base = { distributorCode: template.code, distributorName: template.name };

  if (detectCodedSheet(rows)) return { status: "coded_sheet", ...base };

  // Office: a pivot, not a row sheet. Parse pivot + allocate.
  if (template.brickLookup === "office-allocation") {
    const pivot = parseOfficePivot(rows, template);
    if (pivot.length === 0) return { status: "header_error", ...base, missingGroups: ["product", "qty"] };
    const office = computeOfficeAllocation({
      pivotRows: pivot,
      maps,
      regionShare: input.officeRegionShare ?? [],
      brickShare: input.officeBrickShare ?? [],
      period: input.period ?? "",
    });
    return {
      status: "ok",
      ...base,
      result: office,
      period: input.period ?? null,
      hasDateColumn: false,
      regionOnly: Boolean(template.regionOnly),
      brickLookup: template.brickLookup,
      nationalProducts: office.nationalProducts,
      nationalUnits: office.nationalUnits,
    };
  }

  // Row strategies (customer-code / brick-name): validate headers, then normalize.
  const headerCheck = validateHeaders(rows, template, allTemplates);
  if (!headerCheck.valid) {
    return { status: "header_error", ...base, missingGroups: headerCheck.missingGroups, fingerprintWarning: headerCheck.fingerprintWarning };
  }

  const result = normalizeSheet({ rows, template, maps, period: input.period ?? "" });
  const period = template.hasDateColumn ? dominantPeriodFrom(result.coded) : (input.period ?? null);
  return { status: "ok", ...base, result, period, hasDateColumn: template.hasDateColumn, regionOnly: Boolean(template.regionOnly), brickLookup: template.brickLookup };
}

// Async wrapper: resolve the template, load masters + crosswalks + the workbook, then dispatch.
// `loadOfficeShares` injects the Office contribution base for the period (wired to committed sales).
export async function recognizeSalesOpsWorkbook(
  distributorCode: string,
  file: File,
  opts?: { period?: string; loadOfficeShares?: (period: string) => Promise<{ regionShare: OfficeRegionShare[]; brickShare: OfficeBrickShare[] }> },
): Promise<SalesOpsRecognizeResult> {
  const template = getDistributorTemplate(distributorCode);
  if (!template) throw new Error(`No Sales Operations template for distributor ${distributorCode}.`);

  const [maps, buffer] = await Promise.all([loadSalesOperationsCrosswalks(), file.arrayBuffer()]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const rows = sheetToGrid(workbook.worksheets[0]);

  let officeShares: { regionShare: OfficeRegionShare[]; brickShare: OfficeBrickShare[] } | undefined;
  if (template.brickLookup === "office-allocation" && opts?.loadOfficeShares && opts.period) {
    officeShares = await opts.loadOfficeShares(opts.period);
  }

  return recognizeGrid({
    rows,
    template,
    maps,
    period: opts?.period,
    officeRegionShare: officeShares?.regionShare,
    officeBrickShare: officeShares?.brickShare,
  });
}

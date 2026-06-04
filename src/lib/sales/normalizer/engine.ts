import ExcelJS from "exceljs";

import { deriveHierarchy, normalizeCodeKey, resolveBrick, resolveProduct } from "@/lib/sales/normalizer/resolvers";
import { IGNORE_PRODUCT_CODE, type CodedRow, type Crosswalks, type DistributorProfile, type NormalizeException, type NormalizeResult } from "@/lib/sales/normalizer/types";

// ── small self-contained parsers (kept local so the normalizer doesn't reach into the importer) ──

function cellText(cell: ExcelJS.Cell | undefined): string {
  const v = cell?.value;
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("result" in o) return String(o.result ?? "");
    if ("text" in o) return String(o.text ?? "");
    if ("richText" in o) return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
    if ("hyperlink" in o) return String(o.text ?? o.hyperlink ?? "");
  }
  return String(v);
}

function parseNum(value: unknown, emptyAsZero = false): number {
  const text = String(value ?? "").replace(/,/g, "").trim();
  if (!text) return emptyAsZero ? 0 : Number.NaN;
  const n = Number(text);
  return Number.isFinite(n) ? n : Number.NaN;
}

function discountFrac(value: unknown): number {
  const text = String(value ?? "").replace(/%/g, "").replace(/,/g, "").trim();
  if (!text) return 0;
  const n = Number(text);
  if (!Number.isFinite(n) || n === 0) return 0;
  return Math.abs(n) > 1 ? n / 100 : n;
}

// Timezone-safe YYYY-MM (same approach as the importer's invoicePeriod).
function periodFrom(value: unknown): string | null {
  const ym = (y: number, m: number) => (Number.isInteger(y) && y >= 1900 && m >= 1 && m <= 12 ? `${y}-${String(m).padStart(2, "0")}` : null);
  if (value instanceof Date) return ym(value.getUTCFullYear(), value.getUTCMonth() + 1);
  const text = String(value ?? "").trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})/);
  if (iso) return ym(Number(iso[1]), Number(iso[2]));
  const dmy = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (dmy) {
    const a = Number(dmy[1]); const b = Number(dmy[2]); let y = Number(dmy[3]); if (y < 100) y += 2000;
    const month = a > 12 && b <= 12 ? b : a;
    return ym(y, month);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : ym(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1);
}

// ── header map ──

type HeaderMap = { col: Map<string, number>; headerRow: number };

function buildHeaderMap(sheet: ExcelJS.Worksheet): HeaderMap {
  let headerRow = 1;
  for (let r = 1; r <= Math.min(sheet.rowCount, 10); r += 1) {
    let filled = 0;
    sheet.getRow(r).eachCell({ includeEmpty: false }, () => { filled += 1; });
    if (filled >= 3) { headerRow = r; break; }
  }
  const col = new Map<string, number>();
  sheet.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, c) => {
    const key = cellText(cell).trim().toLowerCase();
    if (key && !col.has(key)) col.set(key, c);
  });
  return { col, headerRow };
}

function firstValue(row: ExcelJS.Row, map: HeaderMap, columns: string[] | undefined): string {
  for (const name of columns ?? []) {
    const c = map.col.get(name.trim().toLowerCase());
    if (c) {
      const text = cellText(row.getCell(c)).trim();
      if (text) return text;
    }
  }
  return "";
}

// ── engine ──

export function normalizeRows(
  sheet: ExcelJS.Worksheet,
  profile: DistributorProfile,
  maps: Crosswalks,
): NormalizeResult {
  const header = buildHeaderMap(sheet);
  const coded: CodedRow[] = [];
  const exceptions: NormalizeException[] = [];
  let productResolved = 0;
  let brickResolved = 0;
  let ignored = 0;

  for (let r = header.headerRow + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    // skip fully-empty rows
    let any = false;
    row.eachCell({ includeEmpty: false }, () => { any = true; });
    if (!any) continue;

    const rawProduct = profile.productColumns.map((cName) => firstValue(row, header, [cName])).find(Boolean) ?? "";
    const productValues = profile.productColumns.map((cName) => firstValue(row, header, [cName]));
    const productCode = resolveProduct(productValues, maps);

    // "We don't sell this" — the item is explicitly mapped to ignore: drop the row entirely.
    if (productCode === IGNORE_PRODUCT_CODE) { ignored += 1; continue; }

    const customerCode = firstValue(row, header, profile.customerCodeColumns);
    const customerKey = customerCode ? `${normalizeCodeKey(profile.distributorCode)} ${normalizeCodeKey(customerCode)}` : null;
    const territoryValues = (profile.territoryColumns ?? []).map((cName) => firstValue(row, header, [cName]));
    const brickIdValues = (profile.brickIdColumns ?? []).map((cName) => firstValue(row, header, [cName]));
    const brick = resolveBrick({ brickIdValues, customerKey, territoryValues }, maps);
    const hierarchy = deriveHierarchy(brick, maps);

    if (productCode) productResolved += 1;
    if (hierarchy) brickResolved += 1;

    if (!productCode || !hierarchy) {
      exceptions.push({
        rawProduct,
        rawProductName: productValues.slice(1).find(Boolean) ?? "",
        rawTerritory: territoryValues.find(Boolean) ?? "",
        rawCustomerCode: customerCode,
        rawCustomerName: firstValue(row, header, profile.customerNameColumns),
        rawRowNumber: r,
        reason: !productCode && !hierarchy ? "both" : !productCode ? "product" : "brick",
      });
      continue;
    }

    const product = maps.productByCode.get(productCode);
    const qty = parseNum(firstValue(row, header, profile.qtyColumns));
    const bonusQty = parseNum(firstValue(row, header, profile.bonusColumns), true);
    const discount = discountFrac(firstValue(row, header, profile.discountColumns));
    const sheetValue = parseNum(firstValue(row, header, profile.valueColumns), true);
    const value = profile.valueSource === "sheet"
      ? sheetValue
      : (Number.isFinite(qty) ? qty * (product?.factoryPrice ?? 0) * (1 - discount) : 0);

    coded.push({
      areaCode: hierarchy.areaCode,
      areaName: hierarchy.areaName,
      brickId: hierarchy.brickId,
      brickName: hierarchy.brickName,
      bonusQty: Number.isFinite(bonusQty) ? bonusQty : 0,
      clientCode: customerCode || null,
      clientName: firstValue(row, header, profile.customerNameColumns) || null,
      discount,
      distributorCode: profile.distributorCode,
      invoiceDate: periodFrom(firstValue(row, header, profile.dateColumns)) ?? "",
      isDirect: profile.valueSource === "sheet",
      officialLine: product?.line || "Unknown",
      productCode,
      productName: product?.productName ?? productCode,
      qty: Number.isFinite(qty) ? qty : 0,
      rawRowNumber: r,
      regionCode: hierarchy.regionCode,
      regionName: hierarchy.regionName,
      value: Number.isFinite(value) ? value : 0,
    });
  }

  return {
    coded,
    distributorCode: profile.distributorCode,
    exceptions,
    summary: { brickResolved, fullyCoded: coded.length, ignored, productResolved, totalRows: coded.length + exceptions.length + ignored },
  };
}

export async function normalizeRawWorkbook(
  buffer: ArrayBuffer | Buffer,
  profile: DistributorProfile,
  maps: Crosswalks,
): Promise<NormalizeResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return { coded: [], distributorCode: profile.distributorCode, exceptions: [], summary: { brickResolved: 0, fullyCoded: 0, ignored: 0, productResolved: 0, totalRows: 0 } };
  }
  return normalizeRows(sheet, profile, maps);
}

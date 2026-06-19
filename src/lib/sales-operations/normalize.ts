// Sales Operations Module — pure normalizer.
//
// Turns a RAW distributor sheet into fully-coded rows, following the locked rules (see types.ts):
//   • Product resolved NAME-first (per-distributor name alias → master product name), code is a
//     FALLBACK only.
//   • Brick resolved per the template's `brickLookup` strategy (customer-code | brick-name).
//   • Area/Region always derived from the brick master.
//   • value = qty × factory price. Discounts ignored. Bonus / free units excluded entirely.
//
// All functions here are pure (no I/O) so they are fully unit-testable with in-memory crosswalks.

import type {
  BrickRef,
  CodedRow,
  Crosswalks,
  DistributorTemplate,
  NormalizeException,
  NormalizeResult,
  ProductRef,
} from "@/lib/sales-operations/types";

// ───────────────────────── key normalizers ─────────────────────────

// Free-text alias key: trim, unify Arabic forms, collapse non-alphanumerics, lowercase.
export function normalizeAliasKey(value: unknown): string {
  return String(value ?? "")
    .replace(/ـ/g, "") // tatweel
    .replace(/[إأآا]/g, "ا") // unify alef forms
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function normalizeCodeKey(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

// Numeric-canonical key (leading zeros stripped) for purely-numeric codes; null otherwise.
export function numericCanonicalKey(value: unknown): string | null {
  const code = normalizeCodeKey(value);
  if (!/^\d+$/.test(code)) return null;
  return code.replace(/^0+(?=\d)/, "");
}

// Header-match key: trim + lowercase (exact match after normalization, never fuzzy).
function headerKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

// ───────────────────────── cell helpers ─────────────────────────

export type Cell = string | number | boolean | Date | null | undefined;
export type CellRow = Cell[];

export function cellText(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

export function parseNum(value: Cell): number {
  if (typeof value === "number") return value;
  const text = cellText(value).replace(/,/g, "");
  if (!text) return NaN;
  const n = Number(text);
  return Number.isFinite(n) ? n : NaN;
}

// A truthy bonus flag = a free-goods row. Blank / "0" / "false" are NOT bonus.
function isBonusFlag(value: Cell): boolean {
  const text = cellText(value).toLowerCase();
  return text !== "" && text !== "0" && text !== "false" && text !== "no";
}

// ───────────────────────── period (date → YYYY-MM) ─────────────────────────

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Normalize a date cell to "YYYY-MM". Handles real Date objects, Excel serial numbers, ISO strings,
// and DD-MM / MM-DD text (disambiguated by dateFormat). Returns "" when unparseable.
export function periodFrom(value: Cell, dateFormat: "day-first" | "month-first" = "day-first"): string {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date) return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}`;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel serial date (days since 1899-12-30).
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
    return "";
  }
  const text = cellText(value);
  // ISO-ish: YYYY-MM or YYYY-MM-DD
  const iso = /^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?/.exec(text);
  if (iso) return `${iso[1]}-${pad2(Number(iso[2]))}`;
  // DD-MM-YYYY / MM-DD-YYYY (separators - / .)
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(text);
  if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    const month = dateFormat === "month-first" ? a : b;
    if (month >= 1 && month <= 12) return `${year}-${pad2(month)}`;
  }
  return "";
}

// ───────────────────────── product (name-first) ─────────────────────────

export type ProductMatch = { productCode: string; matchedBy: "name-alias" | "name-master" | "code" | "code-canonical" | "code-alias" } | null;

// Resolve the reference product. NAME first (per-distributor alias, then master product name);
// the distributor product CODE is consulted only as a fallback.
export function resolveProduct(
  nameValues: Cell[],
  codeValues: Cell[],
  maps: Crosswalks,
  distributorCode = "",
): ProductMatch {
  const dist = normalizeCodeKey(distributorCode);
  // 1) NAME — primary
  for (const raw of nameValues) {
    const text = cellText(raw);
    if (!text) continue;
    const key = normalizeAliasKey(text);
    if (!key) continue;
    if (dist) {
      const aliased = maps.productAliasByKey.get(`${dist} ${key}`);
      if (aliased) return { productCode: aliased, matchedBy: "name-alias" };
    }
    const master = maps.productByName.get(key);
    if (master) return { productCode: master, matchedBy: "name-master" };
  }
  // 2) CODE — fallback
  for (const raw of codeValues) {
    const text = cellText(raw);
    if (!text) continue;
    const code = normalizeCodeKey(text);
    if (maps.productByCode.has(code)) return { productCode: code, matchedBy: "code" };
    const canon = numericCanonicalKey(code);
    if (canon) {
      const byCanon = maps.productByCanonicalCode.get(canon);
      if (byCanon) return { productCode: byCanon, matchedBy: "code-canonical" };
    }
    if (dist) {
      const byCodeAlias = maps.productAliasByKey.get(`${dist} ${normalizeAliasKey(code)}`);
      if (byCodeAlias) return { productCode: byCodeAlias, matchedBy: "code-alias" };
    }
  }
  return null;
}

// ───────────────────────── brick (by strategy) ─────────────────────────

export type BrickResolution = { areaCode: string; brickId: string; regionCode: string; source: string } | null;

// Resolve the reference brick per the distributor's column-L strategy.
//   customer-code → look up FROM the customer code via the customer→brick crosswalk.
//   brick-name    → look up FROM the brick/area NAME via the territory / area alias.
// office-allocation distributors never reach here (handled by the office allocator).
export function resolveBrick(
  template: DistributorTemplate,
  input: { customerCode?: Cell; brickNameValues?: Cell[] },
  maps: Crosswalks,
): BrickResolution {
  if (template.brickLookup === "customer-code") {
    const code = cellText(input.customerCode);
    if (!code) return null;
    const dist = normalizeCodeKey(template.code);
    const exact = maps.customerBrickByKey.get(`${dist} ${normalizeCodeKey(code)}`);
    const canon = numericCanonicalKey(code);
    const brickId = exact ?? (canon ? maps.customerBrickByCanonicalKey.get(`${dist} ${canon}`) : undefined);
    if (brickId && maps.brickById.has(brickId)) {
      const b = maps.brickById.get(brickId)!;
      return { areaCode: b.areaCode, brickId, regionCode: b.regionCode, source: "customer" };
    }
    return null;
  }
  if (template.brickLookup === "brick-name") {
    for (const raw of input.brickNameValues ?? []) {
      const key = normalizeAliasKey(raw);
      if (!key) continue;
      const hit = maps.territoryAliasByKey.get(key);
      if (hit) {
        if (hit.targetType === "brick") {
          const b = maps.brickById.get(normalizeCodeKey(hit.targetCode));
          if (b) return { areaCode: b.areaCode, brickId: b.brickId, regionCode: b.regionCode, source: "brick-name" };
        } else if (hit.targetType === "area") {
          const a = maps.areaByCode.get(normalizeCodeKey(hit.targetCode));
          if (a) return { areaCode: a.areaCode, brickId: "", regionCode: a.regionCode, source: "brick-name-area" };
        }
      }
      const areaHit = maps.areaAliasByKey.get(key);
      if (areaHit) return { areaCode: normalizeCodeKey(areaHit.areaCode), brickId: "", regionCode: normalizeCodeKey(areaHit.regionCode), source: "area" };
    }
    return null;
  }
  return null;
}

// Brick id (or area code) → full hierarchy names. Area/Region come ONLY from the master.
export function deriveHierarchy(
  resolution: BrickResolution,
  maps: Crosswalks,
): Pick<BrickRef, "areaCode" | "areaName" | "brickId" | "brickName" | "regionCode" | "regionName"> | null {
  if (!resolution) return null;
  if (resolution.brickId) {
    const b = maps.brickById.get(resolution.brickId);
    if (b) return { areaCode: b.areaCode, areaName: b.areaName, brickId: b.brickId, brickName: b.brickName, regionCode: b.regionCode, regionName: b.regionName };
  }
  const a = maps.areaByCode.get(resolution.areaCode);
  if (a) return { areaCode: a.areaCode, areaName: a.areaName, brickId: "", brickName: "", regionCode: a.regionCode, regionName: a.regionName };
  const r = maps.regionByCode.get(resolution.regionCode);
  if (r) return { areaCode: resolution.areaCode, areaName: resolution.areaCode, brickId: "", brickName: "", regionCode: r.regionCode, regionName: r.regionName };
  return null;
}

// ───────────────────────── header detection ─────────────────────────

function templateHeaderStrings(template: DistributorTemplate): string[] {
  return [
    ...(template.customerCodeHeaders ?? []),
    ...(template.customerNameHeaders ?? []),
    ...(template.customerAddressHeaders ?? []),
    ...(template.brickNameHeaders ?? []),
    ...(template.productNameHeaders ?? []),
    ...(template.productCodeHeaders ?? []),
    ...(template.qtyHeaders ?? []),
    ...(template.dateHeaders ?? []),
  ].map(headerKey);
}

// Pick the real header row: scan the first 10 rows, choose the one carrying the most known headers
// (≥2), earliest on a tie — so a merged banner/title row above the headers is skipped.
export function detectHeaderRow(rows: CellRow[], template: DistributorTemplate): number {
  const known = new Set(templateHeaderStrings(template));
  let best = -1;
  let bestHits = 0;
  const limit = Math.min(rows.length, 10);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] ?? [];
    let hits = 0;
    for (const cell of row) if (known.has(headerKey(cellText(cell)))) hits++;
    if (hits > bestHits) {
      bestHits = hits;
      best = i;
    }
  }
  if (best >= 0 && bestHits >= 2) return best;
  // fallback: first row with ≥3 filled cells
  for (let i = 0; i < limit; i++) {
    const filled = (rows[i] ?? []).filter((c) => cellText(c) !== "").length;
    if (filled >= 3) return i;
  }
  return 0;
}

function buildHeaderIndex(headerRow: CellRow): Map<string, number> {
  const index = new Map<string, number>();
  headerRow.forEach((cell, col) => {
    const key = headerKey(cellText(cell));
    if (key && !index.has(key)) index.set(key, col);
  });
  return index;
}

function valuesFor(row: CellRow, index: Map<string, number>, headers: string[] | undefined): Cell[] {
  const out: Cell[] = [];
  for (const h of headers ?? []) {
    const col = index.get(headerKey(h));
    if (col !== undefined) out.push(row[col]);
  }
  return out;
}

function firstText(row: CellRow, index: Map<string, number>, headers: string[] | undefined): string {
  for (const v of valuesFor(row, index, headers)) {
    const t = cellText(v);
    if (t) return t;
  }
  return "";
}

function firstCell(row: CellRow, index: Map<string, number>, headers: string[] | undefined): Cell {
  for (const v of valuesFor(row, index, headers)) {
    if (cellText(v) !== "") return v;
  }
  return undefined;
}

// Most-frequent invoice period among coded rows (the batch period).
export function dominantPeriodFrom(rows: CodedRow[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.invoiceDate) counts.set(row.invoiceDate, (counts.get(row.invoiceDate) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [period, n] of counts) {
    if (n > bestN) {
      best = period;
      bestN = n;
    }
  }
  return best;
}

// ───────────────────────── sheet normalizer ─────────────────────────

export type NormalizeInput = {
  rows: CellRow[];
  template: DistributorTemplate;
  maps: Crosswalks;
  // Period (YYYY-MM) used when the distributor has no date column (ChemiPharm); also the fallback
  // when a dated row's date can't be parsed.
  period?: string;
};

// Normalize one distributor's raw sheet into coded rows + exceptions + excluded(bonus) rows.
// Office (office-allocation) is handled by a dedicated allocator and is rejected here.
export function normalizeSheet({ rows, template, maps, period = "" }: NormalizeInput): NormalizeResult {
  if (template.brickLookup === "office-allocation") {
    throw new Error(`normalizeSheet: distributor "${template.code}" uses office-allocation; use the office allocator instead.`);
  }

  const coded: CodedRow[] = [];
  const exceptions: NormalizeException[] = [];
  const excluded: NormalizeResult["excluded"] = [];
  let scannedDataRows = 0;
  let productResolved = 0;
  let brickResolved = 0;
  let excludedBonus = 0;
  let blankKeySkipped = 0;

  const headerRowIdx = detectHeaderRow(rows, template);
  const index = buildHeaderIndex(rows[headerRowIdx] ?? []);

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (row.every((c) => cellText(c) === "")) continue; // skip wholly-blank rows
    scannedDataRows++;
    const rawRowNumber = i + 1;

    // Bonus / free units — excluded entirely.
    if (template.bonusHeaders && isBonusFlag(firstCell(row, index, template.bonusHeaders))) {
      excludedBonus++;
      excluded.push({
        rawProduct: firstText(row, index, template.productCodeHeaders),
        rawProductName: firstText(row, index, template.productNameHeaders),
        rawRowNumber,
        qty: parseNum(firstCell(row, index, template.qtyHeaders)) || 0,
        reason: "bonus",
      });
      continue;
    }

    const nameValues = valuesFor(row, index, template.productNameHeaders);
    const codeValues = valuesFor(row, index, template.productCodeHeaders);
    const customerCode = firstText(row, index, template.customerCodeHeaders);
    const brickNameValues = valuesFor(row, index, template.brickNameHeaders);
    const customerName = firstText(row, index, template.customerNameHeaders);
    const customerAddress = firstText(row, index, template.customerAddressHeaders);

    const hasProductKey = nameValues.some((v) => cellText(v)) || codeValues.some((v) => cellText(v));
    const hasBrickKey = template.brickLookup === "customer-code" ? Boolean(customerCode) : brickNameValues.some((v) => cellText(v));

    // Blank-key rows: no usable keys at all → summary/footer row, or a hard error for EG-BR.
    if (!hasProductKey && !hasBrickKey) {
      if (template.blankCustomerBehavior === "error") {
        exceptions.push(blankException(rawRowNumber, "blank_key"));
      } else {
        blankKeySkipped++;
      }
      continue;
    }
    if (template.brickLookup === "customer-code" && !customerCode && template.blankCustomerBehavior === "error") {
      exceptions.push(blankException(rawRowNumber, "blank_key", { rawCustomerName: customerName }));
      continue;
    }

    const productMatch = resolveProduct(nameValues, codeValues, maps, template.code);
    const brickResolution = resolveBrick(template, { customerCode, brickNameValues }, maps);
    const hierarchy = deriveHierarchy(brickResolution, maps);
    if (productMatch) productResolved++;
    if (hierarchy) brickResolved++;

    if (!productMatch || !hierarchy) {
      const reason: NormalizeException["reason"] = !productMatch && !hierarchy ? "both" : !productMatch ? "product" : "brick";
      exceptions.push({
        rawProduct: firstText(row, index, template.productCodeHeaders),
        rawProductName: firstText(row, index, template.productNameHeaders),
        rawBrickName: firstText(row, index, template.brickNameHeaders),
        rawCustomerCode: customerCode,
        rawCustomerName: customerName,
        rawRowNumber,
        reason,
      });
      continue;
    }

    const product = maps.productByCode.get(productMatch.productCode) ?? unknownProduct(productMatch.productCode);
    const qty = parseNum(firstCell(row, index, template.qtyHeaders));
    const safeQty = Number.isFinite(qty) ? qty : 0;
    const value = safeQty * (product.factoryPrice ?? 0); // value = qty × factory price (no discount)
    const invoiceDate = template.hasDateColumn
      ? periodFrom(firstCell(row, index, template.dateHeaders), template.dateFormat ?? "day-first") || period
      : period;

    coded.push({
      areaCode: hierarchy.areaCode,
      areaName: hierarchy.areaName,
      brickId: hierarchy.brickId,
      brickName: hierarchy.brickName,
      clientCode: customerCode || null,
      clientName: customerName || null,
      clientAddress: customerAddress || null,
      distributorCode: template.code,
      family: product.family || "",
      invoiceDate,
      officialLine: product.line || "Unknown",
      productCode: product.productCode,
      productName: product.productName,
      qty: safeQty,
      rawRowNumber,
      regionCode: hierarchy.regionCode,
      regionName: hierarchy.regionName,
      value,
    });
  }

  return {
    distributorCode: template.code,
    coded,
    exceptions,
    excluded,
    summary: {
      scannedDataRows,
      fullyCoded: coded.length,
      productResolved,
      brickResolved,
      excludedBonus,
      blankKeySkipped,
      exceptions: exceptions.length,
    },
  };
}

function blankException(
  rawRowNumber: number,
  reason: NormalizeException["reason"],
  extra?: Partial<NormalizeException>,
): NormalizeException {
  return {
    rawProduct: "",
    rawProductName: "",
    rawBrickName: "",
    rawCustomerCode: "",
    rawCustomerName: "",
    rawRowNumber,
    reason,
    ...extra,
  };
}

function unknownProduct(productCode: string): ProductRef {
  return { productCode, productName: "Unknown", factoryPrice: 0, family: "", line: "Unknown" };
}

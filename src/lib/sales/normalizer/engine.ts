import ExcelJS from "exceljs";

import { HEADER_SCAN_ROWS, normalizeHeaderKey } from "@/lib/sales/normalizer/header-normalize";
import { deriveHierarchy, normalizeCodeKey, numericCanonicalKey, resolveBrick, resolveProduct } from "@/lib/sales/normalizer/resolvers";
import { IGNORE_PRODUCT_CODE, type CodedRow, type Crosswalks, type CustomerBrickCorrection, type DistributorProfile, type NormalizeException, type NormalizeIgnoredRow, type NormalizeResult } from "@/lib/sales/normalizer/types";

export type HeaderValidationFailure = { label: string; expected: string[] };
export type HeaderValidationResult = {
  valid: boolean;
  missingGroups: HeaderValidationFailure[];
  fingerprintWarning?: { likelyCode: string; likelyName: string };
};

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

/**
 * Discount as a fraction, or NaN when the cell is present but cannot be trusted.
 *
 * NaN (not a clamp) is the point. This used to end in
 *     return Math.min(1, Math.max(0, fraction));
 * so a "150" typo became a 100% discount, `value = qty x price x (1 - 1)` = 0, and the sale silently
 * vanished. It also made upload-validation's `discount_out_of_range` check unreachable — nothing
 * out-of-range ever survived the clamp to be validated. The caller now raises an exception instead,
 * so a bad cell is reviewed rather than quietly zeroing revenue.
 */
function discountFrac(value: unknown): number {
  const text = String(value ?? "").replace(/%/g, "").replace(/,/g, "").trim();
  if (!text) return 0; // an empty cell genuinely means "no discount"
  const n = Number(text);
  if (!Number.isFinite(n)) return Number.NaN; // present but unreadable
  if (n === 0) return 0;
  // Convention: >1 is a percentage, <=1 is already a fraction.
  const fraction = Math.abs(n) > 1 ? n / 100 : n;
  // >= 1 is rejected rather than applied. A cell of exactly "1" is genuinely ambiguous under the
  // convention above — 1% or 100%? — and reading it as 100% zeroes the row. Anything that would
  // wipe out a sale should be reviewed, not guessed at. Production carries no discount at or above
  // 1 today (all 52 non-zero values are 0.0–0.08), so this rejects nothing that currently exists.
  if (fraction < 0 || fraction >= 1) return Number.NaN;
  return fraction;
}

// Timezone-safe YYYY-MM. dayFirst disambiguates DD-MM-YYYY vs MM-DD-YYYY when both parts are <= 12
// (e.g. "08-04-2026" is 8 April in DD-MM, but August in MM-DD). The caller detects the column's
// orientation from values that can't be ambiguous (a part > 12) — see detectDayFirst.
function periodFrom(value: unknown, dayFirst?: boolean): string | null {
  const ym = (y: number, m: number) => (Number.isInteger(y) && y >= 1900 && m >= 1 && m <= 12 ? `${y}-${String(m).padStart(2, "0")}` : null);
  if (value instanceof Date) return ym(value.getUTCFullYear(), value.getUTCMonth() + 1);
  const text = String(value ?? "").trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})/);
  if (iso) return ym(Number(iso[1]), Number(iso[2]));
  const dmy = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (dmy) {
    const a = Number(dmy[1]); const b = Number(dmy[2]); let y = Number(dmy[3]); if (y < 100) y += 2000;
    let month: number;
    if (dayFirst === true) month = b >= 1 && b <= 12 ? b : a;        // DD-MM-YYYY: month is the 2nd part
    else if (dayFirst === false) month = a >= 1 && a <= 12 ? a : b;  // MM-DD-YYYY: month is the 1st part
    else month = a > 12 && b <= 12 ? b : a;                          // unknown column: legacy best-guess
    return ym(y, month);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : ym(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1);
}

// Decide if a sheet's date column is day-first (DD-MM) or month-first (MM-DD) by scanning its values.
// A value whose FIRST part is > 12 can only be a day -> DD-MM (decisive). A value whose SECOND part is
// > 12 (first <= 12) can only be a day there -> MM-DD. undefined when every value is ambiguous.
function detectDayFirst(sheet: ExcelJS.Worksheet, header: HeaderMap, dateColumns: string[] | undefined): boolean | undefined {
  let sawMonthFirst = false;
  for (let r = header.headerRow + 1; r <= sheet.rowCount; r += 1) {
    const m = firstValue(sheet.getRow(r), header, dateColumns).match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (!m) continue;
    if (Number(m[1]) > 12) return true;          // first part is a day -> day-first (decisive)
    if (Number(m[2]) > 12) sawMonthFirst = true; // second part is a day -> month-first
  }
  return sawMonthFirst ? false : undefined;
}

// ── header map ──

type HeaderMap = { col: Map<string, number>; headerRow: number };

// All header names this profile expects, normalized via the shared header key. Shared by buildHeaderMap
// (skip banner/title rows) and pickBestSheet (choose the right worksheet).
export function knownHeaderKeys(profile?: DistributorProfile): Set<string> {
  const known = new Set<string>();
  for (const name of [
    ...(profile?.productColumns ?? []),
    ...(profile?.qtyColumns ?? []),
    ...(profile?.dateColumns ?? []),
    ...(profile?.valueColumns ?? []),
    ...(profile?.customerCodeColumns ?? []),
    ...(profile?.customerNameColumns ?? []),
    ...(profile?.territoryColumns ?? []),
    ...(profile?.brickIdColumns ?? []),
  ]) {
    const key = normalizeHeaderKey(name);
    if (key) known.add(key);
  }
  return known;
}

export function buildHeaderMap(sheet: ExcelJS.Worksheet, profile?: DistributorProfile): HeaderMap {
  // Header names this distributor's profile expects — used to skip banner/title rows. e.g. the IS-S
  // "Monthly Sales by Client for SATO PHARMA (PAS)" report puts a merged title in row 1 and the real
  // header in row 2; without this the title row (>=3 filled cells) wins and nothing maps.
  const known = knownHeaderKeys(profile);

  const readRow = (r: number): Map<string, number> => {
    const col = new Map<string, number>();
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, c) => {
      const key = normalizeHeaderKey(cellText(cell));
      if (key && !col.has(key)) col.set(key, c);
    });
    return col;
  };

  // Score the first HEADER_SCAN_ROWS rows by how many KNOWN profile headers each carries. The real
  // header row carries several; a banner/title row carries none (IS-S "Monthly Sales by Client…").
  // Critically, a sparse metadata row with a single stray cell that happens to equal a column name (e.g.
  // "Name", "Column1", "qty") must NOT win, so we require >=2 known hits and pick the row with the MOST
  // (earliest on a tie).
  let best: { col: Map<string, number>; headerRow: number; hits: number } | null = null;
  let firstKnown: HeaderMap | null = null;
  let fallback: HeaderMap | null = null;
  for (let r = 1; r <= Math.min(sheet.rowCount, HEADER_SCAN_ROWS); r += 1) {
    const col = readRow(r);
    if (!fallback && col.size >= 3) fallback = { col, headerRow: r };
    if (known.size === 0) {
      if (col.size >= 3) return { col, headerRow: r };
      continue;
    }
    let hits = 0;
    for (const key of col.keys()) if (known.has(key)) hits += 1;
    if (hits > 0 && !firstKnown) firstKnown = { col, headerRow: r };
    if (hits >= 2 && (!best || hits > best.hits)) best = { col, headerRow: r, hits };
  }
  // Prefer the richest known-header row; else the first row carrying any known header (covers a profile
  // whose real header legitimately exposes only one known column); else the legacy ">=3 filled cells" row.
  if (best) return { col: best.col, headerRow: best.headerRow };
  if (firstKnown) return firstKnown;
  return fallback ?? { col: readRow(1), headerRow: 1 };
}

// STRICT pre-flight header validation ("no deviation"): the sheet must carry the selected
// distributor's CANONICAL required columns (Headers Mapping) — brick-lookup key, product NAME, qty,
// and date when the channel is dated — matched exactly (case/trim only, no alias fallback). A
// missing or renamed required column is rejected, naming the exact expected header. EXTRA/unmapped
// columns are ignored (not blocking). Also detects a wrong-distributor upload via fingerprint score.
export function validateSheetHeaders(
  sheet: ExcelJS.Worksheet,
  profile: DistributorProfile,
  allProfiles: DistributorProfile[],
): HeaderValidationResult {
  const header = buildHeaderMap(sheet, profile);
  const found = new Set(header.col.keys()); // already lowercase-trimmed by buildHeaderMap

  // A required field passes only when its canonical header(s) are present exactly; else it fails and
  // reports the exact header(s) the distributor must use (so a renamed column is named precisely).
  const check = (label: string, cols: string[] | undefined): HeaderValidationFailure | null => {
    if (!cols || cols.length === 0) return null; // field not required for this distributor
    if (cols.some((c) => found.has(normalizeHeaderKey(c)))) return null;
    return { label, expected: cols };
  };
  // Product is keyed by NAME (owner rule: name-first); the code column is an optional fallback.
  const productNameCols = profile.productNameColumns?.length ? profile.productNameColumns : profile.productColumns;
  // Brick-lookup key: customer code for most distributors, area/territory name for CP, or a direct brick id.
  const locationCols = [
    ...(profile.customerCodeColumns ?? []),
    ...(profile.territoryColumns ?? []),
    ...(profile.brickIdColumns ?? []),
  ];
  const missingGroups = [
    check("Product name",        productNameCols),
    check("Quantity",            profile.qtyColumns),
    check("Date",                profile.dateColumns),
    check("Customer code / Area", locationCols.length > 0 ? locationCols : undefined),
  ].filter((g): g is HeaderValidationFailure => g !== null);

  // Fingerprint scoring: find the profile whose signature columns best match the sheet.
  // If another distributor scores higher than ours, warn the user.
  const score = (p: DistributorProfile) =>
    (p.fingerprintColumns ?? []).filter((c) => found.has(normalizeHeaderKey(c))).length;
  const myScore = score(profile);
  let bestOther: DistributorProfile | null = null;
  let bestScore = 0;
  for (const p of allProfiles) {
    if (p.distributorCode === profile.distributorCode) continue;
    const s = score(p);
    if (s > bestScore && s > myScore) { bestScore = s; bestOther = p; }
  }

  return {
    valid: missingGroups.length === 0,
    missingGroups,
    fingerprintWarning: bestOther
      ? { likelyCode: bestOther.distributorCode, likelyName: bestOther.distributorName }
      : undefined,
  };
}

// The raw (un-normalized) cell texts of the chosen header row — used to show the operator (and the AI
// explainer) the column TITLES the file actually has. Header text only; never reads data rows.
export function headerRowTexts(sheet: ExcelJS.Worksheet, profile?: DistributorProfile): string[] {
  const header = buildHeaderMap(sheet, profile);
  const texts: string[] = [];
  sheet.getRow(header.headerRow).eachCell({ includeEmpty: false }, (cell) => {
    const text = cellText(cell).trim();
    if (text) texts.push(text);
  });
  return texts;
}

/**
 * The file's own column headings, by column index — read once per sheet.
 *
 * HeaderMap.col is keyed by a NORMALIZED heading (lowercased, trimmed), which is right for lookup
 * and useless for provenance: it cannot tell you the file said "ADDRESSSHIP" rather than "Address".
 * These are the headings verbatim, so a stored row can be read back and compared against what a
 * profile expects.
 *
 * EVERY heading is captured, not just the ones the profile maps. A column nobody mapped is exactly
 * the column you need to see when a field arrives empty and the question is whether the distributor
 * ever sent it.
 */
function sourceColumnLabels(sheet: ExcelJS.Worksheet, map: HeaderMap): Map<number, string> {
  const labels = new Map<number, string>();
  sheet.getRow(map.headerRow).eachCell({ includeEmpty: false }, (cell, c) => {
    const label = cellText(cell).trim();
    if (label) labels.set(c, label);
  });
  return labels;
}

/** One source row, keyed by the file's own headings. Empty cells are dropped, not stored as "". */
function rawSourceRow(row: ExcelJS.Row, labels: Map<number, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [column, label] of labels) {
    const text = cellText(row.getCell(column)).trim();
    if (text) out[label] = text;
  }
  return out;
}

function firstValue(row: ExcelJS.Row, map: HeaderMap, columns: string[] | undefined): string {
  for (const name of columns ?? []) {
    const c = map.col.get(normalizeHeaderKey(name));
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
  const header = buildHeaderMap(sheet, profile);
  // Read once per sheet, not once per row: the header row does not change while we walk the data.
  const columnLabels = sourceColumnLabels(sheet, header);
  // Honour explicit per-distributor date format; only auto-detect when not set.
  // All Egyptian distributors are DD-MM-YYYY so auto-detection is unnecessary and can mis-parse
  // a month where every day-value is <= 12 (e.g. early-month data → month-first mis-read).
  const dayFirst = profile.dateFormat === "day-first" ? true
    : profile.dateFormat === "month-first" ? false
    : detectDayFirst(sheet, header, profile.dateColumns);
  const coded: CodedRow[] = [];
  const exceptions: NormalizeException[] = [];
  let productResolved = 0;
  let brickResolved = 0;
  let ignored = 0;
  const ignoredRows: NormalizeIgnoredRow[] = [];
  let blankCustomerSkipped = 0;
  const blankCustomerRows: NormalizeIgnoredRow[] = [];
  let scannedDataRows = 0;
  // Keyed by the same customerKey the resolver uses — last row for a given customer in this sheet
  // wins, so one file never produces two conflicting corrections for the same customer.
  const customerBrickCorrections = new Map<string, CustomerBrickCorrection>();

  for (let r = header.headerRow + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    // skip fully-empty rows
    let any = false;
    row.eachCell({ includeEmpty: false }, () => { any = true; });
    if (!any) continue;
    // Count every non-empty data row exactly once, before it is routed to a bucket — the independent
    // physical tally the validator reconciles against (no-silent-loss guard).
    scannedDataRows += 1;

    const rawProduct = profile.productColumns.map((cName) => firstValue(row, header, [cName])).find(Boolean) ?? "";
    const productValues = profile.productColumns.map((cName) => firstValue(row, header, [cName]));
    const productCode = resolveProduct(productValues, maps, profile.distributorCode);

    // "We don't sell this" — the item is explicitly mapped to ignore: drop the row from coding
    // but record it so the import surface can tell the user exactly how many units were excluded.
    if (productCode === IGNORE_PRODUCT_CODE) {
      ignored += 1;
      const ignoredQty = parseNum(firstValue(row, header, profile.qtyColumns));
      ignoredRows.push({
        rawProduct,
        rawProductName: productValues.slice(1).find(Boolean) ?? "",
        rawRowNumber: r,
        qty: Number.isFinite(ignoredQty) ? ignoredQty : 0,
        reason: "ignore_mapped",
      });
      continue;
    }

    // Bonus/free-goods flag: skip rows marked as bonus deliveries.
    // These are free-goods shipments, not real sales — counting them inflates the numbers.
    if (profile.bonusColumns?.length) {
      const flag = firstValue(row, header, profile.bonusColumns);
      if (flag && flag !== "0" && flag.toLowerCase() !== "false") {
        ignored += 1;
        ignoredRows.push({ rawProduct, rawProductName: productValues.slice(1).find(Boolean) ?? "", rawRowNumber: r, qty: 0, reason: "bonus" });
        continue;
      }
    }

    const customerCode = firstValue(row, header, profile.customerCodeColumns);
    const distKey = normalizeCodeKey(profile.distributorCode);
    const customerKey = customerCode ? `${distKey} ${normalizeCodeKey(customerCode)}` : null;
    const customerCanon = customerCode ? numericCanonicalKey(customerCode) : null;
    const customerCanonicalKey = customerCanon ? `${distKey} ${customerCanon}` : null;
    const territoryValues = (profile.territoryColumns ?? []).map((cName) => firstValue(row, header, [cName]));
    const brickIdValues = (profile.brickIdColumns ?? []).map((cName) => firstValue(row, header, [cName]));
    const brick = resolveBrick({ brickIdValues, customerKey, customerCanonicalKey, territoryValues }, maps);
    const hierarchy = deriveHierarchy(brick, maps);

    if (productCode) productResolved += 1;
    if (hierarchy) brickResolved += 1;

    // Self-heal detection: the sheet itself just told us this customer's brick (direct id or
    // territory/brick-name text) — never via the stored crosswalk. If that disagrees with (or is
    // absent from) the stored customer->brick map, queue a correction so the crosswalk catches up.
    if (brick && brick.source !== "customer" && brick.brickId && customerKey) {
      const stored = maps.customerBrickByKey.get(customerKey)
        ?? (customerCanonicalKey ? maps.customerBrickByCanonicalKey.get(customerCanonicalKey) : undefined);
      if (stored !== brick.brickId) {
        customerBrickCorrections.set(customerKey, {
          distributorCode: profile.distributorCode,
          customerCode,
          brickId: brick.brickId,
          previousBrickId: stored ?? null,
        });
      }
    }

    if (!productCode || !hierarchy) {
      // Blank-customer check: no location data at all (no code, territory, or brick ID).
      // This is a summary/footer row for most distributors but a hard data error for EG-BR.
      const hasAnyLocation = !!(customerCode || territoryValues.find(Boolean) || brickIdValues.find(Boolean));
      if (!hierarchy && !hasAnyLocation) {
        if (profile.blankCustomerBehavior === "error") {
          exceptions.push({
            rawProduct,
            rawProductName: productValues.slice(1).find(Boolean) ?? "",
            rawTerritory: "",
            rawCustomerCode: "",
            rawCustomerName: firstValue(row, header, profile.customerNameColumns),
            rawCustomerAddress: firstValue(row, header, profile.customerAddressColumns),
            rawRowNumber: r,
            reason: "blank_customer",
          });
        } else {
          blankCustomerSkipped += 1;
          const skippedQty = parseNum(firstValue(row, header, profile.qtyColumns));
          blankCustomerRows.push({
            rawProduct,
            rawProductName: productValues.slice(1).find(Boolean) ?? "",
            rawRowNumber: r,
            qty: Number.isFinite(skippedQty) ? skippedQty : 0,
          });
        }
        continue;
      }
      exceptions.push({
        rawProduct,
        rawProductName: productValues.slice(1).find(Boolean) ?? "",
        rawTerritory: territoryValues.find(Boolean) ?? "",
        rawCustomerCode: customerCode,
        rawCustomerName: firstValue(row, header, profile.customerNameColumns),
        rawCustomerAddress: firstValue(row, header, profile.customerAddressColumns),
        rawRowNumber: r,
        reason: !productCode && !hierarchy ? "both" : !productCode ? "product" : "brick",
      });
      continue;
    }

    const product = maps.productByCode.get(productCode);
    const qtyRaw = firstValue(row, header, profile.qtyColumns);
    const valueRaw = firstValue(row, header, profile.valueColumns);
    const discountRaw = firstValue(row, header, profile.discountColumns);
    const qty = parseNum(qtyRaw);
    const bonusQty = 0;
    const discount = discountFrac(discountRaw);
    const sheetValue = parseNum(valueRaw, true);
    const value = profile.valueSource === "sheet"
      ? sheetValue
      : (Number.isFinite(qty) ? qty * (product?.factoryPrice ?? 0) * (1 - discount) : 0);

    // A cell the parser cannot read must NOT become a zero.
    //
    // qty and value were written as `Number.isFinite(x) ? x : 0`, so "1,2OO" (letter O), an Arabic-
    // Indic numeral, "n/a", or a European "1.234,56" all silently became 0 on the path that carries
    // 99.6% of production rows — the sale vanished from every total with nothing to review. parseNum
    // returns NaN for an EMPTY cell too, and an empty quantity legitimately means zero, so only a
    // NON-EMPTY cell that fails to parse is an error.
    const nonEmpty = (raw: unknown) => String(raw ?? "").trim() !== "";
    const badQty = !Number.isFinite(qty) && nonEmpty(qtyRaw);
    const badValue = profile.valueSource === "sheet" && !Number.isFinite(sheetValue) && nonEmpty(valueRaw);
    // discountFrac returns NaN when the cell is present but out of range. It used to clamp silently
    // into [0,1], which both hid the typo and let a "150" become a 100% discount that zeroed the row
    // — and made upload-validation's discount_out_of_range check unreachable, because nothing
    // out-of-range ever survived to be validated.
    const badDiscount = !Number.isFinite(discount) && nonEmpty(discountRaw);

    if (badQty || badValue || badDiscount) {
      exceptions.push({
        rawProduct,
        rawProductName: productValues.slice(1).find(Boolean) ?? "",
        rawTerritory: territoryValues.find(Boolean) ?? "",
        rawCustomerCode: customerCode,
        rawCustomerName: firstValue(row, header, profile.customerNameColumns),
        rawCustomerAddress: firstValue(row, header, profile.customerAddressColumns),
        rawRowNumber: r,
        reason: badQty ? "unparseable_qty" : badValue ? "unparseable_value" : "discount_out_of_range",
      });
      continue;
    }

    coded.push({
      areaCode: hierarchy.areaCode,
      areaName: hierarchy.areaName,
      brickId: hierarchy.brickId,
      brickName: hierarchy.brickName,
      bonusQty: Number.isFinite(bonusQty) ? bonusQty : 0,
      clientAddress: firstValue(row, header, profile.customerAddressColumns) || null,
      clientCode: customerCode || null,
      clientName: firstValue(row, header, profile.customerNameColumns) || null,
      discount,
      distributorCode: profile.distributorCode,
      invoiceDate: periodFrom(firstValue(row, header, profile.dateColumns), dayFirst) ?? "",
      invoiceNumber: null,
      isDirect: profile.valueSource === "sheet",
      officialLine: product?.line || "Unknown",
      productCode,
      productName: product?.productName ?? productCode,
      qty: Number.isFinite(qty) ? qty : 0,
      rawRow: rawSourceRow(row, columnLabels),
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
    ignoredRows,
    blankCustomerRows,
    customerBrickCorrections: [...customerBrickCorrections.values()],
    summary: { brickResolved, blankCustomerSkipped, fullyCoded: coded.length, ignored, productResolved, totalRows: coded.length + exceptions.length + ignored + blankCustomerSkipped, scannedDataRows },
  };
}

// Choose the worksheet that actually carries this distributor's data. Many exports lead with a cover /
// summary / pivot sheet and put the real rows on a later tab; the old "worksheets[0]" assumption then
// read the wrong sheet. We score each sheet by how many KNOWN profile headers its best header row
// carries (via buildHeaderMap) and pick the richest; ties keep the earliest sheet. With no profile
// knowledge we fall back to the widest header row, and to the first sheet when nothing qualifies.
export function pickBestSheet(workbook: ExcelJS.Workbook, profile?: DistributorProfile): ExcelJS.Worksheet | undefined {
  const sheets = workbook.worksheets.filter((ws) => ws && ws.rowCount > 0 && ws.columnCount > 0);
  if (sheets.length <= 1) return sheets[0] ?? workbook.worksheets[0];
  const known = knownHeaderKeys(profile);
  let best = sheets[0];
  let bestHits = -1;
  for (const ws of sheets) {
    const header = buildHeaderMap(ws, profile);
    let hits = 0;
    if (known.size > 0) { for (const key of header.col.keys()) if (known.has(key)) hits += 1; }
    else hits = header.col.size; // no profile: prefer the widest header row
    if (hits > bestHits) { bestHits = hits; best = ws; }
  }
  return best;
}

export async function normalizeRawWorkbook(
  buffer: ArrayBuffer | Buffer,
  profile: DistributorProfile,
  maps: Crosswalks,
): Promise<NormalizeResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = pickBestSheet(workbook, profile);
  if (!sheet) {
    return { coded: [], distributorCode: profile.distributorCode, exceptions: [], ignoredRows: [], blankCustomerRows: [], customerBrickCorrections: [], summary: { brickResolved: 0, blankCustomerSkipped: 0, fullyCoded: 0, ignored: 0, productResolved: 0, totalRows: 0, scannedDataRows: 0 } };
  }
  return normalizeRows(sheet, profile, maps);
}

import {
  persistDistributorSalesUpload,
  summarizeRows,
  type DistributorSalesBrickProductRow,
  type DistributorSalesValidationIssue,
  type DistributorSalesValidationResult,
  type ParsedDistributorRow,
  type SalesDistributorOption,
  type SalesReferenceData,
} from "@/lib/sales/monthly-distributor-import";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Office allocation — the "office" channel reports product UNITS with no geography. Something has
// to decide where they went, and THE OWNER'S RULE (2026-08-10) is:
//
//   "Office must be imported LAST. Take the line's total sales, work out each AREA's contribution
//    to it, and spread the Office units by that contribution."
//
//   Step 1 (area):  ONE blended share per area = that area's share of the line's NON-Office VALUE,
//                   where value is units × the MASTER factory price (his words: "neglect the
//                   values, you take units and × factory in master database"). The same share is
//                   applied to EVERY product — deliberately NOT per product, so a product's office
//                   units can land in an area that sold none of it. He accepted that consequence.
//   Step 2 (brick): inside each area, split that area's slice across its BRICKS pro-rata on the
//                   same blended base. His rule stops at the area; this only exists because the
//                   rows and the rollup key on brick_id, and it leaves every AREA total identical.
//
// Excluding Office from the denominator is what keeps it non-circular — and it is why Office must
// be imported last: the shares are wrong until every other distributor for that line+period is in.
//
// Validated against his own July 2026 CNS closing: feeding his share column through this rule
// reproduces his Stores column to 96 units in 42,838 (0.22%). Weighting by UNITS instead of value
// is four times further out, which is how "value, not units" was settled.
//
// A period with no non-Office sales anywhere falls to NATIONAL.
// Office is a SEPARATE layer: rows carry distributor_code='Office', value = qty × factory price.
//
// PREVIOUSLY (before 2026-08-10) this split each product's units per product, region-then-brick,
// weighted by that product's own unit share. That placed Office differently in every area and was
// the single largest difference between Phoenix and the owner's manual closing — worth 6,075 units
// of area error on July CNS alone.
// ─────────────────────────────────────────────────────────────────────────────

export const OFFICE_DISTRIBUTOR_CODE = "Office";
export const OFFICE_TEMPLATE_KEY = "office_allocation";
const NATIONAL = "NATIONAL";

export type OfficeRegionShare = { productCode: string; regionCode: string; units: number };
export type OfficeBrickShare = { productCode: string; brickId: string; areaCode: string; regionCode: string; units: number };
export type OfficeMappedProduct = { productCode: string; productName: string; units: number; rowNumber: number };
export type OfficeUnmappedName = { productName: string; units: number; rowNumber: number };

type AllocationSlice = { brickId: string; areaCode: string; regionCode: string; units: number };

function round6(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 1_000_000) / 1_000_000;
}

// Largest-remainder reconciliation: round each slice to 6 dp and push the residual onto the largest
// slice so Σ allocated === office units for the product (no drift across many bricks).
function reconcile(slices: AllocationSlice[], target: number): AllocationSlice[] {
  if (slices.length === 0) return slices;
  const rounded = slices.map((s) => ({ ...s, units: round6(s.units) }));
  const sum = round6(rounded.reduce((acc, s) => acc + s.units, 0));
  const residual = round6(target - sum);
  if (residual !== 0) {
    let largest = 0;
    for (let i = 1; i < rounded.length; i += 1) if (rounded[i].units > rounded[largest].units) largest = i;
    rounded[largest] = { ...rounded[largest], units: round6(rounded[largest].units + residual) };
  }
  return rounded.filter((s) => s.units !== 0);
}

/**
 * The blended weights the owner's rule runs on. Built ONCE per file, from every non-Office brick
 * row in the period, and then applied unchanged to every product — that "one share for all
 * products" is the rule, not a shortcut.
 *
 * `areaShare` is the area's share of the line's NON-Office VALUE (units × master factory price).
 * `brickWithinArea` is each brick's share of its own area's units, used only to land the area slice
 * on real bricks; it never changes an area total.
 */
export type OfficeAreaWeights = {
  totalValue: number;
  areaShare: Map<string, number>;
  brickWithinArea: Map<string, { brickId: string; areaCode: string; regionCode: string; share: number }[]>;
};

/**
 * Build the area weights. `priceOf` returns the MASTER factory price for a product code — the value
 * basis the owner named explicitly; the stored row value is never used.
 *
 * Deliberately fed from `brickShare` (brick-carrying channels) and NOT `regionShare`: regionShare
 * includes Direct, which carries no area, and the owner's contribution is distributor sell-out.
 */
export function buildOfficeAreaWeights(
  brickShare: OfficeBrickShare[],
  priceOf: (productCode: string) => number,
): OfficeAreaWeights {
  const areaValue = new Map<string, number>();
  const areaUnits = new Map<string, number>();
  const brickUnits = new Map<string, { brickId: string; areaCode: string; regionCode: string; units: number }>();

  for (const b of brickShare) {
    if (!(b.units > 0) || !b.areaCode) continue;
    const price = priceOf(b.productCode);
    areaValue.set(b.areaCode, (areaValue.get(b.areaCode) ?? 0) + b.units * (price > 0 ? price : 0));
    areaUnits.set(b.areaCode, (areaUnits.get(b.areaCode) ?? 0) + b.units);
    const existing = brickUnits.get(b.brickId);
    if (existing) existing.units += b.units;
    else brickUnits.set(b.brickId, { brickId: b.brickId, areaCode: b.areaCode, regionCode: b.regionCode, units: b.units });
  }

  const totalValue = [...areaValue.values()].reduce((acc, v) => acc + v, 0);
  const areaShare = new Map<string, number>();
  if (totalValue > 0) {
    for (const [area, value] of areaValue) if (value > 0) areaShare.set(area, value / totalValue);
  }

  const brickWithinArea = new Map<string, { brickId: string; areaCode: string; regionCode: string; share: number }[]>();
  for (const b of brickUnits.values()) {
    const denom = areaUnits.get(b.areaCode) ?? 0;
    if (!(denom > 0)) continue;
    const list = brickWithinArea.get(b.areaCode) ?? [];
    list.push({ brickId: b.brickId, areaCode: b.areaCode, regionCode: b.regionCode, share: b.units / denom });
    brickWithinArea.set(b.areaCode, list);
  }

  return { totalValue, areaShare, brickWithinArea };
}

/**
 * Spread ONE product's office units using the blended weights. Returns slices keyed by brick, or the
 * NATIONAL bucket when the period has no non-Office sales to weight on at all.
 * Pure — unit-tested without a database.
 */
function allocateProduct(units: number, weights: OfficeAreaWeights): AllocationSlice[] {
  if (!(units > 0)) return [];

  // Nothing sold anywhere this period → cannot be placed → NATIONAL.
  if (!(weights.totalValue > 0) || weights.areaShare.size === 0) {
    return reconcile([{ brickId: "", areaCode: "", regionCode: NATIONAL, units }], units);
  }

  const sliceMap = new Map<string, AllocationSlice>();
  const addSlice = (key: string, slice: AllocationSlice) => {
    const existing = sliceMap.get(key);
    if (existing) existing.units += slice.units;
    else sliceMap.set(key, { ...slice });
  };

  for (const [areaCode, share] of weights.areaShare) {
    const areaUnitsForProduct = units * share;
    if (!(areaUnitsForProduct > 0)) continue;

    const bricks = weights.brickWithinArea.get(areaCode) ?? [];
    if (bricks.length === 0) {
      // Area carries value but no brick detail — should not happen, both come from brickShare.
      addSlice(NATIONAL, { brickId: "", areaCode: "", regionCode: NATIONAL, units: areaUnitsForProduct });
      continue;
    }
    for (const b of bricks) {
      addSlice(b.brickId, {
        brickId: b.brickId,
        areaCode: b.areaCode,
        regionCode: b.regionCode,
        units: areaUnitsForProduct * b.share,
      });
    }
  }

  return reconcile([...sliceMap.values()], units);
}

export type ComputeOfficeAllocationInput = {
  period: string;
  distributor: SalesDistributorOption;
  fileName: string;
  sheetName: string;
  mapped: OfficeMappedProduct[];
  unmappedNames: OfficeUnmappedName[];
  regionShare: OfficeRegionShare[];
  brickShare: OfficeBrickShare[];
  references: SalesReferenceData;
};

// Build the full validation result (validated or blocked) + the parsed Office rows. Pure (no DB) so
// the two-step math is unit-tested directly.
export function computeOfficeAllocation(input: ComputeOfficeAllocationInput): DistributorSalesValidationResult & { parsedRows: ParsedDistributorRow[] } {
  const { period, distributor, fileName, sheetName } = input;
  const totalNames = input.mapped.length + input.unmappedNames.length;

  const baseResult: Omit<DistributorSalesValidationResult, "byArea" | "byBrick" | "byLine" | "byProduct" | "byRegion" | "totals" | "status" | "issues" | "blockingReasons" | "importableRows" | "failedRows" | "warningRows" | "rowCount" | "advisories"> = {
    distributor,
    fileName,
    period,
    sheetName,
    templateKey: OFFICE_TEMPLATE_KEY,
    templateName: "Office allocation",
  };

  // BLOCKED: any unmapped office product name → surface every one, persist nothing.
  if (input.unmappedNames.length > 0) {
    const issues: DistributorSalesValidationIssue[] = input.unmappedNames.map((n) => ({
      field: "Product",
      message: `"${n.productName}" is not mapped to a Source of Sales product. Map it in the Office product mapping, then preview again.`,
      rowNumber: n.rowNumber,
      severity: "failure",
      value: n.productName,
    }));
    return {
      ...baseResult,
      advisories: [],
      blockingReasons: [
        `${input.unmappedNames.length} office product name(s) are not mapped to a product code. Map them in the Office product mapping, then preview again.`,
      ],
      byArea: [],
      byBrick: [],
      byLine: [],
      byProduct: [],
      byRegion: [],
      failedRows: input.unmappedNames.length,
      importableRows: 0,
      issues,
      parsedRows: [],
      rowCount: totalNames,
      status: "blocked",
      totals: { rowCount: 0, totalBonusQty: 0, totalQty: 0, totalValue: 0 },
      warningRows: 0,
    };
  }

  // Index the references for fast per-product lookup.
  const productByCode = new Map(input.references.products.map((p) => [normalizeCodeKey(p.productCode), p]));

  // The owner's rule: ONE blended set of area weights for the whole file, built from every
  // non-Office brick row in the period and weighted by units × MASTER factory price. Built once
  // here, then applied unchanged to every product.
  const weights = buildOfficeAreaWeights(
    input.brickShare,
    (productCode) => productByCode.get(normalizeCodeKey(productCode))?.factoryPrice ?? 0,
  );
  const brickById = new Map((input.references.bricks ?? []).map((b) => [b.brickId, b]));

  const parsedRows: ParsedDistributorRow[] = [];
  const nationalProducts: string[] = [];
  let rowNumber = 0;

  for (const product of input.mapped) {
    const codeKey = normalizeCodeKey(product.productCode);
    const reference = productByCode.get(codeKey);
    const factoryPrice = reference?.factoryPrice ?? 0;
    const officialLine = reference?.line || "Unknown";
    const productName = reference?.productName || product.productName || product.productCode;

    const slices = allocateProduct(product.units, weights);
    let sentToNational = false;

    for (const slice of slices) {
      rowNumber += 1;
      const isNational = slice.regionCode === NATIONAL || !slice.brickId;
      if (isNational) sentToNational = true;
      const brick = isNational ? undefined : brickById.get(slice.brickId);
      const value = round6(slice.units * factoryPrice);
      parsedRows.push({
        areaCode: isNational ? "" : (brick?.areaCode ?? slice.areaCode),
        areaName: isNational ? "" : (brick?.areaName ?? ""),
        blockCode: isNational ? "" : (brick?.blockCode ?? ""),
        blockName: isNational ? "" : (brick?.blockName ?? ""),
        bonusQty: 0,
        brickId: isNational ? "" : slice.brickId,
        brickName: isNational ? "" : (brick?.brickName ?? ""),
        clientAddress: null,
        clientCode: null,
        clientName: null,
        discount: 0,
        distributorCode: OFFICE_DISTRIBUTOR_CODE,
        isDirect: false,
        invoiceDate: `${period}-01`,
        invoiceNumber: null,
        invoicePeriod: period,
        officialLine,
        productCode: reference?.productCode ?? product.productCode,
        productName,
        qty: slice.units,
        regionCode: isNational ? NATIONAL : (brick?.regionCode ?? slice.regionCode),
        regionName: isNational ? "National" : (brick?.regionName ?? ""),
        rowNumber,
        rawRow: {
          source: "office-allocation",
          productName: product.productName,
          officeUnits: String(product.units),
          allocatedTo: isNational ? "NATIONAL" : slice.brickId,
        },
        validationIssues: [],
        validationState: "valid",
        value,
      });
    }
    if (sentToNational) nationalProducts.push(productName);
  }

  const summary = summarizeRows(parsedRows);
  const advisories: string[] = [];
  if (nationalProducts.length > 0) {
    advisories.push(
      `${nationalProducts.length} product(s) had office units that could not be placed on a brick and went to the National bucket: ${[...new Set(nationalProducts)].join(", ")}.`,
    );
  }

  // Brick × product cross-tab — one entry per (brick, product) pair so the preview can show a
  // per-brick-per-product breakdown instead of only aggregate region totals.
  const byBrickProduct: DistributorSalesBrickProductRow[] = parsedRows
    .map((r) => ({
      areaCode: r.areaCode,
      areaName: r.areaName,
      brickId: r.brickId,
      brickName: r.brickName,
      productCode: r.productCode,
      productName: r.productName,
      qty: Math.round(r.qty * 1e4) / 1e4,
      regionCode: r.regionCode,
      regionName: r.regionName,
      value: Math.round(r.value * 1e4) / 1e4,
    }))
    .sort(
      (a, b) =>
        a.regionCode.localeCompare(b.regionCode) ||
        a.areaCode.localeCompare(b.areaCode) ||
        a.brickId.localeCompare(b.brickId) ||
        a.productCode.localeCompare(b.productCode),
    );

  return {
    ...baseResult,
    advisories,
    blockingReasons: [],
    byArea: summary.byArea,
    byBrick: summary.byBrick,
    byBrickProduct,
    byLine: summary.byLine,
    byProduct: summary.byProduct,
    byRegion: summary.byRegion,
    failedRows: 0,
    importableRows: parsedRows.length,
    issues: [],
    parsedRows,
    rowCount: parsedRows.length,
    status: "validated",
    totals: summary.totals,
    warningRows: 0,
  };
}

// ── DB loaders (the contribution base + office name→code aliases for the period) ──

export async function loadOfficeRegionShare(period: string): Promise<OfficeRegionShare[]> {
  const supabase = getSupabaseAdmin();
  const rows = await rpcAll<{ product_code: string; region_code: string; units: number | string }>(
    supabase,
    "phx_office_region_share",
    { p_period: period },
    ["product_code", "region_code"],
  );
  return rows.map((r) => ({
    productCode: String(r.product_code ?? ""),
    regionCode: String(r.region_code ?? ""),
    units: Number(r.units ?? 0),
  }));
}

export async function loadOfficeBrickShare(period: string): Promise<OfficeBrickShare[]> {
  const supabase = getSupabaseAdmin();
  const rows = await rpcAll<{ product_code: string; brick_id: string; area_code: string; region_code: string; units: number | string }>(
    supabase,
    "phx_office_brick_share",
    { p_period: period },
    ["product_code", "brick_id"],
  );
  return rows.map((r) => ({
    productCode: String(r.product_code ?? ""),
    brickId: String(r.brick_id ?? ""),
    areaCode: String(r.area_code ?? ""),
    regionCode: String(r.region_code ?? ""),
    units: Number(r.units ?? 0),
  }));
}

// Office product-name → product-code map (alias_kind handled by the shared aliases table). Paged past
// PostgREST's 1000-row cap; tolerant of a missing table. Keyed by normalizeAliasKey(name).
export async function loadOfficeNameToCode(): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const distributor = normalizeCodeKey(OFFICE_DISTRIBUTOR_CODE);
  const map = new Map<string, string>();
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const result = await supabase
      .from("source_of_sales_product_aliases")
      .select("alias, product_code")
      .eq("active", true)
      .eq("distributor_code", distributor)
      .order("alias", { ascending: true })
      .range(from, from + pageSize - 1);
    if (result.error) break;
    const page = (result.data ?? []) as Array<{ alias?: string; product_code?: string }>;
    for (const r of page) {
      const key = normalizeAliasKey(r.alias);
      const code = String(r.product_code ?? "").trim();
      if (key && code && !map.has(key)) map.set(key, code);
    }
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return map;
}

export async function persistOfficeAllocation(
  result: DistributorSalesValidationResult & { parsedRows: ParsedDistributorRow[] },
  uploadedBy: string,
) {
  return persistDistributorSalesUpload(result, uploadedBy);
}

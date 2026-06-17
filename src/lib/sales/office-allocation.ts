import {
  persistDistributorSalesUpload,
  summarizeRows,
  type DistributorSalesValidationIssue,
  type DistributorSalesValidationResult,
  type ParsedDistributorRow,
  type SalesDistributorOption,
  type SalesReferenceData,
} from "@/lib/sales/monthly-distributor-import";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Office allocation — the "office" channel reports product UNITS with no geography. Its units are
// distributed to bricks using how every other channel sold the same products that period:
//   Step 1 (region): split each product's office units across REGIONS by that product's region share
//                    across ALL confirmed channels INCLUDING Direct.
//   Step 2 (brick):  inside each region, split that region's office units across BRICKS by that
//                    product's brick share among only BRICK-carrying channels (excludes Direct).
// A product with no key anywhere (or a region with only region-level/Direct sales) falls to NATIONAL.
// Office is a SEPARATE layer: rows carry distributor_code='Office', value = qty × factory price.
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

// Two-step split for ONE product's office units. Returns slices keyed by brick (real geography) or the
// NATIONAL bucket. Pure — unit-tested without a database.
function allocateProduct(
  units: number,
  regionShareForProduct: OfficeRegionShare[],
  brickShareForProduct: OfficeBrickShare[],
): AllocationSlice[] {
  if (!(units > 0)) return [];

  const regionTotal = regionShareForProduct.reduce((acc, r) => acc + (r.units > 0 ? r.units : 0), 0);
  // No sales anywhere this period (across all channels incl. Direct) → cannot be placed → NATIONAL.
  if (!(regionTotal > 0)) {
    return reconcile([{ brickId: "", areaCode: "", regionCode: NATIONAL, units }], units);
  }

  const bricksByRegion = new Map<string, OfficeBrickShare[]>();
  for (const b of brickShareForProduct) {
    if (!(b.units > 0)) continue;
    const list = bricksByRegion.get(b.regionCode) ?? [];
    list.push(b);
    bricksByRegion.set(b.regionCode, list);
  }

  const sliceMap = new Map<string, AllocationSlice>();
  const addSlice = (key: string, slice: AllocationSlice) => {
    const existing = sliceMap.get(key);
    if (existing) existing.units += slice.units;
    else sliceMap.set(key, { ...slice });
  };

  for (const region of regionShareForProduct) {
    if (!(region.units > 0)) continue;
    const regionUnits = units * (region.units / regionTotal);
    if (!(regionUnits > 0)) continue;

    const bricks = bricksByRegion.get(region.regionCode) ?? [];
    const brickTotal = bricks.reduce((acc, b) => acc + b.units, 0);
    if (!(brickTotal > 0)) {
      // Region has region-level sales (e.g. only Direct sold there) but no brick detail → NATIONAL.
      addSlice(NATIONAL, { brickId: "", areaCode: "", regionCode: NATIONAL, units: regionUnits });
      continue;
    }
    for (const b of bricks) {
      addSlice(b.brickId, { brickId: b.brickId, areaCode: b.areaCode, regionCode: b.regionCode, units: regionUnits * (b.units / brickTotal) });
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

  // Index the contribution base + references for fast per-product lookup.
  const regionByProduct = new Map<string, OfficeRegionShare[]>();
  for (const r of input.regionShare) {
    const key = normalizeCodeKey(r.productCode);
    const list = regionByProduct.get(key) ?? [];
    list.push(r);
    regionByProduct.set(key, list);
  }
  const brickByProduct = new Map<string, OfficeBrickShare[]>();
  for (const b of input.brickShare) {
    const key = normalizeCodeKey(b.productCode);
    const list = brickByProduct.get(key) ?? [];
    list.push(b);
    brickByProduct.set(key, list);
  }
  const productByCode = new Map(input.references.products.map((p) => [normalizeCodeKey(p.productCode), p]));
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

    const slices = allocateProduct(product.units, regionByProduct.get(codeKey) ?? [], brickByProduct.get(codeKey) ?? []);
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

  return {
    ...baseResult,
    advisories,
    blockingReasons: [],
    byArea: summary.byArea,
    byBrick: summary.byBrick,
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

// Sales Operations Module — Office allocator.
//
// The "Office" channel exports a PIVOT: product NAME + total UNITS, with NO geography and NO date.
// Its units are distributed to bricks by how every OTHER channel sold the same product that period:
//   Step 1 (region): split each product's office units across REGIONS by the product's region share
//                    across ALL confirmed channels (including Direct).
//   Step 2 (brick):  inside each region, split that region's units across BRICKS by the product's
//                    brick share among only brick-carrying channels (excludes Direct).
// A product with no sales anywhere (or a region with no brick detail) falls to the NATIONAL bucket.
// Office is a separate layer: rows carry distributorCode='Office', value = allocated qty × factory price.
//
// All math here is PURE (shares + masters are injected) so it is unit-tested without a database.
// `normalizeSheet` deliberately throws for office-allocation distributors; this is its counterpart.

import { cellText, normalizeCodeKey, parseNum, resolveProduct } from "@/lib/sales-operations/normalize";
import type { CellRow } from "@/lib/sales-operations/normalize";
import type { CodedRow, Crosswalks, DistributorTemplate, NormalizeException, NormalizeResult } from "@/lib/sales-operations/types";

export const OFFICE_DISTRIBUTOR_CODE = "Office";
const NATIONAL = "NATIONAL";

export type OfficeRegionShare = { productCode: string; regionCode: string; units: number };
export type OfficeBrickShare = { productCode: string; brickId: string; areaCode: string; regionCode: string; units: number };
export type OfficePivotRow = { productName: string; units: number; rawRowNumber: number };

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
// NATIONAL bucket. Pure.
function allocateProduct(units: number, regionShareForProduct: OfficeRegionShare[], brickShareForProduct: OfficeBrickShare[]): AllocationSlice[] {
  if (!(units > 0)) return [];

  const regionTotal = regionShareForProduct.reduce((acc, r) => acc + (r.units > 0 ? r.units : 0), 0);
  if (!(regionTotal > 0)) {
    // No sales anywhere this period → cannot be placed → NATIONAL.
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
      // Region-level sales only (e.g. Direct) but no brick detail → NATIONAL.
      addSlice(NATIONAL, { brickId: "", areaCode: "", regionCode: NATIONAL, units: regionUnits });
      continue;
    }
    for (const b of bricks) {
      addSlice(b.brickId, { brickId: b.brickId, areaCode: b.areaCode, regionCode: b.regionCode, units: regionUnits * (b.units / brickTotal) });
    }
  }

  return reconcile([...sliceMap.values()], units);
}

const HEADER_KEY = (value: unknown) => String(value ?? "").trim().toLowerCase();

// Read the office pivot (product name + units) from a raw grid, using the Office template's headers.
// Stops at the first fully-blank row (everything below the pivot block is unrelated junk).
export function parseOfficePivot(rows: CellRow[], template: DistributorTemplate): OfficePivotRow[] {
  const nameHeaders = (template.productNameHeaders ?? []).map(HEADER_KEY);
  const unitsHeaders = (template.qtyHeaders ?? []).map(HEADER_KEY);
  let headerRow = -1;
  let productCol = -1;
  let unitsCol = -1;
  const limit = Math.min(rows.length, 10);
  for (let r = 0; r < limit; r += 1) {
    let pc = -1;
    let uc = -1;
    (rows[r] ?? []).forEach((cell, c) => {
      const key = HEADER_KEY(cellText(cell));
      if (pc < 0 && nameHeaders.includes(key)) pc = c;
      if (uc < 0 && unitsHeaders.includes(key)) uc = c;
    });
    if (pc >= 0 && uc >= 0) {
      headerRow = r;
      productCol = pc;
      unitsCol = uc;
      break;
    }
  }
  if (headerRow < 0) return [];

  const out: OfficePivotRow[] = [];
  for (let r = headerRow + 1; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    if (row.every((c) => cellText(c) === "")) break; // stop at first blank row
    const name = cellText(row[productCol]);
    if (!name) continue; // skip stray rows with no product name (e.g. a grand-total label)
    const units = parseNum(row[unitsCol]);
    out.push({ productName: name, units: Number.isFinite(units) ? units : 0, rawRowNumber: r + 1 });
  }
  return out;
}

export type ComputeOfficeAllocationInput = {
  pivotRows: OfficePivotRow[];
  maps: Crosswalks;
  regionShare: OfficeRegionShare[];
  brickShare: OfficeBrickShare[];
  period: string; // YYYY-MM (Office has no per-row date; period comes from the picker)
  distributorCode?: string;
};

export type OfficeAllocationResult = NormalizeResult & {
  // Products whose units could not be placed on a brick and went to the NATIONAL bucket.
  nationalProducts: string[];
  // Σ(mapped input units) − Σ(allocated units). Should be ~0; surfaced as office_allocation_residual.
  residualUnits: number;
};

// Allocate the Office pivot into coded rows. Product is resolved NAME-first (Office has no code column);
// unmapped names become exceptions (the whole upload blocks upstream). Pure.
export function computeOfficeAllocation(input: ComputeOfficeAllocationInput): OfficeAllocationResult {
  const distributorCode = input.distributorCode ?? OFFICE_DISTRIBUTOR_CODE;

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

  const coded: CodedRow[] = [];
  const exceptions: NormalizeException[] = [];
  const nationalProducts: string[] = [];
  let productResolved = 0;
  let brickResolved = 0;
  let mappedUnits = 0;
  let allocatedUnits = 0;

  for (const pivot of input.pivotRows) {
    const match = resolveProduct([pivot.productName], [], input.maps, distributorCode);
    if (!match) {
      exceptions.push({
        rawProduct: "",
        rawProductName: pivot.productName,
        rawBrickName: "",
        rawCustomerCode: "",
        rawCustomerName: "",
        rawRowNumber: pivot.rawRowNumber,
        reason: "product",
      });
      continue;
    }
    productResolved += 1;
    const product = input.maps.productByCode.get(match.productCode);
    const factoryPrice = product?.factoryPrice ?? 0;
    if (pivot.units > 0) mappedUnits += pivot.units;

    const slices = allocateProduct(pivot.units, regionByProduct.get(match.productCode) ?? [], brickByProduct.get(match.productCode) ?? []);
    let sentNational = false;
    for (const slice of slices) {
      allocatedUnits += slice.units;
      const isNational = slice.regionCode === NATIONAL || !slice.brickId;
      if (isNational) sentNational = true;
      const brick = isNational ? undefined : input.maps.brickById.get(slice.brickId);
      if (!isNational && brick) brickResolved += 1;
      coded.push({
        areaCode: isNational ? "" : (brick?.areaCode ?? slice.areaCode),
        areaName: isNational ? "" : (brick?.areaName ?? ""),
        brickId: isNational ? "" : slice.brickId,
        brickName: isNational ? "" : (brick?.brickName ?? ""),
        clientCode: null,
        clientName: null,
        clientAddress: null,
        distributorCode,
        family: product?.family ?? "",
        invoiceDate: input.period,
        officialLine: product?.line || "Unknown",
        productCode: product?.productCode ?? match.productCode,
        productName: product?.productName ?? pivot.productName,
        qty: slice.units,
        rawRowNumber: pivot.rawRowNumber,
        regionCode: isNational ? NATIONAL : (brick?.regionCode ?? slice.regionCode),
        regionName: isNational ? "National" : (brick?.regionName ?? ""),
        value: round6(slice.units * factoryPrice),
      });
    }
    if (sentNational) nationalProducts.push(product?.productName ?? pivot.productName);
  }

  return {
    distributorCode,
    coded,
    exceptions,
    excluded: [],
    summary: {
      scannedDataRows: input.pivotRows.length,
      fullyCoded: coded.length,
      productResolved,
      productByCodeFallback: 0, // Office is name-only (pivot has no product code column)
      brickResolved,
      excludedBonus: 0,
      blankKeySkipped: 0,
      exceptions: exceptions.length,
    },
    nationalProducts: [...new Set(nationalProducts)],
    residualUnits: round6(mappedUnits - allocatedUnits),
  };
}

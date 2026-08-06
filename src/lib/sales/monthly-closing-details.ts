import type { AccessContext } from "@/lib/auth/permissions";
import {
  applyProductCodeAllowlist,
  canViewHeadOfficeLine,
  canonicalizeRegionName,
  isHeadOfficeLine,
  isRestrictedProductCode,
  normalizeLineKey,
  resolveSalesAccessScope,
} from "@/lib/sales/access-scope";
import { closingAreaOf, isRebookedRow } from "@/lib/sales/closing-row-area";
import { JULY_2026_DIRECT_PERIOD } from "@/lib/sales/july-2026-direct-orders";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The one month whose DIRECT rows are taken as stored rather than valued at factory price —
 * the owner's ruling of 2026-08-06. See resolveClosingDetailSalesValue for the reasoning.
 *
 * Deliberately the SAME constant as July's hand-mapped direct orders rather than a second
 * `"2026-07"` literal: the ruling and the mapping describe one month, and if that month's direct
 * data ever moves, both must move together.
 */
const STORED_VALUE_DIRECT_PERIOD: string = JULY_2026_DIRECT_PERIOD;

// ─────────────────────────────────────────────────────────────────────────────
// Monthly Closing — DETAILS.
//
// The Closing Matrix is an area x product aggregate. This module is the layer under it:
// every distributor sheet row exactly as it was imported, with the Phoenix master joined on
// so a reader can see how a brick rolls up to an area and re-add the numbers by hand.
//
// It is the audit surface, so it deliberately shows rows the matrix DROPS and says why:
//
//   • Direct rows            -> excluded from phx_monthly_closing_matrix (`not f.is_direct`)
//                               and reported by phx_monthly_closing_direct instead.
//   • Confidential products  -> LA003 / LA004 / SS001, excluded by the matrix RPC and visible
//                               here only to a CEO / Super Admin who explicitly opts in.
//
// Those are the ONLY two exclusions. Verified against production 2026-06: with exactly this
// predicate the detail rows reproduce phx_monthly_closing_matrix to the cent on every line —
// Pedia 11,095u / 2,434,468.50, Anti Infective 7,522u / 696,563.10, CNS 66,656u / 4,109,041.65.
//
// A missing client code is NOT an exclusion. (source_of_sales_fact_rollup's customer-grain
// population path filters on `client_code is not null`, but the matrix RPC reads the
// area/product grain, which keeps those rows. Checked directly: adding a client-code filter
// here understated CNS by 11,205 units.) It is still surfaced as a data-quality flag, because
// a sale with no customer identity cannot be traced back to an outlet.
//
// `includedInClosing` is the single flag that says whether a row is inside the headline
// number; `reconciliation` totals both sides so the two can never silently drift again.
//
// Scope: resolveSalesAccessScope is the authority (line + region + per-user product allowlist).
// Confidential products and the Head Office line stay CEO / Super Admin only — the caller's
// `includeConfidential` request is ignored for every other role, so an API/URL/export tamper
// cannot widen visibility.
// ─────────────────────────────────────────────────────────────────────────────

/** Why a row is not part of the Closing Matrix headline. Empty when it is. */
export type ClosingDetailExclusion = "direct" | "confidential";

export type ClosingDetailRow = {
  /** Stable identity for UI keys and keyset paging. */
  id: number;
  rowNumber: number | null;
  distributorCode: string;
  invoicePeriod: string;
  invoiceDate: string | null;
  officialLine: string;

  /** As-imported geography, straight off the distributor sheet. */
  sheetAreaCode: string;
  sheetAreaName: string;
  sheetRegionCode: string;
  sheetRegionName: string;
  blockCode: string;
  brickId: string;

  /** Phoenix master geography, resolved from the BRICK (the authoritative key). */
  brickName: string;
  areaCode: string;
  areaName: string;
  regionCode: string;
  regionName: string;
  /** True when the sheet's area disagrees with the brick's Phoenix area. */
  areaMismatch: boolean;
  /** True when the brick id is absent from the Phoenix master (cannot roll up). */
  brickUnmapped: boolean;

  clientCode: string;
  clientName: string;
  clientAddress: string;

  productCode: string;
  productName: string;
  family: string;
  factoryPrice: number;

  qty: number;
  bonusQty: number;
  discount: number;
  /** qty x (1 - discount) — the base the matrix values (mirrors fact_rollup.effective_units). */
  effectiveUnits: number;
  /**
   * The row's contribution to the closing's sales value. Normally effectiveUnits x factoryPrice —
   * the distributor formula the matrix uses. See resolveClosingDetailSalesValue for the one
   * documented month that is taken as stored instead.
   */
  salesValue: number;
  /** The value column as it appeared on the distributor sheet, untouched. */
  sheetValue: number;

  isDirect: boolean;
  isConfidential: boolean;
  /** Data quality, NOT an exclusion — the row still counts, it just has no traceable outlet. */
  missingClientCode: boolean;
  validationState: string;

  /** True when this row is inside the Closing Matrix headline. */
  includedInClosing: boolean;
  exclusions: ClosingDetailExclusion[];
};

export type ClosingDetailsTotals = {
  rows: number;
  units: number;
  effectiveUnits: number;
  salesValue: number;
};

export type ClosingDetailsFilters = {
  regionCodes?: string[];
  areaCodes?: string[];
  productCodes?: string[];
  distributorCodes?: string[];
  /** "included" | "excluded" | "" (all) — slices by whether the row feeds the closing. */
  inclusion?: string;
  /** Free text over brick / area / customer / product / client code. */
  search?: string;
};

export type ClosingDetailsResult = {
  line: string | null;
  period: string | null;
  availableLines: string[];
  availablePeriods: string[];
  /** The requested page of rows (already filtered + scoped). */
  rows: ClosingDetailRow[];
  /** Row count after filters, before paging — what `totals` covers. */
  filteredRowCount: number;
  page: number;
  pageSize: number;
  /** Filter options built from everything in scope, so a filter never hides its own choices. */
  options: {
    regions: { code: string; name: string }[];
    areas: { code: string; name: string; regionCode: string }[];
    products: { code: string; name: string }[];
    distributors: string[];
  };
  /** All rows the viewer may see, after filters (not just this page). */
  totals: ClosingDetailsTotals;
  reconciliation: {
    /** Rows that feed the Closing Matrix — these must tie to it exactly. */
    includedInClosing: ClosingDetailsTotals;
    /** Everything the matrix drops, split by reason. */
    excludedDirect: ClosingDetailsTotals;
    excludedConfidential: ClosingDetailsTotals;
    /** Counted in the closing, but with no customer identity to trace it to. */
    missingClientCode: ClosingDetailsTotals;
    /** Rows whose brick is missing from the Phoenix master (roll up to no area). */
    unmappedBricks: ClosingDetailsTotals;
    /** Rows where the sheet area disagrees with the brick's Phoenix area. */
    areaMismatches: ClosingDetailsTotals;
  };
  /** True when the viewer was allowed to reveal LA003 / LA004 / SS001 and asked to. */
  confidentialIncluded: boolean;
  /** True when the viewer's role may toggle confidential products at all. */
  canRevealConfidential: boolean;
  /** True when scope resolved to "nothing" — the UI shows an explicit empty state, not a zero. */
  outOfScope: boolean;
};

const PAGE = 1000;

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * What ONE row contributes to the closing's sales value.
 *
 * This is the only place in the closing where a value is DERIVED rather than read, so it is the
 * only place the owner's July ruling can live without special-casing a sheet.
 *
 * ── THE NORMAL RULE ──────────────────────────────────────────────────────────────────────────
 * effectiveUnits x factoryPrice. That is the DISTRIBUTOR formula — the same arithmetic
 * phx_monthly_closing_matrix values sell-out at (`f.effective_units * p.factory_price`) — and it is
 * correct for a distributor invoice line, whose sheet value is a restatement of it.
 *
 * ── THE JULY 2026 EXCEPTION (owner's ruling, 2026-08-06) ─────────────────────────────────────
 * "july exception take direct units and values as they are — 149,288.50 is accurate 100%"
 *
 * For 2026-07, and for DIRECT rows only, the STORED sheet value IS the value. It is authoritative
 * and is not re-derived from anything.
 *
 * WHY. A direct order is a negotiated deal — it carries its own price, its own discount and its own
 * bonus — so pricing it at factory price answers a question nobody asked. Measured in production on
 * 2026-08-06 for Anti Infective 2026-07 direct, 16 rows, 2,120 units:
 *
 *   source_of_sales_import_rows.value        149,288.50   <- the owner's own file, to the piastre
 *   source_of_sales_fact_rollup.direct_value 149,288.50
 *   phx_monthly_closing_direct               149,288.50
 *   phx_closing_channel_breakdown __DIRECT__ 149,288.50
 *   effectiveUnits x factoryPrice            157,518.00   <- ONLY this line, overstating by 8,229.50
 *
 * Every other surface in the closing already reads the stored value. This derivation was the single
 * disagreement, and it reached the Data sheet's "Sales Value" column, the Data/Total reconciliation
 * (`excludedDirect`) and the on-screen Closing Details panel.
 *
 * WHY ONLY JULY, AND WHY THIS IS NOT A PRICING RULE. The owner ruled ONE month, so every other month
 * keeps exactly the behaviour it has today — deliberately, and a future month must be ruled on
 * before it is added here. This function also does not PRICE anything: it declines to. The locked
 * direct-order pricing rule (discount qty x PUBLIC x (1 - disc%), bonus qty x PHARMACY) is neither
 * read nor changed here, and factory price remains banned as a direct-order price.
 */
export function resolveClosingDetailSalesValue(input: {
  isDirect: boolean;
  /** The row's own invoice period, `YYYY-MM`. */
  invoicePeriod: string;
  /** qty x (1 - discount). */
  effectiveUnits: number;
  factoryPrice: number;
  /** The value column exactly as the sheet stored it. */
  sheetValue: number;
}): number {
  if (input.isDirect && input.invoicePeriod.trim() === STORED_VALUE_DIRECT_PERIOD) return input.sheetValue;
  return input.effectiveUnits * input.factoryPrice;
}

function emptyTotals(): ClosingDetailsTotals {
  return { rows: 0, units: 0, effectiveUnits: 0, salesValue: 0 };
}

function addTo(totals: ClosingDetailsTotals, row: ClosingDetailRow) {
  totals.rows += 1;
  totals.units += row.qty;
  totals.effectiveUnits += row.effectiveUnits;
  totals.salesValue += row.salesValue;
}

function roundTotals(totals: ClosingDetailsTotals): ClosingDetailsTotals {
  return {
    rows: totals.rows,
    units: Number(totals.units.toFixed(6)),
    effectiveUnits: Number(totals.effectiveUnits.toFixed(6)),
    salesValue: Number(totals.salesValue.toFixed(6)),
  };
}

/**
 * Every validated batch id for a period. The matrix RPC joins
 * `source_of_sales_import_batches ... status = 'validated'`; the details read has to apply the
 * same gate or it would show rows the closing never counted.
 */
async function validatedBatchIdsForPeriod(period: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_import_batches")
    .select("id")
    .eq("status", "validated")
    .eq("period", period);
  if (error) throw error;
  return (data ?? []).map((row) => text((row as { id?: unknown }).id)).filter(Boolean);
}

/**
 * Read every import row for the batches, KEYSET-paged on the bigint primary key.
 *
 * Not `.range()`: PostgREST offset paging without an ORDER BY has no stable row order, so
 * consecutive pages can repeat rows and skip others at random. That exact bug dropped 1,262 of
 * 49,713 customer mappings in the June 2026 import. Ordering by `id` and seeking past the last
 * id read is immune to it, and to concurrent inserts shifting rows across a page boundary.
 */
async function readImportRows(batchIds: string[], line: string): Promise<Array<Record<string, unknown>>> {
  if (batchIds.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const rows: Array<Record<string, unknown>> = [];
  let cursor: number | null = null;
  for (;;) {
    let query = supabase
      .from("source_of_sales_import_rows")
      .select(
        "id,row_number,batch_id,distributor_code,invoice_period,invoice_date,official_line," +
          "region_code,region_name,area_code,area_name,block_code,brick_id," +
          "client_code,client_name,client_address,product_code,product_name," +
          "qty,bonus_qty,discount,value,is_direct,validation_state",
      )
      .in("batch_id", batchIds)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (cursor !== null) query = query.gt("id", cursor);

    const { data, error } = await query;
    if (error) throw error;
    const page = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (page.length === 0) break;
    for (const row of page) {
      if (normalizeLineKey(text(row.official_line)) === normalizeLineKey(line)) rows.push(row);
    }
    if (page.length < PAGE) break;
    const last = Number(page[page.length - 1]?.id);
    if (!Number.isFinite(last)) break; // no usable cursor — stop rather than loop forever
    cursor = last;
  }
  await fillMissingAddresses(rows);
  return rows;
}

/**
 * Fill `client_address` from the customer master wherever the sales row itself carries none.
 *
 * Every distributor file has a Customer Address column, ~100% populated, but the normalizer's
 * persist path wrote a literal null for a long time — so all 294,445 existing rows are blank and
 * the closing's Data sheet printed an empty Address column. The import defect is fixed, but that
 * only helps months imported from now on; this fills every month already in the database.
 *
 * Deliberately keyed on (distributor_code, customer_code), which is unique among active master
 * rows, so a customer trading under two distributors keeps two addresses and no row is duplicated.
 * Chunked because PostgREST caps a single `in` list, and a failure here must never take the closing
 * down: an address is a nicety, the numbers are the point.
 */
async function fillMissingAddresses(rows: Array<Record<string, unknown>>): Promise<void> {
  const needed = rows.filter((row) => !text(row.client_address) && text(row.client_code));
  if (needed.length === 0) return;

  const codes = [...new Set(needed.map((row) => text(row.client_code)))];
  const byKey = new Map<string, string>();
  const supabase = getSupabaseAdmin();
  const CHUNK = 400;
  try {
    for (let index = 0; index < codes.length; index += CHUNK) {
      const { data, error } = await supabase
        .from("source_of_sales_customer_map")
        .select("distributor_code,customer_code,address")
        .eq("active", true)
        .in("customer_code", codes.slice(index, index + CHUNK));
      if (error) throw error;
      (data ?? []).forEach((entry) => {
        const address = text((entry as Record<string, unknown>).address);
        if (!address) return;
        const key = `${text((entry as Record<string, unknown>).distributor_code)}|${text((entry as Record<string, unknown>).customer_code)}`;
        byKey.set(key, address);
      });
    }
  } catch {
    return; // master unavailable — leave the column blank rather than fail the closing
  }

  needed.forEach((row) => {
    const address = byKey.get(`${text(row.distributor_code)}|${text(row.client_code)}`);
    if (address) row.client_address = address;
  });
}

export type LoadClosingDetailsInput = {
  access: AccessContext;
  line?: string | null;
  period?: string | null;
  /** Honoured only for a role allowed to reveal confidential products. */
  includeConfidential?: boolean;
  availableLines?: string[];
  availablePeriods?: string[];
  filters?: ClosingDetailsFilters;
  page?: number;
  pageSize?: number;
  /** Return every filtered row rather than one page. Used by the workbook export. */
  unpaged?: boolean;
};

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 2000;

/**
 * Pure filter over already-scoped rows. Separate from `applyDetailScope` on purpose:
 * scope is a security boundary, this is a user convenience. Exported for unit tests.
 */
export function applyDetailFilters(
  rows: ClosingDetailRow[],
  filters: ClosingDetailsFilters | undefined,
): ClosingDetailRow[] {
  if (!filters) return rows;
  const set = (values?: string[]) =>
    values && values.length > 0 ? new Set(values.map((value) => value.trim().toUpperCase())) : null;
  const regions = set(filters.regionCodes);
  const areas = set(filters.areaCodes);
  const products = set(filters.productCodes);
  const distributors = set(filters.distributorCodes);
  const inclusion = text(filters.inclusion).toLowerCase();
  const search = text(filters.search).toLowerCase();

  return rows.filter((row) => {
    if (regions && !regions.has(row.regionCode.toUpperCase())) return false;
    // The CLOSING area — see closing-row-area.ts. Matching on the resolved `areaCode` made the
    // Details tab disagree with the Closing Matrix beside it for a hand-apportioned customer:
    // filtering to Dakahlia 2 hid rows the Matrix books there, and filtering to Dakahlia 1 showed
    // rows it does not. Identical on every row in production except those four.
    if (areas && !areas.has(closingAreaOf(row))) return false;
    if (products && !products.has(row.productCode.toUpperCase())) return false;
    if (distributors && !distributors.has(row.distributorCode.toUpperCase())) return false;
    if (inclusion === "included" && !row.includedInClosing) return false;
    if (inclusion === "excluded" && row.includedInClosing) return false;
    if (search) {
      const haystack = [
        // Both areas are searchable: a re-booked row is booked in one and physically sits in the
        // other, and a reader typing either code expects to find it.
        row.brickId, row.brickName, row.areaCode, row.sheetAreaCode, row.areaName, row.sheetAreaName, row.regionName,
        row.clientCode, row.clientName, row.clientAddress, row.productCode, row.productName,
        row.distributorCode,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

/**
 * Load the raw distributor rows behind one line/month's closing, joined to the Phoenix
 * brick -> area -> region master and scoped to the caller. Pure IO + mapping; every
 * aggregate the UI shows is derived from the returned rows so the two cannot disagree.
 */
export async function loadMonthlyClosingDetails(
  input: LoadClosingDetailsInput,
): Promise<ClosingDetailsResult> {
  const { access } = input;
  const period = text(input.period) || null;
  const availablePeriods = input.availablePeriods ?? [];

  const scope = await resolveSalesAccessScope(access, {
    includeRestricted: input.includeConfidential === true,
  });

  // Only offer the lines this viewer may actually open. Doing it here (rather than in the route)
  // keeps the picker and the data on the same authority, so a portal user never sees a line in
  // the dropdown that then renders "out of scope".
  const availableLines = (input.availableLines ?? []).filter((candidate) => {
    if (isHeadOfficeLine(candidate) && !canViewHeadOfficeLine(access.role)) return false;
    if (!scope.allowedLineNames) return true;
    const allowed = new Set([...scope.allowedLineNames].map(normalizeLineKey));
    return allowed.has(normalizeLineKey(candidate));
  });

  const requestedLine = text(input.line) || null;
  const line = requestedLine && availableLines.includes(requestedLine)
    ? requestedLine
    : availableLines[0] ?? null;
  const canRevealConfidential = scope.canViewRestrictedProducts;
  // `restrictedIncluded` is already role-gated inside the scope engine — a non-CEO asking for
  // confidential products gets `false` here, never the rows.
  const confidentialIncluded = scope.restrictedIncluded;

  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(input.pageSize ?? DEFAULT_PAGE_SIZE)));

  const empty = (outOfScope: boolean): ClosingDetailsResult => ({
    line,
    period,
    availableLines,
    availablePeriods,
    rows: [],
    filteredRowCount: 0,
    page,
    pageSize,
    options: { regions: [], areas: [], products: [], distributors: [] },
    totals: emptyTotals(),
    reconciliation: {
      includedInClosing: emptyTotals(),
      excludedDirect: emptyTotals(),
      missingClientCode: emptyTotals(),
      excludedConfidential: emptyTotals(),
      unmappedBricks: emptyTotals(),
      areaMismatches: emptyTotals(),
    },
    confidentialIncluded,
    canRevealConfidential,
    outOfScope,
  });

  // No line survived the scope filter even though lines exist → an access boundary, not an
  // empty month. The UI must say so rather than render a misleading zero.
  if ((input.availableLines ?? []).length > 0 && availableLines.length === 0) return empty(true);
  if (!line || !period) return empty(false);

  // Head Office is a confidential LINE (whole line + all its products, CEO / Super Admin only).
  if (isHeadOfficeLine(line) && !canViewHeadOfficeLine(access.role)) return empty(true);

  // Line bound. `allowedLineNames === null` means every line (COMPANY scope); an empty set is
  // fail-closed and must render "out of scope", never an innocent-looking zero.
  if (scope.allowedLineNames) {
    if (scope.allowedLineNames.size === 0) return empty(true);
    const allowed = new Set([...scope.allowedLineNames].map(normalizeLineKey));
    if (!allowed.has(normalizeLineKey(line))) return empty(true);
  }

  const [batchIds, references] = await Promise.all([
    validatedBatchIdsForPeriod(period),
    loadSalesReferenceData({ includeCustomerBricks: false }),
  ]);
  if (batchIds.length === 0) return empty(false);

  const rawRows = await readImportRows(batchIds, line);

  // Phoenix master lookups. The BRICK is the authoritative geography key — a row's area is
  // resolved from its brick, and the sheet's own area is kept alongside so the two can be
  // compared rather than silently overwritten.
  const brickById = new Map(
    (references.bricks ?? []).map((brick) => [text(brick.brickId).toUpperCase(), brick]),
  );
  const areaByCode = new Map(
    (references.areas ?? []).map((area) => [text(area.areaCode).toUpperCase(), area]),
  );
  const regionNameByCode = new Map(
    (references.regions ?? []).map((region) => [
      text(region.regionCode).toUpperCase(),
      text(region.regionName),
    ]),
  );
  const productByCode = new Map(
    (references.products ?? []).map((product) => [text(product.productCode).toUpperCase(), product]),
  );

  const allowedRegionCodes = await resolveRegionCodes(scope.allowedRegionNames, references);

  const mapped: ClosingDetailRow[] = rawRows.map((raw) => {
    const brickId = text(raw.brick_id);
    const brick = brickId ? brickById.get(brickId.toUpperCase()) : undefined;
    const sheetAreaCode = text(raw.area_code);
    const sheetRegionCode = text(raw.region_code);

    // Prefer the brick's master area; fall back to the sheet's area when the brick is unmapped.
    const areaCode = text(brick?.areaCode) || sheetAreaCode;
    const area = areaCode ? areaByCode.get(areaCode.toUpperCase()) : undefined;
    const regionCode = text(brick?.regionCode) || text(area?.regionCode) || sheetRegionCode;

    const productCode = text(raw.product_code);
    const product = productCode ? productByCode.get(productCode.toUpperCase()) : undefined;
    const factoryPrice = num(product?.factoryPrice);

    const qty = num(raw.qty);
    const discount = num(raw.discount);
    const effectiveUnits = qty * (1 - discount);
    const isDirect = raw.is_direct === true;
    const clientCode = text(raw.client_code);
    const isConfidential = isRestrictedProductCode(productCode);
    const invoicePeriod = text(raw.invoice_period);
    const sheetValue = num(raw.value);
    // Derived in ONE place, because July 2026's direct rows are taken as stored — see
    // resolveClosingDetailSalesValue for the owner's ruling and the measured figures.
    const salesValue = resolveClosingDetailSalesValue({
      effectiveUnits,
      factoryPrice,
      invoicePeriod,
      isDirect,
      sheetValue,
    });

    const exclusions: ClosingDetailExclusion[] = [];
    if (isDirect) exclusions.push("direct");
    if (isConfidential) exclusions.push("confidential");

    return {
      id: num(raw.id),
      rowNumber: raw.row_number == null ? null : num(raw.row_number),
      distributorCode: text(raw.distributor_code),
      invoicePeriod,
      invoiceDate: text(raw.invoice_date) || null,
      officialLine: text(raw.official_line),

      sheetAreaCode,
      sheetAreaName: text(raw.area_name),
      sheetRegionCode,
      sheetRegionName: text(raw.region_name),
      blockCode: text(raw.block_code) || text(brick?.blockCode),
      brickId,

      brickName: text(brick?.brickName),
      areaCode,
      areaName: text(brick?.areaName) || text(area?.areaName) || text(raw.area_name),
      regionCode,
      regionName: regionNameByCode.get(regionCode.toUpperCase()) ?? text(raw.region_name),
      areaMismatch:
        Boolean(brick) &&
        Boolean(sheetAreaCode) &&
        sheetAreaCode.toUpperCase() !== text(brick?.areaCode).toUpperCase(),
      brickUnmapped: Boolean(brickId) && !brick,

      clientCode,
      clientName: text(raw.client_name),
      clientAddress: text(raw.client_address),

      productCode,
      productName: text(product?.productName) || text(raw.product_name),
      family: text(product?.family),
      factoryPrice,

      qty,
      bonusQty: num(raw.bonus_qty),
      discount,
      effectiveUnits: Number(effectiveUnits.toFixed(6)),
      salesValue: Number(salesValue.toFixed(6)),
      sheetValue,

      isDirect,
      isConfidential,
      missingClientCode: !clientCode,
      validationState: text(raw.validation_state),

      includedInClosing: exclusions.length === 0,
      exclusions,
    };
  });

  const scoped = applyDetailScope(mapped, {
    allowedRegionCodes,
    allowedAreaCodes: scope.allowedAreaCodes,
    allowedProductCodes: scope.allowedProductCodes,
    dropConfidential: !confidentialIncluded,
  });

  // Options come from everything in scope (pre-filter) so choosing one area never removes the
  // other areas from the dropdown.
  const options = buildFilterOptions(scoped);

  const filtered = applyDetailFilters(scoped, input.filters);
  const start = (page - 1) * pageSize;

  return {
    line,
    period,
    availableLines,
    availablePeriods,
    rows: input.unpaged ? filtered : filtered.slice(start, start + pageSize),
    filteredRowCount: filtered.length,
    page,
    pageSize,
    options,
    totals: summarize(filtered, () => true),
    reconciliation: {
      includedInClosing: summarize(filtered, (row) => row.includedInClosing),
      excludedDirect: summarize(filtered, (row) => row.isDirect),
      missingClientCode: summarize(filtered, (row) => row.missingClientCode),
      excludedConfidential: summarize(filtered, (row) => row.isConfidential),
      unmappedBricks: summarize(filtered, (row) => row.brickUnmapped),
      areaMismatches: summarize(filtered, (row) => row.areaMismatch),
    },
    confidentialIncluded,
    canRevealConfidential,
    outOfScope: false,
  };
}

/**
 * Narrow an already-loaded result to a set of AREAS, re-deriving every total from the survivors.
 *
 * WHY THIS EXISTS. The Monthly Closing export applies the store split (a wholesaler's sell-in is
 * shared across the areas of its city — see store-sales-city-split.ts), and that allocation is a
 * property of the MONTH, not of whatever the reader filtered the screen to. A store in Alex East
 * selling 750 boxes is 250 / 250 / 250 across Alex East, Alex West and Alex Center whether or not
 * the export shows all three. So the export loads the rows WITHOUT place narrowing, computes the
 * split over the whole city, and only then narrows to the areas on show with this function. An
 * area's number is therefore identical in a filtered and an unfiltered export.
 *
 * Narrowing at load time instead loses money in both directions: an in-scope store's share to
 * out-of-scope areas is dropped, and an in-scope area never receives its share from an out-of-scope
 * store in the same city.
 *
 * `options` is deliberately carried through untouched — it is built pre-filter on purpose, so that
 * choosing one area never removes the other areas from the dropdown.
 *
 * An empty `areaCodes` means "every area", matching applyDetailFilters' own convention.
 *
 * Selection goes through applyDetailFilters, so it matches on `closingAreaOf` — the area the Closing
 * Matrix books the row in — rather than on the brick-resolved `areaCode`. That is what keeps a
 * filtered workbook's Data sheet holding exactly the rows its own Matrix does; see
 * closing-row-area.ts for the -34,380.00 / +17,190.00 mismatch it closes.
 */
export function narrowClosingDetailsToAreas(
  details: ClosingDetailsResult,
  areaCodes: readonly string[],
): ClosingDetailsResult {
  if (areaCodes.length === 0) return details;
  const rows = applyDetailFilters(details.rows, { areaCodes: [...areaCodes] });
  if (rows.length === details.rows.length) return details;
  return {
    ...details,
    filteredRowCount: rows.length,
    reconciliation: {
      areaMismatches: summarize(rows, (row) => row.areaMismatch),
      excludedConfidential: summarize(rows, (row) => row.isConfidential),
      excludedDirect: summarize(rows, (row) => row.isDirect),
      includedInClosing: summarize(rows, (row) => row.includedInClosing),
      missingClientCode: summarize(rows, (row) => row.missingClientCode),
      unmappedBricks: summarize(rows, (row) => row.brickUnmapped),
    },
    rows,
    totals: summarize(rows, () => true),
  };
}

/** Distinct filter choices present in the viewer's scoped rows, each sorted for a stable UI. */
export function buildFilterOptions(rows: ClosingDetailRow[]): ClosingDetailsResult["options"] {
  const regions = new Map<string, string>();
  const areas = new Map<string, { code: string; name: string; regionCode: string }>();
  const products = new Map<string, string>();
  const distributors = new Set<string>();

  for (const row of rows) {
    if (row.regionCode) regions.set(row.regionCode, row.regionName || row.regionCode);
    // Keyed on the CLOSING area, because that is what the area filter now matches — offering the
    // resolved area instead would list a choice that selects none of this row's own money.
    const areaCode = closingAreaOf(row);
    if (areaCode && !areas.has(areaCode)) {
      // `areaName` describes the BRICK's area, so a re-booked row names its closing area from the
      // sheet instead; otherwise Port Said would be labelled "Dakahlia 1".
      const areaName = (isRebookedRow(row) ? text(row.sheetAreaName) : "") || row.areaName || areaCode;
      areas.set(areaCode, { code: areaCode, name: areaName, regionCode: row.regionCode });
    }
    if (row.productCode) products.set(row.productCode, row.productName || row.productCode);
    if (row.distributorCode) distributors.add(row.distributorCode);
  }

  const byName = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name);
  return {
    regions: [...regions].map(([code, name]) => ({ code, name })).sort(byName),
    areas: [...areas.values()].sort(byName),
    products: [...products].map(([code, name]) => ({ code, name })).sort(byName),
    distributors: [...distributors].sort((left, right) => left.localeCompare(right)),
  };
}

/**
 * Pure row guard. Region + per-user product allowlist + the confidential drop, applied after
 * mapping. Exported so it can be unit-tested without touching Supabase.
 */
export function applyDetailScope(
  rows: ClosingDetailRow[],
  scope: {
    allowedRegionCodes: Set<string> | null;
    /**
     * Seat-derived AREA bound (see src/lib/sales/seat-area-scope.ts). When present it REPLACES the
     * region check: a District / Regional Manager's own area can sit in a foreign region, so matching
     * on region would drop it — and matching on the widened region instead would expose that region's
     * other areas. Empty set = fail closed, same convention as the region bound.
     */
    allowedAreaCodes?: Set<string> | null;
    allowedProductCodes: Set<string> | null;
    dropConfidential: boolean;
  },
): ClosingDetailRow[] {
  let out = rows;
  if (scope.dropConfidential) out = out.filter((row) => !row.isConfidential);
  if (scope.allowedAreaCodes) {
    const allowed = scope.allowedAreaCodes;
    out = out.filter((row) => allowed.has(row.areaCode.trim().toUpperCase()));
  } else if (scope.allowedRegionCodes) {
    const allowed = scope.allowedRegionCodes;
    // Empty set = the viewer's region resolved to no code — fail closed.
    out = out.filter((row) => allowed.has(row.regionCode.trim().toUpperCase()));
  }
  out = applyProductCodeAllowlist(out, scope.allowedProductCodes);
  return out;
}

/** Totals over the rows matching `predicate`. */
export function summarize(
  rows: ClosingDetailRow[],
  predicate: (row: ClosingDetailRow) => boolean,
): ClosingDetailsTotals {
  const totals = emptyTotals();
  for (const row of rows) if (predicate(row)) addTo(totals, row);
  return roundTotals(totals);
}

/** Map canonical employee region NAMES onto Source-of-Sales region CODES via the master. */
async function resolveRegionCodes(
  allowedRegionNames: Set<string> | null,
  references: Awaited<ReturnType<typeof loadSalesReferenceData>>,
): Promise<Set<string> | null> {
  if (!allowedRegionNames) return null;
  const codesByName = new Map<string, Set<string>>();
  for (const region of references.regions ?? []) {
    const key = canonicalizeRegionName(region.regionName);
    const code = text(region.regionCode).toUpperCase();
    if (!key || !code) continue;
    const bucket = codesByName.get(key) ?? new Set<string>();
    bucket.add(code);
    codesByName.set(key, bucket);
  }
  const codes = new Set<string>();
  for (const name of allowedRegionNames) {
    for (const code of codesByName.get(name) ?? []) codes.add(code);
  }
  // An empty result means the region didn't resolve to any code → fail closed.
  return codes;
}

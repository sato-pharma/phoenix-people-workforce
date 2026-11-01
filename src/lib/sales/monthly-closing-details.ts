import type { AccessContext } from "@/lib/auth/permissions";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import {
  applyProductCodeAllowlist,
  canViewHeadOfficeLine,
  canonicalizeRegionName,
  isHeadOfficeLine,
  isRestrictedProductCode,
  normalizeLineKey,
  resolveSalesAccessScope,
  type SalesAccessScope,
} from "@/lib/sales/access-scope";
import { applyCreditedAreaView, buildMainStoresRows } from "@/lib/sales/closing-main-stores";
import { canRevealClosingSource, withoutMaskedSourceRows } from "@/lib/sales/closing-source-mask";
import { applyClosingAreaMergesToDetails } from "@/lib/sales/closing-area-merges";
import { INVOICE_REF_SELECT, invoiceRefOf } from "@/lib/sales/closing-detail-invoice-ref";
import { countsInClosingHeadline } from "@/lib/sales/closing-headline";
import {
  loadOperationalRegionResolver,
  loadSplitRegions,
  type OperationalRegionResolver,
} from "@/lib/sales/closing-organogram-regions";
import { closingAreaOf, isRebookedRow } from "@/lib/sales/closing-row-area";
import { evenSplitKey, loadEvenSplitCustomerKeys } from "@/lib/sales/even-split-registry";
import { resolveMedicalRepSosAreaCodes } from "@/lib/sales/medical-rep-area-scope";
import { loadSalesReferenceData, type SalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { areaCodesForMonth } from "@/lib/org/sales-only-seats";
import { loadProductPeriodPrices, type ProductPeriodPrices } from "@/lib/sales/product-period-price";
import { rowIsInRegionScope, rowMatchesRegionFilter } from "@/lib/sales/sos-region-basis";
import { getSupabaseAdmin } from "@/lib/supabase/server";

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
//                               and reported by phx_monthly_closing_direct instead. Excluded from
//                               that RPC, NOT from the closing — see ./closing-headline.ts.
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
// `includedInClosing` says whether a row feeds the DISTRIBUTOR matrix — that is the flag the
// export's Data/Total SUMIFS bridge is built on, and it must keep meaning exactly that.
//
// IT IS NOT THE SAME QUESTION AS "is this money in the closing". Direct is in the closing: the
// screen and the workbook both render `injectDirectIntoMatrix(matrix, direct)`, so booked direct
// orders sit inside the grand total. Reading `includedInClosing` as the headline is what made the
// Finance Manager's own Monthly Closing tab report "In closing 0.00" for 2026-08 beside 290,387.57
// of direct orders he had just booked, each row flagged "Direct (excluded)" — the money was there,
// the label said it was not. Ask `countsInClosingHeadline(row)` (./closing-headline.ts) for that question, and
// `reconciliation.closingHeadline` for the total.
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
  /**
   * The supplier's own invoice reference, where their feed carries one — read out of `raw_row` by
   * closing-detail-invoice-ref.ts, because no distributor agreed on a column name for it.
   *
   * OPTIONAL ON PURPOSE. Every other reader of this type predates the field and constructs rows
   * without it (the Main Stores substitution, the store split, a dozen test fixtures); required, it
   * would make each of those a compile error for a column only the Rows sheet prints. Absent and
   * null mean the same thing to a reader, and the sheet names the REASON rather than leaving the
   * cell blank — `invoiceRefAbsence`.
   */
  invoiceRef?: string | null;
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
  /**
   * GEOGRAPHIC region — where the area sits on the map. This is the ACCESS dimension: the viewer's
   * allowed regions are resolved from the same master, so `applyDetailScope` must keep testing this
   * one. See `rowIsInRegionScope` in sos-region-basis.ts.
   */
  regionCode: string;
  regionName: string;
  /**
   * ORGANOGRAM region — the DM territory that owns this row's CLOSING area, on this line, in this
   * month. This is what the Closing Matrix beside this tab is grouped by, so it is what the region
   * picker offers and what the region filter matches. On Anti Infective the two genuinely differ:
   * the sheet says UE for all of Upper Egypt, the Matrix says UE-1 and UE-2.
   *
   * Equal to the geographic pair on every line and area the organogram does not re-own, which is
   * most of them.
   */
  operationalRegionCode: string;
  operationalRegionName: string;
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
  /** qty — the base the matrix values (mirrors fact_rollup.effective_units). Units are units. */
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
  /**
   * True when this customer and line are in `sos_even_split_customers` — the database has already
   * shared this row's units across areas, so no other rule may distribute them again. Read by the
   * store city split; see StoreSplitRow.evenSplitApplied and even-split-registry.ts.
   */
  evenSplitApplied: boolean;
  /** Data quality, NOT an exclusion — the row still counts, it just has no traceable outlet. */
  missingClientCode: boolean;
  validationState: string;

  /**
   * True when this row feeds `phx_monthly_closing_matrix` — the DISTRIBUTOR half of the closing.
   *
   * Not the same as "this money is in the closing": direct rows are false here and are still
   * inside the headline. Ask `countsInClosingHeadline` (./closing-headline.ts) for that. The export's Data/Total bridge
   * is built on this flag meaning the distributor half, so it must not be widened in place.
   */
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
    /**
     * Everything inside the closing headline — distributor rows PLUS the direct orders Finance
     * booked into this month. This is the figure that ties to the Closing Matrix's grand total,
     * and the one to put in front of a reader who asks "what is in the closing".
     */
    closingHeadline: ClosingDetailsTotals;
    /** The DISTRIBUTOR half only — what feeds phx_monthly_closing_matrix and the export's SUMIFS. */
    includedInClosing: ClosingDetailsTotals;
    /**
     * The DIRECT half: booked direct orders. Named "excluded" because it is excluded from the
     * distributor matrix RPC, not from the closing — it is a component of `closingHeadline`.
     */
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
 * This is the only place in the closing where a value is DERIVED rather than read.
 *
 * ── DISTRIBUTOR ROWS: effectiveUnits x factoryPrice ──────────────────────────────────────────
 * That is the DISTRIBUTOR formula — the same arithmetic phx_monthly_closing_matrix values sell-out
 * at (`f.effective_units * phx_factory_price(f.product_code, f.period)`) — and it is correct for a
 * distributor invoice line, whose sheet value is a restatement of it. `factoryPrice` arrives already
 * resolved for the closing month; see resolveClosingDetailFactoryPrice.
 *
 * ── DIRECT ROWS: THE STORED VALUE IS THE VALUE, IN EVERY MONTH ───────────────────────────────
 * A direct order is a negotiated deal — its own price, its own discount, its own bonus — so
 * pricing it at factory price answers a question nobody asked. The locked direct-order pricing
 * rule is explicit that "the factory price must NEVER be used in the Direct Orders module — for
 * anything", and every other layer of the closing already reads the stored value.
 *
 * Measured in production for Anti Infective 2026-07 direct on 2026-08-06 (16 rows, 2,120 units):
 *
 *   source_of_sales_import_rows.value        149,288.50   <- the owner's own file, to the piastre
 *   source_of_sales_fact_rollup.direct_value 149,288.50
 *   phx_monthly_closing_direct               149,288.50
 *   phx_closing_channel_breakdown __DIRECT__ 149,288.50
 *   effectiveUnits x factoryPrice            157,518.00   <- ONLY this line, overstating by 8,229.50
 *
 * WHY THIS IS NO LONGER SCOPED TO JULY 2026. It was, from the owner's ruling of 2026-08-06 which
 * named that one month; every later month kept the recompute. That left the surface Finance
 * actually reads — Monthly Closing → Details, the Finance Manager's only closing door — disagreeing
 * with the Closing Matrix the moment Finance booked an order into any month after July. Measured on
 * production 2026-08-25, for the twenty approved orders Finance booked into 2026-08:
 *
 *                    stored (matrix, RPC, rollup)   effectiveUnits x factoryPrice
 *   Pedia                        258,858.67                    274,488.75   (+15,630.08)
 *   Anti Infective                31,528.90                     29,947.50    (-1,581.40)
 *   both lines                   290,387.57                    304,436.25   (+14,048.68)
 *
 * 290,387.57 is exactly the sum of those twenty orders' `sales_value`. The recompute errs in
 * OPPOSITE directions on the two lines, which is what rules out any correction factor: only the
 * deal is the deal. Under the owner's #1 golden rule — the Monthly Closing is the one sales truth
 * and no surface keeps its own maths — a month-scoped exception could only ever be a bug waiting
 * for its month, so the rule now reads as what it always meant: direct is taken as stored.
 *
 * This function still does not PRICE anything: it declines to. The locked direct-order pricing rule
 * (discount qty x PUBLIC x (1 - disc%), bonus qty x PHARMACY) is neither read nor changed here.
 */
export function resolveClosingDetailSalesValue(input: {
  isDirect: boolean;
  /** The row's own invoice period, `YYYY-MM`. Retained for callers; no longer branched on. */
  invoicePeriod: string;
  /** qty. The discount factor was struck out of the whole system on 2026-09-07. */
  effectiveUnits: number;
  factoryPrice: number;
  /** The value column exactly as the sheet stored it. */
  sheetValue: number;
}): number {
  if (input.isDirect) return input.sheetValue;
  return input.effectiveUnits * input.factoryPrice;
}

/**
 * The factory price that values one row of the closing month being read.
 *
 * 🔴 THE PERIOD PRICE, NEVER THE PRODUCT MASTER'S. Saginko (SA001) is valued at 111.15 through
 * 2026-09 and 170.52 from 2026-10 (owner, 2026-09-28: "the sales and target of the retail to be
 * adjusted from 1 October"), while `source_of_sales_products.factory_price` STAYS 111.15 on purpose.
 * Every closing function in the database prices through `public.phx_factory_price(code, period)`;
 * this module read the master price off loadSalesReferenceData until 2026-10-01, so from October the
 * Details tab, the workbook's Data and Total sheets and the live store split's money would have
 * valued Saginko at 111.15 beside a Closing Matrix at 170.52. At August 2026's Anti Infective volume
 * (2,983 units) that is 331,560.45 on the Details tab against 508,661.16 on the Matrix.
 *
 * Priced at the CLOSING month rather than the row's invoice period, because that is what the Matrix
 * prices by: `source_of_sales_fact_rollup.period` is stamped from the BATCH, and these rows are read
 * from exactly this month's batches. The two never differ in production (0 of 362,356 validated
 * rows on 2026-10-01), so this picks which one to mirror; it corrects neither.
 *
 * `?? 0` is the Matrix's own `coalesce(..., 0)`: a product with no price contributes nothing.
 */
export function resolveClosingDetailFactoryPrice(
  prices: Pick<ProductPeriodPrices, "priceFor">,
  productCode: string,
  closingPeriod: string,
): number {
  return prices.priceFor(productCode, closingPeriod) ?? 0;
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

/** Batches read at once. Each walk is sequential inside itself; four keep the PostgREST pool calm. */
const BATCH_READ_CONCURRENCY = 4;
/** Customer-master address chunks read at once — the same pool courtesy as the batch walk. */
const ADDRESS_READ_CONCURRENCY = 4;

/**
 * The `official_line` ILIKE pattern that admits every row `normalizeLineKey` would keep for this
 * line — or null when no pattern can be proven to, and the walk reads every line as it always did.
 *
 * WHY A SUPERSET IS ALL IT HAS TO BE. The JS comparison below stays the authority: a row this admits
 * and the key rejects is still dropped there. So the one thing that must hold is that nothing the key
 * keeps is filtered out here, and it does, for a key of printable ASCII (every line name in the
 * system: "CNS", "Pedia", "Anti Infective", "Head Office"):
 *   • `normalizeLineKey` is trim + toLowerCase, and ILIKE folds ASCII letters exactly as
 *     toLowerCase does, so the key's own letters match in any case;
 *   • the `%` at each end admits whatever `trim()` would have stripped, so a padded " pedia " matches;
 *   • `%`, `_` and `\` in the key are escaped, so they match themselves and never act as wildcards.
 * An EMPTY key is the one that cannot be expressed: it keeps rows whose line is NULL, and no LIKE
 * pattern matches NULL. So an empty or non-ASCII key reads unfiltered.
 */
export function officialLineIlikePattern(lineKey: string): string | null {
  if (!lineKey || !/^[\x20-\x7e]+$/.test(lineKey)) return null;
  return `%${lineKey.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Read every import row for the batches, KEYSET-paged ONE BATCH AT A TIME on
 * (batch_id, row_number), then returned in ascending `id` order.
 *
 * Not `.range()`: PostgREST offset paging without an ORDER BY has no stable row order, so
 * consecutive pages can repeat rows and skip others at random. That exact bug dropped 1,262 of
 * 49,713 customer mappings in the June 2026 import. Seeking past the last key read is immune to it,
 * and to concurrent inserts shifting rows across a page boundary.
 *
 * Not one walk over the whole batch list by `id`, which is what this was until 2026-09-17. Asked for
 * `batch_id IN (…18 ids…) ORDER BY id LIMIT 1000`, Postgres walks the primary key from the very
 * first row ever imported and discards every row belonging to another month: measured on production
 * for July, 254,652 rows thrown away to return the first 1,000, averaging 1.4 s a call over 1,625
 * calls, and every later page crossing another month's rows paid for them too (65 ms average over
 * 61,738 calls). `(batch_id, row_number)` is the table's own unique index and row_number is NOT
 * NULL, so each page is an exact index range: nothing read is thrown away.
 *
 * The ORDER is unchanged. The rows are re-sorted by `id` before they leave, so every consumer sees
 * the same sequence the single walk produced — the details sheet and everything built from it.
 *
 * THE LINE IS ASKED FOR IN SQL TOO (2026-10-01, "slow to transfer between page and page"). A
 * distributor file carries every line, so a Pedia read shipped CNS, Anti Infective and Head Office
 * rows across the wire only for the loop below to drop them. The ILIKE is a SUPERSET of that loop's
 * test (see officialLineIlikePattern), and the loop still decides — so the rows kept, and the order
 * they leave in, are exactly what they were. The keyset is unchanged: each page is still a seek on
 * (batch_id, row_number), now skipping other lines' rows inside the database.
 */
export async function readImportRowsFrom(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  batchIds: string[],
  line: string,
  pageSize = PAGE, // injectable only so a database-free test can force multi-page walks
): Promise<Array<Record<string, unknown>>> {
  // Distinct, because one IN list never returned a row twice and a batch read twice would.
  const batches = [...new Set(batchIds)];
  if (batches.length === 0) return [];
  const lineKey = normalizeLineKey(line);
  const linePattern = officialLineIlikePattern(lineKey);

  const perBatch = await mapWithConcurrency(batches, BATCH_READ_CONCURRENCY, async (batchId) => {
    const kept: Array<Record<string, unknown>> = [];
    let cursor: number | null = null;
    for (;;) {
      let query = supabase
        .from("source_of_sales_import_rows")
        .select(
          "id,row_number,batch_id,distributor_code,invoice_period,invoice_date,official_line," +
            "region_code,region_name,area_code,area_name,block_code,brick_id," +
            "client_code,client_name,client_address,product_code,product_name," +
            "qty,bonus_qty,discount,value,is_direct,validation_state," +
            // The invoice reference, extracted in Postgres from each feed's own heading rather than
            // shipped as the whole `raw_row` blob — see closing-detail-invoice-ref.ts.
            INVOICE_REF_SELECT,
        )
        .eq("batch_id", batchId)
        .order("row_number", { ascending: true })
        .limit(pageSize);
      if (linePattern !== null) query = query.ilike("official_line", linePattern);
      if (cursor !== null) query = query.gt("row_number", cursor);

      const { data, error } = await query;
      if (error) throw error;
      const page = (data ?? []) as unknown as Array<Record<string, unknown>>;
      if (page.length === 0) break;
      for (const row of page) {
        if (normalizeLineKey(text(row.official_line)) === lineKey) kept.push(row);
      }
      if (page.length < pageSize) break;
      const last = Number(page[page.length - 1]?.row_number);
      if (!Number.isFinite(last)) break; // no usable cursor — stop rather than loop forever
      cursor = last;
    }
    return kept;
  });

  return perBatch.flat().sort((a, b) => Number(a.id) - Number(b.id));
}

async function readImportRows(batchIds: string[], line: string): Promise<Array<Record<string, unknown>>> {
  const rows = await readImportRowsFrom(getSupabaseAdmin(), batchIds, line);
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
  const chunks: string[][] = [];
  for (let index = 0; index < codes.length; index += CHUNK) chunks.push(codes.slice(index, index + CHUNK));
  try {
    // FOUR CHUNKS AT A TIME (2026-10-01, "slow to transfer between page and page"), where they used
    // to go one after another. The answers are applied in CHUNK order below, so the map ends up
    // exactly as the one-by-one walk left it; and any chunk failing still leaves every address blank.
    const answers = await mapWithConcurrency(chunks, ADDRESS_READ_CONCURRENCY, async (chunk) => {
      const { data, error } = await supabase
        .from("source_of_sales_customer_map")
        .select("distributor_code,customer_code,address")
        .eq("active", true)
        .in("customer_code", chunk);
      if (error) throw error;
      return data ?? [];
    });
    for (const data of answers) {
      data.forEach((entry) => {
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
  /**
   * Return the real distributor and customer on rows this viewer would otherwise see masked.
   *
   * 🔴 FOR COMPUTATION ONLY. The split keys on `distributorCode` and the customer aggregation
   * keys on `clientCode`, so a computation path reading masked rows does not throw — it quietly
   * produces a different distribution. Every caller that passes this is listed and pinned by
   * tests/closing-source-mask.test.ts, so adding one is a deliberate act rather than a habit.
   */
  revealSource?: boolean;
  /**
   * Keep Fayoum (GZ6) and Beni Suef (UE9) as the two areas they really are.
   *
   * 🔴 FOR THE ATTRIBUTION NET ONLY, AND IT FIXES A WRONG NUMBER RATHER THAN A PREFERENCE.
   * `applyClosingAreaMergesToDetails` rewrites a Beni Suef row's `sheetAreaCode` to GZ6 so the
   * Data sheet and the Details panel show one "Fayoum - Beni Suef" row. The closing MATRIX folds
   * the same pair, so inside the closing that is self-consistent. `au.monthly_attribution_rollup`
   * does NOT fold: it keys on the real area. So a net computed on folded rows charges Beni Suef's
   * whole book OUT of Fayoum while attribution still credits Beni Suef its own base, and Fayoum
   * goes negative — measured live 2026-09-09, Fayoum at −24.95 units on a base of 64.
   *
   * It was there before El Qema's rule changed and merely stayed positive: under the priority
   * ladder Fayoum's net was −29.44 against the same base of 64. So a session finding this is
   * looking at an old defect surfaced by a new distribution, not at a regression in the rule.
   */
  keepMergedAreasApart?: boolean;
  availableLines?: string[];
  availablePeriods?: string[];
  filters?: ClosingDetailsFilters;
  page?: number;
  pageSize?: number;
  /** Return every filtered row rather than one page. Used by the workbook export. */
  unpaged?: boolean;
  /**
   * Reads the caller has ALREADY started for this same `access`, handed in so a loop over MONTHS
   * pays for each once rather than once per month (2026-10-01, "slow to transfer between page and
   * page"). Every one is optional, and an absent one is read here exactly as it always was.
   */
  shared?: ClosingDetailsSharedReads;
};

/**
 * Period-independent reads one request may share across several `loadMonthlyClosingDetails` calls.
 *
 * 🔴 EACH MUST BE EXACTLY WHAT THIS LOADER WOULD HAVE READ FOR ITSELF, FOR THE SAME `access` — the
 * scope and the rep's areas are access boundaries, and a value computed for anyone else would show
 * this viewer someone else's rows. Nothing here is read from a request, and none of it is cached past
 * the request that made it. The loader only READS what it is handed; it never mutates it, which is
 * what makes one value safe to hand to every month at once.
 */
export type ClosingDetailsSharedReads = {
  /**
   * `resolveSalesAccessScope(access, { includeRestricted })`. Used only when `includeRestricted` is
   * the loader's own `includeConfidential === true`; otherwise the loader resolves its own.
   */
  salesScope?: { includeRestricted: boolean; scope: Promise<SalesAccessScope> };
  /** `loadSalesReferenceData({ includeCustomerBricks: false })` — the name masters only. */
  references?: Promise<SalesReferenceData>;
  /** `loadOperationalRegionResolver()`. */
  operationalRegions?: Promise<OperationalRegionResolver>;
  /** `loadEvenSplitCustomerKeys()`. */
  evenSplitCustomers?: Promise<Set<string>>;
  /**
   * A Medical Rep's own areas, `resolveMedicalRepSosAreaCodes(access)` — null is "no area on file".
   * Read only on the Medical Rep branch, exactly where the loader would resolve them itself.
   */
  medicalRepAreaCodes?: Promise<string[] | null>;
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
    // The ORGANOGRAM region — the one the Closing Matrix beside this tab groups by, and therefore
    // the one the picker offers. Matching the geographic code here selected a different population
    // than the Matrix cell the reader was looking at, and on Anti Infective it made this tab's own
    // Export button post a region the Matrix has never heard of. See sos-region-basis.ts.
    if (!rowMatchesRegionFilter(regions, row)) return false;
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
        // Both regions are searchable for the same reason both areas are: the Matrix books the row
        // under its organogram region while the sheet names the geographic one, and a reader typing
        // either expects to find it.
        row.brickId, row.brickName, row.areaCode, row.sheetAreaCode, row.areaName, row.sheetAreaName,
        row.regionName, row.operationalRegionName,
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
  const shared = input.shared;

  // A scope the caller already resolved is taken ONLY when it was resolved with this call's own
  // confidential flag — anything else is resolved here, exactly as before.
  const includeRestricted = input.includeConfidential === true;
  const sharedScope = shared?.salesScope;
  const scope = await (sharedScope && sharedScope.includeRestricted === includeRestricted
    ? sharedScope.scope
    : resolveSalesAccessScope(access, { includeRestricted }));

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
      closingHeadline: emptyTotals(),
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

  // The three period-independent reads come from `shared` when a caller looping over months handed
  // them in — the same function, already running once for the whole request — else from here.
  const [batchIds, references, operationalRegions, evenSplitCustomers, prices] = await Promise.all([
    validatedBatchIdsForPeriod(period),
    shared?.references ?? loadSalesReferenceData({ includeCustomerBricks: false }),
    // The org chart, for the region relabel below. Fails soft to geography, so an unreadable chart
    // costs this tab its region vocabulary and never its rows.
    shared?.operationalRegions ?? loadOperationalRegionResolver(),
    // Customers the database distributes across areas by a rule of their own. Read here, at the one
    // place closing rows are built, so every consumer of those rows inherits the flag instead of
    // having to remember it — the store city split above all. See even-split-registry.ts.
    shared?.evenSplitCustomers ?? loadEvenSplitCustomerKeys(),
    // The price each row is valued at IN THIS MONTH. Not `references.products`, whose price is the
    // product master's flat one — see resolveClosingDetailFactoryPrice.
    loadProductPeriodPrices(),
  ]);

  // 🔴 A MEDICAL REP SEES THEIR OWN AREA, NOT THEIR REGION. The engine reads their SELF scope at region
  // level, and their region holds every sibling rep's area. So their bound is their own area(s), resolved
  // exactly as the portal Monthly Closing matrix beside this tab resolves it, and it REPLACES the
  // region bound below rather than narrowing inside it. No area on file ⇒ out of scope, never the
  // region. Checked before the empty-month answer so a rep with no area never reads as "no data".
  // A caller that already resolved them for this same rep hands them in (`shared`) — the same
  // resolver, so the same bound; null there is still "no area on file", and still out of scope.
  let repClosingAreaCodes: Set<string> | null = null;
  if (access.role === "Medical Rep") {
    const sharedRepAreaCodes = shared?.medicalRepAreaCodes;
    const repAreaCodes = sharedRepAreaCodes
      ? await sharedRepAreaCodes
      : await resolveMedicalRepSosAreaCodes(access, { references });
    if (!repAreaCodes) return empty(true);
    repClosingAreaCodes = new Set(repAreaCodes);
  }

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
    const factoryPrice = resolveClosingDetailFactoryPrice(prices, productCode, period);

    const qty = num(raw.qty);
    const discount = num(raw.discount);
    // UNITS ARE UNITS. This was `qty * (1 - discount)` until 2026-09-07, when the owner struck the
    // discount factor out of the whole system: "we neglect the bonus and the value in any
    // distributor sheet, we take the units and multiply by factory". The sheet's discount column is
    // still imported and still displayed beside the row — it is simply no longer allowed to reduce
    // the units a rep is credited with. The ten database functions that carried the same factor are
    // replaced in the migration of the same date.
    const effectiveUnits = qty;
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
      invoiceRef: invoiceRefOf(raw),
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
      // Defaulted to geography and overwritten below, once the CLOSING area is known (a re-booked
      // row is owned by the area the Matrix books it under, not by the one its brick sits in). A
      // line the organogram does not re-own keeps these values unchanged.
      operationalRegionCode: regionCode,
      operationalRegionName: regionNameByCode.get(regionCode.toUpperCase()) ?? text(raw.region_name),
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
      // The raw invoice puts this customer's whole month in one area; the rollup the Closing Matrix
      // reads has already shared it out. Nothing in the row itself shows that, so it is stamped here.
      evenSplitApplied: evenSplitCustomers.has(evenSplitKey(clientCode, text(raw.official_line))),
      missingClientCode: !clientCode,
      validationState: text(raw.validation_state),

      includedInClosing: exclusions.length === 0,
      exclusions,
    };
  });

  // The display fold, skipped for the attribution net — see keepMergedAreasApart, which exists
  // because the rollup this net feeds keys on the real area and the fold sends the debit elsewhere.
  const merged = input.keepMergedAreasApart === true
    ? mapped
    : applyClosingAreaMergesToDetails(resolveTargetLineCode(line), mapped, period);

  // 🔒 MAIN STORES, AND IT HAS TO BE BUILT HERE — BEFORE THE ACCESS SCOPE.
  //
  // A share is a fraction of a NATIONAL pool. Built after the scope, a regional manager's four
  // areas would divide El Qema's warehouses among themselves and each take about nine times what
  // the closing credits — a number that is wrong, large, and looks perfectly plausible. `merged` is
  // still the whole month here; `applyDetailScope` below drops the areas this viewer may not see,
  // which is the correct order and the only one that gives every viewer the same figure.
  //
  // TWO CONDITIONS, NOT ONE. `revealSource` is the export route asking for the real rows so it can
  // compute from them, and `canRevealClosingSource` is Super Admin and every `system` computation.
  // Testing only the flag would hand a Super Admin El Qema's real rows AND a full set of Main
  // Stores rows on top of them — the month counted twice, with nothing to show it.
  const substituteMainStores = input.revealSource !== true && !canRevealClosingSource(access);
  const areaLabelOf = (areaCode: string) => {
    const area = areaByCode.get(areaCode.toUpperCase());
    if (!area) return null;
    const regionCode = text(area.regionCode).toUpperCase();
    return {
      areaName: text(area.areaName) || areaCode,
      regionCode,
      regionName: regionNameByCode.get(regionCode) ?? text(area.regionName),
    };
  };
  const splitRegions = substituteMainStores ? (await loadSplitRegions(line, period)) ?? undefined : undefined;

  const mainStores = substituteMainStores
    ? buildMainStoresRows(merged, { areaNameOf: areaLabelOf, line, period, regions: splitRegions })
    : [];

  // 🔴 BOTH PASSES READ `merged`, THE WHOLE MONTH, AND NEITHER READS THE OTHER'S OUTPUT.
  //
  // The city split is a pool: which areas share a wholesaler's sell-in depends on who else is in
  // that city. Running the credited view over rows El Qema had already been removed from would ask
  // the split a different question from the one the Closing Matrix asked, and the answer would
  // differ by an amount nothing on the page could explain. So the view is built over everything,
  // and El Qema's shares are dropped from the RESULT — after the arithmetic, never before it.
  const credited = substituteMainStores
    ? applyCreditedAreaView(merged, { areaLabelOf, line, period, regions: splitRegions })
    : merged;

  const scoped = applyDetailScope(
    substituteMainStores ? [...withoutMaskedSourceRows(credited, access), ...mainStores] : merged,
    {
      allowedRegionCodes,
      allowedAreaCodes: areaCodesForMonth(scope.allowedAreaCodes, scope.allowedEarlierMonthAreas, period),
      allowedClosingAreaCodes: repClosingAreaCodes,
      allowedProductCodes: scope.allowedProductCodes,
      dropConfidential: !confidentialIncluded,
    },
  );

  // ── Organogram regions, applied AFTER the access scope, deliberately ────────────────────────
  //
  // This tab sits beside the Closing Matrix, which groups by the ORGANOGRAM region. Until this
  // pass, the tab offered and filtered on the GEOGRAPHIC region instead, so the two disagreed on
  // every area the organogram re-owns — 28 (line, area) pairs in production. On Anti Infective it
  // was worse than a disagreement: the picker offered "UE", the Matrix holds only UE-1 and UE-2,
  // and this tab's own Export button posts the picked region straight to the closing export, where
  // an unmatched region narrows to `__NO_MATCHING_AREA__` and returns an EMPTY workbook.
  //
  // The pass runs after `applyDetailScope` because that is the ACCESS gate and it is expressed in
  // geographic codes. Relabelling first would test a viewer's bound against a code it was never
  // built from and drop every row he owns — an empty tab, which reads as "there were no sales"
  // rather than as a bug. Same rule as the dashboard: access on geography, display on the
  // organogram. See sos-region-basis.ts.
  //
  // Resolved at the CLOSING area (`closingAreaOf`) and at the period being read, never at today —
  // a forward-dated territory move must not reach back into the month it was dated to spare.
  const lineCode = resolveTargetLineCode(line);
  const operationalMap = operationalRegions.forLinePeriod(lineCode, period);
  const relabelled = operationalMap
    ? scoped.map((row) => {
        const owner = operationalMap.regionByArea.get(closingAreaOf(row));
        if (!owner) return row;
        return { ...row, operationalRegionCode: owner.regionCode, operationalRegionName: owner.regionName };
      })
    : scoped;

  // The substitution above is what makes all of this consistent: by the time the rows reach here,
  // El Qema's are gone and Main Stores stands in their place, so the dropdown, the row count, the
  // totals and the rows on the page all describe one population.
  //
  // 🔴 THE ORDER IS LOAD-BEARING AND IT IS NOT OBVIOUS. `buildFilterOptions` runs on the
  // PRE-FILTER rows, so a removal applied further down — against the paged rows, where it used to
  // sit — left `QM` sitting in the tab's own DISTRIBUTOR DROPDOWN with nothing in the rows to show
  // for it. Measured live on Pedia. A Main Stores row carries a BLANK distributor for the same
  // reason: the option builder skips a blank, and a "Main Stores" entry in a distributor filter
  // would be a fourth name for the same thing.
  //
  // 🔴 WHAT MUST NOT MOVE ABOVE THE SUBSTITUTION IS THE STORE SPLIT THE MATRIX READS, and it
  // does not: that one is computed upstream in `loadMonthlyClosingPartsWithStoreSplit`, long before
  // these rows arrive. The split run inside `buildMainStoresRows` is a second, read-only pass over
  // the same rows with the same rule, which is what makes the two agree.

  // Options come from everything in scope (pre-filter) so choosing one area never removes the
  // other areas from the dropdown.
  const options = buildFilterOptions(relabelled);

  const filtered = applyDetailFilters(relabelled, input.filters);
  const start = (page - 1) * pageSize;
  const shown = input.unpaged ? filtered : filtered.slice(start, start + pageSize);

  return {
    line,
    period,
    availableLines,
    availablePeriods,
    rows: [...shown],
    filteredRowCount: filtered.length,
    page,
    pageSize,
    options,
    totals: summarize(filtered, () => true),
    reconciliation: {
      closingHeadline: summarize(filtered, countsInClosingHeadline),
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
      closingHeadline: summarize(rows, countsInClosingHeadline),
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
    // Keyed on the ORGANOGRAM region, because that is what the region filter now matches and what
    // the Closing Matrix shows — offering the geographic code instead listed a choice that selects
    // a different population than the subtotal the reader clicked.
    if (row.operationalRegionCode) {
      regions.set(row.operationalRegionCode, row.operationalRegionName || row.operationalRegionCode);
    }
    // Keyed on the CLOSING area, because that is what the area filter now matches — offering the
    // resolved area instead would list a choice that selects none of this row's own money.
    const areaCode = closingAreaOf(row);
    if (areaCode && !areas.has(areaCode)) {
      // `areaName` describes the BRICK's area, so a re-booked row names its closing area from the
      // sheet instead; otherwise Port Said would be labelled "Dakahlia 1".
      const areaName = (isRebookedRow(row) ? text(row.sheetAreaName) : "") || row.areaName || areaCode;
      // The ORGANOGRAM region, because the panel cascades the area list off the selected region
      // (closing-details-panel.tsx). Tagging areas with the geographic code while the picker offers
      // organogram codes would leave the area list EMPTY the moment a reader picked UE-1.
      areas.set(areaCode, { code: areaCode, name: areaName, regionCode: row.operationalRegionCode });
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
    /**
     * A Medical Rep's OWN area bound, matched on the CLOSING area (`closingAreaOf`) — the area the
     * Closing Matrix books the row in — so their Details rows are exactly the ones behind their own matrix
     * row, including a wholesaler share the city split credits to them. When present it REPLACES both
     * bounds above: their region would add every sibling rep's area. Empty set = fail closed.
     */
    allowedClosingAreaCodes?: Set<string> | null;
    allowedProductCodes: Set<string> | null;
    dropConfidential: boolean;
  },
): ClosingDetailRow[] {
  let out = rows;
  if (scope.dropConfidential) out = out.filter((row) => !row.isConfidential);
  if (scope.allowedClosingAreaCodes) {
    const allowed = new Set([...scope.allowedClosingAreaCodes].map((code) => code.trim().toUpperCase()));
    out = out.filter((row) => allowed.has(closingAreaOf(row)));
  } else if (scope.allowedAreaCodes) {
    const allowed = scope.allowedAreaCodes;
    out = out.filter((row) => allowed.has(row.areaCode.trim().toUpperCase()));
  } else if (scope.allowedRegionCodes) {
    const allowed = scope.allowedRegionCodes;
    // Empty set = the viewer's region resolved to no code — fail closed.
    //
    // GEOGRAPHIC, always: `allowedRegionCodes` is resolved from the same area master this row's
    // `regionCode` came from. The organogram relabel deliberately runs AFTER this gate — testing a
    // viewer's bound against a relabelled code would drop every row he owns and empty the tab.
    out = out.filter((row) => rowIsInRegionScope(allowed, row));
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

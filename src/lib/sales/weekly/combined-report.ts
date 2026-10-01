import type { SupabaseClient } from "@supabase/supabase-js";

import { houseGeneratedAt } from "@/lib/export/house-xlsx-identity";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { applyWeeklyAccessScope, type WeeklyAccessScope } from "@/lib/sales/weekly/access";
import {
  buildBatchesExportWorkbook,
  type BatchProductItem,
  type BatchSummaryItem,
} from "@/lib/sales/weekly/export-batches-workbook";
import { productPeriodPricesFromRows, type ProductPeriodPrices } from "@/lib/sales/product-period-price";
import { livePriceMap, liveSalesValue, weeklyRowPeriod } from "@/lib/sales/weekly/live-price";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";

// The weekly Upload screen's "Combined Report": what it reads, and the file it hands back. The route
// (app/api/sales/weekly/export-batches) only checks the caller and the request.
//
// 🔴 IT READ EVERY SELECTED UPLOAD'S PRODUCT ROWS IN ONE REQUEST — found 2026-09-17. PostgREST answers
// at most 1,000 rows per request and says nothing when it stops there, and a single weekly upload
// routinely holds more, with up to 20 exported at once. Every row past the 1,000th was missing, so the
// per-product sheets read short on Sales Value, Net Units and Stock Units with no warning. Worse, a
// product list cut short can show ONE product for an upload that carried several — and that list is
// what decides whether the report may print a unit total at all, because units of different products
// are never added (unit-totals.ts). The rows are now paged by keyset on `id`, the shape service.ts
// measured on production for this same table.
//
// Its "Generated" line also printed raw UTC. It is the house Cairo stamp now, like every house cover.
//
// 🔴 IT PRINTED EACH ROW'S STORED SALES VALUE, while every other weekly surface prices a row at today's
// Product Master price (live-price.ts). The stored value is the price on the day the sheet was imported,
// so after a factory-price edit the Combined Report and the dashboard disagreed for every upload before
// it. On production on 2026-09-18 that was 36 of 67 uploads and 4,072 rows: 343,832,783.69 EGP stored
// against 356,978,442.97 at today's prices. Rows and upload totals are now priced by the same rule as
// the dashboard, and a price list that cannot be read fails the export instead of printing old values.
//
// 🔴 IT HAD NO ACCESS SCOPE — found 2026-09-20. Every other weekly export hands the viewer's scope to the
// rows it prints, so the three restricted products and the Head Office line reach only the CEO and the
// Super Admin. This one read the rows with the service-role client and printed all of them, and the route
// admits the SFE Manager (it is gated on the upload permission, which he holds). On production that was
// about 88% of the stored weekly value, in 48 of 75 uploads. The scope is now a REQUIRED argument — a
// default would be a fail-open — and an upload the scope took rows from prints the row count, the units
// and the value of the rows the viewer may see, never the totals stored on the upload, which add the
// hidden rows too.
//
// A DATED PRICE COVERS ITS OWN MONTHS (owner, 2026-10-01): Saginko is 170.52 from 2026-10 while its
// master price stays 111.15, so a row is priced at the dated price that covers its cycle month — the
// same rule and the same month as the dashboard — and a dated list that cannot be read fails the export
// too, rather than print October's Saginko at the old price.

type WeeklyProductRow = {
  id: number;
  batch_id: string | null;
  week_start: string | null;
  cycle_month: string | null;
  distributor_code: string | null;
  product_code: string | null;
  product_name: string | null;
  net_qty: number | string | null;
  sales_value: number | string | null;
  stock_qty: number | string | null;
  official_line: string | null;
  region_code: string | null;
  area_code: string | null;
};

type MasterPriceRow = { product_code: string | null; factory_price: number | string | null; active: boolean | null };

type DatedPriceRow = { product_code: string | null; effective_period: string | null; factory_price: number | string | null };

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

/** Today's Product Master prices: the active products, as the dashboard reads them. */
export async function loadCombinedReportPrices(supabase: SupabaseClient): Promise<Map<string, number>> {
  let rows: MasterPriceRow[];
  try {
    rows = await fetchAllRowsKeyset<MasterPriceRow>(
      () => supabase.from("source_of_sales_products").select("product_code, factory_price, active"),
      { cursorColumn: "product_code", cursorOf: (row) => row.product_code },
    );
  } catch (error) {
    throw new SalesWorkflowError(
      "load_failed",
      `The Product Master prices could not be read, so the Combined Report cannot be priced. ${errorMessage(error)}`,
      500,
    );
  }
  return livePriceMap(
    rows.filter((row) => row.active === true).map((row) => ({ productCode: row.product_code, factoryPrice: row.factory_price })),
  );
}

/** The dated prices over today's list (`prices`), resolved the way the dashboard resolves them. */
export async function loadCombinedReportDatedPrices(
  supabase: SupabaseClient,
  prices: ReadonlyMap<string, number>,
): Promise<Pick<ProductPeriodPrices, "priceFor">> {
  const { data, error } = await supabase
    .from("source_of_sales_product_price_history")
    .select("product_code, effective_period, factory_price");
  if (error) {
    throw new SalesWorkflowError(
      "load_failed",
      `The dated Product Master prices could not be read, so the Combined Report cannot be priced. ${errorMessage(error)}`,
      500,
    );
  }
  return productPeriodPricesFromRows(
    [...prices].map(([productCode, factoryPrice]) => ({ productCode, factoryPrice })),
    ((data ?? []) as DatedPriceRow[]).map((row) => ({
      productCode: row.product_code,
      effectivePeriod: row.effective_period,
      factoryPrice: row.factory_price,
    })),
  );
}

/** What the viewer's scope left of one upload — printed in place of the totals stored on it. */
export type CombinedReportUploadTotals = { rows: number; netQty: number; stockQty: number };

export type CombinedReportProducts = {
  /** Per upload: the products the viewer may see, priced at today's master price, added up per product. */
  productsByBatch: Map<string, BatchProductItem[]>;
  /**
   * Only the uploads the scope took at least one row from — and every one of them: an upload whose rows
   * were ALL hidden is here with zeros, so it never falls back to the totals stored on it. An upload the
   * scope left whole is absent and keeps its stored figures exactly as it always did.
   */
  scopedTotals: Map<string, CombinedReportUploadTotals>;
};

/**
 * Every product row of the selected uploads that the viewer's scope allows, priced at today's master
 * price, added up per upload and product. The scope is required: a caller that has none has no business
 * reading these rows.
 */
export async function loadCombinedReportProducts(
  supabase: SupabaseClient,
  batchIds: string[],
  prices: ReadonlyMap<string, number>,
  scope: WeeklyAccessScope,
  datedPrices?: Pick<ProductPeriodPrices, "priceFor">,
): Promise<CombinedReportProducts> {
  let productRows: WeeklyProductRow[];
  try {
    // `id` is read ONLY as the keyset cursor; it is never part of a product line.
    productRows = await fetchAllRowsKeyset<WeeklyProductRow>(
      () =>
        supabase
          .from("weekly_sales_rows")
          .select("id, batch_id, week_start, cycle_month, distributor_code, product_code, product_name, net_qty, sales_value, stock_qty, official_line, region_code, area_code")
          .in("batch_id", batchIds),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    );
  } catch (error) {
    throw new SalesWorkflowError("load_failed", errorMessage(error), 500);
  }

  const loadedByBatch = new Map<string, number>();
  for (const row of productRows) {
    const batchId = row.batch_id ?? "";
    loadedByBatch.set(batchId, (loadedByBatch.get(batchId) ?? 0) + 1);
  }

  // The scope reads a row's product, line, region and area, in the shape the dashboard's rows have.
  const visibleRows = applyWeeklyAccessScope(
    productRows.map((row) => ({
      row,
      productCode: row.product_code ?? "",
      officialLine: row.official_line,
      regionCode: row.region_code,
      areaCode: row.area_code,
    })),
    scope,
  ).map((entry) => entry.row);

  // Aggregate product rows by batch_id + product_code
  const aggregated = new Map<string, Map<string, BatchProductItem>>();
  const keptTotals = new Map<string, CombinedReportUploadTotals>();
  for (const row of visibleRows) {
    const batchId: string = row.batch_id ?? "";
    let byProduct = aggregated.get(batchId);
    if (!byProduct) { byProduct = new Map(); aggregated.set(batchId, byProduct); }
    const key = row.product_code ?? "__unknown__";
    const netQty = Number(row.net_qty ?? 0);
    const stockQty = Number(row.stock_qty ?? 0);
    const salesValue = liveSalesValue(
      {
        distributorCode: row.distributor_code,
        productCode: row.product_code,
        netQty,
        storedValue: Number(row.sales_value ?? 0),
        period: weeklyRowPeriod(row.cycle_month, row.week_start),
      },
      prices,
      datedPrices,
    );
    const kept = keptTotals.get(batchId) ?? { rows: 0, netQty: 0, stockQty: 0 };
    kept.rows += 1;
    kept.netQty += netQty;
    kept.stockQty += stockQty;
    keptTotals.set(batchId, kept);
    const existing = byProduct.get(key);
    if (existing) {
      existing.netQty += netQty;
      existing.salesValue += salesValue;
      existing.stockQty += stockQty;
    } else {
      byProduct.set(key, {
        productCode: row.product_code ?? "",
        productName: row.product_name ?? row.product_code ?? "",
        netQty,
        salesValue,
        stockQty,
      });
    }
  }

  const scopedTotals = new Map<string, CombinedReportUploadTotals>();
  for (const [batchId, loaded] of loadedByBatch) {
    const kept = keptTotals.get(batchId) ?? { rows: 0, netQty: 0, stockQty: 0 };
    if (kept.rows < loaded) scopedTotals.set(batchId, kept);
  }

  return {
    productsByBatch: new Map([...aggregated.entries()].map(([batchId, byProduct]) => [batchId, [...byProduct.values()]])),
    scopedTotals,
  };
}

/** The Combined Report workbook for the selected uploads, or null when none of them exists. */
export async function buildCombinedReportExport(
  supabase: SupabaseClient,
  batchIds: string[],
  scope: WeeklyAccessScope,
  now: Date = new Date(),
): Promise<Buffer | null> {
  const { data: batchRows, error: batchErr } = await supabase
    .from("weekly_sales_batches")
    .select("id, distributor_code, distributor_name, week_start, status, total_rows, total_net_qty, total_sales_value, total_stock_qty")
    .in("id", batchIds);
  if (batchErr) throw new SalesWorkflowError("load_failed", batchErr.message, 500);
  if (!batchRows || batchRows.length === 0) return null;

  const prices = await loadCombinedReportPrices(supabase);
  const datedPrices = await loadCombinedReportDatedPrices(supabase, prices);
  const { productsByBatch, scopedTotals } = await loadCombinedReportProducts(supabase, batchIds, prices, scope, datedPrices);

  // An upload's stored total is the sum of its rows at import prices (every one of the 67 uploads on
  // production, 2026-09-18), so its total at today's prices is the sum of its repriced rows. An upload
  // with no rows keeps its stored figure.
  //
  // An upload the viewer's scope took rows from is the exception, and it never keeps a stored figure:
  // its stored row count and unit totals add the rows he may not see. It prints what he may see, and an
  // upload whose rows were all hidden prints zeros.
  const batches: BatchSummaryItem[] = batchRows.map((b) => {
    const products = productsByBatch.get(b.id as string);
    const scoped = scopedTotals.get(b.id as string);
    return {
      id: b.id as string,
      distributorCode: b.distributor_code as string,
      distributorName: b.distributor_name as string,
      weekStart: b.week_start as string | null,
      status: b.status as string,
      totalRows: scoped ? scoped.rows : ((b.total_rows as number) ?? 0),
      totalNetQty: scoped ? scoped.netQty : ((b.total_net_qty as number) ?? 0),
      totalSalesValue: products
        ? Number(products.reduce((sum, p) => sum + p.salesValue, 0).toFixed(6))
        : scoped
          ? 0
          : ((b.total_sales_value as number) ?? 0),
      totalStockQty: scoped ? scoped.stockQty : ((b.total_stock_qty as number) ?? 0),
    };
  });

  return buildBatchesExportWorkbook(batches, productsByBatch, houseGeneratedAt(now.toISOString()));
}

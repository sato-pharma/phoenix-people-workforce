import type { SupabaseClient } from "@supabase/supabase-js";

import { houseGeneratedAt } from "@/lib/export/house-xlsx-identity";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  buildBatchesExportWorkbook,
  type BatchProductItem,
  type BatchSummaryItem,
} from "@/lib/sales/weekly/export-batches-workbook";
import { livePriceMap, liveSalesValue } from "@/lib/sales/weekly/live-price";
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

type WeeklyProductRow = {
  id: number;
  batch_id: string | null;
  distributor_code: string | null;
  product_code: string | null;
  product_name: string | null;
  net_qty: number | string | null;
  sales_value: number | string | null;
  stock_qty: number | string | null;
};

type MasterPriceRow = { product_code: string | null; factory_price: number | string | null; active: boolean | null };

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

/** Every product row of the selected uploads, priced at today's master price, added up per upload and product. */
export async function loadCombinedReportProducts(
  supabase: SupabaseClient,
  batchIds: string[],
  prices: ReadonlyMap<string, number>,
): Promise<Map<string, BatchProductItem[]>> {
  let productRows: WeeklyProductRow[];
  try {
    // `id` is read ONLY as the keyset cursor; it is never part of a product line.
    productRows = await fetchAllRowsKeyset<WeeklyProductRow>(
      () =>
        supabase
          .from("weekly_sales_rows")
          .select("id, batch_id, distributor_code, product_code, product_name, net_qty, sales_value, stock_qty")
          .in("batch_id", batchIds),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    );
  } catch (error) {
    throw new SalesWorkflowError("load_failed", errorMessage(error), 500);
  }

  // Aggregate product rows by batch_id + product_code
  const aggregated = new Map<string, Map<string, BatchProductItem>>();
  for (const row of productRows) {
    const batchId: string = row.batch_id ?? "";
    let byProduct = aggregated.get(batchId);
    if (!byProduct) { byProduct = new Map(); aggregated.set(batchId, byProduct); }
    const key = row.product_code ?? "__unknown__";
    const netQty = Number(row.net_qty ?? 0);
    const salesValue = liveSalesValue(
      { distributorCode: row.distributor_code, productCode: row.product_code, netQty, storedValue: Number(row.sales_value ?? 0) },
      prices,
    );
    const existing = byProduct.get(key);
    if (existing) {
      existing.netQty += netQty;
      existing.salesValue += salesValue;
      existing.stockQty += Number(row.stock_qty ?? 0);
    } else {
      byProduct.set(key, {
        productCode: row.product_code ?? "",
        productName: row.product_name ?? row.product_code ?? "",
        netQty,
        salesValue,
        stockQty: Number(row.stock_qty ?? 0),
      });
    }
  }

  return new Map(
    [...aggregated.entries()].map(([batchId, byProduct]) => [batchId, [...byProduct.values()]]),
  );
}

/** The Combined Report workbook for the selected uploads, or null when none of them exists. */
export async function buildCombinedReportExport(
  supabase: SupabaseClient,
  batchIds: string[],
  now: Date = new Date(),
): Promise<Buffer | null> {
  const { data: batchRows, error: batchErr } = await supabase
    .from("weekly_sales_batches")
    .select("id, distributor_code, distributor_name, week_start, status, total_rows, total_net_qty, total_sales_value, total_stock_qty")
    .in("id", batchIds);
  if (batchErr) throw new SalesWorkflowError("load_failed", batchErr.message, 500);
  if (!batchRows || batchRows.length === 0) return null;

  const prices = await loadCombinedReportPrices(supabase);
  const productsByBatch = await loadCombinedReportProducts(supabase, batchIds, prices);

  // An upload's stored total is the sum of its rows at import prices (every one of the 67 uploads on
  // production, 2026-09-18), so its total at today's prices is the sum of its repriced rows. An upload
  // with no rows keeps its stored figure.
  const batches: BatchSummaryItem[] = batchRows.map((b) => {
    const products = productsByBatch.get(b.id as string);
    return {
      id: b.id as string,
      distributorCode: b.distributor_code as string,
      distributorName: b.distributor_name as string,
      weekStart: b.week_start as string | null,
      status: b.status as string,
      totalRows: (b.total_rows as number) ?? 0,
      totalNetQty: (b.total_net_qty as number) ?? 0,
      totalSalesValue: products
        ? Number(products.reduce((sum, p) => sum + p.salesValue, 0).toFixed(6))
        : ((b.total_sales_value as number) ?? 0),
      totalStockQty: (b.total_stock_qty as number) ?? 0,
    };
  });

  return buildBatchesExportWorkbook(batches, productsByBatch, houseGeneratedAt(now.toISOString()));
}

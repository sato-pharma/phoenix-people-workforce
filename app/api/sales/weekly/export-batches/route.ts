import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { buildBatchesExportWorkbook } from "@/lib/sales/weekly/export-batches-workbook";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "read");

    const body = (await request.json()) as { batchIds?: unknown };
    const rawIds = body?.batchIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return new Response(JSON.stringify({ error: "batchIds must be a non-empty array." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (rawIds.length > 20) {
      return new Response(JSON.stringify({ error: "Cannot export more than 20 batches at once." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const batchIds = rawIds.filter((id): id is string => typeof id === "string");
    if (batchIds.length === 0) {
      return new Response(JSON.stringify({ error: "No valid batch IDs provided." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = getSupabaseAdmin();

    const { data: batchRows, error: batchErr } = await supabase
      .from("weekly_sales_batches")
      .select("id, distributor_code, distributor_name, week_start, status, total_rows, total_net_qty, total_sales_value, total_stock_qty")
      .in("id", batchIds);
    if (batchErr) throw new SalesWorkflowError("load_failed", batchErr.message, 500);
    if (!batchRows || batchRows.length === 0) {
      return new Response(JSON.stringify({ error: "No batches found." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { data: productRows, error: rowsErr } = await supabase
      .from("weekly_sales_rows")
      .select("batch_id, product_code, product_name, net_qty, sales_value, stock_qty")
      .in("batch_id", batchIds);
    if (rowsErr) throw new SalesWorkflowError("load_failed", rowsErr.message, 500);

    // Aggregate product rows by batch_id + product_code in JavaScript
    const aggregated = new Map<string, Map<string, { productCode: string; productName: string; netQty: number; salesValue: number; stockQty: number }>>();
    for (const row of productRows ?? []) {
      const batchId: string = row.batch_id ?? "";
      let byProduct = aggregated.get(batchId);
      if (!byProduct) { byProduct = new Map(); aggregated.set(batchId, byProduct); }
      const key = row.product_code ?? "__unknown__";
      const existing = byProduct.get(key);
      if (existing) {
        existing.netQty += row.net_qty ?? 0;
        existing.salesValue += row.sales_value ?? 0;
        existing.stockQty += row.stock_qty ?? 0;
      } else {
        byProduct.set(key, {
          productCode: row.product_code ?? "",
          productName: row.product_name ?? row.product_code ?? "",
          netQty: row.net_qty ?? 0,
          salesValue: row.sales_value ?? 0,
          stockQty: row.stock_qty ?? 0,
        });
      }
    }

    const batches = batchRows.map((b) => ({
      id: b.id as string,
      distributorCode: b.distributor_code as string,
      distributorName: b.distributor_name as string,
      weekStart: b.week_start as string | null,
      status: b.status as string,
      totalRows: (b.total_rows as number) ?? 0,
      totalNetQty: (b.total_net_qty as number) ?? 0,
      totalSalesValue: (b.total_sales_value as number) ?? 0,
      totalStockQty: (b.total_stock_qty as number) ?? 0,
    }));

    const productsByBatch = new Map(
      [...aggregated.entries()].map(([batchId, byProduct]) => [batchId, [...byProduct.values()]]),
    );

    const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const buffer = await buildBatchesExportWorkbook(batches, productsByBatch, generatedAt);
    const filename = `phoenix-weekly-combined_${batchIds.length}-batches.xlsx`;

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return new Response(JSON.stringify({ error: "Forbidden." }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    if (error instanceof SalesWorkflowError) {
      return new Response(JSON.stringify({ error: error.message }), { status: error.status, headers: { "Content-Type": "application/json" } });
    }
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Export failed." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

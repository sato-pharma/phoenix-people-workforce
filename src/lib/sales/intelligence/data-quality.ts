import { computeMonthCompleteness } from "@/lib/sales/intelligence/derive";
import { loadSiReference } from "@/lib/sales/intelligence/loader";
import type { SiDataQuality, SiDataQualityBatch, SiMonthCompleteness } from "@/lib/sales/intelligence/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Data Quality Center — operational health of the Source-of-Sales upload pipeline. This is an
// admin (sales:import) view, so it is company-wide; it reports counts and reference-mapping gaps
// (never restricted product names), and flags months as incomplete until every expected
// distributor has uploaded a validated file.

const str = (value: unknown) => String(value ?? "");
const num = (value: unknown) => Number(value ?? 0);

async function countNull(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  period: string,
  column: string,
): Promise<number> {
  const { count } = await supabase
    .from("source_of_sales_import_rows")
    .select("id", { count: "exact", head: true })
    .eq("invoice_period", period)
    .is(column, null);
  return count ?? 0;
}

export async function getSiDataQuality(period: string | null): Promise<SiDataQuality> {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30000 });
  const reference = await loadSiReference();

  const { data: batchData } = await supabase
    .from("source_of_sales_import_batches")
    .select("period,distributor_code,distributor_name,status,total_rows,importable_rows,warning_rows,failed_rows,file_name,uploaded_by,created_at")
    .order("created_at", { ascending: false });

  const batches: SiDataQualityBatch[] = ((batchData ?? []) as Array<Record<string, unknown>>).map((row) => ({
    period: str(row.period),
    distributorCode: str(row.distributor_code),
    distributorName: str(row.distributor_name) || reference.distributorName.get(str(row.distributor_code)) || str(row.distributor_code),
    status: str(row.status),
    totalRows: num(row.total_rows),
    importableRows: num(row.importable_rows),
    warningRows: num(row.warning_rows),
    failedRows: num(row.failed_rows),
    fileName: str(row.file_name),
    uploadedBy: str(row.uploaded_by),
    createdAt: str(row.created_at),
  }));

  const availablePeriods = [...new Set(batches.map((batch) => batch.period).filter(Boolean))].sort((a, b) => b.localeCompare(a));
  const selectedPeriod = period && availablePeriods.includes(period) ? period : availablePeriods[0] ?? null;

  // Files grouped by month (newest first), each month's batches sorted by upload time.
  const byMonth = new Map<string, SiDataQualityBatch[]>();
  for (const batch of batches) {
    if (!batch.period) continue;
    const list = byMonth.get(batch.period) ?? [];
    list.push(batch);
    byMonth.set(batch.period, list);
  }
  const filesByMonth = [...byMonth.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([monthPeriod, monthBatches]) => ({ period: monthPeriod, batches: monthBatches }));

  // Row quality for the selected month = sum of the per-batch validation columns (validated only).
  const periodBatches = selectedPeriod
    ? batches.filter((batch) => batch.period === selectedPeriod && batch.status === "validated")
    : [];
  const rowQuality = periodBatches.reduce(
    (totals, batch) => ({
      totalRows: totals.totalRows + batch.totalRows,
      importableRows: totals.importableRows + batch.importableRows,
      warningRows: totals.warningRows + batch.warningRows,
      failedRows: totals.failedRows + batch.failedRows,
    }),
    { totalRows: 0, importableRows: 0, warningRows: 0, failedRows: 0 },
  );

  // Reference-mapping gaps for the selected month (cheap head-counts; null = unmapped).
  const mappingGaps = selectedPeriod
    ? {
        missingCustomer: await countNull(supabase, selectedPeriod, "client_code"),
        missingArea: await countNull(supabase, selectedPeriod, "area_code"),
        missingRegion: await countNull(supabase, selectedPeriod, "region_code"),
        missingBrick: await countNull(supabase, selectedPeriod, "brick_id"),
      }
    : { missingCustomer: 0, missingArea: 0, missingRegion: 0, missingBrick: 0 };

  // Month completion across all validated months.
  const completenessMap = computeMonthCompleteness(
    batches.filter((batch) => batch.status === "validated").map((batch) => ({ period: batch.period, distributorCode: batch.distributorCode })),
    [...reference.distributorName.keys()],
    reference.distributorName,
  );
  const monthCompletion: SiMonthCompleteness[] = [...completenessMap.values()].sort((a, b) => b.period.localeCompare(a.period));

  return { period: selectedPeriod, availablePeriods, filesByMonth, rowQuality, mappingGaps, monthCompletion };
}

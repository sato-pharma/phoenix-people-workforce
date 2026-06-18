import type { ImportPreviewDiff } from "@/lib/sales/import-preview";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type CoverageSnapshot = {
  batchId: string;
  brickDriftCount: number;
  committedAt: string;
  distinctCustomers: number;
  distributorCode: string;
  id: string;
  importableRows: number;
  importableValue: number;
  mappedCustomers: number;
  newCustomerCodes: string[];
  newCustomers: number;
  period: string | null;
  resolvedPct: number;
  totalRows: number;
  unmappedProducts: string[];
  unmappedProductsCount: number;
};

export type DistributorCoverageRow = {
  distributorCode: string;
  importCount: number;
  latestBrickDrift: number;
  latestCommittedAt: string;
  latestNewCustomers: number;
  latestResolvedPct: number;
  latestUnmappedProducts: number;
  trend: number[]; // resolved pct for last ≤5 imports, oldest first
};

export type CoverageSummary = {
  avgResolvedPct: number;
  byDistributor: DistributorCoverageRow[];
  driftAlerts: {
    batchId: string;
    brickDriftCount: number;
    committedAt: string;
    distributorCode: string;
  }[];
  persistentUnmapped: string[]; // codes appearing as "new" in 3+ snapshots
  totalImports: number;
};

function mapSnapshot(row: Record<string, unknown>): CoverageSnapshot {
  return {
    batchId: String(row.batch_id ?? ""),
    brickDriftCount: Number(row.brick_drift_count ?? 0),
    committedAt: String(row.committed_at ?? ""),
    distinctCustomers: Number(row.distinct_customers ?? 0),
    distributorCode: String(row.distributor_code ?? ""),
    id: String(row.id ?? ""),
    importableRows: Number(row.importable_rows ?? 0),
    importableValue: Number(row.importable_value ?? 0),
    mappedCustomers: Number(row.mapped_customers ?? 0),
    newCustomerCodes: Array.isArray(row.new_customer_codes) ? row.new_customer_codes.map(String) : [],
    newCustomers: Number(row.new_customers ?? 0),
    period: row.period ? String(row.period) : null,
    resolvedPct: Number(row.resolved_pct ?? 0),
    totalRows: Number(row.total_rows ?? 0),
    unmappedProducts: Array.isArray(row.unmapped_products) ? row.unmapped_products.map(String) : [],
    unmappedProductsCount: Number(row.unmapped_products_count ?? 0),
  };
}

export async function saveCoverageSnapshot(input: {
  batchId: string;
  diff: ImportPreviewDiff;
  distributorCode: string;
  period: string | null;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("sos_import_coverage_snapshots").insert({
    batch_id: input.batchId,
    brick_drift_count: input.diff.brickDriftCount,
    distinct_customers: input.diff.distinctCustomers,
    distributor_code: input.distributorCode,
    importable_rows: input.diff.importableRows,
    importable_value: input.diff.importableValue,
    mapped_customers: input.diff.mappedCustomers,
    new_customer_codes: input.diff.newCustomerCodes,
    new_customers: input.diff.newCustomers,
    period: input.period ?? null,
    resolved_pct: input.diff.resolvedRowsPct,
    total_rows: input.diff.totalRows,
    unmapped_products: input.diff.unmappedProducts,
    unmapped_products_count: input.diff.unmappedProductsCount,
  });
  if (error) {
    // Non-fatal: coverage snapshot is analytics — never block an import for it.
    console.error("[sos-coverage] Failed to save snapshot:", error.message);
  }
}

async function listCoverageSnapshots(opts?: { limit?: number }): Promise<CoverageSnapshot[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sos_import_coverage_snapshots")
    .select("*")
    .order("committed_at", { ascending: false })
    .limit(opts?.limit ?? 500);
  if (error) throw error;
  return (data ?? []).map((row) => mapSnapshot(row as Record<string, unknown>));
}

export async function getCoverageSummary(): Promise<CoverageSummary> {
  const snapshots = await listCoverageSnapshots({ limit: 500 });

  if (snapshots.length === 0) {
    return { avgResolvedPct: 0, byDistributor: [], driftAlerts: [], persistentUnmapped: [], totalImports: 0 };
  }

  // Group by distributor (snapshots already ordered desc by committed_at from the query)
  const byDist = new Map<string, CoverageSnapshot[]>();
  for (const s of snapshots) {
    let arr = byDist.get(s.distributorCode);
    if (!arr) { arr = []; byDist.set(s.distributorCode, arr); }
    arr.push(s);
  }

  const byDistributor: DistributorCoverageRow[] = [];
  for (const [distributorCode, rows] of byDist) {
    const latest = rows[0];
    const trend = rows.slice(0, 5).reverse().map((r) => r.resolvedPct); // oldest first
    byDistributor.push({
      distributorCode,
      importCount: rows.length,
      latestBrickDrift: latest.brickDriftCount,
      latestCommittedAt: latest.committedAt,
      latestNewCustomers: latest.newCustomers,
      latestResolvedPct: latest.resolvedPct,
      latestUnmappedProducts: latest.unmappedProductsCount,
      trend,
    });
  }

  // Worst coverage first so the table surfaces what needs attention
  byDistributor.sort((a, b) => a.latestResolvedPct - b.latestResolvedPct);

  const avgResolvedPct =
    Math.round((snapshots.reduce((sum, s) => sum + s.resolvedPct, 0) / snapshots.length) * 10) / 10;

  // Persistent unmapped: customer codes appearing as "new" in 3+ different snapshots
  const codeCount = new Map<string, number>();
  for (const s of snapshots) {
    const seen = new Set<string>();
    for (const code of s.newCustomerCodes) {
      const key = code.toUpperCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      codeCount.set(key, (codeCount.get(key) ?? 0) + 1);
    }
  }
  const persistentUnmapped = [...codeCount.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([code]) => code);

  const driftAlerts = snapshots
    .filter((s) => s.brickDriftCount > 0)
    .slice(0, 20)
    .map((s) => ({
      batchId: s.batchId,
      brickDriftCount: s.brickDriftCount,
      committedAt: s.committedAt,
      distributorCode: s.distributorCode,
    }));

  return { avgResolvedPct, byDistributor, driftAlerts, persistentUnmapped, totalImports: snapshots.length };
}

import type { ImportPreviewDiff } from "@/lib/sales/import-preview";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type NewCustomerDetail = { address: string; code: string; name: string };

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
  newCustomerDetails: NewCustomerDetail[];
  newCustomers: number;
  period: string | null;
  resolvedPct: number;
  totalRows: number;
  unmappedProducts: string[];
  unmappedProductsCount: number;
};

// A customer code that keeps showing up unmapped — surfaced with its name/address (when a recent
// import captured them) so it can be bulk-mapped on the Coverage tab.
export type PersistentUnmappedCustomer = {
  address: string;
  customerCode: string;
  customerName: string;
  distributorCode: string;
  importCount: number;
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
  persistentUnmapped: PersistentUnmappedCustomer[]; // codes appearing as "new" in 3+ snapshots
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
    newCustomerDetails: Array.isArray(row.new_customer_details)
      ? (row.new_customer_details as Record<string, unknown>[]).map((d) => ({
          address: String(d.address ?? ""),
          code: String(d.code ?? ""),
          name: String(d.name ?? ""),
        }))
      : [],
    newCustomers: Number(row.new_customers ?? 0),
    period: row.period ? String(row.period) : null,
    resolvedPct: Number(row.resolved_pct ?? 0),
    totalRows: Number(row.total_rows ?? 0),
    unmappedProducts: Array.isArray(row.unmapped_products) ? row.unmapped_products.map(String) : [],
    unmappedProductsCount: Number(row.unmapped_products_count ?? 0),
  };
}

const MAX_SNAPSHOT_DETAILS = 300;

export async function saveCoverageSnapshot(input: {
  batchId: string;
  details?: NewCustomerDetail[];
  diff: ImportPreviewDiff;
  distributorCode: string;
  period: string | null;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const details = (input.details ?? []).slice(0, MAX_SNAPSHOT_DETAILS);
  const { error } = await supabase.from("sos_import_coverage_snapshots").insert({
    batch_id: input.batchId,
    brick_drift_count: input.diff.brickDriftCount,
    distinct_customers: input.diff.distinctCustomers,
    distributor_code: input.distributorCode,
    importable_rows: input.diff.importableRows,
    importable_value: input.diff.importableValue,
    mapped_customers: input.diff.mappedCustomers,
    new_customer_codes: input.diff.newCustomerCodes,
    new_customer_details: details.length > 0 ? details : null,
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

const PERSISTENT_MIN_IMPORTS = 3;
const PERSISTENT_CAP = 50;

// Pure: customers (distributor + code) that appeared as "new"/unmapped in PERSISTENT_MIN_IMPORTS or
// more distinct snapshots. Carries name/address from the latest snapshot that captured them (older
// snapshots only stored codes — those fall back to a blank name). Counted once per snapshot.
export function aggregatePersistentUnmapped(snapshots: CoverageSnapshot[]): PersistentUnmappedCustomer[] {
  type Agg = { address: string; count: number; customerCode: string; customerName: string; distributorCode: string };
  const byKey = new Map<string, Agg>();

  // Snapshots arrive newest-first, so the FIRST detail we see for a key is the most recent name/address.
  for (const s of snapshots) {
    const dist = s.distributorCode;
    const seen = new Set<string>(); // de-dupe within one snapshot → count snapshots, not rows
    const bump = (rawCode: string, name: string, address: string) => {
      const code = String(rawCode ?? "").trim();
      if (!code) return;
      const key = `${dist.toUpperCase()}|${code.toUpperCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        if (!existing.customerName && name) existing.customerName = name;
        if (!existing.address && address) existing.address = address;
      } else {
        byKey.set(key, { address, count: 1, customerCode: code, customerName: name, distributorCode: dist });
      }
    };
    if (s.newCustomerDetails.length > 0) {
      for (const d of s.newCustomerDetails) bump(d.code, d.name, d.address);
    } else {
      for (const code of s.newCustomerCodes) bump(code, "", ""); // old snapshot — code only
    }
  }

  return [...byKey.values()]
    .filter((a) => a.count >= PERSISTENT_MIN_IMPORTS)
    .sort((a, b) => b.count - a.count || a.customerCode.localeCompare(b.customerCode))
    .slice(0, PERSISTENT_CAP)
    .map((a) => ({
      address: a.address,
      customerCode: a.customerCode,
      customerName: a.customerName,
      distributorCode: a.distributorCode,
      importCount: a.count,
    }));
}

// Pure: fill blank names/addresses on the persistent list from a `${DIST}|${CODE}` → name/address map
// (built from the import-rows table). A customer that already has a name is left untouched.
export function applyNameBackfill(
  items: PersistentUnmappedCustomer[],
  namesByKey: Map<string, { address: string; name: string }>,
): PersistentUnmappedCustomer[] {
  return items.map((item) => {
    if (item.customerName) return item;
    const hit = namesByKey.get(`${item.distributorCode.toUpperCase()}|${item.customerCode.toUpperCase()}`);
    if (!hit?.name) return item;
    return { ...item, address: item.address || hit.address, customerName: hit.name };
  });
}

// Recover names for persistent-unmapped customers that have none (e.g. snapshots taken before names
// were captured) from source_of_sales_import_rows — the authoritative (distributor, code) → name
// source. Best-effort + bounded (the persistent list is capped at PERSISTENT_CAP).
async function backfillNamesFromImportRows(items: PersistentUnmappedCustomer[]): Promise<PersistentUnmappedCustomer[]> {
  const needing = items.filter((i) => !i.customerName);
  if (needing.length === 0) return items;

  const codes = [...new Set(needing.map((i) => i.customerCode))];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_import_rows")
    .select("distributor_code,client_code,client_name,client_address")
    .in("client_code", codes)
    .not("client_name", "is", null)
    .limit(5000);
  if (error || !data) return items;

  const namesByKey = new Map<string, { address: string; name: string }>();
  for (const row of data as Record<string, unknown>[]) {
    const name = String(row.client_name ?? "").trim();
    if (!name) continue;
    const key = `${String(row.distributor_code ?? "").toUpperCase()}|${String(row.client_code ?? "").toUpperCase()}`;
    if (!namesByKey.has(key)) namesByKey.set(key, { address: String(row.client_address ?? "").trim(), name });
  }
  return applyNameBackfill(items, namesByKey);
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

  const persistentUnmapped = await backfillNamesFromImportRows(aggregatePersistentUnmapped(snapshots));

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

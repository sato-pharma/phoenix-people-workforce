import { logError } from "@/lib/observability/log";
import type { ImportPreviewDiff } from "@/lib/sales/import-preview";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
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
  /**
   * EGP, or `null` when the writer did not measure money. The brick-coverage writer knows rows and
   * units but never a value, and it used to store `unitsWithBrick` here — a unit COUNT in a money
   * column, for 100 of the 134 live snapshots. `null` is the truthful answer, so read it as
   * "not measured" and never as zero.
   */
  importableValue: number | null;
  mappedCustomers: number;
  newCustomerCodes: string[];
  newCustomerDetails: NewCustomerDetail[];
  /**
   * Customers this sheet had never seen before, or `null` when the writer did not measure that.
   * The brick-coverage writer stored `customersNeedingBrick - customersWithBrick` here — the
   * BRICK-LESS count, a different question, already recoverable from `distinctCustomers` minus
   * `mappedCustomers`.
   */
  newCustomers: number | null;
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
  /** `null` when the latest snapshot for this distributor did not measure new customers. */
  latestNewCustomers: number | null;
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
  /**
   * Live snapshots this summary was built from — orphans (batch deleted) excluded. NOT every
   * snapshot ever written: it is bounded by `snapshotWindow`.
   */
  totalImports: number;
  /**
   * The read cap. When `totalImports` reaches it, older snapshots exist that the persistent-unmapped
   * worklist could not see — and the oldest recurring offenders are exactly what that worklist is
   * for, so the tab must say it is showing a window rather than imply a total.
   */
  snapshotWindow: number;
};

/**
 * One snapshot row -> CoverageSnapshot. Exported for tests: the whole point of this mapper is that a
 * NULL money or new-customer column stays null instead of collapsing to a plausible 0.
 */
export function mapSnapshot(row: Record<string, unknown>): CoverageSnapshot {
  return {
    batchId: String(row.batch_id ?? ""),
    brickDriftCount: Number(row.brick_drift_count ?? 0),
    committedAt: String(row.committed_at ?? ""),
    distinctCustomers: Number(row.distinct_customers ?? 0),
    distributorCode: String(row.distributor_code ?? ""),
    id: String(row.id ?? ""),
    importableRows: Number(row.importable_rows ?? 0),
    importableValue: row.importable_value == null ? null : Number(row.importable_value),
    mappedCustomers: Number(row.mapped_customers ?? 0),
    newCustomerCodes: Array.isArray(row.new_customer_codes) ? row.new_customer_codes.map(String) : [],
    newCustomerDetails: Array.isArray(row.new_customer_details)
      ? (row.new_customer_details as Record<string, unknown>[]).map((d) => ({
          address: String(d.address ?? ""),
          code: String(d.code ?? ""),
          name: String(d.name ?? ""),
        }))
      : [],
    newCustomers: row.new_customers == null ? null : Number(row.new_customers),
    period: row.period ? String(row.period) : null,
    resolvedPct: Number(row.resolved_pct ?? 0),
    totalRows: Number(row.total_rows ?? 0),
    unmappedProducts: Array.isArray(row.unmapped_products) ? row.unmapped_products.map(String) : [],
    unmappedProductsCount: Number(row.unmapped_products_count ?? 0),
  };
}

const MAX_SNAPSHOT_DETAILS = 300;

/**
 * Coverage below which an import is worth shouting about. June 2026 landed at 95.1% (15,443 units
 * with no brick) and nothing anywhere noticed.
 */
export const BRICK_COVERAGE_WARN_PCT = 98;

export type BrickCoverage = {
  /** Distinct customers on rows that needed a brick and did not get one. */
  unmappedCustomerCodes: string[];
  /** Rows that need a brick (i.e. excluding DIRECT-style brick-level channels). */
  rowsNeedingBrick: number;
  rowsWithBrick: number;
  /** rowsWithBrick / rowsNeedingBrick * 100, 1 dp. 100 when nothing needed a brick. */
  coveragePct: number;
  unitsNeedingBrick: number;
  unitsWithBrick: number;
  customersNeedingBrick: number;
  customersWithBrick: number;
};

type CoverageInputRow = {
  brickId?: string | null;
  bonusQty?: number | null;
  clientCode?: string | null;
  isDirect?: boolean | null;
  qty?: number | null;
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * REAL brick coverage — how many rows that NEEDED a brick actually got one.
 *
 * The metric this replaces was `importableRows / totalRows`, which on the normalizer path is
 * `rows.length / rows.length` — 100% by construction, every single time, no matter how many rows
 * landed with an empty brick_id. It reported 100% for an import that had 3,184 unmapped rows.
 * "Importable" means the parser accepted the row; it says nothing about whether the row found a
 * place on the map.
 *
 * DIRECT (and any other `isDirect` channel) is excluded from the denominator, not counted as a
 * failure: those sell at brick level and carry no customer code by design, so they can never have
 * a per-customer brick and would permanently drag the number down.
 *
 * Pure so the invariant is unit-tested without a database.
 */
export function computeBrickCoverage(rows: readonly CoverageInputRow[]): BrickCoverage {
  const needing = rows.filter((row) => !row.isDirect);
  const hasBrick = (row: CoverageInputRow) => String(row.brickId ?? "").trim() !== "";

  const withBrick = needing.filter(hasBrick);
  const units = (list: readonly CoverageInputRow[]) =>
    list.reduce((sum, row) => sum + num(row.qty) + num(row.bonusQty), 0);

  const customerCodes = (list: readonly CoverageInputRow[]) => {
    const set = new Set<string>();
    for (const row of list) {
      const code = String(row.clientCode ?? "").trim();
      if (code) set.add(code);
    }
    return set;
  };

  const unmappedCodes = customerCodes(needing.filter((row) => !hasBrick(row)));

  return {
    coveragePct:
      needing.length === 0
        ? 100
        : Math.round((withBrick.length / needing.length) * 1000) / 10,
    customersNeedingBrick: customerCodes(needing).size,
    customersWithBrick: customerCodes(withBrick).size,
    rowsNeedingBrick: needing.length,
    rowsWithBrick: withBrick.length,
    unitsNeedingBrick: units(needing),
    unitsWithBrick: units(withBrick),
    unmappedCustomerCodes: [...unmappedCodes].sort(),
  };
}

/**
 * Records real brick coverage for a committed normalizer batch, and shouts when it is bad.
 *
 * `persistNormalizedBatch` — the path every distributor upload actually takes — never wrote a
 * coverage snapshot at all: the newest row in the table on 2026-07-29 predated the June import
 * entirely. So the one place that could have caught June was both measuring the wrong thing AND
 * not running.
 *
 * Deliberately NOT fire-and-forget-silent: a failure here is logged, because the whole point of
 * this record is to notice things nobody was watching.
 */
/**
 * Distinct customers whose resolved brick disagrees with a brick ALREADY STORED for them.
 *
 * The normalizer's `customerBrickCorrections` also carries customers with no stored brick at all
 * (`previousBrickId === null`). Those are FIRST MAPPINGS, not drift, and counting them would turn
 * every first-time import into a mapping alarm. buildImportPreviewDiff draws the same line with
 * `if (!mapped || mapped === resolved) continue`, and the two must agree because they write the
 * same column of the same table.
 */
export function countBrickDrift(
  corrections: readonly { brickId: string; previousBrickId: string | null }[],
): number {
  return corrections.filter(
    (correction) =>
      correction.previousBrickId !== null &&
      String(correction.previousBrickId).trim() !== "" &&
      correction.previousBrickId !== correction.brickId,
  ).length;
}

/**
 * Distinct product labels a sheet could not resolve, in file order.
 *
 * The engine files an unresolved row as an exception whose reason is "product" (the product alone
 * failed) or "both" (product and brick). "brick" is a different failure — it belongs to the brick
 * coverage figure, not this one — so counting it here would double-report one problem as two.
 *
 * Returns the full distinct `count` alongside the labels, because the stored list is sampled: a
 * caller must never report the sample length as the number of unmapped products.
 */
export function collectUnmappedProducts(
  exceptions: readonly { rawProduct?: string | null; reason: string }[],
): { count: number; products: string[] } {
  const seen = new Set<string>();
  const products: string[] = [];
  for (const exception of exceptions) {
    if (exception.reason !== "product" && exception.reason !== "both") continue;
    const label = String(exception.rawProduct ?? "").trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    products.push(label);
  }
  return { count: seen.size, products };
}

/**
 * Record one batch's brick coverage — and the mapping health the Coverage tab reports.
 *
 * `brickDriftCount` and `unmappedProducts` are REQUIRED, deliberately. They used to be written as
 * the literals `0`, `[]` and `0`, on the path EVERY distributor upload takes, so the two columns
 * the Coverage tab exists to show were structurally incapable of reporting a problem. Measured on
 * production 2026-09-05: of 134 snapshots (2026-06-10 to 2026-09-04, 21 distributors) not one has
 * ever carried a non-zero drift or unmapped-product value — while 20 of them recorded FEWER
 * importable rows than total rows, 5,005 rows in all. The one screen built to answer "whose
 * mapping is rotting" gave a clean bill of health to every upload that dropped rows.
 *
 * Required, not optional-with-a-default, because a default is what the bug looked like: a caller
 * that forgets must fail to compile rather than quietly write another zero.
 *
 * Both are defined exactly as buildImportPreviewDiff defines them (see import-preview.ts), so the
 * two writers of this table cannot drift apart:
 *   - drift counts a customer whose resolved brick DIFFERS from a brick already stored for it.
 *     A customer with no stored brick yet is a new mapping, not drift.
 *   - unmapped products are the distinct product labels the sheet could not resolve.
 */
export async function saveBrickCoverageSnapshot(input: {
  batchId: string;
  /** Distinct customers whose resolved brick disagrees with the brick already stored for them. */
  brickDriftCount: number;
  coverage: BrickCoverage;
  details?: NewCustomerDetail[];
  distributorCode: string;
  period: string | null;
  totalRows: number;
  /** Distinct product labels this sheet could not map. Sampled for storage, counted in full. */
  unmappedProducts: readonly string[];
  /** Full distinct count, which can exceed the sampled list above. */
  unmappedProductsCount: number;
}): Promise<void> {
  const { coverage } = input;
  if (coverage.coveragePct < BRICK_COVERAGE_WARN_PCT) {
    logError("SoS import landed below the brick-coverage threshold", {
      labels: {
        event: "sos_import_low_brick_coverage",
        batchId: input.batchId,
        distributorCode: input.distributorCode,
        coveragePct: String(coverage.coveragePct),
        rowsMissingBrick: String(coverage.rowsNeedingBrick - coverage.rowsWithBrick),
        unitsMissingBrick: String(coverage.unitsNeedingBrick - coverage.unitsWithBrick),
      },
    });
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("sos_import_coverage_snapshots").insert({
    batch_id: input.batchId,
    brick_drift_count: input.brickDriftCount,
    distinct_customers: coverage.customersNeedingBrick,
    distributor_code: input.distributorCode,
    importable_rows: coverage.rowsWithBrick,
    // NOT `coverage.unitsWithBrick`. This column is EGP — the other writer of this table fills it
    // from `diff.importableValue` — and brick coverage never measures money. Storing units here put
    // a unit COUNT in a money column for 100 of the 134 live snapshots, and the Coverage tab then
    // averaged the two together. Null is the truthful answer: this writer did not measure it.
    importable_value: null,
    mapped_customers: coverage.customersWithBrick,
    new_customer_codes: coverage.unmappedCustomerCodes.slice(0, MAX_SNAPSHOT_DETAILS),
    new_customer_details: (input.details ?? []).slice(0, MAX_SNAPSHOT_DETAILS) || null,
    // NOT `customersNeedingBrick - customersWithBrick`. That is the BRICK-LESS count, which is a
    // different question from "customers we had never seen before" and is already recoverable from
    // distinct_customers - mapped_customers, both stored above. Writing it here made the tab's
    // "New customers" column mean one thing for one writer and another for the other.
    new_customers: null,
    period: input.period ?? null,
    resolved_pct: coverage.coveragePct,
    total_rows: input.totalRows,
    unmapped_products: input.unmappedProducts.slice(0, MAX_SNAPSHOT_DETAILS),
    unmapped_products_count: input.unmappedProductsCount,
  });
  if (error) {
    logError("Failed to save SoS brick-coverage snapshot", {
      labels: { event: "sos_coverage_snapshot_save_failed", batchId: input.batchId, distributorCode: input.distributorCode },
      error,
    });
  }
}

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
    logError("Failed to save SoS import coverage snapshot", {
      labels: { event: "sos_coverage_snapshot_save_failed", batchId: input.batchId, distributorCode: input.distributorCode },
      error,
    });
  }
}

/**
 * Snapshots whose batch still exists, newest first.
 *
 * `sos_import_coverage_snapshots.batch_id` is TEXT while `source_of_sales_import_batches.id` is
 * UUID, so no foreign key could ever have been declared and deleting a batch cascades to nothing.
 * The orphans it leaves behind are indistinguishable from real imports: 42 of the 134 live
 * snapshots (31%) point at a batch that is gone, and every one of them was being counted as a
 * tracked import and averaged into the resolved-percentage headline.
 */
async function listCoverageSnapshots(opts?: { limit?: number }): Promise<CoverageSnapshot[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sos_import_coverage_snapshots")
    .select("*")
    .order("committed_at", { ascending: false })
    .limit(opts?.limit ?? 500);
  if (error) throw error;
  const rows = (data ?? []).map((row) => mapSnapshot(row as Record<string, unknown>));
  const live = await liveBatchIds(rows.map((r) => r.batchId));
  return rows.filter((r) => live.has(r.batchId));
}

/**
 * Which of these batch ids still exist. Chunked: a PostgREST `.in()` carrying several hundred ids
 * returns ZERO rows and no error, which here would empty the whole Coverage tab rather than fail.
 */
async function liveBatchIds(batchIds: readonly string[]): Promise<Set<string>> {
  const distinct = [...new Set(batchIds.filter(Boolean))];
  const live = new Set<string>();
  const supabase = getSupabaseAdmin();
  for (let i = 0; i < distinct.length; i += BATCH_ID_CHUNK) {
    const chunk = distinct.slice(i, i + BATCH_ID_CHUNK);
    const { data, error } = await supabase.from("source_of_sales_import_batches").select("id").in("id", chunk);
    if (error) {
      // Fail OPEN rather than blanking the tab: an unreadable batch table must not make every
      // snapshot look orphaned. Better a stale count than an empty screen that reads as "no imports".
      logError("Coverage tab could not verify which import batches still exist", {
        labels: { event: "sos_coverage_batch_check_failed", chunkSize: String(chunk.length) },
        error,
      });
      distinct.forEach((id) => live.add(id));
      return live;
    }
    for (const row of (data ?? []) as { id: unknown }[]) live.add(String(row.id));
  }
  return live;
}

const BATCH_ID_CHUNK = 50;

/** How many recent snapshots the Coverage tab reads. Everything it shows is built from these. */
export const SNAPSHOT_WINDOW = 500;

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
  // Keyset-paged: a customer left unmapped across many imports holds many rows, and one read would
  // stop at a fixed count with no error. Best-effort as before: a failed read leaves the names blank.
  let data: Record<string, unknown>[];
  try {
    data = await fetchAllRowsKeyset<Record<string, unknown>>(
      () =>
        supabase
          .from("source_of_sales_import_rows")
          .select("id,distributor_code,client_code,client_name,client_address")
          .in("client_code", codes)
          .not("client_name", "is", null),
      { cursorColumn: "id", cursorOf: (row) => row.id as number | string | null | undefined },
    );
  } catch {
    return items;
  }

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
  const snapshots = await listCoverageSnapshots({ limit: SNAPSHOT_WINDOW });

  if (snapshots.length === 0) {
    return { avgResolvedPct: 0, byDistributor: [], driftAlerts: [], persistentUnmapped: [], snapshotWindow: 0, totalImports: 0 };
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

  // totalImports is what this tab actually knows about: live snapshots inside the window it read.
  // snapshotWindow is the cap, so the caller can tell a complete picture from a truncated one —
  // when the two are equal there are older snapshots the worklist below could not see.
  return { avgResolvedPct, byDistributor, driftAlerts, persistentUnmapped, snapshotWindow: SNAPSHOT_WINDOW, totalImports: snapshots.length };
}

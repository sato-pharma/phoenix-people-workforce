/**
 * In-process cache of the RAW weekly fact rows `loadWeeklyDashboard` pages out of
 * `weekly_sales_rows` — the rows as stored, before live re-pricing and de-cumulation.
 *
 * WHY (2026-10-04 performance review, PERF-002): every weekly page view re-paged the whole validated
 * history — ~35k rows over ~35 round trips — although the rows only change when an upload, delete,
 * retag or alias heal writes them. The figures on screen depend on the whole history (the unfiltered
 * view sums it, the trend and week comparison span every month), so reading FEWER rows would change
 * the numbers; this stops reading the SAME rows again instead.
 *
 * What keeps it correct:
 *   • The key carries the exact batch ids and distributor narrowing of the read, plus each batch's
 *     week/month/distributor stamp — a new, deleted, retagged or re-inserted batch is a new key.
 *   • A generation counter, bumped by every app write path (upload, delete, retag, heal). A heal
 *     rewrites rows inside the SAME batches, which the key alone cannot see.
 *   • A 60 s lifetime as the backstop for writes the app never sees (the direct-order trigger, direct
 *     SQL) — the same window the vacation report rows already use.
 *   • Re-pricing from the Product Master stays per call in the service, so a price edit still shows
 *     at once; and every read hands back COPIES, because that re-pricing mutates `salesValue` in place.
 *
 * One Railway replica, so an in-process cache is coherent. Bounded: a few entries and a total row
 * budget; a read larger than the whole budget is served but not stored.
 */

import { invalidateWeeklyStockCache } from "@/lib/dashboard/invalidation";

export const WEEKLY_ROW_CACHE_TTL_MS = 60_000;
export const WEEKLY_ROW_CACHE_MAX_ENTRIES = 4;
// Measured 2026-10-04 on production data: the full validated history is 52,895 rows and holds 30.9 MB
// of heap once cached (~600 bytes a row). Most views share that ONE entry — the key never includes
// the viewer — so the budget is set across all entries, ~70 MB at most, with headroom for growth.
export const WEEKLY_ROW_CACHE_MAX_ROWS_TOTAL = 120_000;

type CacheEntry<Row> = { rows: Row[]; pages: number; storedAt: number; generation: number };

const entries = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<{ rows: unknown[]; pages: number; source: object }>>();
let generation = 0;

/** Called by every app path that writes weekly rows or batches. */
export function bumpWeeklyRowsGeneration(reason: string): void {
  generation += 1;
  entries.clear();
  // The remembered Weekly Stock payloads (stock-dashboard-service.ts) are built from these rows, so the
  // same writes drop them (2 Nov 2026). Best-effort, as every tag bust is.
  invalidateWeeklyStockCache(reason);
}

export function weeklyRowCacheKey(input: {
  batches: ReadonlyArray<{ id: unknown; week_start?: unknown; cycle_month?: unknown; distributor_code?: unknown }>;
  batchIds: readonly string[];
  distributorCodes: readonly string[] | null;
}): string {
  const wanted = new Set(input.batchIds);
  const stamps = input.batches
    .filter((batch) => wanted.has(String(batch.id)))
    .map((batch) =>
      [String(batch.id), String(batch.week_start ?? ""), String(batch.cycle_month ?? ""), String(batch.distributor_code ?? "")].join("|"),
    )
    .sort();
  const distributors = input.distributorCodes ? [...input.distributorCodes].sort().join(",") : "*";
  return `${stamps.join(";")}#${distributors}`;
}

export type WeeklyRowCacheResult<Row> = {
  rows: Row[];
  pages: number;
  cache: "hit" | "miss";
  /**
   * Which load these rows are copies of — the same object for every read of one cache entry, a new one
   * whenever the entry is replaced. derived-rows.ts keys its once-per-load work on it. Never handed out.
   */
  source: object;
};

/**
 * Serve the rows for `key` from memory when fresh, else run `load` once — concurrent callers with the
 * same key share that one load. Rows are always returned as fresh shallow copies.
 */
export async function getOrLoadWeeklyRows<Row extends object>(
  key: string,
  load: () => Promise<{ rows: Row[]; pages: number }>,
  now: () => number = Date.now,
): Promise<WeeklyRowCacheResult<Row>> {
  const fullKey = `${generation}::${key}`;
  const cached = entries.get(fullKey) as CacheEntry<Row> | undefined;
  if (cached && cached.generation === generation && now() - cached.storedAt < WEEKLY_ROW_CACHE_TTL_MS) {
    // Re-insert so the Map's order stays least-recently-used first.
    entries.delete(fullKey);
    entries.set(fullKey, cached);
    return { rows: copyRows(cached.rows), pages: 0, cache: "hit", source: cached.rows };
  }
  if (cached) entries.delete(fullKey);

  let pending = inFlight.get(fullKey) as Promise<{ rows: Row[]; pages: number; source: object }> | undefined;
  if (!pending) {
    const startedGeneration = generation;
    pending = load().then((result) => {
      // A write that landed while this load ran may not be in these rows — serve them, never keep them.
      if (startedGeneration === generation && result.rows.length <= WEEKLY_ROW_CACHE_MAX_ROWS_TOTAL) {
        const stored = copyRows(result.rows);
        entries.set(fullKey, { rows: stored, pages: result.pages, storedAt: now(), generation });
        // Least-recently-used first, until both the entry count and the row budget fit.
        while (entries.size > WEEKLY_ROW_CACHE_MAX_ENTRIES || cachedRowCount() > WEEKLY_ROW_CACHE_MAX_ROWS_TOTAL) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          entries.delete(oldest);
        }
        // The stored copy is the entry later hits read, so it is the source every reader of this entry shares.
        return { ...result, source: stored };
      }
      return { ...result, source: result.rows };
    });
    inFlight.set(fullKey, pending as Promise<{ rows: unknown[]; pages: number; source: object }>);
    pending.then(
      () => inFlight.delete(fullKey),
      () => inFlight.delete(fullKey),
    );
  }
  const result = await pending;
  return { rows: copyRows(result.rows), pages: result.pages, cache: "miss", source: result.source };
}

function cachedRowCount(): number {
  let total = 0;
  for (const entry of entries.values()) total += entry.rows.length;
  return total;
}

function copyRows<Row extends object>(rows: readonly Row[]): Row[] {
  return rows.map((row) => ({ ...row }));
}

/** Test-only: empty the cache and the in-flight table. */
export function _resetWeeklyRowCache(): void {
  entries.clear();
  inFlight.clear();
  generation = 0;
}

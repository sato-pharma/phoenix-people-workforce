// The vacation report's base rows, packed for the cross-request data cache (PERF-018).
//
// A copy of the precedent in src/lib/sales/vs-target.ts (packAchievementRows /
// unpackAchievementRows), kept in its own dependency-free module so a test can exercise it without
// loading service.ts's whole graph — the same reason ./report-filter is separate.
//
// WHY. Next refuses any data-cache entry over 2MB: in dev the throw lands on a promise Next never
// awaits and kills the dev server; in production it only warns and SKIPS the write, so the cache
// silently stops existing. The unscoped base read is every vacation request ever filed — 643 rows,
// 1.58MB of JSON on production when this was written, growing ~275KB a month — so it would have
// crossed the limit around November with nothing saying so, and ~8 surfaces would have gone back
// to a database read on every page load. ~600 repetitions of the same columns are exactly what gzip
// is best at, so the packed entry is a small fraction of that.

import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

/** Strictly under Next's hard 2MB limit, with margin for the cache's own JSON envelope. */
export const VACATION_ROWS_CACHE_MAX_BYTES = 1_500_000;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Rows -> a base64 gzip payload, or null when even compressed it would not fit.
 *
 * The null return is the load-bearing part: it is the one thing that guarantees an oversize entry
 * is never handed to the data cache. The caller then reads the rows live.
 *
 * base64 because the entry is stored through JSON.stringify and the base64 alphabet needs no
 * escaping, so the size checked here is the size Next measures. Async (not gzipSync) so the deflate
 * runs on libuv's threadpool instead of blocking the event loop.
 *
 * The rows already round-trip through JSON inside the cache today, so a JSON round trip here hands
 * callers exactly the values they received before.
 */
export async function packVacationReportRows<T>(rows: T[]): Promise<string | null> {
  const packed = (await gzipAsync(JSON.stringify(rows))).toString("base64");
  return packed.length > VACATION_ROWS_CACHE_MAX_BYTES ? null : packed;
}

/** The exact inverse of packVacationReportRows. */
export async function unpackVacationReportRows<T>(packed: string): Promise<T[]> {
  const json = (await gunzipAsync(Buffer.from(packed, "base64"))).toString("utf8");
  return JSON.parse(json) as T[];
}

// The hour's page timings, kept in process and handed to the page_timings table once the hour has ended.
//
// What is kept per (hour, page shape, kind, device class, metric): a count, the worst value, and up to
// MAX_SAMPLES_PER_KEY samples for the median and the 90th percentile. A sample past the cap is dropped
// but still COUNTED and still raises the maximum, so a hot page cannot grow this between flushes. An
// hour older than PAGE_TIMING_MAX_HOURS_HELD is dropped unwritten: a database that refuses the flush
// for two days must not turn into a leak in the web process.
//
// Held on globalThis for the reason timings.ts gives: the beacon route and the process-health reporter
// are bundled apart, and a module-level map gave each its own copy. No node: imports and no I/O — the
// route handler records into it; page-timing-flush.ts does the write.

import type {
  PageTimingDevice,
  PageTimingKind,
  PageTimingMetric,
  PageTimingReport,
} from "@/lib/observability/page-timing-intake";

const MAX_SAMPLES_PER_KEY = 2_000;
export const PAGE_TIMING_MAX_HOURS_HELD = 48;

type Bucket = { count: number; max: number; samples: number[] };
type HourBuckets = Map<string, Bucket>;
type Store = Map<string, HourBuckets>;

/** One row of page_timings, as the recording RPC takes it. */
export type PageTimingRow = {
  count: number;
  device: PageTimingDevice;
  hour: string;
  kind: PageTimingKind;
  max_ms: number;
  metric: PageTimingMetric;
  p50_ms: number;
  p90_ms: number;
  path: string;
};

const STORE_KEY = Symbol.for("phoenix.page-timings");

function store(): Store {
  const holder = globalThis as unknown as Record<symbol, Store | undefined>;
  const existing = holder[STORE_KEY];
  if (existing) return existing;
  const created: Store = new Map();
  holder[STORE_KEY] = created;
  return created;
}

/** The UTC hour that holds `at`, as the ISO text the table's `hour` column takes. */
export function pageTimingHour(at: Date): string {
  const hour = new Date(at.getTime());
  hour.setUTCMinutes(0, 0, 0);
  return hour.toISOString();
}

const KEY_SEPARATOR = "\u0001";

function keyOf(path: string, kind: PageTimingKind, device: PageTimingDevice, metric: PageTimingMetric): string {
  return [path, kind, device, metric].join(KEY_SEPARATOR);
}

function dropOldHours(hours: Store, at: Date): void {
  const floor = at.getTime() - PAGE_TIMING_MAX_HOURS_HELD * 3_600_000;
  for (const hour of [...hours.keys()]) {
    if (Date.parse(hour) < floor) hours.delete(hour);
  }
}

export function recordPageTiming(report: PageTimingReport, at: Date = new Date()): void {
  const hour = pageTimingHour(at);
  const hours = store();
  let buckets = hours.get(hour);
  if (!buckets) {
    buckets = new Map();
    hours.set(hour, buckets);
    dropOldHours(hours, at);
  }
  for (const [metric, ms] of Object.entries(report.metrics) as [PageTimingMetric, number][]) {
    if (!Number.isFinite(ms) || ms < 0) continue;
    const key = keyOf(report.path, report.kind, report.device, metric);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { count: 0, max: 0, samples: [] };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (ms > bucket.max) bucket.max = ms;
    if (bucket.samples.length < MAX_SAMPLES_PER_KEY) bucket.samples.push(ms);
  }
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1]!;
}

/**
 * The rows of every hour that has ENDED by `at`; the hour in progress stays in memory. Nothing is
 * removed here — forgetPageTimingHours does that once the database has taken the rows.
 */
export function pageTimingRowsBefore(at: Date = new Date()): PageTimingRow[] {
  const current = pageTimingHour(at);
  const rows: PageTimingRow[] = [];
  for (const [hour, buckets] of store()) {
    // ISO texts of one format order chronologically.
    if (hour >= current) continue;
    for (const [key, bucket] of buckets) {
      const [path, kind, device, metric] = key.split(KEY_SEPARATOR) as [string, PageTimingKind, PageTimingDevice, PageTimingMetric];
      const sorted = [...bucket.samples].sort((a, b) => a - b);
      rows.push({
        count: bucket.count,
        device,
        hour,
        kind,
        max_ms: Math.round(bucket.max),
        metric,
        p50_ms: Math.round(percentile(sorted, 0.5)),
        p90_ms: Math.round(percentile(sorted, 0.9)),
        path,
      });
    }
  }
  return rows;
}

export function forgetPageTimingHours(hours: Iterable<string>): void {
  const held = store();
  for (const hour of hours) held.delete(hour);
}

/** How many hours are waiting in memory, the one in progress included. */
export function pageTimingHoursHeld(): number {
  return store().size;
}

/** For tests only. */
export function resetPageTimingStore(): void {
  store().clear();
}

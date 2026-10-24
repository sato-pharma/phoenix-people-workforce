// In-process latency samples, summarised once a minute into the process-health log line.
//
// No node: imports and no I/O — route handlers record into this, so it must load in any runtime,
// and recording must cost a Map lookup and an array push, nothing that can stall a request.
//
// Bounded per name: beyond MAX_SAMPLES_PER_WINDOW the sample is dropped but still COUNTED, and
// still raises `max`. A hot route therefore cannot grow this without limit between drains, and
// the line still says how many requests there really were and the worst one seen.
//
// Held on `globalThis`: Next bundles the route handlers and instrumentation.ts (which drains this into
// the process-health line) separately, and a plain module-level Map gave each bundle its own copy. On
// 24 Oct 2026 every process_health line in a 15-minute window carried `"timings":{}` while the timed
// CRM routes served dozens of requests. One store per process is the only copy that can be drained.

const MAX_SAMPLES_PER_WINDOW = 2_000;

type Bucket = { count: number; max: number; samples: number[] };

export type TimingSummary = { count: number; max: number; p50: number; p95: number };

const STORE_KEY = Symbol.for("phoenix.timings");

function store(): Map<string, Bucket> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Bucket> | undefined>;
  const existing = holder[STORE_KEY];
  if (existing) return existing;
  const created = new Map<string, Bucket>();
  holder[STORE_KEY] = created;
  return created;
}

export function recordTiming(name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const buckets = store();
  let bucket = buckets.get(name);
  if (!bucket) {
    bucket = { count: 0, max: 0, samples: [] };
    buckets.set(name, bucket);
  }
  bucket.count += 1;
  if (ms > bucket.max) bucket.max = ms;
  if (bucket.samples.length < MAX_SAMPLES_PER_WINDOW) bucket.samples.push(ms);
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1]!;
}

/** Every name's summary since the last drain, in whole milliseconds — and starts a new window. */
export function drainTimings(): Record<string, TimingSummary> {
  const out: Record<string, TimingSummary> = {};
  const buckets = store();
  for (const [name, bucket] of buckets) {
    const sorted = [...bucket.samples].sort((a, b) => a - b);
    out[name] = {
      count: bucket.count,
      max: Math.round(bucket.max),
      p50: Math.round(percentile(sorted, 0.5)),
      p95: Math.round(percentile(sorted, 0.95)),
    };
  }
  buckets.clear();
  return out;
}

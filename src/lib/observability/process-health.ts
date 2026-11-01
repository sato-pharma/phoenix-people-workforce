// One structured line a minute about the server process itself: event-loop delay, heap against
// its limit, RSS, uptime, and the latency summaries recorded through timings.ts.
//
// Railway shows CPU and memory for the container, but not whether the event loop is stalling or
// how close the heap is to its ceiling — the two numbers that explain "everything got slow at
// once". `railway logs | grep process_health` reads the history back.
//
// Since 2026-10-16 the line also names the process ROLE (web, worker or all — src/lib/platform/
// process-role.ts) and the background JOBS that ran during the minute (running-jobs.ts), and a minute
// whose worst stall passes EVENT_LOOP_STALL_ALERT_MS on a process that answers pages raises an
// `event_loop_stall` warning and a Sentry issue. That day three 4.3-second freezes were found only by
// reading the log lines around each one; the next freeze names its own culprit and reaches Telegram.
//
// Since 2026-10-23 the line also carries the garbage collections of its minute (`gc`, `gcTotalMs`,
// `gcLongest`), and a stall warning says whether a collection was long enough to BE the freeze
// (`gcExplainsStall`). The web process froze 1-11 s dozens of times a day with nothing running, memory
// and CPU nowhere near their limits, and a major V8 collection was the leading, unproven suspect:
// `railway logs | grep event_loop_stall` now settles it line by line. The observer is created and
// drained inside THIS module. `timings` and `jobs` are recorded from other chunks, which left both empty
// until 24 Oct 2026; their stores now live on `globalThis`, so every chunk records into the one drained here.
//
// Started once from instrumentation.ts, production only: a dev server or a test run has no use
// for a line every minute, and the timer is unref'd so it never holds a process open.

import { PerformanceObserver, constants as perfConstants, monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

import { logInfo, logWarning } from "@/lib/observability/log";
import { drainJobWindow } from "@/lib/observability/running-jobs";
import { sentryServerStatus } from "@/lib/observability/sentry-policy";
import { drainTimings } from "@/lib/observability/timings";
import { resolveProcessRole, type ProcessRole } from "@/lib/platform/process-role";

const REPORT_INTERVAL_MS = 60_000;

/** A page server that stalls this long has made every request in flight wait a noticeable second. */
export const EVENT_LOOP_STALL_ALERT_MS = 1_000;

/** One Sentry event per culprit per this window; the issue already exists after the first. */
export const STALL_SENTRY_REPEAT_AFTER_MS = 30 * 60_000;

type HistogramLike = { max: number; percentile(percentile: number): number };

function nsToMs(ns: number): number {
  // An empty window reports NaN/0 depending on the field; either way it is "no delay measured".
  return Number.isFinite(ns) && ns > 0 ? Math.round(ns / 1e5) / 10 : 0;
}

/** The histogram reports NANOSECONDS; the line reports milliseconds to one decimal. */
export function summarizeEventLoopDelay(histogram: HistogramLike): { max: number; p50: number; p99: number } {
  return {
    max: nsToMs(histogram.max),
    p50: nsToMs(histogram.percentile(50)),
    p99: nsToMs(histogram.percentile(99)),
  };
}

export type StallAlert = { fingerprint: string[]; message: string };

/**
 * Should this minute raise a freeze alert, and what does it say? Pure. Null under the line, and null on the
 * WORKER: its stalls make no page wait, which is the whole reason it exists. The message carries no figure
 * but the stall and no name but the jobs', so nothing personal leaves.
 */
export function stallAlertFor(input: { jobs: string[]; maxMs: number; role: ProcessRole }): StallAlert | null {
  if (input.role === "worker") return null;
  if (!(input.maxMs >= EVENT_LOOP_STALL_ALERT_MS)) return null;
  const seconds = (Math.round(input.maxMs / 100) / 10).toFixed(1);
  const culprit = input.jobs.length ? input.jobs.join(" + ") : "no background job";
  return {
    fingerprint: ["event-loop-stall", input.role, culprit],
    message: `Server froze for ${seconds} s (${input.role} process) while ${culprit} ran`,
  };
}

function toMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

// ── Garbage collection ──────────────────────────────────────────────────────────────────────────
// V8 reports each collection to a `gc` PerformanceObserver. `major` (mark-sweep-compact) is the kind that
// can pause a big heap for seconds; `minor` (scavenge) is the frequent, short one; `incremental` and `weakcb`
// are the finishing steps. Anything else a future Node adds lands in `other` rather than being dropped.

/**
 * V8's `kGCTypeMinorMarkSweep` (1 << 1), the young-generation collector Node 24 can use instead of the scavenger.
 * `perf_hooks.constants` does not export it (Node 24.15 lists major, minor, incremental and weakcb only), so
 * without this number such a collection would read as `other`.
 */
const V8_GC_MINOR_MARK_SWEEP = 2;

export type GcKind = "incremental" | "major" | "minor" | "other" | "weakcb";
export type GcKindSummary = { count: number; maxMs: number; totalMs: number };
export type GcWindow = Map<GcKind, GcKindSummary>;
export type GcEntryLike = { detail?: unknown; duration: number; kind?: number };
export type GcSummary = {
  byKind: Partial<Record<GcKind, GcKindSummary>>;
  longest: { kind: GcKind; ms: number } | null;
  totalMs: number;
};

/** Node 16+ puts the kind in `entry.detail.kind`; older releases had it on `entry.kind`. */
export function gcKindOf(entry: GcEntryLike): GcKind {
  const detail = entry.detail as { kind?: unknown } | null | undefined;
  const kind = typeof detail?.kind === "number" ? detail.kind : entry.kind;
  if (typeof kind !== "number") return "other";
  if (kind === perfConstants.NODE_PERFORMANCE_GC_MAJOR) return "major";
  if (kind === perfConstants.NODE_PERFORMANCE_GC_MINOR || kind === V8_GC_MINOR_MARK_SWEEP) return "minor";
  if (kind === perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL) return "incremental";
  if (kind === perfConstants.NODE_PERFORMANCE_GC_WEAKCB) return "weakcb";
  return "other";
}

export function createGcWindow(): GcWindow {
  return new Map();
}

/** Add one collection to the window. A non-finite or negative duration is not a measurement and is ignored. */
export function recordGc(window: GcWindow, kind: GcKind, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const current = window.get(kind) ?? { count: 0, maxMs: 0, totalMs: 0 };
  current.count += 1;
  current.totalMs += durationMs;
  if (durationMs > current.maxMs) current.maxMs = durationMs;
  window.set(kind, current);
}

function tenthsOfMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/** Read the window as the line reports it (milliseconds to one decimal) and start the next one empty. */
export function drainGcWindow(window: GcWindow): GcSummary {
  const byKind: GcSummary["byKind"] = {};
  let totalMs = 0;
  let longest: GcSummary["longest"] = null;
  for (const [kind, summary] of window) {
    byKind[kind] = { count: summary.count, maxMs: tenthsOfMs(summary.maxMs), totalMs: tenthsOfMs(summary.totalMs) };
    totalMs += summary.totalMs;
    if (!longest || summary.maxMs > longest.ms) longest = { kind, ms: summary.maxMs };
  }
  window.clear();
  return { byKind, longest: longest ? { kind: longest.kind, ms: tenthsOfMs(longest.ms) } : null, totalMs: tenthsOfMs(totalMs) };
}

/**
 * Was one collection long enough to be the freeze? True when the longest single collection of the minute
 * covers at least half the minute's worst event-loop stall — the V8 pause and the loop delay are measured by
 * different clocks, so equality would be a coincidence; "at least half" is the honest reading of "that was it".
 */
export function gcExplainsStall(longest: GcSummary["longest"], stallMs: number): boolean {
  if (!longest || !(stallMs > 0)) return false;
  return longest.ms >= stallMs / 2;
}

const lastSentryAt = new Map<string, number>();

async function reportStallToSentry(alert: StallAlert): Promise<void> {
  try {
    if (!sentryServerStatus({ appEnv: process.env.APP_ENV, dsn: process.env.SENTRY_DSN }).enabled) return;
    const key = alert.fingerprint.join("|");
    const now = Date.now();
    const last = lastSentryAt.get(key);
    if (last != null && now - last < STALL_SENTRY_REPEAT_AFTER_MS) return;
    lastSentryAt.set(key, now);
    const { captureStallInSentry } = await import("@/lib/observability/sentry-server");
    captureStallInSentry(alert.message, alert.fingerprint);
  } catch {
    // Telemetry must never become a second incident.
  }
}

let started = false;

export function startProcessHealthReporter(): void {
  if (started) return;
  if (process.env.NODE_ENV !== "production") return;
  started = true;

  const role = resolveProcessRole(process.env.PHOENIX_PROCESS_ROLE);
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let lastStallAtMs: number | null = null;

  // The collections of the current minute, observed and drained in this module instance.
  const gcWindow = createGcWindow();
  let gcObserver: PerformanceObserver | null = null;
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recordGc(gcWindow, gcKindOf(entry as unknown as GcEntryLike), entry.duration);
    });
    gcObserver.observe({ entryTypes: ["gc"] });
  } catch (error) {
    gcObserver = null;
    // A runtime without the `gc` entry type must cost the line its GC figures, never the line itself.
    logWarning("gc observer unavailable", { error, labels: { event: "process_health_gc_unavailable" } });
  }

  const timer = setInterval(() => {
    // A throw inside a timer callback is an uncaught exception, which ends the process. Telemetry
    // must never be the thing that takes the server down.
    try {
      const memory = process.memoryUsage();
      const eventLoopDelayMs = summarizeEventLoopDelay(histogram);
      const jobs = drainJobWindow();
      // The observer delivers on a later turn of the loop. A freeze that ends in the same turn this timer fires
      // would otherwise leave the very collection that caused it queued for NEXT minute's line.
      for (const entry of gcObserver?.takeRecords() ?? []) {
        recordGc(gcWindow, gcKindOf(entry as unknown as GcEntryLike), entry.duration);
      }
      const gc = drainGcWindow(gcWindow);
      logInfo("process health", {
        labels: { event: "process_health" },
        context: {
          eventLoopDelayMs,
          gc: gc.byKind,
          gcLongest: gc.longest,
          gcTotalMs: gc.totalMs,
          heapLimitMb: toMb(getHeapStatistics().heap_size_limit),
          heapUsedMb: toMb(memory.heapUsed),
          jobs,
          role,
          rssMb: toMb(memory.rss),
          timings: drainTimings(),
          uptimeS: Math.round(process.uptime()),
        },
      });
      const alert = stallAlertFor({ jobs, maxMs: eventLoopDelayMs.max, role });
      if (alert) {
        // The 2026-10-17 freezes with no job running recurred every exactly 65:00. Seconds since the previous stall and
        // since boot say whether a timer of this process owns that period, or the container is being restarted around it.
        const nowMs = Date.now();
        const sinceLastStallS = lastStallAtMs == null ? null : Math.round((nowMs - lastStallAtMs) / 1000);
        lastStallAtMs = nowMs;
        logWarning(alert.message, {
          labels: { event: "event_loop_stall" },
          context: {
            gcExplainsStall: gcExplainsStall(gc.longest, eventLoopDelayMs.max),
            gcLongest: gc.longest,
            gcTotalMs: gc.totalMs,
            heapUsedMb: toMb(memory.heapUsed),
            jobs,
            role,
            rssMb: toMb(memory.rss),
            sinceLastStallS,
            stallMs: eventLoopDelayMs.max,
            uptimeS: Math.round(process.uptime()),
          },
        });
        void reportStallToSentry(alert);
      }
      // The ended hours' page timings go to the page_timings table — one RPC per web process once an
      // hour (page-timing-flush.ts). A dynamic import keeps the Supabase client out of this module's own
      // graph; a refused write is logged there and tried again on the next tick.
      void import("@/lib/observability/page-timing-flush")
        .then((flush) => flush.flushPageTimings())
        .catch((error) => logWarning("page timings flush failed", { error, labels: { event: "page_timings_flush_failed" } }));
    } catch (error) {
      logWarning("process health report failed", { error, labels: { event: "process_health_failed" } });
    } finally {
      histogram.reset();
    }
  }, REPORT_INTERVAL_MS);
  // Inline rather than live-poller's unrefTimer: importing that would load the whole CRM poller graph
  // into a module whose only job is one log line a minute.
  (timer as unknown as { unref?: () => void }).unref?.();
}

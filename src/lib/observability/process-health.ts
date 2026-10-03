// One structured line a minute about the server process itself: event-loop delay, heap against
// its limit, RSS, uptime, and the latency summaries recorded through timings.ts.
//
// Railway shows CPU and memory for the container, but not whether the event loop is stalling or
// how close the heap is to its ceiling — the two numbers that explain "everything got slow at
// once". `railway logs | grep process_health` reads the history back.
//
// Started once from instrumentation.ts, production only: a dev server or a test run has no use
// for a line every minute, and the timer is unref'd so it never holds a process open.

import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

import { logInfo, logWarning } from "@/lib/observability/log";
import { drainTimings } from "@/lib/observability/timings";

const REPORT_INTERVAL_MS = 60_000;

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

function toMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

let started = false;

export function startProcessHealthReporter(): void {
  if (started) return;
  if (process.env.NODE_ENV !== "production") return;
  started = true;

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const timer = setInterval(() => {
    // A throw inside a timer callback is an uncaught exception, which ends the process. Telemetry
    // must never be the thing that takes the server down.
    try {
      const memory = process.memoryUsage();
      logInfo("process health", {
        labels: { event: "process_health" },
        context: {
          eventLoopDelayMs: summarizeEventLoopDelay(histogram),
          heapLimitMb: toMb(getHeapStatistics().heap_size_limit),
          heapUsedMb: toMb(memory.heapUsed),
          rssMb: toMb(memory.rss),
          timings: drainTimings(),
          uptimeS: Math.round(process.uptime()),
        },
      });
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

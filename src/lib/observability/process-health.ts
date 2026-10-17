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
// Started once from instrumentation.ts, production only: a dev server or a test run has no use
// for a line every minute, and the timer is unref'd so it never holds a process open.

import { monitorEventLoopDelay } from "node:perf_hooks";
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

  const timer = setInterval(() => {
    // A throw inside a timer callback is an uncaught exception, which ends the process. Telemetry
    // must never be the thing that takes the server down.
    try {
      const memory = process.memoryUsage();
      const eventLoopDelayMs = summarizeEventLoopDelay(histogram);
      const jobs = drainJobWindow();
      logInfo("process health", {
        labels: { event: "process_health" },
        context: {
          eventLoopDelayMs,
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

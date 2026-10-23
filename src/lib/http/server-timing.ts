// A `Server-Timing` header built from DURATIONS ONLY, so a slow route can be read in the browser's
// network panel and in the per-minute process-health line without a profiler.
//
// WHAT IT NEVER CARRIES: a name, an id, a query, a row count or any text a caller typed. A metric name
// is a fixed lowercase word chosen in code (`^[a-z][a-z0-9_]{0,31}$`) and everything else is dropped,
// because this header is visible to the browser and to any proxy in between.
//
// Each stage is also recorded under `route_<label>_<stage>` in observability/timings.ts, which the
// process-health line drains once a minute (p50 / p95 / max). No I/O, no node: imports.

import { recordTiming } from "@/lib/observability/timings";

const METRIC_NAME = /^[a-z][a-z0-9_]{0,31}$/;

export type ServerTimingEntry = { name: string; ms: number };

/** The header value for the entries that are valid, or null when none are. Milliseconds to one decimal. */
export function formatServerTiming(entries: readonly ServerTimingEntry[]): string | null {
  const parts: string[] = [];
  for (const entry of entries) {
    if (!METRIC_NAME.test(entry.name)) continue;
    if (!Number.isFinite(entry.ms) || entry.ms < 0) continue;
    parts.push(`${entry.name};dur=${Math.round(entry.ms * 10) / 10}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

export type ServerTimer = {
  /** Runs `work`, records how long it took under `name`, and hands back its result (or its error). */
  measure<T>(name: string, work: () => Promise<T>): Promise<T>;
  /** Records the time since the timer started or the last lap under `name`; for a step that must stay a plain statement. */
  lap(name: string): void;
  /** `{ "Server-Timing": … }` with every stage and a `total`, to spread into a response's headers. */
  headers(): Record<string, string>;
};

/** One timer per request. `label` is the route's short fixed name, e.g. `crm_today`. */
export function startServerTimer(label: string): ServerTimer {
  const startedAt = performance.now();
  const stages: ServerTimingEntry[] = [];
  let lapStart = startedAt;
  return {
    lap(name) {
      const now = performance.now();
      stages.push({ name, ms: now - lapStart });
      recordTiming(`route_${label}_${name}`, now - lapStart);
      lapStart = now;
    },
    async measure(name, work) {
      const stageStart = performance.now();
      try {
        return await work();
      } finally {
        const ms = performance.now() - stageStart;
        stages.push({ name, ms });
        recordTiming(`route_${label}_${name}`, ms);
      }
    },
    headers() {
      const total = performance.now() - startedAt;
      recordTiming(`route_${label}_total`, total);
      const value = formatServerTiming([...stages, { name: "total", ms: total }]);
      const out: Record<string, string> = {};
      if (value) out["Server-Timing"] = value;
      return out;
    },
  };
}

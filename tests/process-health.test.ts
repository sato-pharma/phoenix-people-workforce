import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { summarizeEventLoopDelay } from "../src/lib/observability/process-health.ts";
import { drainTimings, recordTiming } from "../src/lib/observability/timings.ts";
import { stripComments } from "./support/comment-strip.ts";

// The once-a-minute process-health line: its timing maths, its nanosecond conversion, and the
// wiring that keeps it a single unref'd timer started from instrumentation.ts.

function read(path: string) {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

export function runProcessHealthTests() {
  // --- timings: count / p50 / p95 / max, whole milliseconds -----------------------------------
  drainTimings(); // start from an empty window whatever ran before
  for (let ms = 1; ms <= 100; ms += 1) recordTiming("route.a", ms);
  recordTiming("route.b", 1.4);
  recordTiming("route.b", 2.6);
  recordTiming("route.b", Number.NaN);
  recordTiming("route.b", -5);

  const first = drainTimings();
  assert.deepEqual(
    first["route.a"],
    { count: 100, max: 100, p50: 50, p95: 95 },
    "1..100 ms must summarise as count 100, p50 50, p95 95, max 100 (nearest rank)",
  );
  assert.deepEqual(
    first["route.b"],
    { count: 2, max: 3, p50: 1, p95: 3 },
    "fractional samples round to whole ms, and a NaN or negative sample is not counted at all",
  );

  // --- drain starts a new window --------------------------------------------------------------
  assert.deepEqual(drainTimings(), {}, "drainTimings must clear what it returned — the next window starts empty");

  // --- beyond the cap a sample is dropped, but still counted and still raises max -------------
  for (let i = 0; i < 2_000; i += 1) recordTiming("route.hot", 1);
  for (let i = 0; i < 500; i += 1) recordTiming("route.hot", 1_000);
  const capped = drainTimings()["route.hot"];
  assert.equal(capped?.count, 2_500, "a sample over the per-window cap must still be counted");
  assert.equal(capped?.max, 1_000, "a sample over the per-window cap must still raise max");
  assert.equal(capped?.p95, 1, "a sample over the per-window cap must not be kept for the percentiles");

  // --- event-loop delay: nanoseconds in, milliseconds out --------------------------------------
  assert.deepEqual(
    summarizeEventLoopDelay({
      max: 120_000_000,
      percentile: (p: number) => (p === 50 ? 20_500_000 : p === 99 ? 85_000_000 : -1),
    }),
    { max: 120, p50: 20.5, p99: 85 },
    "the histogram reports nanoseconds; the line must report milliseconds",
  );
  assert.deepEqual(
    summarizeEventLoopDelay({ max: 0, percentile: () => Number.NaN }),
    { max: 0, p50: 0, p99: 0 },
    "an empty window reads as zero delay, never NaN in the log line",
  );

  // --- source pins ------------------------------------------------------------------------------
  const health = read("src/lib/observability/process-health.ts");
  const guardAt = health.indexOf("if (started) return;");
  const setAt = health.indexOf("started = true;");
  assert.ok(
    guardAt > 0 && setAt > guardAt,
    "startProcessHealthReporter must refuse a second start (`if (started) return;`) before it marks itself started",
  );
  assert.match(
    health,
    /if \(process\.env\.NODE_ENV !== "production"\) return;/,
    "the reporter must start in production only",
  );
  assert.match(health, /\(timer as unknown as \{ unref\?: \(\) => void \}\)\.unref\?\.\(\);/, "the reporter's interval must be unref'd so it never holds the process open");
  assert.match(health, /histogram\.reset\(\);/, "the histogram must be reset after each report, or every line is the lifetime figure");
  assert.match(health, /event: "process_health"/, "the line must carry labels.event process_health — the key log search uses");

  const instrumentation = read("instrumentation.ts");
  const housekeepingAt = instrumentation.indexOf('await import("@/lib/crm/housekeeping-scheduler")');
  const healthAt = instrumentation.indexOf('await import("@/lib/observability/process-health")');
  assert.ok(
    housekeepingAt > 0 && healthAt > housekeepingAt,
    "instrumentation.ts must import @/lib/observability/process-health dynamically, in its own try AFTER the housekeeping scheduler",
  );
  assert.doesNotMatch(
    instrumentation,
    /^import[^\n]*process-health/m,
    "process-health must never be a static import of instrumentation.ts — that hook is bundled for the edge runtime too",
  );
  // 🔴 The three schedulers and process-health compile ONLY in a production build (2026-10-17): each
  // refuses a non-production build at run time anyway, and under `next dev` they were 465 repo files and
  // 52 MB of compiled code that never ran. Only a BLOCK-form NODE_ENV test prunes the dynamic imports.
  assert.match(
    instrumentation,
    /if \(process\.env\.NODE_ENV === "production"\) \{\s*try \{\s*const \{ startLiveCrmPoller \} = await import\("@\/lib\/crm\/live-poller"\);[\s\S]*?await import\("@\/lib\/early-birds\/close-scheduler"\)[\s\S]*?await import\("@\/lib\/crm\/housekeeping-scheduler"\)[\s\S]*?await import\("@\/lib\/observability\/process-health"\)[\s\S]*?\} else \{\s*console\.log\("\[schedulers\] not started: not a production build/,
    "the schedulers and process-health sit inside one production-build block, so a dev server never compiles them",
  );

  const timings = read("src/lib/observability/timings.ts");
  assert.doesNotMatch(
    timings,
    /node:/,
    "timings.ts must import nothing from node: — route handlers record into it, in whatever runtime they run",
  );

  // The two P1 paths of the 2026-10-04 review report their time, so their fixes can be read in the logs.
  assert.match(
    read("src/lib/approvals-hub/badge-counts-payload.ts"),
    /recordTiming\("badge_counts", Date\.now\(\) - startedAt\)/,
    "the badge poll must record its time into the process_health line",
  );
  assert.match(
    read("src/lib/sales/weekly/service.ts"),
    /recordTiming\("weekly_dashboard_load", Date\.now\(\) - loadStartedAt\)/,
    "the weekly dashboard load must record its time into the process_health line",
  );
}

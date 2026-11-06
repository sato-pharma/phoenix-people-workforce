import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PerformanceObserver, constants as perfConstants } from "node:perf_hooks";
import v8 from "node:v8";
import vm from "node:vm";

import {
  createGcWindow,
  drainGcWindow,
  gcExplainsStall,
  gcKindOf,
  recordGc,
  summarizeEventLoopDelay,
} from "../src/lib/observability/process-health.ts";
import { drainTimings, recordTiming } from "../src/lib/observability/timings.ts";
import { stripComments } from "./support/comment-strip.ts";

// The once-a-minute process-health line: its timing maths, its nanosecond conversion, and the
// wiring that keeps it a single unref'd timer started from instrumentation.ts.

function read(path: string) {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

export async function runProcessHealthTests() {
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

  // --- garbage collection: the kinds, the window, and "was it long enough to be the freeze" --------
  assert.equal(gcKindOf({ detail: { kind: perfConstants.NODE_PERFORMANCE_GC_MAJOR }, duration: 1 }), "major");
  assert.equal(gcKindOf({ detail: { kind: perfConstants.NODE_PERFORMANCE_GC_MINOR }, duration: 1 }), "minor");
  assert.equal(
    gcKindOf({ detail: { kind: 2 }, duration: 1 }),
    "minor",
    "V8's minor mark-sweep (kind 2, which perf_hooks.constants does not export) is a young-generation collection and reads as minor, not as an unknown kind",
  );
  assert.equal(gcKindOf({ detail: { kind: perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL }, duration: 1 }), "incremental");
  assert.equal(gcKindOf({ detail: { kind: perfConstants.NODE_PERFORMANCE_GC_WEAKCB }, duration: 1 }), "weakcb");
  assert.equal(gcKindOf({ kind: perfConstants.NODE_PERFORMANCE_GC_MAJOR, duration: 1 }), "major", "the pre-Node-16 field still reads");
  assert.equal(gcKindOf({ detail: { kind: 9999 }, duration: 1 }), "other", "a kind a future Node adds is counted, not dropped");
  assert.equal(gcKindOf({ detail: null, duration: 1 }), "other", "an entry with no kind at all is counted as other");

  const window = createGcWindow();
  recordGc(window, "minor", 2.04);
  recordGc(window, "minor", 3.06);
  recordGc(window, "major", 5_120.44);
  recordGc(window, "minor", Number.NaN);
  recordGc(window, "minor", -1);
  const drained = drainGcWindow(window);
  assert.deepEqual(
    drained,
    {
      byKind: { major: { count: 1, maxMs: 5_120.4, totalMs: 5_120.4 }, minor: { count: 2, maxMs: 3.1, totalMs: 5.1 } },
      longest: { kind: "major", ms: 5_120.4 },
      totalMs: 5_125.5,
    },
    "the window reports count, longest and total per kind to one decimal, the longest of the minute, and ignores a NaN or negative sample",
  );
  assert.deepEqual(drainGcWindow(window), { byKind: {}, longest: null, totalMs: 0 }, "draining starts the next minute empty");

  assert.equal(gcExplainsStall({ kind: "major", ms: 5_100 }, 5_200), true, "a 5.1 s collection is the 5.2 s freeze");
  assert.equal(gcExplainsStall({ kind: "major", ms: 2_600 }, 5_200), true, "half the stall is still the bulk of it");
  assert.equal(gcExplainsStall({ kind: "minor", ms: 12 }, 5_200), false, "a 12 ms scavenge does not explain a 5 s freeze — the cause is elsewhere");
  assert.equal(gcExplainsStall(null, 5_200), false, "no collection in the minute explains nothing");
  assert.equal(gcExplainsStall({ kind: "major", ms: 900 }, 0), false, "no stall, nothing to explain");

  // The real thing, on this Node: force a major collection and see the observer deliver it with a kind and a duration.
  // (`--expose-gc` is switched on for this process and read back through a fresh context, the standard way to call gc().)
  v8.setFlagsFromString("--expose-gc");
  const forceGc = vm.runInNewContext("gc") as () => void;
  const seen: Array<{ duration: number; kind: string }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) seen.push({ duration: entry.duration, kind: gcKindOf(entry as never) });
  });
  observer.observe({ entryTypes: ["gc"] });
  forceGc();
  await new Promise((resolve) => setImmediate(resolve));
  const flushed = observer.takeRecords();
  observer.disconnect();
  for (const entry of flushed) seen.push({ duration: entry.duration, kind: gcKindOf(entry as never) });
  assert.ok(seen.length > 0, "a forced collection must reach a gc PerformanceObserver at all");
  assert.ok(seen.some((entry) => entry.kind === "major"), "a forced full collection must read as major, not other — got " + JSON.stringify(seen));
  assert.ok(seen.every((entry) => Number.isFinite(entry.duration) && entry.duration >= 0), "every collection carries a finite duration");

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
  assert.match(health, /observe\(\{ entryTypes: \["gc"\] \}\)/, "the reporter must observe V8's gc entries — the leading suspect for the freezes");
  assert.match(
    health,
    /gcObserver\?\.takeRecords\(\)[\s\S]*?const gc = drainGcWindow\(gcWindow\);/,
    "undelivered collections are taken BEFORE the window is drained, or a freeze ending in the timer's own turn blames the next minute",
  );
  assert.match(
    health,
    /\n\s+gc: gc\.byKind,\n\s+gcLongest: gc\.longest,\n\s+gcTotalMs: gc\.totalMs,/,
    "the per-minute line carries the collections of its minute",
  );
  assert.match(
    health,
    /event: "event_loop_stall" \},\s*context: \{\s*gcExplainsStall: gcExplainsStall\(gc\.longest, eventLoopDelayMs\.max\),\s*gcLongest: gc\.longest,\s*gcTotalMs: gc\.totalMs,/,
    "the stall warning says whether a collection was long enough to be the freeze",
  );
  assert.match(
    health,
    /fingerprint: \["event-loop-stall", input\.role, culprit\]/,
    "the stall's Sentry fingerprint is unchanged — the GC figures ride the log line, never open a new Sentry issue",
  );

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
  // 🔴 The schedulers and process-health compile ONLY in a production build (2026-10-17): each refuses
  // a non-production build at run time anyway, and under `next dev` they were 465 repo files and 52 MB
  // of compiled code that never ran. Only a BLOCK-form NODE_ENV test prunes the dynamic imports. (The
  // iReports360 live poller that opened this block went with the vendor on 6 November 2026.)
  assert.match(
    instrumentation,
    /if \(process\.env\.NODE_ENV === "production"\) \{\s*(?:\/\/[^\n]*\n\s*)*try \{\s*const \{ startEarlyBirdsCloseScheduler \} = await import\("@\/lib\/early-birds\/close-scheduler"\);[\s\S]*?await import\("@\/lib\/crm\/housekeeping-scheduler"\)[\s\S]*?await import\("@\/lib\/observability\/process-health"\)[\s\S]*?\} else \{\s*console\.log\("\[schedulers\] not started: not a production build/,
    "the schedulers and process-health sit inside one production-build block, so a dev server never compiles them",
  );
  assert.doesNotMatch(instrumentation, /import\("@\/lib\/crm\/live-poller"\)|startLiveCrmPoller\(/, "the retired iReports360 live poller is never started again");

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

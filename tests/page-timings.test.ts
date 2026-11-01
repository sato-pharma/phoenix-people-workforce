import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PAGE_TIMING_SOFT_BATCH_LIMIT,
  deviceClassOf,
  sanitizePageTimings,
} from "../src/lib/observability/page-timing-intake.ts";
import { flushPageTimings, type PageTimingsRpcClient } from "../src/lib/observability/page-timing-flush.ts";
import {
  forgetPageTimingHours,
  pageTimingHour,
  pageTimingHoursHeld,
  pageTimingRowsBefore,
  recordPageTiming,
  resetPageTimingStore,
} from "../src/lib/observability/page-timing-store.ts";
import { readSummaryRow, summariseSlowPages, type PageTimingSummaryRow } from "../src/lib/system-audit/slow-pages.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Record everything, and nobody (owner, 1 Nov 2026: "hourly medians per page, 30 days, no names").
 *
 * The browser beacon grew from two paint times to the whole hard load (first byte, first content, largest
 * content, interactive, first /api/ answer), the taps inside the app (RouteTransitionProvider knows the
 * tap and the arrival) and a device class; the server sums each hour in memory and writes it to
 * page_timings once the hour has ended; phx_prune_retention drops it at 30 days; the System Audit shows
 * the slowest pages of the week. What this pins: the intake drops everything that is not a page shape, a
 * kind, a device class and milliseconds; the hour in progress is never written and a refused write is
 * never forgotten; the table has no column a person could be in; the retention period is the owner's.
 *
 * Files are read inside the function, never at module load, so a break test sees the edited file.
 */
function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function code(path: string): string {
  return stripComments(read(path));
}

const VISITS = "/employee-portals/phoenix-crm/visits";

export function runPageTimingsTests() {
  // ── The intake: a page shape, a kind, a device class and milliseconds — nothing else ─────────────
  const [hard, ...rest] = sanitizePageTimings({
    device: "low",
    hard: { path: `${VISITS}?seat=ab12`, ttfb: 412.2, fcp: 812.4, lcp: 1503, interactive: 1100, firstData: 1650, hrId: "PD-0030", ua: "Mozilla" },
    hrId: "B-10",
    name: "Omar",
  });
  assert.deepEqual(rest, [], "one hard load is one report");
  assert.deepEqual(
    hard,
    { device: "low", kind: "hard", metrics: { fcp: 812, first_data: 1650, interactive: 1100, lcp: 1503, ttfb: 412 }, path: VISITS },
    "every hard-load number is read, rounded, under the page shape; an id, a name and a user agent are dropped",
  );
  assert.deepEqual(Object.keys(hard!).sort(), ["device", "kind", "metrics", "path"], "a report has four fields and no room for a person");
  assert.deepEqual(
    sanitizePageTimings({ path: "/employee-portals", fcp: 812.4, lcp: 1503 }),
    [{ device: "unknown", kind: "hard", metrics: { fcp: 812, lcp: 1503 }, path: "/employee-portals" }],
    "the first beacon's shape (path and two numbers at the top level) is still read, with the device unknown",
  );
  assert.deepEqual(sanitizePageTimings({ device: "tablet", hard: { path: "/admin", ttfb: 300 } })[0]?.device, "unknown", "a device class the intake does not know is unknown, never a guess");
  assert.deepEqual(sanitizePageTimings({ hard: { path: "/login", ttfb: 300 } }), [], "a page outside the portal and the admin shell is refused");
  assert.deepEqual(sanitizePageTimings({ hard: { path: "/admin", ttfb: -5, lcp: 9_999_999 } }), [], "negative and absurd numbers are dropped");
  assert.deepEqual(sanitizePageTimings([{ path: "/admin", ttfb: 300 }]), [], "an array body is refused");

  const taps = sanitizePageTimings({
    device: "high",
    soft: [
      ...Array.from({ length: PAGE_TIMING_SOFT_BATCH_LIMIT + 2 }, (_, i) => ({ path: `/employee-portals/page-${i}`, ms: 100 + i })),
    ],
  });
  assert.equal(taps.length, PAGE_TIMING_SOFT_BATCH_LIMIT, "a batch past the tap limit is cut at the limit");
  assert.deepEqual(taps[0], { device: "high", kind: "soft", metrics: { soft: 100 }, path: "/employee-portals/:id" }, "a tap is a soft report with one metric, its digit-bearing segment reduced to :id like every path");
  assert.deepEqual(
    sanitizePageTimings({ soft: [{ path: "/login", ms: 50 }, { path: "/admin" }, { path: "/admin", ms: 70 }, "x"] }),
    [{ device: "unknown", kind: "soft", metrics: { soft: 70 }, path: "/admin" }],
    "a tap outside the portal, without a number, or not an object is skipped; the rest are kept",
  );

  assert.equal(deviceClassOf({ hardwareConcurrency: 8, deviceMemory: 8 }), "high");
  assert.equal(deviceClassOf({ hardwareConcurrency: 4, deviceMemory: 8 }), "low", "four cores is a phone");
  assert.equal(deviceClassOf({ hardwareConcurrency: 8, deviceMemory: 4 }), "low", "4 GB is a phone");
  assert.equal(deviceClassOf({ hardwareConcurrency: 8 }), "high", "cores alone decide when memory is not offered");
  assert.equal(deviceClassOf({}), "unknown", "neither figure offered is unknown, never a guess");

  // ── The store: the hour in progress stays in memory; an ended hour becomes rows ─────────────────
  resetPageTimingStore();
  assert.equal(pageTimingHour(new Date("2026-11-01T10:15:30.500Z")), "2026-11-01T10:00:00.000Z", "an hour is its UTC floor");
  const tenPast = new Date("2026-11-01T10:15:00Z");
  for (const ms of [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]) {
    recordPageTiming({ device: "high", kind: "hard", metrics: { lcp: ms }, path: VISITS }, tenPast);
  }
  recordPageTiming({ device: "low", kind: "soft", metrics: { soft: 700 }, path: "/employee-portals" }, new Date("2026-11-01T11:05:00Z"));
  assert.deepEqual(pageTimingRowsBefore(new Date("2026-11-01T10:59:59Z")), [], "the hour in progress is not written");
  const rows = pageTimingRowsBefore(new Date("2026-11-01T11:05:00Z"));
  assert.deepEqual(
    rows,
    [{ count: 10, device: "high", hour: "2026-11-01T10:00:00.000Z", kind: "hard", max_ms: 10000, metric: "lcp", p50_ms: 5000, p90_ms: 9000, path: VISITS }],
    "the ended hour is one row per page, kind, device and metric: count, median, 90th percentile, worst",
  );
  assert.deepEqual(Object.keys(rows[0]!).sort(), ["count", "device", "hour", "kind", "max_ms", "metric", "p50_ms", "p90_ms", "path"], "a row has no column a person could be in");
  assert.equal(pageTimingRowsBefore(new Date("2026-11-01T11:05:00Z")).length, 1, "reading the rows removes nothing");
  forgetPageTimingHours(["2026-11-01T10:00:00.000Z"]);
  assert.deepEqual(pageTimingRowsBefore(new Date("2026-11-01T11:05:00Z")), [], "a forgotten hour is gone");
  assert.deepEqual(
    pageTimingRowsBefore(new Date("2026-11-01T12:00:00Z")),
    [{ count: 1, device: "low", hour: "2026-11-01T11:00:00.000Z", kind: "soft", max_ms: 700, metric: "soft", p50_ms: 700, p90_ms: 700, path: "/employee-portals" }],
    "the next hour's taps follow once it has ended",
  );

  resetPageTimingStore();
  const nine = new Date("2026-11-01T09:30:00Z");
  for (let i = 0; i < 2_000; i += 1) recordPageTiming({ device: "high", kind: "hard", metrics: { ttfb: 1 }, path: "/admin" }, nine);
  for (let i = 0; i < 300; i += 1) recordPageTiming({ device: "high", kind: "hard", metrics: { ttfb: 5000 }, path: "/admin" }, nine);
  const capped = pageTimingRowsBefore(new Date("2026-11-01T10:00:00Z"))[0]!;
  assert.equal(capped.count, 2_300, "a sample past the cap is still counted");
  assert.equal(capped.max_ms, 5000, "and still raises the worst");
  assert.equal(capped.p50_ms, 1, "the median comes from the kept samples");
  assert.equal(capped.p90_ms, 1, "so does the 90th percentile — the samples past the cap raise only the count and the worst");

  resetPageTimingStore();
  recordPageTiming({ device: "high", kind: "hard", metrics: { ttfb: 1 }, path: "/admin" }, new Date("2026-10-29T10:00:00Z"));
  recordPageTiming({ device: "high", kind: "hard", metrics: { ttfb: 1 }, path: "/admin" }, new Date("2026-11-01T10:15:00Z"));
  assert.equal(pageTimingHoursHeld(), 1, "an hour older than two days is dropped unwritten — a refused flush is never a leak");
  resetPageTimingStore();

  // ── The flush: one RPC with the ended hours, forgotten only once the database took them ──────────
  return (async () => {
    const calls: Array<{ args: Record<string, unknown>; fn: string }> = [];
    const taking = { rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ args, fn }); return Promise.resolve({ data: 1, error: null }); } } as unknown as PageTimingsRpcClient;
    const refusing = { rpc: () => Promise.resolve({ data: null, error: { message: "the database is away" } }) } as unknown as PageTimingsRpcClient;
    const later = new Date("2026-11-01T11:05:00Z");
    recordPageTiming({ device: "high", kind: "hard", metrics: { lcp: 1200 }, path: VISITS }, tenPast);

    assert.equal(await flushPageTimings({ client: refusing, now: later }), 0, "a refused write writes nothing");
    assert.equal(pageTimingHoursHeld(), 1, "and the hour is kept for the next tick");
    assert.equal(await flushPageTimings({ client: taking, now: later }), 1, "the next tick writes the kept hour");
    assert.equal(calls.length, 1, "one RPC");
    assert.equal(calls[0]!.fn, "phx_page_timings_record", "into the recording function");
    assert.deepEqual(
      calls[0]!.args.p_rows,
      [{ count: 1, device: "high", hour: "2026-11-01T10:00:00.000Z", kind: "hard", max_ms: 1200, metric: "lcp", p50_ms: 1200, p90_ms: 1200, path: VISITS }],
      "with the hour's rows and nothing else",
    );
    assert.equal(pageTimingHoursHeld(), 0, "a written hour is forgotten");
    assert.equal(await flushPageTimings({ client: taking, now: later }), 0, "nothing ended, nothing sent");
    assert.equal(calls.length, 1, "no RPC for an empty flush");
    resetPageTimingStore();

    // ── The Slowest pages tab: the week folded per page, slowest first ───────────────────────────
    assert.deepEqual(
      readSummaryRow({ path: "/admin", kind: "hard", device: "high", metric: "lcp", count: "12", p50_ms: 900, p90_ms: 1800, max_ms: 4000 }),
      { count: 12, device: "high", kind: "hard", max_ms: 4000, metric: "lcp", p50_ms: 900, p90_ms: 1800, path: "/admin" },
      "a bigint count sent as text is read as a number",
    );
    assert.equal(readSummaryRow({ path: "/admin", kind: "warm", device: "high", metric: "lcp", count: 1, p50_ms: 1, p90_ms: 1, max_ms: 1 }), null, "a kind the table does not allow is refused");
    const summary: PageTimingSummaryRow[] = [
      { count: 10, device: "high", kind: "hard", max_ms: 3000, metric: "lcp", p50_ms: 1000, p90_ms: 2000, path: VISITS },
      { count: 10, device: "low", kind: "hard", max_ms: 5000, metric: "lcp", p50_ms: 3000, p90_ms: 4000, path: VISITS },
      { count: 20, device: "low", kind: "hard", max_ms: 2000, metric: "fcp", p50_ms: 800, p90_ms: 1500, path: VISITS },
      { count: 20, device: "low", kind: "hard", max_ms: 900, metric: "ttfb", p50_ms: 400, p90_ms: 700, path: VISITS },
      { count: 5, device: "low", kind: "soft", max_ms: 1200, metric: "soft", p50_ms: 400, p90_ms: 900, path: "/employee-portals" },
    ];
    const pages = summariseSlowPages(summary);
    assert.deepEqual(pages.map((page) => page.path), [VISITS, "/employee-portals"], "slowest first, by the 90th percentile of the page looking ready");
    assert.deepEqual(pages[0]!.largestContent, { count: 20, maxMs: 5000, p50Ms: 2000, p90Ms: 3000 }, "the device classes fold by count");
    assert.deepEqual(pages[0]!.lowDeviceFirstContent, { count: 20, maxMs: 2000, p50Ms: 800, p90Ms: 1500 }, "the low-end figure is the low rows alone");
    assert.deepEqual(pages[0]!.firstByte, { count: 20, maxMs: 900, p50Ms: 400, p90Ms: 700 });
    assert.equal(pages[0]!.taps, null, "no taps reached the visits page in this window");
    assert.deepEqual(pages[1]!.taps, { count: 5, maxMs: 1200, p50Ms: 400, p90Ms: 900 });
    assert.equal(pages[1]!.largestContent, null);

    // ── The browser side ───────────────────────────────────────────────────────────────────────────
    const beacon = code("src/components/layout/page-timing-beacon.tsx");
    for (const needle of [
      "navigator.sendBeacon(",
      "window.location.pathname",
      ".responseStart",
      ".domInteractive",
      '"first-contentful-paint"',
      '"largest-contentful-paint"',
      'includes("/api/")',
      "deviceClassOf(",
      "export function reportSoftNavigation(",
      "PAGE_TIMING_SOFT_BATCH_LIMIT",
      "flushSoftNavigations();",
    ]) {
      assert.ok(beacon.includes(needle), `the beacon reads and sends ${needle}`);
    }
    assert.doesNotMatch(beacon, /location\.(search|href|hash)|document\.cookie|localStorage|userAgent|hrId|loginId/, "the beacon never reads the query, the full URL, a cookie, storage, the user agent or a person");
    const provider = code("src/components/layout/route-transition-provider.tsx");
    assert.ok(provider.includes("reportSoftNavigation(pathname, performance.now() - softStartedAtRef.current)"), "a soft navigation is measured from the tap to the new route rendering, under the new pathname");
    assert.ok(provider.includes("softStartedAtRef.current = performance.now();"), "the tap starts the clock");
    assert.match(provider, /setPending\(false\);\s*softStartedAtRef\.current = null;/, "nine seconds and no page is not a measurement");
    assert.match(provider, /eligibleRef\.current = false;\s*softStartedAtRef\.current = null;/, "a click that opened a panel is not a measurement");

    // ── The server side ────────────────────────────────────────────────────────────────────────────
    const route = code("app/api/telemetry/page-timing/route.ts");
    assert.ok(route.includes("sanitizePageTimings(") && route.includes("recordPageTiming(report)"), "the route records every report of a beacon into the hour's store");
    assert.ok(!/supabase|getSupabaseAdmin|cookies\(|hrId/.test(route), "the route itself touches no database and no session");
    const health = code("src/lib/observability/process-health.ts");
    assert.ok(health.includes('import("@/lib/observability/page-timing-flush")') && health.includes(".flushPageTimings()"), "the process-health tick flushes the ended hours, through a dynamic import");
    const flush = code("src/lib/observability/page-timing-flush.ts");
    assert.match(flush, /if \(error\) \{[\s\S]*?return 0;\s*\}\s*forgetPageTimingHours\(/, "the hours are forgotten only after the database took them");

    // ── The table: no column a person could be in; the owner's retention ─────────────────────────
    const migration = stripSqlComments(read("supabase/migrations/20261101233000_page_timings.sql"));
    const table = /create table if not exists public\.page_timings \(([\s\S]*?)\n\);/.exec(migration)?.[1] ?? "";
    const columns = table
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^(primary key|check|constraint)/.test(line))
      .map((line) => line.split(/\s+/)[0]!);
    assert.deepEqual(columns, ["hour", "path", "kind", "device", "metric", "count", "p50_ms", "p90_ms", "max_ms", "updated_at"], "the table's columns");
    assert.ok(columns.every((column) => !/^(hr_id|login|login_id|address|ip|user_agent|email|name|actor)$/.test(column)), "no column a person could be in");
    assert.ok(migration.includes("alter table public.page_timings enable row level security;"), "row security on, no policy, no browser grant");
    for (const fn of ["phx_page_timings_record(jsonb)", "phx_page_timings_summary(timestamptz)", "phx_prune_retention()"]) {
      assert.ok(migration.includes(`revoke execute on function public.${fn} from public, anon, authenticated;`), `${fn} is the service role's alone`);
    }
    assert.match(migration, /delete from public\.page_timings where ctid in \(\s*select ctid from public\.page_timings where hour < now\(\) - interval '30 days'/, "page_timings is pruned at 30 days — the owner's period");
    assert.equal((migration.match(/interval '12 months'/g) ?? []).length, 2, "audit_logs and attendance_raw_punches keep their 12 months");
    assert.equal((migration.match(/interval '6 months'/g) ?? []).length, 1, "email_delivery_events keeps its 6 months");
    assert.ok(!migration.includes("cron.schedule"), "no new pg_cron job — the existing one runs the function");
    const rules = read(".claude/rules/database.md");
    assert.ok(/`page_timings` 30 days/.test(rules), "the retention rule in module memory lists page_timings at 30 days");

    // ── The tab ────────────────────────────────────────────────────────────────────────────────────
    const audit = code("src/components/admin/system-audit/system-audit-page.tsx");
    assert.ok(audit.includes('{ key: "slow-pages", label: "Slowest pages" }') && audit.includes("<SlowPagesSection />"), "the System Audit has a Slowest pages tab");
    const section = code("src/components/admin/system-audit/slow-pages-section.tsx");
    assert.equal((section.match(/<table[\s>]/g) ?? []).length, (section.match(/<colgroup>/g) ?? []).length, "every table fixes its columns");
    assert.ok(section.includes("table-fixed") && !section.includes("overflow-x"), "the tables fit the screen; no horizontal scroll");
  })();
}

/**
 * System Error & Data Integrity Audit — the Slowest pages tab.
 *
 * Reads page_timings — the hourly summaries the web process writes from the browser beacon
 * (src/lib/observability/page-timing-*.ts) — through phx_page_timings_summary and folds a window per
 * page: how many times each page loaded or was tapped to, and how long that took at the median, at the
 * 90th percentile and at worst. No person is in the table, so none is here. A failed read throws; the
 * section then says "Unavailable — reason".
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { PageTimingDevice, PageTimingKind, PageTimingMetric } from "@/lib/observability/page-timing-intake";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

export const SLOW_PAGES_WINDOW_DAYS = 7;
export const SLOW_PAGES_SUMMARY_RPC = "phx_page_timings_summary";

export type PageTimingSummaryRow = {
  count: number;
  device: PageTimingDevice;
  kind: PageTimingKind;
  max_ms: number;
  metric: PageTimingMetric;
  p50_ms: number;
  p90_ms: number;
  path: string;
};

export type PageFigure = { count: number; maxMs: number; p50Ms: number; p90Ms: number };

export type SlowPage = {
  path: string;
  /** Hard loads: the first byte, the server's share. Its count is the number of loads. */
  firstByte: PageFigure | null;
  /** Hard loads: the first content painted (every browser reports it). */
  firstContent: PageFigure | null;
  /** Hard loads: the largest content painted, when the page looked ready (Safari reports none). */
  largestContent: PageFigure | null;
  /** Hard loads on low-end devices (four cores or fewer, or 4 GB or less): the first content. */
  lowDeviceFirstContent: PageFigure | null;
  /** Taps inside the app that reached this page: from the tap to the page rendering. */
  taps: PageFigure | null;
};

export type SlowPagesOverview = { days: number; loads: number; pages: SlowPage[]; since: string; taps: number };

const KINDS = new Set<string>(["hard", "soft"]);
const DEVICES = new Set<string>(["low", "high", "unknown"]);
const METRICS = new Set<string>(["ttfb", "fcp", "lcp", "interactive", "first_data", "soft"]);

function wholeNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** One RPC row as the database sent it, or null when a field is not what the table allows. */
export function readSummaryRow(raw: unknown): PageTimingSummaryRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const count = wholeNumber(row.count);
  const p50 = wholeNumber(row.p50_ms);
  const p90 = wholeNumber(row.p90_ms);
  const max = wholeNumber(row.max_ms);
  if (typeof row.path !== "string" || count === null || count === 0 || p50 === null || p90 === null || max === null) return null;
  if (typeof row.kind !== "string" || !KINDS.has(row.kind)) return null;
  if (typeof row.device !== "string" || !DEVICES.has(row.device)) return null;
  if (typeof row.metric !== "string" || !METRICS.has(row.metric)) return null;
  return {
    count,
    device: row.device as PageTimingDevice,
    kind: row.kind as PageTimingKind,
    max_ms: max,
    metric: row.metric as PageTimingMetric,
    p50_ms: p50,
    p90_ms: p90,
    path: row.path,
  };
}

/** The count-weighted figure of several rows (one per device class), or null with no rows. */
function weighted(rows: PageTimingSummaryRow[]): PageFigure | null {
  const count = rows.reduce((sum, row) => sum + row.count, 0);
  if (count === 0) return null;
  const average = (pick: (row: PageTimingSummaryRow) => number) =>
    Math.round(rows.reduce((sum, row) => sum + pick(row) * row.count, 0) / count);
  return { count, maxMs: Math.max(...rows.map((row) => row.max_ms)), p50Ms: average((row) => row.p50_ms), p90Ms: average((row) => row.p90_ms) };
}

function slowest(page: SlowPage): number {
  return (page.largestContent ?? page.firstContent ?? page.taps)?.p90Ms ?? 0;
}

/** Pure: a window's rows folded per page, slowest first by the 90th percentile of the page looking ready. */
export function summariseSlowPages(rows: PageTimingSummaryRow[]): SlowPage[] {
  const byPath = new Map<string, PageTimingSummaryRow[]>();
  for (const row of rows) {
    const list = byPath.get(row.path) ?? [];
    list.push(row);
    byPath.set(row.path, list);
  }
  const pages: SlowPage[] = [];
  for (const [path, list] of byPath) {
    const hard = list.filter((row) => row.kind === "hard");
    const page: SlowPage = {
      path,
      firstByte: weighted(hard.filter((row) => row.metric === "ttfb")),
      firstContent: weighted(hard.filter((row) => row.metric === "fcp")),
      largestContent: weighted(hard.filter((row) => row.metric === "lcp")),
      lowDeviceFirstContent: weighted(hard.filter((row) => row.metric === "fcp" && row.device === "low")),
      taps: weighted(list.filter((row) => row.kind === "soft" && row.metric === "soft")),
    };
    if (!page.firstByte && !page.firstContent && !page.largestContent && !page.taps) continue;
    pages.push(page);
  }
  pages.sort((a, b) => slowest(b) - slowest(a) || a.path.localeCompare(b.path));
  return pages;
}

export async function loadSlowPagesOverview(
  input: { client?: SupabaseClient; days?: number; now?: Date } = {},
): Promise<SlowPagesOverview> {
  const days = input.days ?? SLOW_PAGES_WINDOW_DAYS;
  const since = new Date((input.now ?? new Date()).getTime() - days * 86_400_000).toISOString();
  const client = input.client ?? getSupabaseAdmin({ requestTimeoutMs: 15_000 });
  // One grouped row per page, kind, device and metric (749 over the last 7 days): paged by the shared
  // RPC pager so a response ceiling can never cut pages off the list. A failed page throws.
  const data = await rpcAll(client, SLOW_PAGES_SUMMARY_RPC, { p_since: since }, ["path", "kind", "device", "metric"]);
  const rows = data.map(readSummaryRow).filter((row): row is PageTimingSummaryRow => row !== null);
  const pages = summariseSlowPages(rows);
  return {
    days,
    loads: pages.reduce((sum, page) => sum + ((page.firstByte ?? page.firstContent)?.count ?? 0), 0),
    pages,
    since,
    taps: pages.reduce((sum, page) => sum + (page.taps?.count ?? 0), 0),
  };
}

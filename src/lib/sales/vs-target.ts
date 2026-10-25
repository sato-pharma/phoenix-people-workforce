// ─────────────────────────────────────────────────────────────────────────────
// Sales vs Target — the field force's primary performance surface.
//
// Sales come from ONE place: au.f_monthly_achievement, reached here through the
// multi-period wrapper phx_sales_vs_target_range. That function already unions Source
// of Sales (indirect, priced at factory price) with Direct Orders (at their own
// invoiced value, on the Finance-owned sales month) and attributes both down
// line → operational region → canonical area → rep seat → DM seat, using seat
// occupancy AS OF the period end. This module deliberately does NOT re-derive any of
// that: /sales/targets and Monthly Closing read the same function, and a second
// definition of "achievement" is exactly how two screens start quoting different
// numbers for the same month.
//
// What this module adds is the dashboard's own three concerns:
//
//   1. THE JULY 2026 FLOOR. The dashboard starts at 2026-07 and never reads earlier —
//      even though May/June 2026 SoS data exists. July therefore has NO prior period
//      and reports so, rather than quietly comparing against June (owner decision,
//      2026-08-04). The floor is enforced in SQL as well; this is the second lock.
//
//   2. TARGET COVERAGE, AND THE RULE THE % ACTUALLY USES.
//
//      Owner ruling, 2026-09-05: "FOLLOW THE OLD MONTHLY CLOSING ... MUST BE 100%
//      IDENTICAL". This screen and the Monthly Closing must print the same percentage
//      for the same line and month, so the closing's arithmetic is the arithmetic, and
//      it is copied here rather than reasoned about afresh. The closing carries TWO
//      rules, and both are honoured below:
//
//        INSIDE one month — every pound over the target that was set, untargeted areas
//        and products included (`closingAchievement` in monthly-closing-matrix-cells.ts).
//
//        ACROSS months — only the months that CARRY a target count, because this screen
//        spans a window and the closing does not. That is the old export's own "ALL
//        MONTHS" row (monthly-closing-export.ts, Block 5), whose formula is
//        `SUMIF(target,">0",sales)/SUM(target)` and whose comment gives the reason:
//        dividing every month's sales by the targeted months' targets "would print a
//        wildly flattering percentage against a target nobody set for those months".
//        Measured 2026-09-05 over Jan–Sep on the three tracked lines, ignoring that
//        second rule reads 77.55% where the closing's own rule reads 35.26% — because
//        Mar–Jun carry sales and no target at all.
//
//      So the numerator is GRADED actual: every pound inside a month this group was
//      targeted in. Missing target is null, never 0.
//
//      COVERED/UNCOVERED is still tracked and still shown, but it is now a coverage
//      statistic beside the percentage rather than the numerator inside it — the split
//      that used to drive the % and no longer does. As of 2026-08-04 only 36 of 142
//      (line, area) pairs carrying July sales had a target at all, which is why the
//      reader still needs to see it.
//
//   3. THE HIERARCHY. Team (line) → region → area → medical rep → brick, each level
//      carrying its own prior-period comparison.
//
// Everything below the loaders is PURE, so the rules above are unit-testable without a
// database.
// ─────────────────────────────────────────────────────────────────────────────

import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { cache } from "react";
import { unstable_cache } from "next/cache";

import { SALES_ACHIEVEMENT_STAMPED_CACHE_TAG } from "@/lib/dashboard/invalidation";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";
import { asyncPool } from "@/lib/utils/async-pool";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { resolveTargetLineCode, type AchievementRow } from "@/lib/sales/monthly-targets";

const PERIOD_RE = /^\d{4}-\d{2}$/;

/**
 * The first month this dashboard ever reports on (owner decision, 2026-08-04).
 *
 * Also hard-coded in au.f_sales_vs_target_range. Two locks on purpose: the SQL floor
 * stops any caller reading pre-July data, and this one stops the UI offering a period
 * it would then render as empty.
 */
export const SALES_VS_TARGET_FLOOR = "2026-07";

/**
 * The first month the CANONICAL ENGINE holds data for — a data floor, not a policy one.
 *
 * These are two different facts and conflating them is what kept ten surfaces on the legacy
 * `sales_records` engine. SoS actuals run from 2026-01 (verified live: 50-51 areas x 4 lines
 * every month Jan-Jul 2026); the July floor above is the /sales-vs-target DASHBOARD's own
 * decision about what it offers in its picker. A surface that legitimately reports history —
 * employee-360, the monthly dashboard, the admin KPI, reconciliation — needs the engine's
 * range, not the dashboard's, and previously had no way to ask for it: loadVsTargetRange
 * returns [] below the dashboard floor.
 *
 * So: read history through this floor, render the dashboard through the one above. Neither
 * moves the other. The SQL clamp in au.f_sales_vs_target_range is the third lock and is what
 * actually bounds the data.
 */
export const SALES_HISTORY_FLOOR = "2026-01";

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isValidVsTargetPeriod(period: string | null | undefined): period is string {
  return typeof period === "string" && PERIOD_RE.test(period) && period >= SALES_VS_TARGET_FLOOR;
}

/** Same shape check against the engine's data floor, for history-reporting surfaces. */
export function isValidHistoryPeriod(period: string | null | undefined): period is string {
  return typeof period === "string" && PERIOD_RE.test(period) && period >= SALES_HISTORY_FLOOR;
}

// ── Period arithmetic ────────────────────────────────────────────────────────

/** Shift a YYYY-MM period by whole months. Returns null for a malformed input. */
export function shiftPeriod(period: string, months: number): string | null {
  if (!PERIOD_RE.test(period)) return null;
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  if (month < 1 || month > 12) return null;
  // Date.UTC normalises the month overflow/underflow for us; day 1 is never ambiguous.
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The period this one is compared against, or null when there isn't one.
 *
 * Returns null for 2026-07 BY DESIGN. June 2026 data exists and would load fine, which
 * is precisely the trap: the dashboard's window starts in July, so a July-vs-June
 * comparison would mix in a month the rest of the dashboard refuses to show. The UI
 * renders "no prior period" instead of a delta.
 */
export function priorPeriodOf(period: string): string | null {
  if (!isValidVsTargetPeriod(period)) return null;
  const prior = shiftPeriod(period, -1);
  if (!prior || prior < SALES_VS_TARGET_FLOOR) return null;
  return prior;
}

/**
 * Every period the dashboard can show: the July 2026 floor up to the current Cairo
 * month. Cairo, not UTC — on the 1st of a month, UTC is still in the previous month for
 * three hours, and the picker would offer a month the owner does not consider started.
 */
export function salesVsTargetPeriods(): { periods: string[]; current: string } {
  const { year, month } = currentCairoDateParts();
  const current = `${year}-${String(month).padStart(2, "0")}`;
  const periods: string[] = [];
  let cursor = SALES_VS_TARGET_FLOOR;
  // Guarded loop: if the clock is ever behind the floor, `periods` stays [floor].
  while (cursor <= current && periods.length < 240) {
    periods.push(cursor);
    const next = shiftPeriod(cursor, 1);
    if (!next) break;
    cursor = next;
  }
  if (periods.length === 0) periods.push(SALES_VS_TARGET_FLOOR);
  return { periods, current: periods[periods.length - 1] };
}

// ── Loaders ──────────────────────────────────────────────────────────────────

/** One brick's sales inside an area, for the rep-level drill-down. */
export type BrickSalesRow = {
  period: string;
  lineCode: string | null;
  regionCode: string | null;
  areaCode: string | null;
  areaState: string | null;
  repSeatId: string | null;
  repHrId: string | null;
  dmSeatId: string | null;
  dmHrId: string | null;
  /** null when the source row carried no brick at all — real sales, no brick recorded. */
  brickId: string | null;
  brickName: string | null;
  blockCode: string | null;
  salesUnits: number;
  salesValue: number;
  directValue: number;
  indirectValue: number;
};

/**
 * Achievement rows for every period in [from, to] in one round trip.
 *
 * Returns [] rather than throwing for a malformed or pre-floor range — the SQL applies
 * the same floor, so a caller cannot widen the window by passing an earlier `from`.
 */
export async function loadVsTargetRange(from: string, to: string): Promise<AchievementRow[]> {
  if (!isValidVsTargetPeriod(from) || !isValidVsTargetPeriod(to) || to < from) return [];
  return loadAchievementRange(from, to);
}

// ── The achievement cache is keyed per MONTH, not per range ──────────────────
//
// It used to be keyed per range, and that is what made this the most expensive statement in the
// database: 7,973 seconds of server time across 3,436 calls — more than every other statement in
// the instance put together (production pg_stat_statements, read 2026-09-04). Two things caused it.
//
// FIRST, NO TWO CALLERS SHARED AN ENTRY. Six surfaces read this loader and five of them anchor at
// SALES_HISTORY_FLOOR, so the dashboard's 2026-01..2026-09 and Sales Truth's 2026-09..2026-09
// overlap almost completely — and still missed each other entirely, because the range bounds were
// in the cache key and an overlap was therefore worth nothing.
//
// SECOND, THE COST IS SUPERLINEAR IN THE WIDTH OF THE RANGE. Measured on production 2026-09-04
// with EXPLAIN ANALYZE, warm, against au.f_sales_vs_target_range directly:
//
//     1 month   2026-08             889 rows      41.9 ms
//     3 months  2026-01..2026-03  2,688 rows      94.7 ms
//     9 months  2026-01..2026-09  7,880 rows     540.8 ms
//
// A nine-month range costs 13x a single month to return 9x the rows, and it was paid in full on
// every render — even though eight of those nine months are closed and cannot change.
//
// Keyed per month, a closed month is computed once per token epoch and then shared by every
// caller and every range containing it, so the realistic worst case is ONE uncached month.
//
// The comment that stood here said "one round trip for the whole range — do NOT loop a per-period
// RPC over this, every call crosses the Atlantic to eu-central-1." That was true when the app ran
// outside Europe. Production is now Railway europe-west4 (Amsterdam) against Supabase eu-central-1
// (Frankfurt), colocated deliberately (AGENTS.md §3), so the per-call latency it warned about is
// single-digit milliseconds. It does still hold for a laptop in Cairo — which is exactly why the
// fan-out below goes through asyncPool, whose dev clamp makes it serial there.
const ACHIEVEMENT_MONTH_CACHE_PREFIX = "sales-vs-target-achievement-month";
// Token-keyed: the freshness stamp changes the cache key on any input change, so this TTL is
// NOT a staleness window — it only evicts superseded epochs. Correctness comes from the token.
const ACHIEVEMENT_MONTH_CACHE_TTL_SECONDS = 3600;
/**
 * How many UNCACHED months may be in flight at once.
 *
 * Only ever reached on a cold epoch; a warm range makes no round trips at all. Four holds at most
 * four pooler connections per request — so several managers landing together cannot exhaust
 * Supavisor — while still finishing a fully cold nine-month range in roughly a third of the old
 * single call. asyncPool clamps this to 1 in development.
 */
const ACHIEVEMENT_MONTH_FETCH_CONCURRENCY = 4;
/**
 * The widest range the fan-out will expand, mirroring au.f_sales_vs_target_range's own v_max_months.
 *
 * Load-bearing, not defensive. The SQL clamp used to bound a malformed or hostile `to` for free,
 * because the whole range was ONE call and the function clamped it server-side. Expanding the range
 * here moves that responsibility into this file: without this cap, `to = '9999-12'` would become
 * tens of thousands of RPCs instead of one clamped query.
 */
const ACHIEVEMENT_MAX_MONTHS = 24;

/**
 * A ceiling well under Next's hard 2MB data-cache limit, and the reason the rows below are
 * stored COMPRESSED rather than raw.
 *
 * Next refuses any entry whose serialized size exceeds 2MB, and the refusal is violent. In dev
 * it THROWS, and the throw lands on a promise Next itself never awaits and never catches —
 * `workStore.pendingRevalidates[key] = cacheNewResult(...)` in
 * next/dist/server/web/spec-extension/unstable-cache.js — so it surfaces as an
 * unhandledRejection and Node kills the entire dev server (exit 0xC0000409). There is no catch
 * site anywhere in our code that can stop it; the only defence is to never hand over an
 * oversize entry. In production the same branch only `console.warn`s and skips the write, which
 * is quieter and in one way worse: the cache silently stops existing and nothing says so.
 *
 * This range crossed 2MB around 2026-05 and nobody noticed. Measured against production
 * 2026-08-22: 6,950 rows for 2026-01..2026-08 serialize to 2,799,322 bytes on their own, and
 * Next measured 3,189,652 once wrapped in its own cache envelope — 1.5x the limit, growing by
 * one ~870-row / ~415KB month every month, so no floor-anchored range will ever fit raw again.
 * Every caller anchored at SALES_HISTORY_FLOOR had therefore been paying the full
 * 2.38s of database time on EVERY render — this is the field force's single most expensive
 * query — while believing it was cached.
 *
 * The payload is ~6,950 repetitions of the same 19 keys, which is precisely what gzip is best
 * at, so the compressed entry lands far below this ceiling and the cache does what it was
 * written to do again. A gunzip on each hit costs a few milliseconds against a 2.38s round trip
 * to eu-central-1.
 *
 * Since 2026-09-04 entries are ONE MONTH each — ~890 rows, an order of magnitude under this
 * ceiling — so the bypass below should now never fire in production. The guard stays anyway: it
 * is the only thing standing between a future data-growth month and the dev-server kill above,
 * and it costs one comparison. Keep the null path and its caller; do not "simplify" either away
 * on the grounds that the payload is small now.
 */
export const ACHIEVEMENT_CACHE_MAX_BYTES = 1_500_000;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Rows -> a base64 gzip payload, or null when even compressed it would not fit.
 *
 * The null return is the load-bearing part, not a formality: it is the single thing that
 * guarantees an oversize entry is never handed to the data cache, and so the only thing
 * standing between a future data-growth month and the dev-server kill described above.
 *
 * base64 rather than a binary string because the entry is stored through JSON.stringify: the
 * base64 alphabet needs no JSON escaping, so the encoding overhead stays a predictable 4/3 and
 * the size checked here is the size Next will measure.
 *
 * Async (not gzipSync) so the compression runs on libuv's threadpool instead of blocking the
 * event loop of a single-replica server for the length of a 3MB deflate.
 */
export async function packAchievementRows(rows: AchievementRow[]): Promise<string | null> {
  const packed = (await gzipAsync(JSON.stringify(rows))).toString("base64");
  return packed.length > ACHIEVEMENT_CACHE_MAX_BYTES ? null : packed;
}

/** The exact inverse of packAchievementRows. */
export async function unpackAchievementRows(packed: string): Promise<AchievementRow[]> {
  const json = (await gunzipAsync(Buffer.from(packed, "base64"))).toString("utf8");
  return JSON.parse(json) as AchievementRow[];
}

/**
 * The unstable_cache key parts for ONE month of achievement rows.
 *
 * Exported so a test can pin the two properties the design rests on. (1) The freshness token
 * participates: drop it and two reads taken either side of a seat/target/actuals change would
 * collide on one entry and the cache could hand back a stale rep/DM attribution. (2) The key
 * carries the PERIOD and nothing about the range it was asked for — that is what lets two
 * different ranges share the months they overlap on, which is the whole point of the change.
 *
 * The array order IS the cache key — do not reorder casually.
 */
export function achievementMonthCacheKeyParts(period: string, token: string): string[] {
  return [ACHIEVEMENT_MONTH_CACHE_PREFIX, period, token];
}

/**
 * Every period in [from, to] inclusive, ascending, clamped exactly the way the SQL clamps it.
 *
 * Mirrors au.f_sales_vs_target_range: floor `from` at SALES_HISTORY_FLOOR (the engine's data
 * floor), return nothing for a malformed or inverted range, and take at most ACHIEVEMENT_MAX_MONTHS
 * from the floored start. Callers used to get that clamping for free from the one SQL call; now
 * that the range is expanded here, this function IS the clamp.
 *
 * Pure, so the bound is testable with no database.
 */
export function achievementPeriodsInRange(from: string, to: string): string[] {
  if (!PERIOD_RE.test(from) || !PERIOD_RE.test(to)) return [];
  const start = from < SALES_HISTORY_FLOOR ? SALES_HISTORY_FLOOR : from;
  if (to < start) return [];
  const periods: string[] = [];
  let cursor: string | null = start;
  while (cursor && cursor <= to && periods.length < ACHIEVEMENT_MAX_MONTHS) {
    periods.push(cursor);
    cursor = shiftPeriod(cursor, 1);
  }
  return periods;
}

/**
 * A one-round-trip freshness stamp over every input to the achievement range: the attribution
 * config fingerprint (which already hashes line_area_map in full, seat ids included), seat
 * occupancy history, monthly targets, attribution-rollup refresh state, and today's Cairo date
 * (for au.f_seat_occupant_asof's "today's wiring wins" boundary). Wrapped in React `cache` so
 * that when several surfaces load ranges within one request they share a single stamp fetch.
 *
 * Returns null on ANY failure. A null stamp makes loadAchievementRange read live rather than
 * risk serving a stale rep/DM attribution from the cache — slow-but-correct, never stale.
 *
 * Exported because it is the right key for ANY cache built on top of this range — Business
 * Review caches its whole built bundle on it. Callers outside this module must treat null the
 * same way this one does: build live, never serve a possibly-stale entry.
 */
export const loadAchievementCacheStamp = cache(async (): Promise<string | null> => {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc("phx_sales_vs_target_cache_token");
    if (error || typeof data !== "string" || data.length === 0) return null;
    return data;
  } catch {
    return null;
  }
});

/**
 * Achievement rows carrying NO sales line at all — dropped, never mapped.
 *
 * `au.f_monthly_attribution`'s last branch emits every fact row whose `official_line` finds no entry
 * in `au.sos_official_line_map`, with `line_code` null and `unmapped_reason` 'unmapped_line'. In
 * production that is exactly ONE product: RY001 ROYANOXICAM 8MG 20 TAB, whose line is **Head
 * Office** — 104 rows and 10,458.00 EGP across 2026-01 … 2026-07, measured on production 2026-09-01.
 *
 * Head Office is not a tracked line. Monthly Closing never books it (`resolveTargetLineCode` answers
 * null and the line is skipped), and the golden rule is that Head Office is FILTERED before any
 * number is quoted — never given a line to make it tidy. Leaving these rows in is what made every
 * company-level total taken from this loader read high by their value while Monthly Closing read
 * correct: two reports disagreeing over money that belongs to neither of them.
 *
 * Dropped here, at the one chokepoint all six consumers of `loadAchievementRange` share, so the
 * answer cannot differ between the dashboard, the portal, Business Review and Employee 360 — and
 * before the cache, so a cached range can never replay the leak.
 *
 * Pure, so the rule is testable with no database.
 */
export function dropRowsWithNoSalesLine<Row extends { lineCode: string | null }>(
  rows: readonly Row[],
): Row[] {
  return rows.filter((row) => String(row.lineCode ?? "").trim().length > 0);
}

/**
 * The uncached RPC read + pure map. Body is byte-identical to the pre-cache loader.
 *
 * THE WIDE CALL IS THE TIMEOUT — never call this with a range wider than ONE month.
 *
 * PostgREST runs as `authenticator`, whose `statement_timeout` is **8 s** (read live from
 * pg_roles, production 2026-09-29). A floor-anchored range is already past half of that and
 * grows by a month every month, so the wide form does not fail occasionally — it fails on
 * schedule. Measured on production the same day, over 24h of edge logs for this one RPC:
 *
 *     722 calls  under 1.5 s   — the per-month reads, healthy
 *     323 calls  1.5 s - 8 s   — wide reads that happened to fit
 *     310 calls  >= 8 s        — wide reads killed by the timeout, returned to the user as 500
 *
 * That is 310 failed Sales vs Target renders a day, every one of them a wide call. The RPC costs
 * about the same in total either way (nine single months = 4,533 ms, the one wide call = 4,716 ms),
 * so splitting buys no database time — what it buys is that no single request can reach the
 * ceiling, and on a warm epoch eight of the nine months never leave the cache at all.
 *
 * The caller that used to pass a wide range was loadAchievementRange's null-token fallback, which
 * chose the most expensive call available at the one moment the system was already struggling.
 * It now fans out per month like the cached path. Pinned by tests/sales-vs-target-cache.test.ts.
 */
async function loadAchievementRangeUncached(from: string, to: string): Promise<AchievementRow[]> {
  const supabase = getSupabaseAdmin();
  const rows = await rpcAll<Record<string, unknown>>(
    supabase,
    "phx_sales_vs_target_range",
    { p_from: from, p_to: to },
    ["period", "line_code", "region_code", "area_code", "product_code"],
  );
  return dropRowsWithNoSalesLine(rows.map((row) => ({
    period: str(row.period),
    lineCode: str(row.line_code) || null,
    regionCode: str(row.region_code) || null,
    areaCode: str(row.area_code) || null,
    areaState: str(row.area_state) || null,
    isOther: row.is_other === true,
    repSeatId: str(row.rep_seat_id) || null,
    repHrId: str(row.rep_hr_id) || null,
    dmSeatId: str(row.dm_seat_id) || null,
    dmHrId: str(row.dm_hr_id) || null,
    productCode: str(row.product_code),
    actualUnits: num(row.actual_units),
    actualValue: num(row.actual_value),
    targetUnits: optNum(row.target_units),
    targetValue: optNum(row.target_value),
    achievementValue: optNum(row.achievement_value),
    achievementUnits: optNum(row.achievement_units),
    hasTarget: row.has_target === true,
    hasActual: row.has_actual === true,
  })));
}

/**
 * Concurrent reads of ONE token-keyed cache entry share a single run of `read`.
 *
 * `unstable_cache` does not dedupe a MISS: every caller that arrives before the first one has written
 * the entry runs the callback itself, so two portal pages rendering the same cold month paid the same
 * ~870 ms achievement read twice (2026-10-01, "slow to transfer between page and page"). This is the
 * keyed form of `singleFlight` (utils/single-flight.ts), which holds one slot: here it is one slot per
 * cache key, dropped the moment its run settles — resolved OR rejected — so it holds nothing
 * afterwards, is never a cache, and a failure reaches only the callers already waiting on it.
 *
 * Only for entries whose key carries the freshness token (the achievement stamp): a caller that
 * arrives after the data moved gets a different token, so a different key, and never joins a run that
 * began against the old data. Share a PACKED value and unpack it per caller, so no two callers ever
 * hold the same row objects.
 */
export function shareTokenKeyedRead<T>(
  flights: Map<string, Promise<T>>,
  keyParts: readonly string[],
  read: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify(keyParts);
  const pending = flights.get(key);
  if (pending) return pending;
  // A synchronous throw becomes a rejection of the shared run, exactly as in singleFlight.
  const started: Promise<T> = new Promise<T>((resolve) => resolve(read())).finally(() => {
    if (flights.get(key) === started) flights.delete(key);
  });
  flights.set(key, started);
  return started;
}

/** In-flight month reads, keyed by the full cache key — see shareTokenKeyedRead. */
const achievementMonthReadsInFlight = new Map<string, Promise<string | null>>();

/**
 * ONE month, from the cross-request cache, computed live only on a miss.
 *
 * The token in the key is the entire invalidation story — see loadAchievementCacheStamp. A null
 * pack means even compressed the month would not fit, so we read it live rather than hand the data
 * cache an entry that would take the dev server down; that null marker is itself cached for the
 * epoch, so the next caller skips straight to the live read instead of re-compressing a payload
 * already known not to fit.
 *
 * SHARED WHILE IN FLIGHT (2026-10-01, "slow to transfer between page and page"): concurrent callers
 * asking for the same month under the same token join one cache read — see shareTokenKeyedRead. The
 * key, the function and therefore every row are exactly what each caller would have read alone; each
 * caller still unpacks its own copy of the rows.
 */
async function loadAchievementMonth(period: string, token: string): Promise<AchievementRow[]> {
  const keyParts = achievementMonthCacheKeyParts(period, token);
  const packed = await shareTokenKeyedRead(achievementMonthReadsInFlight, keyParts, () =>
    unstable_cache(
      async () => packAchievementRows(await loadAchievementRangeUncached(period, period)),
      keyParts,
      // Tagged so a Product Master price edit expires it at once: the token does not see a price.
      { revalidate: ACHIEVEMENT_MONTH_CACHE_TTL_SECONDS, tags: [SALES_ACHIEVEMENT_STAMPED_CACHE_TAG] },
    )(),
  );
  if (packed === null) return loadAchievementRangeUncached(period, period);
  return unpackAchievementRows(packed);
}

/**
 * The same rows as loadVsTargetRange, bounded by the ENGINE's floor instead of the dashboard's.
 *
 * Identical query and identical mapping — the only difference is which floor rejects the range.
 * Reach for this from a surface that reports history (employee-360, the monthly dashboard, the
 * admin KPI, reconciliation, the Business Review); reach for loadVsTargetRange from
 * /sales-vs-target and anything that must obey the owner's July picker decision.
 *
 * Served a month at a time so overlapping ranges share their closed months — see the block comment
 * above ACHIEVEMENT_MONTH_CACHE_PREFIX for the measurements that forced the change.
 *
 * The concatenation is byte-identical to the old single-range read: rpcAll orders every call by
 * (period, line_code, region_code, area_code, product_code), period sorts first, and the months go
 * back in ascending order — so appending months in order reproduces exactly the sequence one wide
 * call produced. Callers that group or total are order-insensitive anyway, but Sales Truth
 * reconciliation compares row-for-row, so this is a contract and not an accident.
 */
export async function loadAchievementRange(from: string, to: string): Promise<AchievementRow[]> {
  if (!isValidHistoryPeriod(from) || !isValidHistoryPeriod(to) || to < from) return [];
  const periods = achievementPeriodsInRange(from, to);
  if (periods.length === 0) return [];
  // Self-invalidating cross-request cache. The token changes the cache key whenever actuals,
  // targets, or seat occupancy move — none of which share an invalidation chokepoint — so a
  // cache hit can never serve a stale rep/DM attribution. No token ⇒ read live (never stale).
  const token = await loadAchievementCacheStamp();
  // Bounded, and serial in development — a cold epoch is the only time any of these is a round
  // trip at all. asyncPool preserves input order, which is what makes the flat() below ordered.
  const months = await asyncPool(
    ACHIEVEMENT_MONTH_FETCH_CONCURRENCY,
    periods,
    // A null token means read live — but STILL one month per RPC. Never one wide call: see the
    // THE WIDE CALL IS THE TIMEOUT block above loadAchievementRangeUncached.
    (period) => (token ? loadAchievementMonth(period, token) : loadAchievementRangeUncached(period, period)),
  );
  return months.flat();
}

/**
 * The `${lineCode}|${areaCode}` pairs the canonical model says SHOULD carry a target.
 *
 * Not every untargeted area is a gap. Of the 106 line-area pairs with 2026-07 sales and no
 * target, 36 are "Other" areas (no DM, no rep, spillover geography) that carry no target by
 * design — 159,318 EGP. The real gap is the other 70, worth 1,823,610 EGP. Reporting both
 * as one number would send managers hunting for targets that were never meant to exist.
 */
export async function loadTargetBearingPairs(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("au_v_line_area_map")
    .select("line_code,area_code,carries_target")
    .eq("carries_target", true);
  if (error) throw error;
  const pairs = new Set<string>();
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
    const lineCode = str(record.line_code).trim();
    const areaCode = str(record.area_code).trim();
    if (lineCode && areaCode) pairs.add(`${lineCode}|${areaCode}`);
  }
  return pairs;
}

/** Brick-grain sales for one period. Sums exactly to the area totals in the range load. */
export async function loadBrickSales(period: string): Promise<BrickSalesRow[]> {
  if (!isValidVsTargetPeriod(period)) return [];
  const supabase = getSupabaseAdmin();
  const rows = await rpcAll<Record<string, unknown>>(
    supabase,
    "phx_sales_brick_detail",
    { p_period: period },
    ["line_code", "area_code", "brick_id"],
  );
  return rows.map((row) => ({
    period: str(row.period),
    lineCode: str(row.line_code) || null,
    regionCode: str(row.region_code) || null,
    areaCode: str(row.area_code) || null,
    areaState: str(row.area_state) || null,
    repSeatId: str(row.rep_seat_id) || null,
    repHrId: str(row.rep_hr_id) || null,
    dmSeatId: str(row.dm_seat_id) || null,
    dmHrId: str(row.dm_hr_id) || null,
    brickId: str(row.brick_id) || null,
    brickName: str(row.brick_name) || null,
    blockCode: str(row.block_code) || null,
    salesUnits: num(row.sales_units),
    salesValue: num(row.sales_value),
    directValue: num(row.direct_value),
    indirectValue: num(row.indirect_value),
  }));
}

/**
 * The `${lineCode}|${period}` pairs whose Monthly Closing has been PUBLISHED.
 *
 * Distributor files landing is necessary but not sufficient for a live dashboard to trust a
 * month: Monthly Closing publication is a separate, LATER, admin-gated action (see
 * monthly-closing-publication.ts) — the owner reconciles a line's numbers and clicks Publish
 * only once they are final. [Owner ruling, 2026-08-13]: the live "sales vs target" and keycard
 * dashboards must show a period ONLY once its Monthly Closing is published, per line — a blank
 * dashboard is the correct, intended state until then, never a live-but-unclosed number.
 *
 * This replaced the earlier "any real distributor upload landed" signal (loadUploadedPeriods),
 * which fixed the August-direct-order regression but still let the dashboard show a month's
 * raw, not-yet-reconciled figures for up to 12 days before that line's closing was actually
 * published (July 2026: Anti Infective published 2026-08-08, Pedia 2026-08-10, CNS 2026-08-12
 * — all landed their distributor files well before that).
 *
 * Deliberately NOT caught by the caller: an error boundary is recoverable, whereas an empty
 * set would make the UI assert that a published month was never published — the exact false
 * certainty this whole module exists to prevent.
 */
export async function loadPublishedPeriodKeys(from: string, to: string): Promise<Set<string>> {
  if (!isValidVsTargetPeriod(from) || !isValidVsTargetPeriod(to) || to < from) return new Set();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("monthly_closing_publications")
    .select("line,period")
    .gte("period", from)
    .lte("period", to)
    // Currently published only. This is a VISIBILITY gate, so a month withdrawn from the portal
    // must go dark here too — the row now survives an unpublish (20260907140000), and without
    // this filter a withdrawn month would keep lighting the dashboard.
    .is("unpublished_at", null);
  if (error) throw error;
  return publishedPeriodKeysOf((data ?? []) as Record<string, unknown>[]);
}

/**
 * Source-of-Sales distributor codes that are not a distributor at all.
 *
 * `DirectReq` is the pseudo-distributor the Direct Orders module injects approved orders
 * under; `DIRECT` is the legacy manual direct upload. Both write into Source of Sales one
 * order at a time, all month long. Neither is evidence that the month's distributor files
 * have arrived.
 */
const NON_DISTRIBUTOR_BATCH_CODES = new Set(["direct", "directreq"]);

/**
 * The uploaded-month ledger over the engine's floor, for history-reporting surfaces.
 *
 * Every surface that sums more than one month needs this, not `has_actual` — the August 2026
 * single direct order documented above is not a hypothetical, and a cumulative window that
 * trusts `has_actual` divides July's real sales by July+August's targets.
 */
export async function loadUploadedPeriodsInRange(from: string, to: string): Promise<Set<string>> {
  if (!isValidHistoryPeriod(from) || !isValidHistoryPeriod(to) || to < from) return new Set();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_import_batches")
    .select("period,distributor_code")
    .gte("period", from)
    .lte("period", to);
  if (error) throw error;
  return uploadedPeriodsOf((data ?? []) as Record<string, unknown>[]);
}

/**
 * Pure half of the loader, so the direct-order exclusion is testable without a database.
 *
 * Returns BARE periods (`2026-07`), not the `lineCode|period` keys publishedPeriodKeysOf
 * returns. The two sets are not interchangeable and a merge once silently swapped them, which
 * types cannot catch — both are Set<string> — and which empties every history surface, since
 * `.has("2026-07")` never matches `"cns|2026-07"`.
 */
export function uploadedPeriodsOf(batches: Array<Record<string, unknown>>): Set<string> {
  const periods = new Set<string>();
  for (const batch of batches) {
    const period = str(batch.period).trim();
    // Case-insensitive: the ledger holds both `DIRECT` and `DirectReq`.
    const code = str(batch.distributor_code).trim().toLowerCase();
    if (!period || NON_DISTRIBUTOR_BATCH_CODES.has(code)) continue;
    periods.add(period);
  }
  return periods;
}

/**
 * Pure half of the loader, so the line-spelling resolution is testable without a database.
 *
 * `monthly_closing_publications.line` holds the verbatim official Source-of-Sales line label
 * ("Anti Infective", "CNS", "Pedia" — see monthly-closing-portal.ts), not the short code
 * AchievementRow carries. resolveTargetLineCode is the SAME resolver the Closing Matrix itself
 * uses to look up targets for a line it is showing, so this cannot drift into its own second
 * definition of "which line is this". A row whose `line` text does not resolve is silently
 * dropped — fail SAFE, matching monthly-closing-publication.ts's own convention: a wiring or
 * spelling problem must read as "not published", never crash the dashboard or, worse, publish
 * everything.
 */
export function publishedPeriodKeysOf(closings: Array<Record<string, unknown>>): Set<string> {
  const keys = new Set<string>();
  for (const closing of closings) {
    const period = str(closing.period).trim();
    const lineCode = resolveTargetLineCode(str(closing.line));
    if (!period || !lineCode) continue;
    keys.add(`${lineCode}|${period}`);
  }
  return keys;
}

/** True when a row's own (line, period) has a published Monthly Closing. */
export function isRowPublished(
  row: Pick<AchievementRow, "lineCode" | "period">,
  publishedKeys: ReadonlySet<string>,
): boolean {
  return row.lineCode != null && publishedKeys.has(`${row.lineCode}|${row.period}`);
}

/**
 * The month the dashboard opens on.
 *
 * Two conditions, BOTH required: the month's (line-scoped) Monthly Closing is published, and
 * this viewer has sales inside it. Ranking on sales alone is what put the whole company on
 * August's single direct order; ranking on "any distributor file landed" is what kept showing
 * a month's raw figures for up to 12 days before that line's owner actually published them.
 *
 * When the viewer has no sales in any published month we still open on the newest PUBLISHED
 * month rather than on the newest month carrying any row at all: "nothing in your scope" is a
 * fact the viewer can act on, a confident 0% against a month nobody has closed is not.
 * `fallback` (the current month) is reached only when nothing has been published at all.
 */
export function pickLandingPeriod(
  rows: AchievementRow[],
  publishedKeys: ReadonlySet<string>,
  fallback: string,
): string {
  let withSales: string | null = null;
  for (const row of rows) {
    if (!row.hasActual || !isRowPublished(row, publishedKeys)) continue;
    if (withSales == null || row.period > withSales) withSales = row.period;
  }
  if (withSales) return withSales;

  let newestPublished: string | null = null;
  for (const key of publishedKeys) {
    const period = key.slice(key.indexOf("|") + 1);
    if (!period) continue;
    if (newestPublished == null || period > newestPublished) newestPublished = period;
  }
  return newestPublished ?? fallback;
}

/**
 * One month of a viewer's bound-scoped rows, divided at the Monthly Closing publication gate.
 *
 * `rows` keeps only the rows whose own (line, period) closing is PUBLISHED, and every sales figure
 * the dashboard shows is built from `rows` alone — so a month nobody has published never shows a
 * sale, however many raw rows it already holds.
 *
 * The two pending figures are what the "not published yet" panel quotes instead, and both come from
 * the RAW rows because nothing else carries them. `totals` is built from `rows`, so for an
 * unpublished month its target is 0 by construction: the panel's "a target of … is already loaded"
 * sentence read `totals.targetValue` and could never render — confirmed on production 2026-09-16,
 * where a CNS medical rep's September carried a 300,085.04 EGP target. Both figures are 0 once the
 * month is published, when the same money and target sit inside `totals` instead.
 */
export function splitPeriodAtPublication(
  rawRowsForPeriod: AchievementRow[],
  publishedKeys: ReadonlySet<string>,
): {
  rows: AchievementRow[];
  salesLoaded: boolean;
  pendingDirectValue: number;
  pendingTargetValue: number;
} {
  const rows = rawRowsForPeriod.filter((row) => isRowPublished(row, publishedKeys));
  const salesLoaded = rows.length > 0;
  return {
    rows,
    salesLoaded,
    pendingDirectValue: salesLoaded
      ? 0
      : rawRowsForPeriod.reduce((sum, row) => sum + row.actualValue, 0),
    // The target only, never the actual: a target is not a sale, so quoting it shows nothing the
    // publication gate is holding back.
    pendingTargetValue: salesLoaded
      ? 0
      : rawRowsForPeriod.reduce((sum, row) => sum + (row.targetValue ?? 0), 0),
  };
}

// ── Totals with target-coverage accounting ───────────────────────────────────

export type VsTargetTotals = {
  actualValue: number;
  actualUnits: number;
  targetValue: number;
  targetUnits: number;
  /**
   * Actual inside a month this group carries a target in — the numerator achievement % uses.
   *
   * Not "actual on a key that has a target": inside a targeted month EVERY pound counts, because
   * that is what the Monthly Closing divides. The month is the only thing that excludes anything,
   * and it excludes whole months rather than keys. See rule 2 in the header.
   */
  gradedActualValue: number;
  /** The same rule in units, so achievementUnits divides like-for-like as value does. */
  gradedActualUnits: number;
  /** Actual sitting on a key that HAS a target. A coverage statistic, no longer a numerator. */
  coveredActualValue: number;
  /** The same, in units. */
  coveredActualUnits: number;
  /** Actual with no target row anywhere. Reported beside the %, never inside it. */
  uncoveredActualValue: number;
  /** Distinct (line, area, product) keys with a target, and without. */
  coveredKeys: number;
  uncoveredKeys: number;
  /** null when there is no target to divide by. NEVER 0, never Infinity. */
  achievementValue: number | null;
  achievementUnits: number | null;
};

export function emptyTotals(): VsTargetTotals {
  return {
    actualValue: 0,
    actualUnits: 0,
    targetValue: 0,
    targetUnits: 0,
    gradedActualValue: 0,
    gradedActualUnits: 0,
    coveredActualValue: 0,
    coveredActualUnits: 0,
    uncoveredActualValue: 0,
    coveredKeys: 0,
    uncoveredKeys: 0,
    achievementValue: null,
    achievementUnits: null,
  };
}

/**
 * Fold one row into a running total.
 *
 * Achievement is NOT accumulated — it is recomputed from the sums by sealTotals. Adding
 * up per-row percentages averages a 10%-achieving product with a 400%-achieving one and
 * calls it 205%, which is wrong at every level above the row.
 */
function addRow(total: VsTargetTotals, row: AchievementRow, gradedPeriods: ReadonlySet<string>): void {
  total.actualValue += row.actualValue;
  total.actualUnits += row.actualUnits;
  total.targetValue += row.targetValue ?? 0;
  total.targetUnits += row.targetUnits ?? 0;
  // The month decides, not the key. A row with no target of its own still counts when the group
  // was targeted that month — that is the closing including an untargeted area in its line total.
  if (gradedPeriods.has(row.period)) {
    total.gradedActualValue += row.actualValue;
    total.gradedActualUnits += row.actualUnits;
  }
  if (row.hasTarget) {
    total.coveredActualValue += row.actualValue;
    total.coveredActualUnits += row.actualUnits;
    total.coveredKeys += 1;
  } else {
    total.uncoveredActualValue += row.actualValue;
    total.uncoveredKeys += 1;
  }
}

/**
 * The months this set of rows carries a target in — the only months an achievement may count.
 *
 * Computed per GROUP, from that group's own rows, because the question is "was THIS team targeted
 * in that month", not "did anyone have a target somewhere". A region with no February target must
 * not have its February sales graded against another region's February.
 *
 * Exported so a caller that grades at a DIFFERENT grain can compute the set ONCE and hand it to
 * every `totalRows` beneath it — see the override on `totalRows` below.
 */
export function gradedPeriodsOf(rows: readonly AchievementRow[]): Set<string> {
  const periods = new Set<string>();
  for (const row of rows) if ((row.targetValue ?? 0) > 0) periods.add(row.period);
  return periods;
}

/**
 * Compute the percentages once the sums are final.
 *
 * A zero target yields null, not 0 and not Infinity: "no target set" and "achieved
 * nothing against a real target" are different facts and the UI renders them
 * differently. Targets are never negative, but actuals can be (returns and credit notes
 * — Anti-Infective/Haram-Faisal was −32,166 EGP in 2026-07), so a negative achievement
 * is legitimate and is left alone.
 *
 * BOTH percentages divide the GRADED actual by the target, so value and units answer the same
 * question. They divided the COVERED actual until 2026-09-05, which is what made this screen
 * disagree with the Monthly Closing; see rule 2 in the header for the owner's ruling and the
 * measurements behind it.
 */
function sealTotals(total: VsTargetTotals): VsTargetTotals {
  total.achievementValue = total.targetValue !== 0 ? total.gradedActualValue / total.targetValue : null;
  total.achievementUnits = total.targetUnits !== 0 ? total.gradedActualUnits / total.targetUnits : null;
  return total;
}

/**
 * Total a set of rows, with coverage accounting.
 *
 * `gradedPeriods` overrides which months may contribute to the numerator. Omit it and the set is
 * computed from these rows alone — "was THIS team targeted that month", the right question for a
 * total that stands on its own, and what every caller outside the Business Review wants.
 *
 * Pass one when a WIDER unit owns that decision. The Business Review does: owner ruling
 * 2026-09-26, every level of a line grades against the LINE's targeted months, because the
 * Monthly Closing grades a line. Without the override an area untargeted in a month its line WAS
 * targeted in drops that month's sales from its own numerator while the line keeps them, so the
 * areas stop summing to the line — measured on production for Jul–Aug 2026, summing the areas
 * read 70.12% where the line rule reads 74.35%: a 1,598,667 EGP hole in the numerator, and two
 * different company achievements on two screens of one module.
 */
export function totalRows(rows: AchievementRow[], gradedPeriods?: ReadonlySet<string>): VsTargetTotals {
  const total = emptyTotals();
  const graded = gradedPeriods ?? gradedPeriodsOf(rows);
  for (const row of rows) addRow(total, row, graded);
  return sealTotals(total);
}

/** Share of actual value that has a target beside it. null when there is no actual. */
export function coverageRatio(total: VsTargetTotals): number | null {
  const denominator = total.coveredActualValue + total.uncoveredActualValue;
  return denominator !== 0 ? total.coveredActualValue / denominator : null;
}

// ── Hierarchy roll-up ────────────────────────────────────────────────────────

export type VsTargetLevel = "team" | "region" | "area" | "rep" | "brick";

export type VsTargetNode = {
  /** Stable identity for React keys and drill-down links. Never rendered. */
  key: string;
  /** What the user reads. Always a name — never a code (owner standing rule). */
  name: string;
  level: VsTargetLevel;
  current: VsTargetTotals;
  /** null when the selected period has no prior period (July 2026) — not zero. */
  prior: VsTargetTotals | null;
  /** Fractional change in actual value vs prior. null when there is no prior, or prior was 0. */
  growth: number | null;
};

/**
 * Growth vs the prior period.
 *
 * null (not 0, not Infinity) when there is no prior period or the prior was zero —
 * "grew from nothing" is not a percentage, and rendering it as +100% or ∞ invites the
 * field force to argue with the dashboard.
 */
export function growthOf(current: VsTargetTotals, prior: VsTargetTotals | null): number | null {
  if (!prior || prior.actualValue === 0) return null;
  return (current.actualValue - prior.actualValue) / Math.abs(prior.actualValue);
}

type NodeSpec = {
  level: VsTargetLevel;
  /** Grouping key, or null to drop the row from this level entirely. */
  keyOf: (row: AchievementRow) => string | null;
  /** Code → display name. Falls back to a readable label, never to a bare code. */
  nameOf: (key: string) => string;
};

/**
 * Roll rows up one level, pairing each node with its prior-period self.
 *
 * `priorRows` must already be scoped exactly like `rows`, or a manager sees this month
 * bounded to their territory and last month bounded to the company.
 */
export function rollupLevel(
  rows: AchievementRow[],
  priorRows: AchievementRow[] | null,
  spec: NodeSpec,
): VsTargetNode[] {
  // Bucketed BEFORE folding, because the graded months are a property of the group rather than of
  // the row: a node is graded in a month only if that node itself was targeted in it. Streaming
  // rows straight into a running total cannot know that until every row has been seen.
  const fold = (source: AchievementRow[]) => {
    const grouped = new Map<string, AchievementRow[]>();
    for (const row of source) {
      const key = spec.keyOf(row);
      if (key == null) continue;
      const bucket = grouped.get(key);
      if (bucket) bucket.push(row);
      else grouped.set(key, [row]);
    }
    const totals = new Map<string, VsTargetTotals>();
    for (const [key, rows] of grouped) totals.set(key, totalRows(rows));
    return totals;
  };

  const currentTotals = fold(rows);
  const priorTotals = priorRows ? fold(priorRows) : null;

  return [...currentTotals.entries()]
    .map(([key, current]) => {
      const prior = priorTotals ? priorTotals.get(key) ?? emptyTotals() : null;
      return {
        key,
        name: spec.nameOf(key),
        level: spec.level,
        current,
        prior,
        growth: growthOf(current, prior),
      };
    })
    .sort((left, right) => right.current.actualValue - left.current.actualValue);
}

/** Resolvers the roll-ups need to turn codes into the names the owner insists on seeing. */
export type VsTargetNames = {
  lineName: (code: string) => string;
  regionName: (code: string) => string;
  areaName: (code: string) => string;
  employeeName: (hrId: string) => string;
};

/** Team = sales line (CNS / Pedia / Anti-infective). */
export function rollupByTeam(rows: AchievementRow[], prior: AchievementRow[] | null, names: VsTargetNames) {
  return rollupLevel(rows, prior, {
    level: "team",
    keyOf: (row) => row.lineCode,
    nameOf: names.lineName,
  });
}

export function rollupByRegion(rows: AchievementRow[], prior: AchievementRow[] | null, names: VsTargetNames) {
  return rollupLevel(rows, prior, {
    level: "region",
    keyOf: (row) => row.regionCode,
    nameOf: names.regionName,
  });
}

export function rollupByArea(rows: AchievementRow[], prior: AchievementRow[] | null, names: VsTargetNames) {
  return rollupLevel(rows, prior, {
    level: "area",
    keyOf: (row) => row.areaCode,
    nameOf: names.areaName,
  });
}

/**
 * Per medical rep.
 *
 * Rows with no resolved occupant are dropped rather than bucketed: a vacant area's sales
 * are real and appear at area level, but inventing a "rep" for them would put another
 * person's numbers under a name that does not exist. The area roll-up is where that
 * value stays visible.
 */
export function rollupByRep(rows: AchievementRow[], prior: AchievementRow[] | null, names: VsTargetNames) {
  return rollupLevel(rows, prior, {
    level: "rep",
    keyOf: (row) => row.repHrId,
    nameOf: names.employeeName,
  });
}

/** Per district manager. */
export function rollupByDm(rows: AchievementRow[], prior: AchievementRow[] | null, names: VsTargetNames) {
  return rollupLevel(rows, prior, {
    level: "rep",
    keyOf: (row) => row.dmHrId,
    nameOf: names.employeeName,
  });
}

/**
 * Add finished totals together and recompute the percentages from the sums — never an average of
 * percentages (see addRow). Every field is a plain sum, so the result is exactly what the parts say.
 */
function sumTotals(parts: readonly VsTargetTotals[]): VsTargetTotals {
  const total = emptyTotals();
  for (const part of parts) {
    total.actualValue += part.actualValue;
    total.actualUnits += part.actualUnits;
    total.targetValue += part.targetValue;
    total.targetUnits += part.targetUnits;
    total.gradedActualValue += part.gradedActualValue;
    total.gradedActualUnits += part.gradedActualUnits;
    total.coveredActualValue += part.coveredActualValue;
    total.coveredActualUnits += part.coveredActualUnits;
    total.uncoveredActualValue += part.uncoveredActualValue;
    total.coveredKeys += part.coveredKeys;
    total.uncoveredKeys += part.uncoveredKeys;
  }
  return sealTotals(total);
}

/**
 * Per Regional Manager (owner, 2026-10-20: Sales vs Target had no Regional Manager level).
 *
 * A Regional Manager's node is the SUM of the district-manager nodes beneath him and nothing else.
 * Rows are grouped by the Regional Manager `regionalManagerOf` names (the occupied RSM seat over the
 * row's DM seat), then by district manager inside him; each district manager's slice is totalled
 * exactly as rollupByDm totals it, and his node adds those totals up — sales value, target value and
 * the graded actual alike — so his % is the one his districts' sums give, recomputed, never averaged.
 * No figure is re-derived: every number is a Monthly Closing value already on a row.
 *
 * A row with no seated district manager (a vacant district) is left out on purpose: it has no
 * district-manager node either, so including it would make his row read more than the districts the
 * District Managers level lists. Pure — the caller supplies the seat lookup.
 */
export function rollupByRegionalManager(
  rows: AchievementRow[],
  priorRows: AchievementRow[] | null,
  names: VsTargetNames,
  regionalManagerOf: (row: AchievementRow) => string | null,
): VsTargetNode[] {
  const fold = (source: AchievementRow[]) => {
    const grouped = new Map<string, Map<string, AchievementRow[]>>();
    for (const row of source) {
      if (!row.dmHrId) continue;
      const regionalManager = regionalManagerOf(row);
      if (!regionalManager) continue;
      let byDm = grouped.get(regionalManager);
      if (!byDm) {
        byDm = new Map();
        grouped.set(regionalManager, byDm);
      }
      const bucket = byDm.get(row.dmHrId);
      if (bucket) bucket.push(row);
      else byDm.set(row.dmHrId, [row]);
    }
    const totals = new Map<string, VsTargetTotals>();
    for (const [regionalManager, byDm] of grouped) {
      totals.set(regionalManager, sumTotals([...byDm.values()].map((dmRows) => totalRows(dmRows))));
    }
    return totals;
  };

  const currentTotals = fold(rows);
  const priorTotals = priorRows ? fold(priorRows) : null;

  return [...currentTotals.entries()]
    .map(([key, current]) => {
      const prior = priorTotals ? priorTotals.get(key) ?? emptyTotals() : null;
      return {
        key,
        name: names.employeeName(key),
        // The same level the District Managers roll-up carries: a person-level node.
        level: "rep" as const,
        current,
        prior,
        growth: growthOf(current, prior),
      };
    })
    .sort((left, right) => right.current.actualValue - left.current.actualValue);
}

/**
 * Per product, across whatever scope the caller already filtered to.
 *
 * The first build had no product dimension at all, which left the page with a one-bar
 * "trend" occupying a third of the screen and nothing to actually analyse. Product mix is
 * the densest real analysis available from rows we have already loaded — no extra query.
 */
export function rollupByProduct(
  rows: AchievementRow[],
  prior: AchievementRow[] | null,
  productName: (code: string) => string,
) {
  return rollupLevel(rows, prior, {
    level: "team",
    keyOf: (row) => (row.productCode ? row.productCode : null),
    nameOf: productName,
  });
}

/**
 * The N best and N worst nodes by achievement.
 *
 * Nodes with no target are excluded from BOTH ends rather than sorted as zero: an area
 * nobody set a target for is not the worst performer in the company, and putting it at the
 * bottom of a leaderboard is exactly the libel the coverage split exists to prevent.
 */
export function rankByAchievement(nodes: VsTargetNode[], count: number): { top: VsTargetNode[]; bottom: VsTargetNode[] } {
  const measurable = nodes.filter((node) => node.current.achievementValue != null);
  const sorted = [...measurable].sort(
    (left, right) => (right.current.achievementValue ?? 0) - (left.current.achievementValue ?? 0),
  );
  const top = sorted.slice(0, count);
  // Take from the end, then reverse so the worst reads first.
  const bottom = sorted.slice(Math.max(0, sorted.length - count)).reverse();
  // With fewer nodes than 2*count the two lists would overlap and show the same row twice.
  const topKeys = new Set(top.map((node) => node.key));
  return { top, bottom: bottom.filter((node) => !topKeys.has(node.key)) };
}

// ── Brick roll-up ────────────────────────────────────────────────────────────

export type BrickNode = {
  key: string;
  name: string;
  blockCode: string | null;
  salesValue: number;
  salesUnits: number;
  directValue: number;
  indirectValue: number;
  priorSalesValue: number | null;
  growth: number | null;
  /** True when the source rows carried no brick — shown as "No brick recorded". */
  isUnassigned: boolean;
};

/** Sentinel key for sales inside an area that carried no brick id at all. */
const UNASSIGNED_BRICK_KEY = "\u0000no-brick";

/**
 * Bricks for one area, paired with the prior period.
 *
 * Sales with no brick id are kept under an explicit "No brick recorded" node — 73 rows
 * worth 10,772.98 EGP in 2026-07. Dropping them would make the brick list quietly fail
 * to sum to the area total the rep sees one level up.
 */
export function rollupBricks(
  rows: BrickSalesRow[],
  priorRows: BrickSalesRow[] | null,
): BrickNode[] {
  const fold = (source: BrickSalesRow[]) => {
    const map = new Map<string, { name: string | null; blockCode: string | null; value: number; units: number; direct: number; indirect: number }>();
    for (const row of source) {
      const key = row.brickId ?? UNASSIGNED_BRICK_KEY;
      const entry = map.get(key) ?? { name: row.brickName, blockCode: row.blockCode, value: 0, units: 0, direct: 0, indirect: 0 };
      entry.value += row.salesValue;
      entry.units += row.salesUnits;
      entry.direct += row.directValue;
      entry.indirect += row.indirectValue;
      if (!entry.name && row.brickName) entry.name = row.brickName;
      map.set(key, entry);
    }
    return map;
  };

  const current = fold(rows);
  const prior = priorRows ? fold(priorRows) : null;

  return [...current.entries()]
    .map(([key, entry]) => {
      const isUnassigned = key === UNASSIGNED_BRICK_KEY;
      const priorValue = prior ? prior.get(key)?.value ?? 0 : null;
      return {
        key,
        // Never fall back to the brick id: a code in the name column is the one thing
        // the owner has ruled out everywhere in the UI.
        name: isUnassigned ? "No brick recorded" : entry.name ?? "Unnamed brick",
        blockCode: entry.blockCode,
        salesValue: entry.value,
        salesUnits: entry.units,
        directValue: entry.direct,
        indirectValue: entry.indirect,
        priorSalesValue: priorValue,
        growth: priorValue != null && priorValue !== 0 ? (entry.value - priorValue) / Math.abs(priorValue) : null,
        isUnassigned,
      };
    })
    .sort((left, right) => right.salesValue - left.salesValue);
}

// ── Trend ────────────────────────────────────────────────────────────────────

export type TrendPoint = {
  period: string;
  actualValue: number;
  targetValue: number;
  coveredActualValue: number;
  achievementValue: number | null;
};

/**
 * One point per period in the loaded range, oldest first.
 *
 * Periods present in the range but carrying no rows still get a point, so a month with
 * no uploaded sales renders as a visible gap the viewer can question rather than
 * silently vanishing from the axis.
 */
export function buildTrend(rows: AchievementRow[], periods: string[]): TrendPoint[] {
  // One point is one month, so the across-months rule cannot bite here: a month with a target
  // grades all of its own sales, and a month without one has no target to divide by and reads
  // null either way. Grouped rather than streamed so each point takes the same `totalRows` path
  // every other figure on the page takes — one definition of achievement, not two.
  const byPeriod = new Map<string, AchievementRow[]>();
  for (const period of periods) byPeriod.set(period, []);
  for (const row of rows) byPeriod.get(row.period)?.push(row);
  return periods.map((period) => {
    const total = totalRows(byPeriod.get(period) ?? []);
    return {
      period,
      actualValue: total.actualValue,
      targetValue: total.targetValue,
      coveredActualValue: total.coveredActualValue,
      achievementValue: total.achievementValue,
    };
  });
}

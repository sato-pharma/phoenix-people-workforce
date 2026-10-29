// Business Review — read-only service layer, multi-line (Pedia, CNS, Anti-Infective).
//
// This module is what the pages call. It resolves the requested window, builds the whole review
// once, and exposes the cross-line views and the incentive-curve helpers on top of it.
//
// EVERY FIGURE IS LIVE AND WINDOW-SCOPED. Sales, targets and achievement come from the canonical
// engine; marketing, outstation, CRM visits, double visits, customers and per-role activity come
// from their own production tables. No committed workbook feeds a number any more.
//
// CACHING — READ THIS BEFORE CHANGING THE KEY OR THE TTL
//
// The bundle is cached, gzipped, under a size guard. Three things that guard is there for:
//
//  1. A Next data-cache entry over 2 MB THROWS FROM A DETACHED PROMISE — uncatchable — and takes
//     the dev server down with it, while production merely stops caching in silence. That is what
//     commit ef1abfdf paid for on the achievement range. A six-month, three-line bundle with a
//     thousand people in it is not obviously under the ceiling, so it is compressed and measured,
//     and anything over the ceiling is rebuilt live rather than stored.
//  2. The cache key carries the sales freshness stamp, so any change to actuals, targets or seat
//     occupancy lands immediately.
//  3. That stamp does NOT cover marketing, outstation, CRM or the employee directory. Nothing in
//     this repo stamps those, so the TTL — not the stamp — is what bounds their staleness, and it
//     is deliberately short. A review opened twice in a minute must not cost two CRM range reads;
//     a visit logged this morning must show up this morning. If you lengthen the TTL, you are
//     lengthening exactly that window, and the Coverage tab will not know to say so.
//
// Incentive tiers come from the LOCKED 2026 scheme (imported, never modified). Applying that
// curve to a RESTATED window is why REVIEW_SOURCE_NOTICE exists — see canonical.ts.

import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { unstable_cache } from "next/cache";

import { calculateIncentive2026 } from "@/lib/incentives/scheme-2026";
import type { SourceMaskViewer } from "@/lib/sales/closing-source-mask";
import { isDegraded, serveWithoutCaching, servedWithoutCachingValue } from "@/lib/cache/serve-uncached";
import { SALES_ACHIEVEMENT_STAMPED_CACHE_TAG } from "@/lib/dashboard/invalidation";
import { loadAchievementCacheStamp, shareTokenKeyedRead } from "@/lib/sales/vs-target";

import {
  availableReviewPeriods,
  loadReviewBundle,
  OFFICIAL_LINE,
  REVIEW_LINE_CODES,
  REVIEW_SOURCE_NOTICE,
  REVIEW_THRESHOLDS,
  type ReviewBundle,
  type ReviewLine,
} from "./canonical";
import { concentrationPeriods, type ReviewCoverage } from "./coverage";
import { resolveReviewWindow, type ReviewWindow, type WindowResolution } from "./period";
import { loadClosingDetailFacts, type ClosingDetailLoad } from "./sources/closing-detail";
import type { AreaSummary, DmSummary, ProductRow, ReviewCompany, ReviewDataset } from "./types";
import {
  DEFAULT_REVIEW_VIEW,
  isReviewView,
  REVIEW_LINES,
  REVIEW_VIEWS,
  type ReviewView,
} from "./review-views";

export type { ReviewLine, ReviewWindow };
export { availableReviewPeriods, REVIEW_LINE_CODES, REVIEW_SOURCE_NOTICE, REVIEW_THRESHOLDS };
export type BusinessReview = ReviewBundle;

// The view switcher's option list lives in ./review-views.ts (a dependency-free module) for the
// same reason official-lines.ts does: the Business Review dashboard is a CLIENT component that
// needs REVIEW_VIEWS but not this file's server-only review builder. Re-exported here so every
// existing server caller keeps importing from where it already does.
export { DEFAULT_REVIEW_VIEW, isReviewView, REVIEW_LINES, REVIEW_VIEWS, type ReviewView };

// ───────────────────────────────── cache plumbing ─────────────────────────────────

const BUNDLE_CACHE_PREFIX = "business-review-bundle";
/** Short on purpose — see the caching note at the top of this file. */
const BUNDLE_CACHE_TTL_SECONDS = 300;
/** Next's own data-cache ceiling is 2 MB; stop well short of it. */
const BUNDLE_CACHE_MAX_BYTES = 1_500_000;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** The bundle is plain JSON throughout (no Set, no Map, no Date). The source modules hold those
 *  shapes but every one is folded to a Record or an array before it reaches `ReviewBundle`. If
 *  that ever stops being true, this round trip is where it will show. */
async function packBundle(bundle: ReviewBundle): Promise<string | null> {
  const packed = (await gzipAsync(JSON.stringify(bundle))).toString("base64");
  return packed.length > BUNDLE_CACHE_MAX_BYTES ? null : packed;
}

async function unpackBundle(packed: string): Promise<ReviewBundle> {
  const json = (await gunzipAsync(Buffer.from(packed, "base64"))).toString("utf8");
  return JSON.parse(json) as ReviewBundle;
}

/** Exported ONLY so a test can pin that the freshness stamp participates in the key: drop it and
 *  two reads taken either side of a target load would collide on the same entry. The array order
 *  IS the cache key — do not reorder casually. */
export function reviewBundleCacheKeyParts(
  window: ReviewWindow,
  adjustment: string | null,
  stamp: string,
): string[] {
  return [BUNDLE_CACHE_PREFIX, window.from, window.to, adjustment ?? "-", stamp];
}

/**
 * Bundle cache reads in flight, keyed by the full cache key. The key carries the achievement stamp,
 * so a render arriving after the sales moved never joins a build that began before — see
 * shareTokenKeyedRead. What is shared is the PACKED string; every caller unpacks its own bundle.
 */
const bundleReadsInFlight = new Map<string, Promise<string | null>>();

// ───────────────────────────────── the entry point ─────────────────────────────────

export type BusinessReviewResult = {
  review: BusinessReview;
  /** What the resolver did with the requested range, if anything — the page shows this. */
  resolution: WindowResolution;
  /** Every month the review can be asked about, ascending. Feeds the two filter selects. */
  available: string[];
};

/**
 * Load the whole review for a requested window — all three lines, the company rollup, the
 * coverage block and the provenance — in ONE canonical range call.
 *
 * `from`/`to` are raw request parameters and may be anything at all. They are resolved, never
 * trusted: an out-of-range, reversed, malformed or absent range CLAMPS to something real and
 * reports what it changed in `resolution`, so a bookmarked or hand-typed URL degrades to a
 * labelled window instead of a crash or a blank page with no explanation.
 *
 * Call this once per render and pass the result down. Calling it per line would run the
 * attribution pass three times over the same months, and every round trip crosses to
 * eu-central-1.
 */
export async function loadBusinessReview(input?: {
  from?: string | null;
  to?: string | null;
}): Promise<BusinessReviewResult> {
  // READ TOGETHER (2026-10-01, "slow to transfer between page and page"): the month list and the
  // freshness stamp are two independent reads — the stamp does not depend on the window — and
  // neither can throw (each answers [] / null on failure), so one round trip's wait instead of two.
  const [available, stamp] = await Promise.all([availableReviewPeriods(), loadAchievementCacheStamp()]);
  const resolution = resolveReviewWindow(input?.from ?? null, input?.to ?? null, available);
  const { window, adjustment } = resolution;

  // No stamp ⇒ build live rather than risk serving a stale attribution. Slow-but-correct.
  if (!stamp) return { review: await loadReviewBundle(window, adjustment), resolution, available };

  // SHARED WHILE IN FLIGHT: two viewers opening the same window together join one cache read instead
  // of each building the whole bundle on a miss. Same key, same builder, same bundle.
  const keyParts = reviewBundleCacheKeyParts(window, adjustment, stamp);
  let packed: string | null;
  try {
    packed = await shareTokenKeyedRead(bundleReadsInFlight, keyParts, () =>
      unstable_cache(
        async () => {
          const bundle = await loadReviewBundle(window, adjustment);
          // A source that failed to read (visits, marketing, outstation, the directory) says "no
          // data" on this render, and must not keep saying it for five minutes: served, never kept.
          if (isDegraded(bundle)) serveWithoutCaching(bundle, "a Business Review source failed to read");
          return packBundle(bundle);
        },
        keyParts,
        // Tagged so a Product Master price edit expires it at once: the stamp does not see a price.
        { revalidate: BUNDLE_CACHE_TTL_SECONDS, tags: [SALES_ACHIEVEMENT_STAMPED_CACHE_TAG] },
      )(),
    );
  } catch (error) {
    const served = servedWithoutCachingValue<ReviewBundle>(error);
    if (!served) throw error;
    return { review: served.value, resolution, available };
  }
  // null means this window does not fit even compressed, so nothing usable was stored. Build live:
  // correct-but-slow is the right trade against handing the data cache an entry that would take
  // the process down. The null marker itself is cached, so later calls skip straight to here.
  if (packed === null) {
    return { review: await loadReviewBundle(window, adjustment), resolution, available };
  }
  return { review: await unpackBundle(packed), resolution, available };
}

/**
 * The closing's customer-grain rows for this window — brick, customer and channel.
 *
 * 🔴 NOT CACHED, AND THAT IS THE POINT. `loadBusinessReview` above is wrapped in
 * `unstable_cache` keyed on the window and the achievement stamp and NOTHING ABOUT THE VIEWER,
 * because every figure in that bundle is the same for everyone who may open the page. These rows
 * are not: El Qema's are removed for everyone but the Super Admin. One Super Admin request
 * populating a shared entry that a district manager is then served would leak the source through a
 * concentration share, which is exactly what the mask exists to prevent. A line's customer list
 * also runs to thousands of rows a month, and a >2MB `unstable_cache` entry throws in development,
 * uncatchably, only there.
 *
 * Cut to the FIGURE window, never the requested one — a month whose distributor files have not
 * landed is held out of every other figure on the page, and letting it into this one would put a
 * brick on a chart the achievement beside it does not know about.
 */
export async function loadReviewConcentration(input: {
  coverage: Pick<ReviewCoverage, "figureWindow" | "notUploaded" | "window">;
  viewer: SourceMaskViewer;
  /**
   * The review lines whose rows the caller will read. Omitted = all three, which is what the pack
   * route and every other existing caller get, unchanged.
   *
   * NARROWED TO WHAT THE CALLER KEEPS (2026-10-01, "slow to transfer between page and page"). The
   * portal's rep, district and narrowed views read `byLine[...]` for their own line(s) and nothing
   * else, so every other line was one customer-grain RPC per month read only to be thrown away. A
   * line's rows do not depend on which other lines are read — one RPC per (line, month), masked row
   * by row — so `byLine` for a requested line is identical either way. `rows`, `periodsWithData` and
   * `masked` then describe the requested lines only, which is why only a caller reading `byLine`
   * alone may pass this.
   */
  lines?: readonly ReviewLine[];
}): Promise<ClosingDetailLoad> {
  // 🔴 Never `figureWindow?.periods ?? []` — that field is null for every COMPLETE window, and the
  // brick, customer and channel pages came back empty (`concentrationPeriods`, 2026-10-29).
  const periods = concentrationPeriods(input.coverage);
  const wanted = input.lines ? new Set<ReviewLine>(input.lines) : null;
  return loadClosingDetailFacts({
    figurePeriods: periods,
    lines: REVIEW_LINES.filter(({ id }) => wanted === null || wanted.has(id)).map(({ id }) => ({
      lineCode: REVIEW_LINE_CODES[id],
      officialLine: OFFICIAL_LINE[id],
    })),
    viewer: input.viewer,
  });
}

// ─────────────────────────────── views over the bundle ───────────────────────────────

export function getReviewDataset(review: BusinessReview, line: ReviewLine = "pedia"): ReviewDataset {
  return review.datasets[line];
}

/** Cross-line company rollup — drives the All Company tab. */
export function getReviewCompany(review: BusinessReview): ReviewCompany {
  return review.company;
}

/** Every area across all three lines, tagged with the line it belongs to. Derived from the
 * per-line datasets rather than duplicated into the company rollup, so a line fix can never
 * drift from the consolidated view. */
export function getReviewCompanyAreas(review: BusinessReview): (AreaSummary & { line: string; lineId: ReviewLine })[] {
  return REVIEW_LINES.flatMap(({ id, label }) =>
    review.datasets[id].areas.map((a) => ({ ...a, line: label, lineId: id })),
  );
}

/** Every DM seat across all three lines. `keyProducts`/`families` come from that DM's own
 * line, since the product catalogue differs per line. Target-less catch-all buckets are
 * excluded — they are unmanaged areas, not managers. */
export function getReviewCompanyDms(review: BusinessReview): (DmSummary & {
  line: string;
  lineId: ReviewLine;
  keyProducts: string[];
  families: string[];
  visitsAvailable: boolean;
})[] {
  return REVIEW_LINES.flatMap(({ id, label }) => {
    const ds = review.datasets[id];
    const keyProducts = ds.products.filter((p) => p.include).map((p) => p.product);
    const families = Array.from(new Set(ds.products.filter((p) => p.include).map((p) => p.family)));
    return ds.dms
      .filter((d) => d.allProducts.target > 0)
      .map((d) => ({ ...d, line: label, lineId: id, keyProducts, families, visitsAvailable: ds.visits.available }));
  });
}

/** Per-line product tables for the consolidated Deep Analysis. Kept per line (not merged)
 * because the three lines sell entirely different catalogues — merging their product rows
 * would imply a shared product set that does not exist. */
export function getReviewCompanyProductTables(review: BusinessReview): { id: ReviewLine; label: string; products: ProductRow[] }[] {
  return REVIEW_LINES.map(({ id, label }) => ({
    id,
    label,
    products: review.datasets[id].products.filter((p) => p.total.target > 0 || p.total.sales > 0),
  }));
}

/** Shared fail thresholds. Verified identical across all three lines (20% / 50%); if a line
 * ever diverges this throws rather than silently applying one line's rule to all. */
export function getReviewCompanyThresholds(review: BusinessReview): { repFailBelow: number; dsmFailBelow: number } {
  const all = REVIEW_LINES.map(({ id }) => review.datasets[id].meta.thresholds);
  const first = all[0];
  const same = all.every((t) => t.repFailBelow === first.repFailBelow && t.dsmFailBelow === first.dsmFailBelow);
  if (!same) {
    throw new Error(
      "Business Review lines have diverging fail thresholds; the consolidated company view needs " +
        "an explicit rule: " +
        JSON.stringify(all),
    );
  }
  return first;
}

/** Payout % for an achievement %, straight from the locked 2026 curve. */
export function payoutPercentageFor(achievement: number | null): number {
  if (achievement == null) return 0;
  return calculateIncentive2026({ achievementPercent: achievement }).payoutPercentage;
}

export type IncentiveBand = "not-eligible" | "threshold" | "on-target" | "over-achiever" | "elite";
export function bandFor(achievement: number | null): IncentiveBand {
  if (achievement == null || achievement < 90) return "not-eligible";
  if (achievement < 100) return "threshold";
  if (achievement < 120) return "on-target";
  if (achievement < 150) return "over-achiever";
  return "elite";
}
export const BAND_LABEL: Record<IncentiveBand, string> = {
  "not-eligible": "Below threshold",
  threshold: "Threshold 90–100%",
  "on-target": "On target 100–120%",
  "over-achiever": "Over-achiever 120–150%",
  elite: "Elite 150%+",
};

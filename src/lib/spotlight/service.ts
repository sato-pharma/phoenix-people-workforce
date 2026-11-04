// Spotlight — the domain service.
//
// The one place that turns a selection into a result. Pages and routes call THIS; they never reach
// for `loadMonthlyAchievement`, the org tree or the ranking directly, because a second definition of
// "achievement" is exactly how two screens start quoting different numbers for the same month.
//
// It reads the SAME function every other sales surface reads — `au.f_monthly_achievement`, through
// `loadMonthlyAchievement` — so a spotlight and /sales/targets and the Monthly Closing cannot
// disagree about a person. That is a deliberate constraint, not a convenience: the owner's ruling of
// 2026-09-05 is that the closing's arithmetic is the arithmetic.

import { loadMonthlyAchievement } from "@/lib/sales/monthly-targets";
import { isSalesPeriodReleasedForLines, loadSalesReleaseKeys } from "@/lib/sales/unpublished-sales-access";
import { currentCairoDateParts } from "@/lib/i18n/format";

import { buildHeadline, buildSubheadline } from "./headline";
import { spotlightLines } from "./line-windows";
import { loadSpotlightOrg, type SpotlightOrgIndex } from "./org";
import { gateWindow } from "./period";
import {
  TRACKED_LINES,
  bucketRows,
  rankRows,
  rowsFromBuckets,
  summariseShortlist,
  type Bucket,
} from "./rank";
import type { SpotlightResult, SpotlightSelection } from "./types";

export class SpotlightWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpotlightWindowError";
  }
}

/** Hard ceiling on how many subjects one sheet may carry. */
export const SPOTLIGHT_MAX_LIMIT = 60;

export function normaliseSelection(selection: SpotlightSelection): SpotlightSelection {
  const lines = selection.filters.lines?.filter(Boolean) ?? [];
  return {
    ...selection,
    filters: {
      ...selection.filters,
      excludeVacant: selection.filters.excludeVacant === true,
      // An empty line filter means the three tracked lines, never "everything the data holds".
      // Head Office carries no target and ~90% of weekly value; unfiltered it would win every
      // value ranking and distort every achievement denominator it touched.
      lines: lines.length > 0 ? lines : [...TRACKED_LINES],
    },
    // No sales value means no ranking by it: the order must be one the sheet can show.
    ...(selection.showValue === false ? { showValue: false, rankBy: "achievement" as const } : {}),
    limit: selection.limit === null
      ? null
      : Math.max(1, Math.min(SPOTLIGHT_MAX_LIMIT, Math.floor(selection.limit))),
  };
}

export type LoadOptions = {
  /** Injected by the tests so the whole service can run without a database. */
  loadPeriod?: (period: string) => Promise<Awaited<ReturnType<typeof loadMonthlyAchievement>>>;
  loadOrg?: () => Promise<SpotlightOrgIndex>;
  today?: { year: number; month: number };
};

/**
 * Build a spotlight.
 *
 * Throws `SpotlightWindowError` when the window is not yet complete. That is a 4xx, not a 5xx — the
 * caller asked for something legitimate that is not available yet, and the message says when it will
 * be.
 */
export async function loadSpotlight(
  input: SpotlightSelection,
  options: LoadOptions = {},
): Promise<SpotlightResult> {
  const selection = normaliseSelection(input);

  const publishedKeys = await loadSalesReleaseKeys();
  // The lines the sheet reads, never the whole company: rows are filtered to them before anything is
  // added up, so a month is released when THOSE lines have published it (owner, 2026-11-04).
  const readLines = spotlightLines(selection.filters.lines);
  const gate = gateWindow(selection.window, options.today, (period) =>
    isSalesPeriodReleasedForLines(period, readLines, publishedKeys),
  );
  if (!gate.allowed) throw new SpotlightWindowError(gate.reason);

  const org = await (options.loadOrg ?? loadSpotlightOrg)();
  const loadPeriod = options.loadPeriod ?? loadMonthlyAchievement;

  // ── The streaming fold ──────────────────────────────────────────────────────────────────────
  // One month at a time, folded and dropped. Sequential rather than parallel on purpose: six
  // concurrent reads of a 17,000-cell function is a burst this single-replica container gains
  // nothing from, and the whole point of folding was to keep the peak small.
  const buckets = new Map<string, Bucket>();
  for (const period of gate.periods) {
    const rows = await loadPeriod(period);
    bucketRows(rows, selection.subject, org, selection.filters, buckets);
  }

  const buildOptions = {
    kind: selection.subject,
    org,
    filters: selection.filters,
    lineNames: org.lineNames,
    regionNames: org.regionNames,
    areaNames: org.areaNames,
  };
  const all = rowsFromBuckets(buckets, buildOptions);
  const { ranked, considered, untargeted } = rankRows(
    all,
    selection.rankBy,
    selection.direction,
    selection.limit,
  );

  const totals = summariseShortlist(ranked);
  const headlineContext = {
    selection,
    rows: ranked,
    windowLabel: gate.label,
    lineNames: org.lineNames,
    regionNames: org.regionNames,
    areaNames: org.areaNames,
  };

  const cairo = currentCairoDateParts();
  const generatedAtCairo = new Date(Date.UTC(cairo.year, cairo.month - 1, cairo.day))
    .toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" });

  return {
    selection,
    periods: gate.periods,
    windowLabel: gate.label,
    headline: buildHeadline(headlineContext),
    subheadline: buildSubheadline(headlineContext),
    rows: ranked,
    totalSubjects: considered,
    shortlistActualValue: totals.actualValue,
    shortlistTargetValue: totals.targetValue,
    shortlistAchievement: totals.achievement,
    untargetedSubjects: untargeted,
    generatedAtCairo,
  };
}

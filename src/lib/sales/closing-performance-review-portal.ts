import type { AccessContext } from "@/lib/auth/permissions";
import {
  loadClosingPerformanceReview,
  PERFORMANCE_REVIEW_MONTHS,
  type ClosingPerformanceReview,
  type ClosingPerformanceReviewFilter,
} from "@/lib/sales/closing-performance-review";
import {
  boundPeriodsToPublished,
  listPerformanceReviewPublishedPeriods,
  pickPerformanceReviewLine,
  resolvePerformanceReviewViewerScope,
  type PerformanceReviewViewerScope,
} from "@/lib/sales/closing-performance-review-scope";

// ─────────────────────────────────────────────────────────────────────────────
// The BOUNDED Performance Review — one read, used by the portal page, the route the page re-reads
// from, and the route behind its Export button.
//
// It exists so the bound is written ONCE. Three callers each resolving a scope, each listing
// published months and each deciding what to do with a refused line is three chances for one of them
// to be generous, and the generous one is the one that leaks. Everything here is server-side: the
// browser sends a selection, never a scope.
//
// It lives beside the scope module rather than inside it because it is the only thing that needs both
// the scope and the loader, and the loader already imports the scope module to narrow its matrices —
// putting the orchestration there would close that import into a cycle.
// ─────────────────────────────────────────────────────────────────────────────

export type ScopedPerformanceReviewResult = {
  /** Lines the viewer holds that have at least one published month — what the picker may offer. */
  availableLines: string[];
  /** True when the viewer's line exists but nothing is published for him yet. */
  awaitingPublish: boolean;
  /** The line the review covers, or null when it could not be resolved or was refused. */
  line: string | null;
  /** The viewer's published months for `line`, newest first. */
  publishedPeriods: string[];
  /** True when a line was asked for and it is not the viewer's. Never substituted — see below. */
  refusedLine: boolean;
  /** Months asked for that are not published for this viewer. Named, never silently dropped. */
  refusedPeriods: string[];
  /** The scoped review. Null whenever there is nothing this viewer may read. */
  review: ClosingPerformanceReview | null;
  /** One plain sentence saying what the figures cover, for the page to print. */
  scopeNote: string;
  /** The bound that was applied, for a caller that needs to state it. */
  viewerScope: PerformanceReviewViewerScope;
};

/**
 * What this viewer's figures cover, in his own terms.
 *
 * Names the TERRITORY, never the mechanism: "your own areas" is what a district manager calls it,
 * where "region scope narrowed by seat area codes" is what we call it. A role we do not have a
 * sentence for still gets a true one rather than nothing.
 */
function scopeNoteForRole(access: Pick<AccessContext, "role">): string {
  if (access.role === "District Manager") return "Scoped to your own areas.";
  if (access.role === "Regional Manager") return "Scoped to your own region.";
  if (access.role === "National Sales Manager") return "Your whole line.";
  return "Scoped to your own territory.";
}

/**
 * Load the Performance Review for a bounded viewer.
 *
 * TWO REFUSALS, NEITHER OF THEM A SUBSTITUTION:
 *
 *  • A LINE outside his scope is refused (`refusedLine`), never swapped for one he does hold — the
 *    rule `pickPortalClosingLine` exists for. A stale `?line=` must not print another line's
 *    rankings under the heading he asked for.
 *  • A MONTH that is not published for him is refused (`refusedPeriods`) and the rest still loads,
 *    so a total never covers fewer months than the heading claims without saying so.
 *
 * With nothing asked for, it loads his newest published month — the one he would otherwise have to
 * pick before seeing anything.
 */
export async function loadScopedClosingPerformanceReview(input: {
  access: AccessContext;
  filter?: ClosingPerformanceReviewFilter | null;
  months?: number;
  requestedLine?: string | null;
  requestedPeriod?: string | null;
  requestedPeriods?: string[] | null;
}): Promise<ScopedPerformanceReviewResult> {
  const { access } = input;
  const viewerScope = await resolvePerformanceReviewViewerScope(access);
  const scopeNote = scopeNoteForRole(access);
  const empty = {
    availableLines: [] as string[],
    awaitingPublish: false,
    line: null,
    publishedPeriods: [] as string[],
    refusedLine: false,
    refusedPeriods: [] as string[],
    review: null,
    scopeNote,
    viewerScope,
  } satisfies ScopedPerformanceReviewResult;

  // At most three lines (the oversight set's size), normally one — his own.
  const publishedByLine = new Map<string, string[]>(
    await Promise.all(
      viewerScope.allowedLines.map(
        async (line) => [line, await listPerformanceReviewPublishedPeriods(line)] as const,
      ),
    ),
  );
  const publishedLines = viewerScope.allowedLines.filter(
    (line) => (publishedByLine.get(line) ?? []).length > 0,
  );

  const choice = pickPerformanceReviewLine({
    publishedLines,
    requestedLine: input.requestedLine,
    scope: viewerScope,
  });
  if (choice.refused || !choice.line) {
    return { ...empty, availableLines: choice.availableLines, refusedLine: choice.refused };
  }

  const publishedPeriods = publishedByLine.get(choice.line) ?? [];
  if (publishedPeriods.length === 0) {
    return {
      ...empty,
      availableLines: choice.availableLines,
      awaitingPublish: true,
      line: choice.line,
    };
  }

  const requested = [
    ...(input.requestedPeriods ?? []),
    ...(input.requestedPeriod ? [input.requestedPeriod] : []),
  ].filter(Boolean);
  const bound = boundPeriodsToPublished(requested, publishedPeriods);
  // Newest published month by default. `publishedPeriods` is newest first, so that is [0].
  const periods = bound.allowed.length > 0 ? bound.allowed : [publishedPeriods[0]];

  const review = await loadClosingPerformanceReview({
    // His own lines and his own published months — the pickers may offer nothing wider than the bound.
    availableLines: choice.availableLines,
    availablePeriods: publishedPeriods,
    filter: input.filter ?? null,
    line: choice.line,
    months: input.months ?? PERFORMANCE_REVIEW_MONTHS,
    periods,
    viewerScope,
  });

  // 🔴 THE MONTH THAT CAME BACK MUST BE THE MONTH THAT WAS ASKED FOR. `loadMonthlyClosingParts`
  // substitutes the newest VALIDATED month (published or not) when the requested one is absent from
  // the closing's global validated list — which can happen to a published month whose batch is later
  // invalidated or replaced through the corrections screen. The multi-month loader guards against
  // that substitution; the single-month path does not, and a portal reader opening the page with no
  // month chosen takes exactly that path. Refusing by name is what the rest of this function does
  // with a month he may not read, so an unpublished substitute is refused the same way rather than
  // printed under a heading he did not ask for.
  const loaded = review.selectedPeriods ?? [];
  const substituted = loaded.filter((period) => !periods.includes(period));
  if (substituted.length > 0) {
    return {
      ...empty,
      availableLines: choice.availableLines,
      line: choice.line,
      publishedPeriods,
      refusedPeriods: Array.from(new Set([...bound.refused, ...periods])).sort(),
    };
  }

  return {
    availableLines: choice.availableLines,
    awaitingPublish: false,
    line: choice.line,
    publishedPeriods,
    refusedLine: false,
    refusedPeriods: bound.refused,
    review,
    scopeNote,
    viewerScope,
  };
}

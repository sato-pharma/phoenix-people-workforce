import type { AccessContext } from "@/lib/auth/permissions";
import { PERFORMANCE_REVIEW_FIRST_PERIOD } from "@/lib/sales/closing-performance-review-regions";
import { listPublishedPeriodsForLine } from "@/lib/sales/monthly-closing-publication";
import {
  pickPortalClosingLine,
  resolvePortalClosingScope,
  scopeMatrixToGeographyNoFallback,
  scopeMatrixToProducts,
  stripRestrictedColumns,
} from "@/lib/sales/monthly-closing-portal";
import type { MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";

// ─────────────────────────────────────────────────────────────────────────────
// "EVERYONE SEES ONLY HIS SCOPE" — the Performance Review's half of it.
//
// Owner, 2026-10-13: "show performance review tab in each district manager account … and of course,
// everyone sees only his scope." A district manager reads the same six views the admin screen shows,
// over his OWN areas; a regional manager over his region; a national sales manager over his line.
//
// It resolves nothing of its own. The bound comes from `resolvePortalClosingScope`, the same engine
// the portal Monthly Closing has used since 2026-07-30, and the narrowing is applied with that
// module's own matrix scopers — so a manager's Performance Review and his Monthly Closing cannot
// disagree about what his territory is, and a change to "who sees which region" moves both at once.
//
// THE NARROWING IS SERVER-SIDE AND UNCONDITIONAL. The review is six views DERIVED from the matrix
// (rankings, family shares, two grids, the month series), so it must be narrowed BEFORE the
// derivation — a rank re-derived from scoped rows is "3rd of 9 in my district", which is the figure a
// manager acts on. It is applied to the headline month and to every month of the series through the
// same function, so no column can carry an area the reader may not see.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One manager's bound on the review: the lines he may open, the geography and the products.
 *
 * Deliberately the same three fields `PortalClosingScope` carries, rather than a reduction of them —
 * `null` means "unbounded on this axis" exactly as it does there (a National Sales Manager has no
 * geography bound; a manager with no product sheet has no product bound), and an EMPTY set means "no
 * rows", which is what a manager whose geography could not be resolved must see rather than the
 * whole line.
 */
export type PerformanceReviewViewerScope = {
  /** Area codes from the viewer's organogram seat. Authoritative over `regionNames` when present. */
  areaCodes: Set<string> | null;
  /** Every line the viewer may open, in display order. */
  allowedLines: string[];
  /** The line to show unless the viewer asks for another one he holds. */
  line: string | null;
  /** Allowed product codes; null means every product on the line. */
  productCodes: Set<string> | null;
  /** Canonical region names the viewer may see; null means every region. */
  regionNames: Set<string> | null;
};

/** The viewer's own bound, from the shared sales access-scope engine. */
export async function resolvePerformanceReviewViewerScope(
  access: AccessContext,
): Promise<PerformanceReviewViewerScope> {
  const scope = await resolvePortalClosingScope(access);
  return {
    allowedLines: scope.allowedLines,
    areaCodes: scope.areaCodes,
    line: scope.line,
    productCodes: scope.productCodes,
    regionNames: scope.regionNames,
  };
}

/**
 * The viewer's geography, applied with NO FALLBACK — a bound that matches nothing in this matrix
 * shows NO ROWS, never the un-narrowed line.
 *
 * 🔴 **THIS IS WHY THE REVIEW DOES NOT CALL `applyRegionScope`, THE SHARED HELPER THE PORTAL MONTHLY
 * CLOSING USES.** That helper keeps ONE deliberate fallback for a region-level viewer whose region
 * label matched nothing — it reads it as a data gap and hands back the WHOLE matrix
 * (`monthly-closing-portal.ts`, the aggregate "Alexandria + Delta" label). The live shape that reaches
 * it is the 26 employees labelled "Upper Egypt" against Anti Infective's "Upper Egypt 1"/"Upper
 * Egypt 2" groups. (Its second fallback — seat areas that match nothing dropping to the region and
 * then the line — was removed from the portal closing on 2026-10-26, so both screens now share
 * `scopeMatrixToGeographyNoFallback` for that case.)
 *
 * On a closing GRID a widened fallback is a legibility problem. Here it is a disclosure: this review
 * ranks named reps against one another, carries each one's manager, and downloads as a workbook — and
 * `scopeIsBounded` would then label the whole company's ranking "own territory · 58 areas". An empty
 * sheet is the truth about a territory we could not match, so an empty sheet is what it shows.
 *
 * It IS the portal's own no-fallback rule (`scopeMatrixToGeographyNoFallback`), so the area-code and
 * region-name matching — including the re-homed-area rule that keeps UE1..UE8 with an "Upper Egypt"
 * viewer — is identical. Only the aggregate-label fallback is absent.
 */
function narrowGeographyWithNoFallback(
  matrix: MonthlyClosingMatrix,
  scope: PerformanceReviewViewerScope,
): MonthlyClosingMatrix {
  return scopeMatrixToGeographyNoFallback(matrix, scope.regionNames, scope.areaCodes);
}

/**
 * Narrow one closing matrix to a viewer's scope — geography, then products, then the confidential
 * strip, in that order.
 *
 * The products and the strip are the portal Monthly Closing's own (`scopeMatrixToProducts`, and
 * `stripRestrictedColumns`, which drops LA003/LA004/SS001 for every portal viewer); the geography is
 * `narrowGeographyWithNoFallback` above, which is those same scopers without the shared helper's
 * widening fallbacks.
 *
 * The confidential strip is applied LAST and unconditionally, because it is a product lock rather
 * than a scope: a manager who legitimately holds every product on his line still may not read those
 * three columns.
 */
export function narrowMatrixToViewerScope(
  matrix: MonthlyClosingMatrix,
  scope: PerformanceReviewViewerScope | null | undefined,
): MonthlyClosingMatrix {
  if (!scope) return matrix;
  const geography = narrowGeographyWithNoFallback(matrix, scope);
  // `null` is "every product on the line", which is not the same request as an empty set — so the
  // column filter is skipped entirely rather than handed a set that would keep nothing.
  const products = scope.productCodes
    ? scopeMatrixToProducts(geography, scope.productCodes)
    : geography;
  return stripRestrictedColumns(products);
}

/**
 * Which line a scoped read loads, and which lines the picker may offer.
 *
 * Delegates to `pickPortalClosingLine`, so the one rule that matters holds here too: A REQUESTED
 * LINE IS NEVER SILENTLY SUBSTITUTED. A manager who follows a stale `?line=` to a line outside his
 * scope is refused and told so, never shown another line's rankings under the heading he asked for.
 */
export function pickPerformanceReviewLine(input: {
  publishedLines: readonly string[];
  requestedLine?: string | null;
  scope: PerformanceReviewViewerScope;
}) {
  return pickPortalClosingLine({
    allowedLines: input.scope.allowedLines,
    publishedLines: input.publishedLines,
    requestedLine: input.requestedLine,
  });
}

/**
 * The months a scoped viewer may read: PUBLISHED months for that line, newest first, never earlier
 * than the review's first period.
 *
 * 🔴 **PUBLICATION IS THE GATE, AND THE FLOOR IS JULY.** The owner's instruction was "show them the
 * history", corrected the same day to "no show performance review in emp portal starting from july"
 * — so the list is exactly the months he has PUBLISHED from July upward, and it grows by his
 * publishing a month rather than by anything here. A manager therefore cannot read a month the
 * company has not released, which is the same contract the portal Monthly Closing has always had,
 * nor one closed on the earlier area map, which is the floor the admin screen already has.
 */
export async function listPerformanceReviewPublishedPeriods(
  line: string | null | undefined,
): Promise<string[]> {
  const published = await listPublishedPeriodsForLine(line);
  return published.filter((period) => period >= PERFORMANCE_REVIEW_FIRST_PERIOD);
}

/**
 * Keep only the requested months the viewer may actually read.
 *
 * Refusing rather than substituting, for the reason `pickPortalClosingLine` refuses a line: a
 * selection quietly reduced to the months that happen to be published prints a total covering fewer
 * months than the heading claims. The caller reports what it could not read — the review payload
 * already carries `skippedPeriods` for exactly that.
 */
export function boundPeriodsToPublished(
  requested: readonly string[],
  publishedPeriods: readonly string[],
): { allowed: string[]; refused: string[] } {
  const published = new Set(publishedPeriods);
  const allowed: string[] = [];
  const refused: string[] = [];
  for (const period of requested) {
    if (!period) continue;
    if (published.has(period)) allowed.push(period);
    else refused.push(period);
  }
  return { allowed: allowed.sort(), refused: refused.sort() };
}

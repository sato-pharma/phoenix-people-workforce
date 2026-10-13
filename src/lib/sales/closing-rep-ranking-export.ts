import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { logError } from "@/lib/observability/log";
import {
  buildRepRanking,
  carveChannelsByArea,
  carveByArea,
  loadRankingSeats,
  probationByUniqueName,
  type RepRanking,
} from "@/lib/sales/closing-rep-ranking";
import { periodEndDate } from "@/lib/sales/closing-performance-review";
import { loadDistributorNameIndex } from "@/lib/sales/closing-details-distributor-names";
import type { RankingPublication } from "@/lib/sales/closing-rep-ranking-legacy-shape";
import {
  buildRepRankingWorkbook,
  type RepRankingWorkbookResult,
} from "@/lib/sales/closing-rep-ranking-workbook";
import type { ClosingDetailRow } from "@/lib/sales/monthly-closing-details";
import { loadPortalMonthlyClosing } from "@/lib/sales/monthly-closing-portal";
import { isRepRankingLine } from "@/lib/sales/closing-rep-ranking-line";
import type { MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ENTRY POINT THE EXPORT ROUTE CALLS.
//
// 🔴 THE DRESSED LINES ONLY — Anti Infective, then CNS, which he added the same day ("now use the
// CNS identity to make the new identity ranking rep closing sheet ... for CNS with CNS identity").
// Every other line keeps the workbook it has, untouched — `isRepRankingLine` is the single gate, so
// there is one place to read and one place to change when he widens it again.
//
// This exists because a route must not orchestrate a domain: the figures, the scope, the seat model
// and the warehouse carve are all sales rules, and the route's job is to answer HTTP. It returns
// null when this viewer cannot be given a ranking for this month, and the route then falls through to
// the export it would have produced anyway — so a gap here degrades to the old file rather than to an
// error page.
// ─────────────────────────────────────────────────────────────────────────────

/** How many published months the workbook trends over, the closing month included. */
const TREND_MONTHS = 3;

/**
 * 🔴 The ONE gate. The ranking workbook replaces the portal export on this line and no other.
 *
 * Re-exported, not defined here: the admin screen's third export button asks the same question in
 * the BROWSER, and this module reaches `@/lib/supabase/server`, which a client bundle cannot hold.
 * See closing-rep-ranking-line.ts. Every caller of this module keeps importing it from here.
 */
export { isRepRankingLine };

/**
 * This line's publication history, newest first — the Trust sheet's provenance table.
 *
 * Fails soft: a workbook without its provenance table is worth more than no workbook, and nothing
 * else on the file reads this.
 */
async function loadRankingPublications(line: string): Promise<RankingPublication[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("monthly_closing_publications")
      .select("period,published_at,published_by,unpublished_at")
      .eq("line", line)
      .order("period", { ascending: false });
    if (error) throw error;
    return (data ?? []) as RankingPublication[];
  } catch (error) {
    logError("Rep ranking publication history read failed; the Trust sheet ships without it", {
      error,
      labels: { event: "closing_rep_ranking_publications_failed" },
    });
    return [];
  }
}

/**
 * The months the workbook trends over: the month being exported plus the published months before it,
 * oldest first.
 *
 * 🔴 TAKEN FROM THE VIEWER'S OWN PUBLISHED LIST, never from a calendar. A month that was never
 * published is not a zero month — it is a month this reader is not allowed to see, and inventing its
 * column would both breach the publish gate and make the quarter's total disagree with the line.
 */
export function resolveTrendPeriods(availablePeriods: readonly string[], period: string): string[] {
  const published = [...availablePeriods].sort(); // oldest first
  const index = published.indexOf(period);
  if (index < 0) return [period];
  return published.slice(Math.max(0, index - (TREND_MONTHS - 1)), index + 1);
}

export type RepRankingExport = RepRankingWorkbookResult & { ranking: RepRanking };

/**
 * Build this viewer's rep-ranking workbook for one month, or null when it cannot be built.
 *
 * SCOPE COMES FROM `loadPortalMonthlyClosing`, once per trend month, so every month on the file is
 * narrowed by exactly the chain that narrows the viewer's screen and gated on the same publication.
 * "Everyone his scope" is therefore not re-implemented here: a Medical Rep's matrices hold his own
 * area, so his ranking is his own row.
 */
export async function buildScopedRepRankingExport(input: {
  access: AccessContext;
  line: string;
  period: string;
  /**
   * The closing month's detail rows, already scoped by the caller.
   *
   * 🔴 THE UNMASKED SET, DELIBERATELY. These rows are what the published cells were built from, so
   * the warehouse carve adds back to them; the masked set has rows REMOVED, which would understate
   * the store channel against the very cell it is carved out of. Nothing identifying survives the
   * carve — it emits money per area × product and one count of distinct warehouse customers, never a
   * customer name or code — so the mask has nothing to protect here.
   */
  rows: readonly ClosingDetailRow[];
  availablePeriods: readonly string[];
  /**
   * 🔴 THE OWNER'S OWN COPY, off by default — pass it ONLY behind `readsUnpublishedClosings(access)`.
   *
   * True trends over the VALIDATED months instead of the published ones, for the readers who
   * already open an unpublished closing everywhere else: Super Admin, SFE Manager, CEO and Finance
   * Manager. Added 2026-10-13, when he asked why the admin download refused September and every
   * Anti Infective month turned out to be unpublished — September since 9 October, July and August
   * since the 12th — so a publish-gated builder could produce nothing at all for him. The portal
   * export never passes it: there the publish gate is the whole point.
   */
  includeUnpublished?: boolean;
}): Promise<RepRankingExport | null> {
  const { access, includeUnpublished, line, period } = input;
  if (!isRepRankingLine(line)) return null;

  const trend = resolveTrendPeriods(input.availablePeriods, period);
  const loaded = await Promise.all(
    trend.map(async (month) => {
      const result = await loadPortalMonthlyClosing({ access, includeUnpublished, line, period: month })
        .catch(() => null);
      // A month whose scoped load came back on a DIFFERENT month would silently label one month's
      // figures with another's, so it is dropped rather than trusted.
      const matrix = result?.selectedPeriod === month ? result.matrix : null;
      // 🔴 AND A MONTH WITH NO ROWS FOR THIS LINE IS NOT A ZERO MONTH. The validated month list is
      // global, because an import batch carries no line, so `includeUnpublished` can offer a month
      // this line never traded in. Rendered as a trend column it would read as every rep scoring
      // nothing that month, and the quarter's total would disagree with the line. Dropped instead —
      // and the requested month failing this test returns null below, so the caller says "cannot be
      // built" rather than shipping an empty ranking.
      return matrix && matrix.regions.length > 0 ? { matrix, period: month } : null;
    }),
  );
  const matricesByPeriod = loaded.filter(
    (entry): entry is { matrix: MonthlyClosingMatrix; period: string } => entry !== null,
  );
  if (!matricesByPeriod.some((entry) => entry.period === period)) return null;

  const carve = carveChannelsByArea(input.rows, line);
  const [seats, probation, publications] = await Promise.all([
    loadRankingSeats(period),
    probationByUniqueName(periodEndDate(period) ?? period),
    loadRankingPublications(line),
  ]);

  const ranking = buildRepRanking({
    directByArea: carveByArea(carve.direct),
    line,
    // THE THIRD CHANNEL ON CNS. `carveChannelsByArea` fills this map only on a line that has the
    // Office channel at all, so passing it unconditionally is right: off CNS it is empty and every
    // seat's office is 0. Owner, 2026-10-13: "in CNS, instead of the direct order column in
    // channels, you will put office."
    officeByArea: carveByArea(carve.office),
    matricesByPeriod,
    period,
    probationByName: probation,
    seats,
    storesByArea: carveByArea(carve.stores),
    warehouseCustomers: carve.warehouseCustomers.size,
  });

  const built = await buildRepRankingWorkbook({
    carve: { direct: carve.direct, office: carve.office, stores: carve.stores },
    // 🔴 THE ROWS TAB'S OWN ROWS — the SAME set every figure above it was carved from, never a
    // second read of the month (owner, 2026-10-13: "I want the raw detailed sheet to be in the
    // export rep ranking in monthly closing"). The sheet blanks El Qema itself, for every reader,
    // because a finished workbook is forwarded and carries no access context with it; the
    // reasoning is in closing-rows-sheet.ts.
    details: input.rows,
    distributorNames: await loadDistributorNameIndex(),
    probationByName: probation,
    publications,
    ranking,
  });
  return { ...built, ranking };
}

// ─────────────────────────────────────────────────────────────────────────────
// Marketing Manager Scorecard — the one loader behind the report and both of its exports.
//
// The screen, the workbook and the PDF all come through here, so the figure an executive reads on
// the page is byte-for-byte the figure in the file he forwards. A second loader would eventually
// disagree, and nobody would notice until two copies of one number were already in circulation.
//
// Scope comes free: `getMarketingRoiReport` already resolves the viewer's own visibility
// (`resolveMarketingRoiScope`) — company-wide for the oversight roles, the hierarchy subtree for a
// manager, own seat plus his own area AND line for a Medical Rep, and for a National Sales Manager
// his subtree plus every campaign on his line whoever ran it (owner, 2026-10-20), so the Product
// and Group Product Managers who spend on his line get a row of their own on his Scorecard.
// Nothing here widens it.
//
// 🔴 THE STATUS LIST IS PASSED EXPLICITLY, EVERY TIME. An empty list is NOT "everything": the
// engine reads it as its executive default, approved money only (`resolveRoiStatusScope`), which
// would silently drop every pending, returned, rejected and cancelled request — the exact counts
// this report exists to show ("one did five requests, three from them are approved, and two no").
// `.claude/rules/marketing.md`, "AN EMPTY STATUS LIST IS 'APPROVED MONEY ONLY', NEVER 'ALL'".
//
// 🔴 THIS REPORT NEVER BLOCKS ANYBODY (owner, 2026-10-09: "don't put the rule … never block
// anyone"). It reads and reports; it refuses nothing, and no caller may make a request's fate
// depend on what it says.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext } from "@/lib/auth/permissions";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import {
  buildMarketingManagerScorecard,
  type MarketingManagerScorecard,
} from "@/lib/marketing-requests/manager-scorecard";
import {
  missingDistributorFiles,
  monthAdd,
  type DistributorFileGap,
} from "@/lib/marketing-requests/manager-scorecard-awaiting";
import { ROI_LIVE_TRACKER_STATUSES } from "@/lib/marketing-requests/roi-live-stages";
import { getMarketingRoiReport, roiValueBucket } from "@/lib/marketing-requests/roi-report-service";
import {
  emptyRoiFilterState,
  type MarketingRoiReportRow,
  type RoiFilterState,
} from "@/lib/marketing-requests/roi-report-types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

function scorecardFilters(): RoiFilterState {
  return {
    ...emptyRoiFilterState(),
    status: [...ROI_LIVE_TRACKER_STATUSES],
  };
}

/**
 * Which distributors have not filed an already-elapsed month of an approved campaign's ROI window.
 *
 * Owner instruction, 2026-10-09: "show on the Scorecard which zeroes are missing distributor
 * files". Two lookup-sized reads — the validated batch index and the distributor names (21 rows).
 * Nothing scans the sales rows.
 *
 * 🔴 THE PARENT CODE IS JUDGED, NOT THE FAMILY. A report row carries the parent code its pharmacies
 * map to (`IS`), which is also the main code that distributor files under; `IS-T` and `IS-S` are its
 * tender and own-label siblings. Reading the family as one would call Ibn Sina filed for September
 * on the strength of Ibn Sina-Sato alone — the real case this caption exists for — and reading every
 * sibling separately would caption almost every row, because Overseas Tender lags every month while
 * Overseas files on time. `manager-scorecard-awaiting.ts` carries the full reasoning.
 *
 * 🔴 IT FAILS OPEN. Any error here returns no gaps, so the report renders with every figure intact
 * and simply no caption — a caption is an explanation, never a precondition for the money.
 */
async function loadDistributorFileGaps(
  rows: MarketingRoiReportRow[],
  generatedAtIso: string,
): Promise<ReadonlyMap<string, DistributorFileGap[]>> {
  const empty = new Map<string, DistributorFileGap[]>();
  const approved = rows.filter((row) => roiValueBucket(row.status) === "approved" && row.payDate);
  if (approved.length === 0) return empty;

  try {
    const supabase = getSupabaseAdmin();
    const [batches, distributors] = await Promise.all([
      supabase.from("source_of_sales_import_batches").select("period, distributor_code").eq("status", "validated"),
      supabase.from("source_of_sales_distributors").select("distributor_code, distributor_name"),
    ]);
    if (batches.error || distributors.error) return empty;

    const filedPeriodsByDistributor = new Map<string, Set<string>>();
    for (const batch of (batches.data ?? []) as Array<{ period?: string | null; distributor_code?: string | null }>) {
      const period = (batch.period ?? "").trim();
      const code = (batch.distributor_code ?? "").trim();
      if (!period || !code) continue;
      const held = filedPeriodsByDistributor.get(code) ?? new Set<string>();
      held.add(period);
      filedPeriodsByDistributor.set(code, held);
    }

    const distributorNameByCode = new Map<string, string>();
    for (const entry of (distributors.data ?? []) as Array<{
      distributor_code?: string | null;
      distributor_name?: string | null;
    }>) {
      const code = (entry.distributor_code ?? "").trim();
      const name = (entry.distributor_name ?? "").trim();
      if (code && name) distributorNameByCode.set(code, name);
    }

    // Cairo, never UTC — at 01:00 Cairo on the 1st a UTC clock still reads the previous month.
    // And the cut is the month BEFORE this one: a distributor files a month after it ends, so
    // treating the running month as owed would accuse every distributor of being late every day.
    const currentPeriod = cairoDateTimeSortable(generatedAtIso).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(currentPeriod)) return empty;
    const lastClosedPeriod = monthAdd(currentPeriod, -1);

    return missingDistributorFiles({
      distributorNameByCode,
      filedPeriodsByDistributor,
      lastClosedPeriod,
      requests: approved.map((row) => ({
        distributorCodes: row.distributorCodes,
        payMonth: (row.payDate ?? "").slice(0, 7) || null,
        requestId: row.requestId,
        roiDurationMonths: row.roiDurationMonths,
      })),
    });
  } catch {
    return empty;
  }
}

/** The report: every person in the viewer's scope who raised a marketing request, with his money. */
export async function getMarketingManagerScorecard(
  access: AccessContext,
  generatedAtIso: string = new Date().toISOString(),
): Promise<MarketingManagerScorecard> {
  const report = await getMarketingRoiReport(access, scorecardFilters(), generatedAtIso);
  const fileGapsByRequestId = await loadDistributorFileGaps(report.rows, generatedAtIso);
  return buildMarketingManagerScorecard({
    attributionLines: report.attributionLines,
    fileGapsByRequestId,
    generatedAtIso,
    rows: report.rows,
    salesDataAsOf: report.kpi.salesDataAsOf,
  });
}

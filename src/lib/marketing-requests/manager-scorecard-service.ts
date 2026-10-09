// ─────────────────────────────────────────────────────────────────────────────
// Marketing Manager Scorecard — the one loader behind the report and both of its exports.
//
// The screen, the workbook and the PDF all come through here, so the figure an executive reads on
// the page is byte-for-byte the figure in the file he forwards. A second loader would eventually
// disagree, and nobody would notice until two copies of one number were already in circulation.
//
// Scope comes free: `getMarketingRoiReport` already resolves the viewer's own visibility
// (`resolveMarketingRoiScope`) — company-wide for the oversight roles, the hierarchy subtree for a
// manager, own seat plus his own area AND line for a Medical Rep. Nothing here widens it.
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
import {
  buildMarketingManagerScorecard,
  type MarketingManagerScorecard,
} from "@/lib/marketing-requests/manager-scorecard";
import { ROI_LIVE_TRACKER_STATUSES } from "@/lib/marketing-requests/roi-live-stages";
import { getMarketingRoiReport } from "@/lib/marketing-requests/roi-report-service";
import { emptyRoiFilterState, type RoiFilterState } from "@/lib/marketing-requests/roi-report-types";

function scorecardFilters(): RoiFilterState {
  return {
    ...emptyRoiFilterState(),
    status: [...ROI_LIVE_TRACKER_STATUSES],
  };
}

/** The report: every person in the viewer's scope who raised a marketing request, with his money. */
export async function getMarketingManagerScorecard(
  access: AccessContext,
  generatedAtIso: string = new Date().toISOString(),
): Promise<MarketingManagerScorecard> {
  const report = await getMarketingRoiReport(access, scorecardFilters(), generatedAtIso);
  return buildMarketingManagerScorecard({
    attributionLines: report.attributionLines,
    generatedAtIso,
    rows: report.rows,
    salesDataAsOf: report.kpi.salesDataAsOf,
  });
}

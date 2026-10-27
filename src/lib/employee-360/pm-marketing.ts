// Employee 360 — PM / Group PM marketing-request ROI.
//
// A Product Manager's other lever (besides product sales) is the marketing
// investments they request. This surfaces, for the PM being viewed, the ROI on
// the marketing requests THEY submitted: spend, expected vs actual return, and
// how many are on-track. Reuses the marketing ROI report + KPI-band builder,
// scoped to this requester. A failed read throws: the page catches it and says the
// section could not be read, rather than drawing an empty one that reads as "no requests".

import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdsMatch } from "@/lib/hr-id";
import { buildKpiBand, getMarketingRoiReport } from "@/lib/marketing-requests/roi-report-service";
import { emptyRoiFilterState } from "@/lib/marketing-requests/roi-report-types";

export type PmMarketingRequest = {
  code: string;
  /** What the request is for, as the ROI tracker names it: its type and its customer. */
  typeName: string | null;
  customerName: string;
  line: string | null;
  estimatedCost: number;
  actual: number;
  status: string;
};

export type PmMarketingSummary = {
  hasData: boolean;
  requestCount: number;
  totalEstimatedCost: number;
  totalExpectedRoi: number;
  totalActualValue: number;
  coverageRatio: number; // actual / required (0..1+)
  onTrack: number;
  behind: number;
  awaiting: number;
  noData: number;
  topRequests: PmMarketingRequest[];
};

const EMPTY: PmMarketingSummary = {
  hasData: false,
  requestCount: 0,
  totalEstimatedCost: 0,
  totalExpectedRoi: 0,
  totalActualValue: 0,
  coverageRatio: 0,
  onTrack: 0,
  behind: 0,
  awaiting: 0,
  noData: 0,
  topRequests: [],
};

/** Marketing-request ROI for the requests this PM/GPM submitted. */
export async function getPmMarketingRoi(
  hrId: string,
  access: AccessContext,
  nowIso: string,
): Promise<PmMarketingSummary> {
  const report = await getMarketingRoiReport(access, emptyRoiFilterState(), nowIso);
  const rows = report.rows.filter((r) => hrIdsMatch(r.requesterHrId, hrId));
  if (rows.length === 0) return EMPTY;
  // The report's ledger, so a sale two of this PM's campaigns both claim is counted once.
  const kpi = buildKpiBand(rows, report.kpi.salesDataAsOf, 0, report.attributionLines);
  const topRequests: PmMarketingRequest[] = [...rows]
    .sort((a, b) => b.estimatedCost - a.estimatedCost)
    .slice(0, 6)
    .map((r) => ({
      code: r.requestCode,
      typeName: r.requestTypeName,
      customerName: r.customerName,
      line: r.line,
      estimatedCost: r.estimatedCost,
      actual: r.actualSalesValue,
      status: String(r.resultStatus),
    }));
  return {
    hasData: true,
    requestCount: kpi.requestCount,
    totalEstimatedCost: kpi.totalEstimatedCost,
    totalExpectedRoi: kpi.totalExpectedRoi,
    totalActualValue: kpi.totalActualValue,
    coverageRatio: kpi.coverageRatio,
    onTrack: kpi.onTrackCount,
    behind: kpi.behindCount,
    awaiting: kpi.awaitingDataCount,
    noData: kpi.noDataCount,
    topRequests,
  };
}

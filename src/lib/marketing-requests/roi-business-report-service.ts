// Marketing ROI Report — read-only server orchestration for the standalone business report.
//
// Composes two EXISTING, unmodified services — never re-implements attribution or the
// diagnostic classifier:
//   - getMarketingRoiReport  (roi-report-service.ts)  → the role-scoped forecast/actual rows
//   - explainMarketingRequestRoi (roi-explain-service.ts) → the precise per-request "why" for
//     any row with zero attributed sales (only called for that bounded subset, never for the
//     whole company at once, to stay within the attribution RPC's cost envelope).
//
// Strictly read-only: no insert/update/delete/upsert anywhere in this file.

import type { AccessContext } from "@/lib/auth/permissions";
import {
  buildRoiBusinessRow,
  buildRoiCohorts,
  groupRoiRowsByCustomer,
  groupRoiRowsByRequester,
  type RoiBusinessRow,
  type RoiCohorts,
  type RoiCustomerOption,
  type RoiRequesterOption,
} from "@/lib/marketing-requests/roi-business-report";
import type { RoiExplainReason } from "@/lib/marketing-requests/roi-explain";
import { explainMarketingRequestRoi } from "@/lib/marketing-requests/roi-explain-service";
import { getMarketingRoiReport } from "@/lib/marketing-requests/roi-report-service";
import { emptyRoiFilterState, type MarketingRoiReportRow } from "@/lib/marketing-requests/roi-report-types";

export type RoiBusinessGroup = { by: "requester"; hrId: string } | { by: "customer"; name: string };

export type MarketingRoiBusinessOptions = {
  requesters: RoiRequesterOption[];
  customers: RoiCustomerOption[];
};

/** Distinct requesters + customers who have at least one visible marketing request, for the
 *  two tab dropdowns. Uses the same role-scoped index as ROI Tracking (unmodified). */
export async function getMarketingRoiBusinessOptions(access: AccessContext): Promise<MarketingRoiBusinessOptions> {
  const report = await getMarketingRoiReport(access, emptyRoiFilterState(), new Date().toISOString());
  return {
    customers: groupRoiRowsByCustomer(report.rows),
    requesters: groupRoiRowsByRequester(report.rows),
  };
}

/** Attach the precise Explain ROI reason to every zero-attributed-sales row in the (bounded)
 *  selected group, in parallel. Rows that already have attributed sales don't need it — their
 *  business problem is always "Sales found". A single request's explain failure never breaks
 *  the rest of the list — it degrades to the coarser bulk-only fallback for that row. */
async function attachExplainReasons(
  access: AccessContext,
  rows: MarketingRoiReportRow[],
  generatedAtIso: string,
): Promise<RoiBusinessRow[]> {
  const needsExplain = rows.filter((row) => !row.hasSalesData);
  const reasonByRequestId = new Map<string, RoiExplainReason>();

  await Promise.all(
    needsExplain.map(async (row) => {
      try {
        const explain = await explainMarketingRequestRoi(access, row.requestId, generatedAtIso);
        reasonByRequestId.set(row.requestId, explain.diagnostic.reason);
      } catch {
        // Leave unset — buildRoiBusinessRow falls back to the bulk-only classification.
      }
    }),
  );

  return rows.map((row) => buildRoiBusinessRow(row, reasonByRequestId.get(row.requestId) ?? null));
}

/**
 * Business rows for ONE selected requester or ONE selected customer — never the whole
 * company at once, so the per-row Explain ROI calls stay bounded to a small, user-chosen set.
 */
export async function getMarketingRoiBusinessRows(
  access: AccessContext,
  group: RoiBusinessGroup,
): Promise<{ rows: RoiBusinessRow[] }> {
  const generatedAtIso = new Date().toISOString();

  if (group.by === "requester") {
    // Native, cheap server-side filter — the attribution RPC only runs for this requester's
    // own requests, not the whole company (the efficient path).
    const filters = { ...emptyRoiFilterState(), requester: [group.hrId] };
    const report = await getMarketingRoiReport(access, filters, generatedAtIso);
    return { rows: await attachExplainReasons(access, report.rows, generatedAtIso) };
  }

  // No "customer" filter dimension exists on the shared Filter Engine (RoiFilterState), so this
  // reuses the same company-scoped call ROI Tracking itself makes when unfiltered, then narrows
  // to the selected customer. Same cost class as opening the existing ROI Tracking page.
  const report = await getMarketingRoiReport(access, emptyRoiFilterState(), generatedAtIso);
  const matched = report.rows.filter((row) => row.customerName === group.name);
  return { rows: await attachExplainReasons(access, matched, generatedAtIso) };
}

/** ROI-weighted cohorts over ALL role-scoped rows — the "Performance" view (which request type /
 *  requester / approver role / line / region returns, and how efficiently). Same company-scoped
 *  call the unfiltered ROI Tracking page makes, aggregated by the pure buildRoiCohorts. Read-only. */
export async function getMarketingRoiCohorts(access: AccessContext): Promise<RoiCohorts> {
  const report = await getMarketingRoiReport(access, emptyRoiFilterState(), new Date().toISOString());
  return buildRoiCohorts(report.rows);
}

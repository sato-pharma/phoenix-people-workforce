// Business Review — marketing requests, live.
//
// This replaces a committed workbook figure (277,450 EGP of Pedia spend for Jan–Jun 2026) that was
// cut from a LEGACY CRM export, `Req jan june s1.xlsx`. That export is not in this database and
// never was. What `marketing_requests` actually holds, checked live on 2026-08-22, is 15 rows in
// total, every one of them created between 2026-08-02 and 2026-09-01, of which exactly one is
// approved. So for any window that ends before August 2026 the honest answer is "no marketing
// requests exist for this period", and the coverage layer is what says it. Rendering the workbook
// number against a live window, or a 0 against an empty one, are the same mistake.
//
// The committed/pending split is NOT re-invented here: it is the ROI engine's own
// `roiValueBucket`, which the fact tables, the Sales-Marketing Intelligence dashboard and the ROI
// report all already agree on. `rejected` and `archived` are in NEITHER bucket — their money is
// not committed and nobody is waiting on it.
//
// The month is `pay_date`, not `request_date` and not `created_at`, because that is the month the
// money lands in and the month every existing marketing aggregate keys on.

import { markDegraded } from "@/lib/cache/serve-uncached";
import { roiValueBucket } from "@/lib/marketing-requests/roi-report-service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";

import type { ReviewWindow } from "../period";
import { periodMonthEnd } from "../period-format";

export type MarketingBucket = "committed" | "pending";

export type MarketingFact = {
  period: string;
  requesterHrId: string;
  lineId: number | null;
  areaId: number | null;
  status: string;
  /** Null for `rejected` and `archived` — real history, but neither committed nor awaited. */
  bucket: MarketingBucket | null;
  cost: number;
};

export type MarketingLoad = {
  facts: MarketingFact[];
  /** Months that returned at least one request, whatever its status. */
  periodsWithData: string[];
  /** Every row the window returned, including the rejected and archived ones. */
  totalRows: number;
};

export async function loadMarketingFacts(window: ReviewWindow): Promise<MarketingLoad> {
  const supabase = getSupabaseAdmin();

  let rows: Record<string, unknown>[] = [];
  try {
    rows = await fetchAllRows<Record<string, unknown>>(
      () =>
        supabase
          .from("marketing_requests")
          .select("id, requester_hr_id, line_id, area_id, status, estimated_cost, pay_date")
          .not("pay_date", "is", null)
          .gte("pay_date", `${window.from}-01`)
          .lte("pay_date", periodMonthEnd(window.to)),
      "id",
    );
  } catch {
    // A missing table or a transient read must not read as "spent nothing" — an empty load with
    // no periods makes the coverage layer report the source as empty, which is the truthful state.
    // Marked, so the bundle cache never keeps it past this render.
    return markDegraded({ facts: [], periodsWithData: [], totalRows: 0 });
  }

  const facts: MarketingFact[] = [];
  const periods = new Set<string>();

  for (const row of rows) {
    const payDate = String(row.pay_date ?? "");
    const period = payDate.slice(0, 7);
    if (!window.periods.includes(period)) continue;
    periods.add(period);

    const requesterHrId = String(row.requester_hr_id ?? "").trim();

    const status = String(row.status ?? "");
    const cost = Number(row.estimated_cost ?? 0);
    facts.push({
      period,
      requesterHrId,
      lineId: row.line_id == null ? null : Number(row.line_id),
      areaId: row.area_id == null ? null : Number(row.area_id),
      status,
      bucket: roiValueBucket(status as never) === "approved"
        ? "committed"
        : roiValueBucket(status as never) === "pending"
          ? "pending"
          : null,
      cost: Number.isFinite(cost) ? cost : 0,
    });
  }

  return {
    facts,
    periodsWithData: [...periods].sort(),
    totalRows: facts.length,
  };
}

export const MARKETING_ORIGIN = "public.marketing_requests, keyed on pay_date";
export const MARKETING_RULE =
  "Committed spend is the ROI engine's own set — approved, active, roi_tracking, closed and " +
  "finance_hold. Pending is shown separately; rejected and archived count as neither.";

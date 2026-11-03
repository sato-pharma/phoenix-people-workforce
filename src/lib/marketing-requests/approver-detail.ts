import type { AccessContext } from "@/lib/auth/permissions";
import { marketingCustomer360Href } from "@/lib/customer-360/hrefs";
import { canOpenCustomer360 } from "@/lib/customer-360/open-link";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  getMarketingRequestDecisionSummary,
  type MarketingRequestDecisionSummary,
} from "@/lib/marketing-requests/service";

// ─────────────────────────────────────────────────────────────────────────────
// Everything about a request, for the approver who is holding it.
//
// Composed ON TOP of getMarketingRequestDecisionSummary rather than rebuilding it: that function
// already assembles the products, ROI figures, customer identity/address/contact, target
// pharmacies, notes and double-count warnings, AND enforces the authorization that matters —
// assertMarketingStepAssignedToActor, so only the approver actually holding the current step can
// read any of it. Re-implementing either half would let the two drift apart.
//
// The decision argument is display-only (it selects button labels); passing "approve" here does
// NOT record anything. Nothing in this module writes.
// ─────────────────────────────────────────────────────────────────────────────

/** One earlier marketing request for the same customer, with what it actually returned. */
export type MarketingCustomerHistoryEntry = {
  actualSalesValue: number | null;
  estimatedCost: number;
  payDate: string | null;
  requestCode: string;
  /** on_track | behind | awaiting_data | no_data — null when ROI has never been calculated. */
  roiStatus: string | null;
  status: string;
};

export type MarketingCustomerHistory = {
  entries: MarketingCustomerHistoryEntry[];
  /**
   * True only when this customer genuinely has no earlier request.
   *
   * Kept separate from `entries.length === 0` on purpose: "we have never spent on this customer
   * before" and "we could not load the history" are opposite facts for an approver, and both
   * render as an empty list. The UI must be able to tell them apart.
   */
  isFirstRequest: boolean;
  /** Total of every earlier request's estimated cost. Null when the history could not be read. */
  priorSpend: number | null;
  /** Total realised sales attributed to those earlier requests. Null when never calculated. */
  priorRealisedSales: number | null;
  /** False when the lookup failed — the UI must say so rather than imply a clean slate. */
  available: boolean;
};

export type MarketingApproverRequestDetail = MarketingRequestDecisionSummary & {
  /** The customer's Customer 360 page, for an office viewer. Decided here because this window runs in both shells. */
  customer360Href: string | null;
  customerHistory: MarketingCustomerHistory;
};

const UNAVAILABLE_HISTORY: MarketingCustomerHistory = {
  available: false,
  entries: [],
  isFirstRequest: false,
  priorRealisedSales: null,
  priorSpend: null,
};

function toNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Roll earlier requests into the figures the approver reads. Pure, and exported so the
 * absence-is-not-zero rules are testable without a database.
 *
 * The distinction this function exists to protect: "we spent money and got nothing back" and
 * "nobody has calculated the return yet" are opposite facts, and both arrive here as no number.
 * Rendering either as `EGP 0` tells the CEO the campaign failed when it may simply be unmeasured.
 */
export function summariseCustomerHistory(
  entries: MarketingCustomerHistoryEntry[],
): MarketingCustomerHistory {
  if (entries.length === 0) {
    // A genuine clean slate. priorSpend is a true 0 (nothing was ever spent); priorRealisedSales
    // stays null because there is no campaign whose return could have been measured.
    return { available: true, entries: [], isFirstRequest: true, priorRealisedSales: null, priorSpend: 0 };
  }

  const measured = entries
    .map((entry) => entry.actualSalesValue)
    .filter((value): value is number => value !== null);

  return {
    available: true,
    entries,
    isFirstRequest: false,
    // Null, never 0, when NO earlier request has a calculated return.
    priorRealisedSales: measured.length > 0 ? measured.reduce((sum, value) => sum + value, 0) : null,
    priorSpend: entries.reduce((sum, entry) => sum + entry.estimatedCost, 0),
  };
}

/**
 * What this company has already spent on this customer, and what came back.
 *
 * Never throws: a failed history lookup must not take down the approval screen the CEO is trying
 * to decide on. It degrades to `available: false`, which the UI states plainly.
 */
async function loadCustomerHistory(
  customerId: string | null,
  excludeRequestId: string,
): Promise<MarketingCustomerHistory> {
  if (!customerId) return UNAVAILABLE_HISTORY;
  try {
    const supabase = getSupabaseAdmin();
    const requestsResult = await supabase
      .from("marketing_requests")
      .select("id, request_code, status, estimated_cost, pay_date")
      .eq("customer_id", customerId)
      .neq("id", excludeRequestId)
      .order("pay_date", { ascending: false });
    if (requestsResult.error) return UNAVAILABLE_HISTORY;

    const rows = (requestsResult.data ?? []) as Array<{
      estimated_cost?: number | string | null;
      id: string;
      pay_date?: string | null;
      request_code?: string | null;
      status?: string | null;
    }>;
    if (rows.length === 0) return summariseCustomerHistory([]);

    // Realised sales per earlier request, where ROI has actually been calculated.
    const factsResult = await supabase
      .from("marketing_roi_request_facts")
      .select("request_id, actual_sales_value, actual_roi_status")
      .in("request_id", rows.map((row) => row.id));
    const factByRequestId = new Map<string, { salesValue: number | null; status: string | null }>();
    if (!factsResult.error) {
      for (const fact of (factsResult.data ?? []) as Array<{
        actual_roi_status?: string | null;
        actual_sales_value?: number | string | null;
        request_id: string;
      }>) {
        factByRequestId.set(fact.request_id, {
          salesValue: toNumber(fact.actual_sales_value),
          status: fact.actual_roi_status ?? null,
        });
      }
    }

    const entries: MarketingCustomerHistoryEntry[] = rows.map((row) => {
      const fact = factByRequestId.get(row.id);
      return {
        actualSalesValue: fact?.salesValue ?? null,
        estimatedCost: toNumber(row.estimated_cost) ?? 0,
        payDate: row.pay_date ?? null,
        requestCode: row.request_code ?? row.id,
        roiStatus: fact?.status ?? null,
        status: row.status ?? "unknown",
      };
    });

    return summariseCustomerHistory(entries);
  } catch {
    return UNAVAILABLE_HISTORY;
  }
}

async function resolveCustomerId(requestId: string): Promise<string | null> {
  try {
    const result = await getSupabaseAdmin()
      .from("marketing_requests")
      .select("customer_id")
      .eq("id", requestId)
      .maybeSingle();
    if (result.error) return null;
    return (result.data as { customer_id?: string | null } | null)?.customer_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Full request detail for the approver holding it — read-only.
 *
 * Authorization is inherited from getMarketingRequestDecisionSummary, which throws unless the
 * caller holds the request's CURRENT step. That is deliberate: this endpoint exposes the
 * customer's address, contact mobile and full pharmacy list, so it must be exactly as tight as
 * the decision screen it mirrors.
 */
export async function getMarketingRequestApproverDetail(
  requestId: string,
  access: AccessContext,
): Promise<MarketingApproverRequestDetail> {
  const summary = await getMarketingRequestDecisionSummary(requestId, "approve", access);
  // The summary carries the customer's NAME and code but not its id, and the id is what the
  // history joins on. Resolved only after the summary has authorized the caller.
  const customerId = await resolveCustomerId(summary.requestId);
  const [customerHistory, canOpenCustomer] = await Promise.all([
    loadCustomerHistory(customerId, summary.requestId),
    canOpenCustomer360(access),
  ]);
  return {
    ...summary,
    customer360Href: canOpenCustomer && customerId ? marketingCustomer360Href(customerId) : null,
    customerHistory,
  };
}

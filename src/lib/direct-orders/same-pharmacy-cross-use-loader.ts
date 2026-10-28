import { hrIdLookupKeys } from "@/lib/hr-id";
import {
  buildSamePharmacyCrossUseFlag,
  describeDirectOrderUse,
  describeMarketingRequestUse,
  extraDealsOnOrder,
  isLiveDirectOrderForCrossUse,
  isLiveMarketingRequestForCrossUse,
  isSameRequester,
  type DirectOrderDealLine,
  type SamePharmacyCrossUse,
  type SamePharmacyCrossUseFlag,
} from "@/lib/direct-orders/same-pharmacy-cross-use";
import { findMarketingPharmacyIds } from "@/lib/direct-orders/venue-validation-photos";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// The reads behind the same-pharmacy, same-person flag (owner, 2026-10-28) — the rule and the wording
// are in `same-pharmacy-cross-use.ts`. Both loaders NEVER THROW: the flag decorates an approval
// window, and an approver must never lose the record because a decoration could not be read. A
// failed read shows no flag and is logged.
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const OTHER_RECORDS_LIMIT = 50;

function text(row: Row | null | undefined, key: string): string | null {
  const value = row?.[key];
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function num(row: Row | null | undefined, key: string): number | null {
  const value = row?.[key];
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The current non-CC rung of each request, for the "With the CEO" style status label. */
async function loadCurrentStepCodes(requestIds: string[]): Promise<Map<string, string>> {
  const codes = new Map<string, string>();
  if (requestIds.length === 0) return codes;
  const { data } = await getSupabaseAdmin()
    .from("marketing_request_approval_steps")
    .select("request_id, step_code")
    .in("request_id", requestIds)
    .eq("status", "current")
    .eq("is_cc", false);
  for (const row of (data ?? []) as Row[]) {
    const requestId = text(row, "request_id");
    const stepCode = text(row, "step_code");
    if (requestId && stepCode) codes.set(requestId, stepCode);
  }
  return codes;
}

/**
 * On a DIRECT ORDER's approval window: the live marketing requests the same requester raised for the
 * pharmacy this order goes to — only when the order itself carries an extra deal, so a normal order
 * costs no read at all.
 */
export async function loadSamePharmacyFlagForDirectOrder(params: {
  orderId: string;
  /** The order's own lines — the extra-deal test runs on these before anything is read. */
  lines: readonly DirectOrderDealLine[];
  /** The campaign the order was raised from, if any — named on that request's line. */
  marketingRequestId: string | null | undefined;
  pharmacyId: string | null | undefined;
  pharmacyName: string | null | undefined;
  requesterHrId: string | null | undefined;
  requesterName: string | null | undefined;
}): Promise<SamePharmacyCrossUseFlag | null> {
  if (!params.pharmacyId || !params.requesterHrId) return null;
  const thisOrderExtraDeals = extraDealsOnOrder(params.lines);
  if (thisOrderExtraDeals.length === 0) return null;
  try {
    const supabase = getSupabaseAdmin();
    const marketingPharmacyIds = await findMarketingPharmacyIds(String(params.pharmacyId));
    if (marketingPharmacyIds.length === 0) return null;

    const { data: links, error: linksError } = await supabase
      .from("marketing_request_pharmacies")
      .select("request_id, pharmacy_id")
      .in("pharmacy_id", marketingPharmacyIds);
    if (linksError) throw linksError;
    const pharmacyIdsByRequest = new Map<string, string[]>();
    for (const row of (links ?? []) as Row[]) {
      const requestId = text(row, "request_id");
      const pharmacyId = text(row, "pharmacy_id");
      if (!requestId || !pharmacyId) continue;
      pharmacyIdsByRequest.set(requestId, [...(pharmacyIdsByRequest.get(requestId) ?? []), pharmacyId]);
    }
    if (pharmacyIdsByRequest.size === 0) return null;

    const { data: requests, error: requestsError } = await supabase
      .from("marketing_requests")
      .select("id, request_code, requester_hr_id, status, estimated_cost, submitted_at, customer_id, request_type_id, other_request_type")
      .in("id", Array.from(pharmacyIdsByRequest.keys()))
      .in("requester_hr_id", hrIdLookupKeys(params.requesterHrId))
      .order("submitted_at", { ascending: false, nullsFirst: false })
      .limit(OTHER_RECORDS_LIMIT);
    if (requestsError) throw requestsError;
    const live = ((requests ?? []) as Row[]).filter(
      (row) =>
        isSameRequester(text(row, "requester_hr_id"), params.requesterHrId) &&
        isLiveMarketingRequestForCrossUse(text(row, "status")),
    );
    if (live.length === 0) return null;

    const requestIds = live.map((row) => String(row.id));
    const customerIds = Array.from(new Set(live.map((row) => text(row, "customer_id")).filter((id): id is string => Boolean(id))));
    const typeIds = Array.from(new Set(live.map((row) => num(row, "request_type_id")).filter((id): id is number => id !== null)));
    const namedPharmacyIds = Array.from(new Set(requestIds.flatMap((id) => pharmacyIdsByRequest.get(id) ?? [])));
    const [stepCodes, customers, types, pharmacies] = await Promise.all([
      loadCurrentStepCodes(requestIds),
      customerIds.length
        ? supabase.from("marketing_customers").select("id, display_name").in("id", customerIds)
        : Promise.resolve({ data: [] as Row[] }),
      typeIds.length
        ? supabase.from("marketing_request_types").select("id, name").in("id", typeIds)
        : Promise.resolve({ data: [] as Row[] }),
      supabase.from("marketing_pharmacies").select("id, display_name").in("id", namedPharmacyIds),
    ]);
    const customerName = new Map(((customers.data ?? []) as Row[]).map((row) => [String(row.id), text(row, "display_name")]));
    const typeName = new Map(((types.data ?? []) as Row[]).map((row) => [String(row.id), text(row, "name")]));
    const pharmacyName = new Map(((pharmacies.data ?? []) as Row[]).map((row) => [String(row.id), text(row, "display_name")]));
    const fallbackPharmacyName = params.pharmacyName?.trim() || "this pharmacy";

    const uses: SamePharmacyCrossUse[] = live.map((row) => {
      const id = String(row.id);
      const firstPharmacy = (pharmacyIdsByRequest.get(id) ?? [])[0];
      const typeId = num(row, "request_type_id");
      return describeMarketingRequestUse({
        id,
        requestCode: text(row, "request_code") ?? "without a code",
        status: text(row, "status") ?? "",
        currentStepCode: stepCodes.get(id) ?? null,
        submittedAt: text(row, "submitted_at"),
        estimatedCost: num(row, "estimated_cost"),
        requestTypeName: (typeId !== null ? typeName.get(String(typeId)) : null) ?? text(row, "other_request_type"),
        customerName: customerName.get(text(row, "customer_id") ?? "") ?? null,
        pharmacyName: (firstPharmacy ? pharmacyName.get(firstPharmacy) : null) ?? fallbackPharmacyName,
        linkedAsCampaign: Boolean(params.marketingRequestId) && id === params.marketingRequestId,
      });
    });
    return buildSamePharmacyCrossUseFlag({
      viewing: "direct_order",
      requesterName: params.requesterName ?? null,
      uses,
      thisOrderExtraDeals,
    });
  } catch (error) {
    logError("Same-pharmacy marketing requests could not be read for a direct order's approval window", {
      labels: { event: "direct_order_same_pharmacy_flag_failed" },
      context: { orderId: params.orderId },
      error,
    });
    return null;
  }
}

/** The direct-order venues each marketing pharmacy IS: through the hand-over's link, or a code pair. */
async function findDirectOrderVenues(marketingPharmacyIds: string[]): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const marketingPharmacyByVenue = new Map<string, string>();
  const [{ data: linked }, { data: codes }] = await Promise.all([
    supabase
      .from("marketing_pharmacy_direct_order_venues")
      .select("marketing_pharmacy_id, direct_order_pharmacy_id")
      .in("marketing_pharmacy_id", marketingPharmacyIds),
    supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("pharmacy_id, mapped_distributor_code, mapped_customer_code")
      .in("pharmacy_id", marketingPharmacyIds)
      .neq("active", false),
  ]);
  for (const row of (linked ?? []) as Row[]) {
    const venueId = text(row, "direct_order_pharmacy_id");
    const marketingPharmacyId = text(row, "marketing_pharmacy_id");
    if (venueId && marketingPharmacyId) marketingPharmacyByVenue.set(venueId, marketingPharmacyId);
  }
  // Pairwise, never two crossed .in() lists — that would match distributor A's code to B's customer.
  for (const pair of (codes ?? []) as Row[]) {
    const distributorCode = text(pair, "mapped_distributor_code");
    const customerCode = text(pair, "mapped_customer_code");
    const marketingPharmacyId = text(pair, "pharmacy_id");
    if (!distributorCode || !customerCode || !marketingPharmacyId) continue;
    const { data } = await supabase
      .from("direct_order_pharmacy_distributor_codes")
      .select("pharmacy_id")
      .eq("distributor_code", distributorCode)
      .eq("customer_code", customerCode)
      .limit(20);
    for (const row of (data ?? []) as Row[]) {
      const venueId = text(row, "pharmacy_id");
      if (venueId && !marketingPharmacyByVenue.has(venueId)) marketingPharmacyByVenue.set(venueId, marketingPharmacyId);
    }
  }
  return marketingPharmacyByVenue;
}

/** A row of the lines table, or the order row itself, as one deal line. */
function dealLine(row: Row): DirectOrderDealLine {
  return {
    productCode: text(row, "product_code"),
    productName: text(row, "product_name"),
    dealType: text(row, "deal_type"),
    qty: num(row, "qty"),
    bonus: num(row, "bonus"),
    discountPct: num(row, "discount_pct"),
  };
}

/**
 * On a MARKETING REQUEST's approval window: the live direct orders the same requester raised to any
 * pharmacy this request targets — only the ones with an extra deal on a line.
 */
export async function loadSamePharmacyFlagForMarketingRequest(params: {
  requestId: string;
  requesterHrId: string | null | undefined;
  requesterName: string | null | undefined;
}): Promise<SamePharmacyCrossUseFlag | null> {
  if (!params.requesterHrId) return null;
  try {
    const supabase = getSupabaseAdmin();
    const { data: targets, error: targetsError } = await supabase
      .from("marketing_request_pharmacies")
      .select("pharmacy_id")
      .eq("request_id", params.requestId);
    if (targetsError) throw targetsError;
    const marketingPharmacyIds = Array.from(
      new Set(((targets ?? []) as Row[]).map((row) => text(row, "pharmacy_id")).filter((id): id is string => Boolean(id))),
    );
    if (marketingPharmacyIds.length === 0) return null;

    const marketingPharmacyByVenue = await findDirectOrderVenues(marketingPharmacyIds);
    if (marketingPharmacyByVenue.size === 0) return null;

    const { data: orders, error: ordersError } = await supabase
      .from("direct_order_requests")
      .select("id, requester_hr_id, status, sales_month, submitted_at, product_code, product_name, qty, sales_value, deal_type, bonus, discount_pct, pharmacy_id, marketing_request_id")
      .in("pharmacy_id", Array.from(marketingPharmacyByVenue.keys()))
      .in("requester_hr_id", hrIdLookupKeys(params.requesterHrId))
      .order("submitted_at", { ascending: false, nullsFirst: false })
      .limit(OTHER_RECORDS_LIMIT);
    if (ordersError) throw ordersError;
    const live = ((orders ?? []) as Row[]).filter(
      (row) =>
        isSameRequester(text(row, "requester_hr_id"), params.requesterHrId) &&
        isLiveDirectOrderForCrossUse(text(row, "status")),
    );
    if (live.length === 0) return null;

    // Each order's lines; an order with none reads as its own row, one line.
    const { data: items, error: itemsError } = await supabase
      .from("direct_order_request_items")
      .select("request_id, line_no, product_code, product_name, deal_type, qty, bonus, discount_pct")
      .in("request_id", live.map((row) => String(row.id)))
      .order("line_no", { ascending: true });
    if (itemsError) throw itemsError;
    const linesByOrder = new Map<string, DirectOrderDealLine[]>();
    for (const row of (items ?? []) as Row[]) {
      const orderId = text(row, "request_id");
      if (orderId) linesByOrder.set(orderId, [...(linesByOrder.get(orderId) ?? []), dealLine(row)]);
    }
    const extra = live
      .map((row) => ({ row, extraDeals: extraDealsOnOrder(linesByOrder.get(String(row.id)) ?? [dealLine(row)]) }))
      .filter((order) => order.extraDeals.length > 0);
    if (extra.length === 0) return null;

    const venueIds = Array.from(new Set(extra.map(({ row }) => text(row, "pharmacy_id")).filter((id): id is string => Boolean(id))));
    const { data: venues } = await supabase.from("direct_order_pharmacies").select("id, pharmacy_name").in("id", venueIds);
    const venueName = new Map(((venues ?? []) as Row[]).map((row) => [String(row.id), text(row, "pharmacy_name")]));

    const uses: SamePharmacyCrossUse[] = extra.map(({ row, extraDeals }) =>
      describeDirectOrderUse({
        id: String(row.id),
        status: text(row, "status") ?? "",
        salesMonth: text(row, "sales_month"),
        submittedAt: text(row, "submitted_at"),
        salesValue: num(row, "sales_value"),
        extraDeals,
        pharmacyName: venueName.get(text(row, "pharmacy_id") ?? "") ?? "this pharmacy",
        linkedAsCampaign: text(row, "marketing_request_id") === params.requestId,
      }),
    );
    return buildSamePharmacyCrossUseFlag({ viewing: "marketing_request", requesterName: params.requesterName ?? null, uses });
  } catch (error) {
    logError("Same-pharmacy direct orders could not be read for a marketing request's approval window", {
      labels: { event: "marketing_request_same_pharmacy_flag_failed" },
      context: { requestId: params.requestId },
      error,
    });
    return null;
  }
}

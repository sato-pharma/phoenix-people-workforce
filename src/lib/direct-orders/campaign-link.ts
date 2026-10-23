/**
 * The campaign a direct order came from — declared by the requester, at the moment they raise it.
 *
 * WHY THIS EXISTS
 *
 * `direct_order_requests.marketing_request_id` has been in the schema since the module's foundation
 * migration (20260718140000) and is READ in five places: the report column "Marketing req", the
 * approval detail card, the reversal (which copies it forward on purpose), Customer 360's campaign
 * attribution, and the report export. Nothing ever WROTE it. Measured on production 2026-09-03:
 * 93 direct orders, 0 carrying a campaign — not one, ever. The single writer was the reversal path,
 * copying an original whose value was always null.
 *
 * So every one of those readers was rendering a permanent blank, and the module's ROI could not
 * answer "which campaign produced this sale" for any order in its history. This file is the write
 * side. It does not change what anything reads.
 *
 * WHY THE REQUESTER PICKS, RATHER THAN THE SYSTEM INFERRING
 *
 * There is already an inference path: `marketing_requests.track_direct_sales`, a Super-Admin toggle
 * meaning "credit this campaign's ROI with direct orders at its target pharmacies + products". It is
 * ALSO dormant — 0 of 29 campaigns have it on — and it could not work here even if switched on,
 * because the venue link it depends on does not exist in the data:
 *
 *   · `marketing_request_pharmacies.pharmacy_id` points at `marketing_pharmacies`; a direct order's
 *     `pharmacy_id` points at `direct_order_pharmacies`. Two registers, no shared id — 0 overlap.
 *   · Resolved across registers on the distributor code pair (the same spine Customer 360 uses),
 *     only 3 of 58 direct-order venues match a marketing venue at all, and 0 of those are campaign
 *     targets.
 *
 * A picker offering "campaigns targeting this pharmacy" would therefore be EMPTY for every order in
 * production. The owner's answer settles it: the requester declares the campaign. A declaration is
 * also the stronger record — it is someone's statement, not a guess this data cannot support.
 *
 * WHAT IS OFFERED, AND WHY THAT SCOPE
 *
 * Live campaigns ON THE ORDER'S OWN PRODUCT LINE. The line is the one axis both sides genuinely
 * share: a direct order's line comes from its basket, a campaign carries `line_id`, and all 7 live
 * campaigns have it populated. It is a real constraint rather than an arbitrary one, and it leaves
 * the picker non-empty for every line that raises orders (measured 2026-09-03: Anti Infective 2,
 * Pedia 3, CNS 2 live campaigns; direct orders exist on Anti Infective and Pedia).
 *
 * ONLY THE REQUESTER'S OWN CAMPAIGNS (owner, 2026-10-23: "you must show the campaigns of the
 * requester himself only, not all the campaigns done"). This REVERSES the earlier decision to offer
 * every live campaign on the line, which had been rejected because only 3 of 11 requesters had a
 * campaign of their own. The owner's rule wins: the picker lists a campaign only when
 * `marketing_requests.requester_hr_id` is the person raising the order, and the submit-side check
 * refuses anyone else's campaign too, so a hand-posted body cannot reach past what the list shows.
 * A requester with no campaign of their own on the line sees an empty picker, which is the normal
 * "No campaign" answer and never blocks a submission.
 *
 * NOT A NEW PERMISSION SURFACE. Every role that may raise a direct order — District Manager,
 * Regional Manager, National Sales Manager, Product Manager, Group Product Manager — is already in
 * `marketingCreatorRoles`, so all of them can open the marketing module today. This exposes nothing
 * new. It still returns LABELS ONLY: never `estimated_cost`, `expected_roi_value`,
 * `required_roi_value` or any other campaign money, because a picker is not a reason to widen what
 * a requester can read.
 *
 * THE FIELD IS OPTIONAL AND MUST STAY OPTIONAL. Most direct orders are not campaign-driven; 93 of
 * 93 have no campaign today. Making it required would block every order in the system.
 */

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { DIRECT_ORDER_REQUESTER_ROLES } from "@/lib/direct-orders/types";
import type { MarketingRequestStatus } from "@/lib/marketing-requests/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The campaign states a new order may be attached to.
 *
 * This is `approvedMarketingRequestStatuses` (the marketing module's own definition of "this
 * campaign's money was approved") MINUS `closed`. A closed campaign's ROI window has ended, so
 * attaching fresh sales to it would credit money to a period that is already reported and settled.
 *
 * `finance_hold` IS included: the hold concerns paying the campaign's own cost, not whether sales
 * it produced should count — and the ROI report already treats it as approved money.
 *
 * `tests/direct-order-campaign-link.test.ts` pins this against the marketing constant, so if that
 * list changes the drift fails CI rather than silently widening or narrowing what a requester can
 * attach an order to.
 */
export const PICKABLE_CAMPAIGN_STATUSES: readonly MarketingRequestStatus[] = [
  "approved",
  "active",
  "roi_tracking",
  "finance_hold",
] as const;

/** One campaign a requester may attach an order to. Labels only — no campaign money, ever. */
export type DirectOrderCampaignOption = {
  readonly id: string;
  /** Human-readable campaign code, e.g. "MKT-0042" — never a bare uuid on screen. */
  readonly requestCode: string;
  readonly customerName: string | null;
  readonly areaName: string | null;
  readonly lineName: string | null;
  readonly status: MarketingRequestStatus;
};

/**
 * Did this person raise the campaign? HR ids are MIXED CASE in this database, so a plain equality
 * check silently under-matches — lower BOTH sides. A blank id on either side never matches.
 */
export function isCampaignRaisedBy(requesterHrId: unknown, myHrId: unknown): boolean {
  const mine = String(myHrId ?? "").trim().toLowerCase();
  return Boolean(mine) && String(requesterHrId ?? "").trim().toLowerCase() === mine;
}

function canRaiseDirectOrder(role: PhoenixRole | string | null | undefined): boolean {
  const clean = String(role ?? "").trim() as PhoenixRole;
  return clean === "Super Admin" || DIRECT_ORDER_REQUESTER_ROLES.includes(clean);
}

/**
 * Gate. Deliberately the SAME rule `submitDirectOrder` applies, not a looser one: the campaign list
 * is part of raising an order, so anyone who cannot raise one has no business reading it. A guest
 * context resolves to role "Employee" rather than null (see AGENTS.md), so this must test the role
 * positively rather than checking for an absent session.
 */
function assertCanPickCampaign(access: AccessContext): void {
  if (access.scope === "system") return;
  if (!canRaiseDirectOrder(access.role)) {
    throw new Error(`Forbidden: ${access.role} cannot raise direct orders, so cannot pick a campaign.`);
  }
}

type CampaignRow = {
  id: unknown;
  request_code: unknown;
  status: unknown;
  line_id: unknown;
  area_id: unknown;
  customer_id: unknown;
  requester_hr_id: unknown;
};

function text(value: unknown): string | null {
  const clean = String(value ?? "").trim();
  return clean ? clean : null;
}

/**
 * Resolve a line NAME (what a direct order carries, e.g. "Pedia") to a line id (what a campaign
 * carries). Case-insensitive: the order's line comes from the product master and the campaign's
 * from the `lines` table, and nothing guarantees the two agree on capitalisation.
 */
async function resolveLineId(lineName: string | null): Promise<number | null> {
  const clean = String(lineName ?? "").trim();
  if (!clean) return null;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("lines").select("id, name");
  if (error) throw error;
  const match = (data ?? []).find(
    (row) => String((row as { name?: unknown }).name ?? "").trim().toLowerCase() === clean.toLowerCase(),
  );
  if (!match) return null;
  const id = Number((match as { id?: unknown }).id);
  return Number.isFinite(id) ? id : null;
}

/**
 * The campaigns this requester may attach an order on `lineName` to.
 *
 * Returns [] rather than throwing when the line does not resolve — an unknown line means "no
 * campaign can be matched", which is an empty picker, not an error that should block a submission.
 */
export async function listDirectOrderCampaignOptions(
  access: AccessContext,
  lineName: string | null,
): Promise<DirectOrderCampaignOption[]> {
  // Declared in access-registry.ts as direct_orders:read, so it is asserted here — the same
  // permission its sibling GET (pharmacy-search) enforces. The role rule below is narrower
  // still: reading the campaign list is part of raising an order.
  await assertPermission(access, "direct_orders", "read");
  assertCanPickCampaign(access);

  const lineId = await resolveLineId(lineName);
  if (lineId == null) return [];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("marketing_requests")
    // Labels only. Adding a money column here would widen what a requester can read — see the
    // header. If a future caller needs campaign cost, it belongs behind the marketing module's own
    // gate, not behind this one.
    .select("id, request_code, status, line_id, area_id, customer_id, requester_hr_id")
    .eq("line_id", lineId)
    .in("status", [...PICKABLE_CAMPAIGN_STATUSES]);
  if (error) throw error;

  // The owner's rule: only the campaigns THIS requester raised. Filtered here rather than in the
  // query because the HR id column is mixed case and the live list is small.
  const rows = ((data ?? []) as CampaignRow[]).filter((row) => isCampaignRaisedBy(row.requester_hr_id, access.hrId));
  if (rows.length === 0) return [];

  const areaIds = [...new Set(rows.map((row) => Number(row.area_id)).filter((id) => Number.isFinite(id)))];
  const customerIds = [...new Set(rows.map((row) => text(row.customer_id)).filter((id): id is string => Boolean(id)))];

  const [areaRes, customerRes, lineRes] = await Promise.all([
    areaIds.length > 0
      ? supabase.from("areas").select("id, name").in("id", areaIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    customerIds.length > 0
      ? supabase.from("marketing_customers").select("id, display_name").in("id", customerIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    supabase.from("lines").select("id, name").eq("id", lineId).maybeSingle(),
  ]);
  if (areaRes.error) throw areaRes.error;
  if (customerRes.error) throw customerRes.error;

  const areaNames = new Map<number, string | null>();
  for (const row of (areaRes.data ?? []) as { id?: unknown; name?: unknown }[]) {
    areaNames.set(Number(row.id), text(row.name));
  }
  const customerNames = new Map<string, string | null>();
  for (const row of (customerRes.data ?? []) as { id?: unknown; display_name?: unknown }[]) {
    const id = text(row.id);
    if (id) customerNames.set(id, text(row.display_name));
  }
  const lineDisplayName = text((lineRes.data as { name?: unknown } | null)?.name);

  const options = rows.map((row): DirectOrderCampaignOption => ({
    id: String(row.id),
    requestCode: text(row.request_code) ?? String(row.id),
    customerName: customerNames.get(text(row.customer_id) ?? "") ?? null,
    areaName: areaNames.get(Number(row.area_id)) ?? null,
    lineName: lineDisplayName,
    status: String(row.status) as MarketingRequestStatus,
  }));

  // By code so the order is stable between renders.
  return options.sort((a, b) => a.requestCode.localeCompare(b.requestCode, "en"));
}

/**
 * Validate a campaign the requester says this order came from, and return the id to store.
 *
 * Server-side, and never trusting the client: the picker is a convenience, this is the boundary. It
 * re-checks the SAME things the list applies — the campaign exists, the requester raised it, it is
 * in a pickable state, and it is on this order's line — so a hand-posted body cannot attach an order to a
 * rejected campaign, another line's campaign, or a campaign id that does not exist.
 *
 * Returns null for "no campaign", which is the normal case and must never be an error.
 */
export async function resolveSubmittedCampaignId(
  access: AccessContext,
  marketingRequestId: string | null | undefined,
  lineName: string | null,
): Promise<string | null> {
  const clean = String(marketingRequestId ?? "").trim();
  if (!clean) return null;

  assertCanPickCampaign(access);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("marketing_requests")
    .select("id, status, line_id, request_code, requester_hr_id")
    .eq("id", clean)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error("That marketing campaign was not found.");
  }

  // Owner rule (2026-10-23): an order attaches only to a campaign its requester raised. Checked
  // before the status so the message never reveals the state of someone else's campaign.
  if (!isCampaignRaisedBy((data as { requester_hr_id?: unknown }).requester_hr_id, access.hrId)) {
    throw new Error("That marketing campaign was not found among your campaigns.");
  }

  const status = String((data as { status?: unknown }).status ?? "") as MarketingRequestStatus;
  if (!PICKABLE_CAMPAIGN_STATUSES.includes(status)) {
    throw new Error(
      `Campaign ${text((data as { request_code?: unknown }).request_code) ?? clean} is "${status}" — an order can only be attached to an approved campaign whose ROI window is still open.`,
    );
  }

  const lineId = await resolveLineId(lineName);
  if (lineId == null || Number((data as { line_id?: unknown }).line_id) !== lineId) {
    throw new Error(
      `Campaign ${text((data as { request_code?: unknown }).request_code) ?? clean} is not on the ${lineName ?? "requested"} line.`,
    );
  }

  return String((data as { id: unknown }).id);
}

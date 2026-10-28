// ─────────────────────────────────────────────────────────────────────────────
// One pharmacy, one person, BOTH modules — the double-cost flag (owner, 2026-10-28).
//
// "A direct order already got its own bonus or discount, and a marketing request is extra money for
// work and cooperation — so we must be informed, because like this we pay the doctor AND the
// pharmacy itself extra cost." His example: Osama raises a marketing request for a customer whose
// pharmacy is Ahmed H, then raises a direct order to Ahmed H — so Ahmed H must be flagged.
//
// THE RULE: when the SAME requester has used the SAME pharmacy in a direct order AND in a marketing
// request (either order — "vice versa"), every approval window of both shows it, to every rung of the
// chain, the CEO included. It is FLAGGED, never blocked and never decided: the approvers still
// approve, return or reject.
//
// "The same pharmacy" is a direct-order venue and a marketing pharmacy joined by the link table the
// automatic hand-over writes (`marketing_pharmacy_direct_order_venues`) or by the SAME distributor +
// customer code pair, matched pairwise — the join the approval window's validation photos already use.
// "The same person" is the requester of each, compared by canonical HR id (both tables store mixed case).
//
// A request that never committed money cannot make anyone pay twice, so a draft, a rejected and a
// cancelled one are left out on both sides — plus an expired or reversed direct order. A returned
// one still counts: it is one resubmit from the chain.
//
// This file is PURE (no database) so the rule is testable; the reads live in
// `same-pharmacy-cross-use-loader.ts`.
// ─────────────────────────────────────────────────────────────────────────────

import { canonicalHrIdKey } from "@/lib/hr-id";
import { describeDirectOrderStatus } from "@/lib/direct-orders/status-labels";
import { marketingRequestStatusLabel } from "@/lib/marketing-requests/request-status-label";
import { INERT_MARKETING_REQUEST_STATUSES } from "@/lib/marketing-requests/request-overlap";

/** Direct-order statuses that never committed money, so they cannot make anyone pay twice. */
export const INERT_DIRECT_ORDER_CROSS_USE_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "rejected",
  "cancelled",
  "expired",
  "reversed",
]);

export function isLiveDirectOrderForCrossUse(status: string | null | undefined): boolean {
  const key = String(status ?? "").trim().toLowerCase();
  return key.length > 0 && !INERT_DIRECT_ORDER_CROSS_USE_STATUSES.has(key);
}

export function isLiveMarketingRequestForCrossUse(status: string | null | undefined): boolean {
  const key = String(status ?? "").trim().toLowerCase();
  return key.length > 0 && !INERT_MARKETING_REQUEST_STATUSES.has(key);
}

/** Same person, whatever case each table stored the HR id in. A blank id never matches anyone. */
export function isSameRequester(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = canonicalHrIdKey(left);
  const b = canonicalHrIdKey(right);
  return Boolean(a) && a === b;
}

/** One use of the pharmacy in the OTHER module, in the words the approval window prints. */
export type SamePharmacyCrossUse = {
  module: "marketing_request" | "direct_order";
  /** The other record's id — a key for the list, never shown. */
  id: string;
  /** "Marketing request MR-0123" or "Direct order of 12 Oct 2026". */
  reference: string;
  statusLabel: string;
  pharmacyName: string;
  description: string;
};

/** The flag an approval window prints. Null when nothing crosses — the render gate. */
export type SamePharmacyCrossUseFlag = {
  requesterName: string;
  pharmacyNames: string[];
  uses: SamePharmacyCrossUse[];
  headline: string;
  explanation: string;
};

const CAIRO_DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

/** The day an instant fell on in Cairo ("22 Aug 2026"), never raw UTC. */
export function crossUseDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : CAIRO_DAY.format(date);
}

function egp(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return `EGP ${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export type MarketingRequestUseInput = {
  id: string;
  requestCode: string;
  status: string;
  currentStepCode: string | null;
  submittedAt: string | null;
  estimatedCost: number | null;
  requestTypeName: string | null;
  customerName: string | null;
  pharmacyName: string;
  /** The direct order being approved names THIS request as the campaign it came from. */
  linkedAsCampaign?: boolean;
};

export function describeMarketingRequestUse(input: MarketingRequestUseInput): SamePharmacyCrossUse {
  const statusLabel = marketingRequestStatusLabel({ currentStepCode: input.currentStepCode, status: input.status });
  const day = crossUseDay(input.submittedAt);
  const what = [input.requestTypeName?.trim(), egp(input.estimatedCost)].filter(Boolean).join(", ");
  const customer = input.customerName?.trim();
  return {
    module: "marketing_request",
    id: input.id,
    reference: `Marketing request ${input.requestCode}`,
    statusLabel,
    pharmacyName: input.pharmacyName,
    description:
      `${what ? `${what} ` : ""}for ${customer ? `the customer ${customer}` : "a customer"} at ${input.pharmacyName}` +
      `${day ? `, submitted ${day}` : ""} — ${statusLabel}.` +
      (input.linkedAsCampaign ? " This order names it as the campaign it came from." : ""),
  };
}

export type DirectOrderUseInput = {
  id: string;
  status: string;
  salesMonth: string | null;
  submittedAt: string | null;
  productName: string | null;
  salesValue: number | null;
  dealType: string | null;
  bonus: number | null;
  discountPct: number | null;
  pharmacyName: string;
  /** The order names THIS marketing request as the campaign it came from. */
  linkedAsCampaign: boolean;
};

function dealText(input: Pick<DirectOrderUseInput, "dealType" | "bonus" | "discountPct">): string | null {
  const deal = String(input.dealType ?? "").toLowerCase();
  if (deal === "discount" && input.discountPct !== null && Number(input.discountPct) > 0) {
    return `${Number(input.discountPct).toLocaleString("en-US", { maximumFractionDigits: 2 })}% discount`;
  }
  if (input.bonus !== null && Number(input.bonus) > 0) return `${Number(input.bonus)} bonus units`;
  return null;
}

export function describeDirectOrderUse(input: DirectOrderUseInput): SamePharmacyCrossUse {
  const statusLabel = describeDirectOrderStatus(input.status, input.salesMonth).label;
  const day = crossUseDay(input.submittedAt);
  const what = [input.productName?.trim(), dealText(input), egp(input.salesValue)].filter(Boolean).join(", ");
  return {
    module: "direct_order",
    id: input.id,
    reference: day ? `Direct order of ${day}` : "Direct order",
    statusLabel,
    pharmacyName: input.pharmacyName,
    description:
      `${what ? `${what} ` : ""}to ${input.pharmacyName} — ${statusLabel}.` +
      (input.linkedAsCampaign ? " The order names this marketing request as the campaign it came from." : ""),
  };
}

/**
 * The flag for the approval window, or null when the requester used none of these pharmacies in the
 * other module. `viewing` is the module of the record being approved.
 */
export function buildSamePharmacyCrossUseFlag(params: {
  viewing: "direct_order" | "marketing_request";
  requesterName: string | null;
  uses: SamePharmacyCrossUse[];
}): SamePharmacyCrossUseFlag | null {
  const seen = new Set<string>();
  const uses = params.uses.filter((use) => {
    const key = `${use.module}:${use.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uses.length === 0) return null;
  const requesterName = params.requesterName?.trim() || "The requester";
  const pharmacyNames = Array.from(new Set(uses.map((use) => use.pharmacyName)));
  const pharmacies = pharmacyNames.join(", ");
  const other = params.viewing === "direct_order" ? "marketing request" : "direct order";
  const count = uses.length === 1 ? `a ${other}` : `${uses.length} ${other}s`;
  return {
    requesterName,
    pharmacyNames,
    uses,
    headline: `Same pharmacy, same person: ${requesterName} also used ${pharmacies} in ${count}`,
    explanation:
      "A direct order already carries its own bonus or discount, and a marketing request is extra money for the " +
      "work and cooperation — approving both pays the doctor and the pharmacy itself an extra cost. " +
      "Flagged for every approver, the CEO included; it is not blocked.",
  };
}

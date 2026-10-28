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
// ONLY AN EXTRA DEAL IS FLAGGED (owner, the same morning): "is the direct order going out with the normal
// bonus or extra?" Every anti-infective goes out at 10% bonus, so Royafloxacin and Saginko are no problem.
// What he looks for is a line above its product's normal level — Ivyronc above 20% bonus (its commercial
// maximum at the distributors; a direct order can carry 30%), Lacto Advanced above 15% discount and
// Guamusin above 10% bonus. A bonus product sold at a discount counts when the discount is worth more than
// the bonus limit, and the other way round (his choice, the same morning). Any other product never flags.
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

/** A product whose direct-order deal is "extra" above this level. Matched by product code. */
export type ExtraDealLimit = {
  productName: string;
  productCodes: readonly string[];
  kind: "bonus" | "discount";
  limitPct: number;
};

export const EXTRA_DEAL_LIMITS: readonly ExtraDealLimit[] = [
  { productName: "Ivyronc", productCodes: ["IV001"], kind: "bonus", limitPct: 20 },
  { productName: "Lacto Advanced", productCodes: ["LA001", "LA002"], kind: "discount", limitPct: 15 },
  { productName: "Guamusin", productCodes: ["GU001"], kind: "bonus", limitPct: 10 },
];

/** One line of a direct order, as the order lines table stores it. */
export type DirectOrderDealLine = {
  productCode: string | null;
  productName: string | null;
  dealType: string | null;
  qty: number | null;
  bonus: number | null;
  discountPct: number | null;
};

function pct(value: number): string {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

/** Two decimals, the way a percentage is printed — so 16.6667% off reads as equal to a 20% bonus. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The line's deal in words when it is above its product's normal level, else null. A bonus of b% gives
 * 100 + b units for the price of 100, so it is worth b / (100 + b) off; that is how a deal of the other
 * kind is compared with the limit.
 */
export function extraDealOnLine(line: DirectOrderDealLine): string | null {
  const code = String(line.productCode ?? "").trim().toUpperCase();
  const limit = EXTRA_DEAL_LIMITS.find((entry) => entry.productCodes.includes(code));
  if (!limit) return null;
  const name = line.productName?.trim() || limit.productName;
  const normal = `the normal ${pct(limit.limitPct)} ${limit.kind}`;
  if (String(line.dealType ?? "").trim().toLowerCase() === "discount") {
    const discount = Number(line.discountPct);
    if (!Number.isFinite(discount) || discount <= 0) return null;
    if (limit.kind === "discount") {
      return discount > limit.limitPct ? `${name} at ${pct(discount)} discount, above ${normal}` : null;
    }
    const worth = round2((100 * limit.limitPct) / (100 + limit.limitPct));
    return round2(discount) > worth
      ? `${name} at ${pct(discount)} discount, worth more than ${normal} (${pct(worth)} off)`
      : null;
  }
  const qty = Number(line.qty);
  const bonus = Number(line.bonus);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(bonus) || bonus <= 0) return null;
  const bonusPct = (bonus * 100) / qty;
  if (limit.kind === "bonus") {
    return bonus * 100 > qty * limit.limitPct ? `${name} at ${pct(bonusPct)} bonus, above ${normal}` : null;
  }
  const worth = round2((100 * limit.limitPct) / (100 - limit.limitPct));
  return round2(bonusPct) > worth
    ? `${name} at ${pct(bonusPct)} bonus, worth more than ${normal} (${pct(worth)} bonus)`
    : null;
}

/** Every extra line of an order, in line order. Empty = a normal deal, never flagged. */
export function extraDealsOnOrder(lines: readonly DirectOrderDealLine[]): string[] {
  return lines.map(extraDealOnLine).filter((deal): deal is string => deal !== null);
}

/** "Ivyronc above 20% bonus, Lacto Advanced above 15% discount, Guamusin above 10% bonus". */
export const EXTRA_DEAL_LIMITS_TEXT = EXTRA_DEAL_LIMITS.map(
  (limit) => `${limit.productName} above ${pct(limit.limitPct)} ${limit.kind}`,
).join(", ");

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
  /** A direct order's lines above their normal level, in words. Empty on a marketing request. */
  extraDeals: string[];
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
    extraDeals: [],
  };
}

export type DirectOrderUseInput = {
  id: string;
  status: string;
  salesMonth: string | null;
  submittedAt: string | null;
  salesValue: number | null;
  /** The order's lines above their normal level — `extraDealsOnOrder`. */
  extraDeals: string[];
  pharmacyName: string;
  /** The order names THIS marketing request as the campaign it came from. */
  linkedAsCampaign: boolean;
};

export function describeDirectOrderUse(input: DirectOrderUseInput): SamePharmacyCrossUse {
  const statusLabel = describeDirectOrderStatus(input.status, input.salesMonth).label;
  const day = crossUseDay(input.submittedAt);
  const what = [input.extraDeals.join("; "), egp(input.salesValue)].filter(Boolean).join(", ");
  return {
    module: "direct_order",
    id: input.id,
    reference: day ? `Direct order of ${day}` : "Direct order",
    statusLabel,
    pharmacyName: input.pharmacyName,
    description:
      `${what ? `${what} ` : ""}to ${input.pharmacyName} — ${statusLabel}.` +
      (input.linkedAsCampaign ? " The order names this marketing request as the campaign it came from." : ""),
    extraDeals: input.extraDeals,
  };
}

/**
 * The flag for the approval window, or null when nothing crosses. `viewing` is the module of the record
 * being approved. Only an EXTRA deal counts: on a direct order, the order itself must carry one
 * (`thisOrderExtraDeals`); on a marketing request, a direct order with no extra line is dropped.
 */
export function buildSamePharmacyCrossUseFlag(params: {
  viewing: "direct_order" | "marketing_request";
  requesterName: string | null;
  uses: SamePharmacyCrossUse[];
  /** On a direct order's window: that order's own lines above their normal level. */
  thisOrderExtraDeals?: readonly string[];
}): SamePharmacyCrossUseFlag | null {
  const thisOrderExtraDeals = params.thisOrderExtraDeals ?? [];
  if (params.viewing === "direct_order" && thisOrderExtraDeals.length === 0) return null;
  const seen = new Set<string>();
  const uses = params.uses.filter((use) => {
    if (use.module === "direct_order" && use.extraDeals.length === 0) return false;
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
    headline: `Same pharmacy, same person, extra deal: ${requesterName} also used ${pharmacies} in ${count}`,
    explanation:
      (params.viewing === "direct_order"
        ? `This order's deal is above the normal level: ${thisOrderExtraDeals.join("; ")}. `
        : `The direct order's deal is above the normal level (${EXTRA_DEAL_LIMITS_TEXT}). `) +
      "A direct order already carries its own bonus or discount, and a marketing request is extra money for the " +
      "work and cooperation — approving both pays the doctor and the pharmacy itself an extra cost. " +
      "Flagged for every approver, the CEO included; it is not blocked.",
  };
}

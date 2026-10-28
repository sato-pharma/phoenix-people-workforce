import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildSamePharmacyCrossUseFlag,
  crossUseDay,
  describeDirectOrderUse,
  describeMarketingRequestUse,
  extraDealOnLine,
  extraDealsOnOrder,
  isLiveDirectOrderForCrossUse,
  isLiveMarketingRequestForCrossUse,
  isSameRequester,
  type DirectOrderDealLine,
} from "../src/lib/direct-orders/same-pharmacy-cross-use.ts";
import { stripComments } from "./support/comment-strip.ts";

// Same pharmacy, same person, BOTH modules (owner, 2026-10-28): a direct order already carries its
// own bonus or discount and a marketing request is extra money on top, so when the SAME requester
// used the SAME pharmacy in both, every approver of either — the CEO included — sees a flag. Flagged,
// never blocked. The same morning he narrowed it to an EXTRA deal only: Ivyronc above 20% bonus,
// Lacto Advanced above 15% discount, Guamusin above 10% bonus. Measured on production that day: 2
// such pairs, both Ivyronc at 25% bonus; Osama's Ivyronc at exactly 20% drops out.

/** Code only, so an explaining comment can never satisfy a wiring pin. */
function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

function line(productCode: string, dealType: "bonus" | "discount", qty: number, value: number): DirectOrderDealLine {
  return {
    productCode,
    productName: null,
    dealType,
    qty,
    bonus: dealType === "bonus" ? value : null,
    discountPct: dealType === "discount" ? value : null,
  };
}

export function runSamePharmacyCrossUseFlagTests() {
  // ── The same person, whatever case each table stored the HR id in ───────────────────────────────
  assert.equal(isSameRequester("P-101", "p-101 "), true, "HR ids are stored in mixed case across the two modules");
  assert.equal(isSameRequester("AAA", "AA"), true, "a legacy alias is the same person");
  assert.equal(isSameRequester("P-101", "P-102"), false, "a different requester is never flagged — the rule is SAME person");
  assert.equal(isSameRequester("", ""), false, "a blank id never matches anyone, even another blank");
  assert.equal(isSameRequester(null, null), false, "a missing id never matches anyone");

  // ── Only money that was committed can make anyone pay twice ─────────────────────────────────────
  for (const status of ["approved", "pending_approval", "returned", "held"]) {
    assert.equal(isLiveDirectOrderForCrossUse(status), true, `a ${status} direct order still counts`);
  }
  for (const status of ["draft", "rejected", "cancelled", "expired", "reversed", "", null]) {
    assert.equal(isLiveDirectOrderForCrossUse(status), false, `a ${String(status)} direct order is left out`);
  }
  for (const status of ["active", "pending_approval", "finance_hold", "returned"]) {
    assert.equal(isLiveMarketingRequestForCrossUse(status), true, `a ${status} marketing request still counts`);
  }
  for (const status of ["draft", "rejected", "cancelled"]) {
    assert.equal(isLiveMarketingRequestForCrossUse(status), false, `a ${status} marketing request is left out`);
  }

  // ── Only an EXTRA deal: each product against its own normal level ───────────────────────────────
  assert.equal(extraDealOnLine(line("IV001", "bonus", 100, 20)), null, "Ivyronc at exactly 20% bonus is normal (Osama's order)");
  assert.equal(
    extraDealOnLine(line("IV001", "bonus", 100, 25)),
    "Ivyronc at 25% bonus, above the normal 20% bonus",
    "Ivyronc above its distributors' 20% maximum is extra",
  );
  assert.equal(extraDealOnLine(line("IV001", "discount", 100, 16.6667)), null, "16.67% off is worth the same as a 20% bonus");
  assert.equal(
    extraDealOnLine(line("IV001", "discount", 100, 55)),
    "Ivyronc at 55% discount, worth more than the normal 20% bonus (16.67% off)",
    "an Ivyronc discount worth more than a 20% bonus is extra (his choice)",
  );
  assert.equal(extraDealOnLine(line("LA001", "discount", 100, 15)), null, "Lacto Advanced at exactly 15% discount is normal");
  assert.equal(
    extraDealOnLine({ ...line("LA002", "discount", 100, 27), productName: "Lacto Advanced 2" }),
    "Lacto Advanced 2 at 27% discount, above the normal 15% discount",
    "both Lacto Advanced codes, named as the line names them",
  );
  assert.equal(extraDealOnLine(line("LA001", "bonus", 100, 17.65)), null, "a 17.65% bonus is worth the same as 15% off");
  assert.match(extraDealOnLine(line("LA001", "bonus", 100, 20)) ?? "", /worth more than the normal 15% discount \(17\.65% bonus\)/);
  assert.equal(extraDealOnLine(line("GU001", "bonus", 50, 5)), null, "Guamusin at exactly 10% bonus is normal");
  assert.equal(extraDealOnLine(line("GU001", "bonus", 50, 10)), "Guamusin at 20% bonus, above the normal 10% bonus");
  assert.match(extraDealOnLine(line("GU001", "discount", 100, 35)) ?? "", /Guamusin at 35% discount, worth more than the normal 10% bonus \(9\.09% off\)/);
  assert.equal(extraDealOnLine(line("RO001", "bonus", 100, 15)), null, "Royafloxacin never flags — anti-infectives are no problem");
  assert.equal(extraDealOnLine(line("SA001", "discount", 100, 50)), null, "Saginko never flags");
  assert.equal(extraDealOnLine(line("iv001 ", "bonus", 100, 30)) !== null, true, "the product code is matched whatever its case");
  assert.equal(extraDealOnLine(line("IV001", "bonus", 0, 5)), null, "a line with no quantity has no bonus percentage");
  assert.deepEqual(
    extraDealsOnOrder([line("RO001", "bonus", 100, 10), line("IV001", "bonus", 40, 12)]),
    ["Ivyronc at 30% bonus, above the normal 20% bonus"],
    "an order is extra when ANY line is",
  );

  // ── Dates are Cairo days, never raw UTC ─────────────────────────────────────────────────────────
  assert.equal(crossUseDay("2026-10-27T22:30:00Z"), "28 Oct 2026", "22:30 UTC on the 27th is already the 28th in Cairo");
  assert.equal(crossUseDay("not a date"), null);

  // ── The words each window prints ────────────────────────────────────────────────────────────────
  const marketingUse = describeMarketingRequestUse({
    id: "mr-1",
    requestCode: "MKT-REQ-1",
    status: "active",
    currentStepCode: null,
    submittedAt: "2026-10-01T08:00:00Z",
    estimatedCost: 15000,
    requestTypeName: "Sponsorship",
    customerName: "Dr Mona",
    pharmacyName: "Ahmed H Pharmacy",
    linkedAsCampaign: true,
  });
  assert.equal(marketingUse.reference, "Marketing request MKT-REQ-1");
  assert.match(marketingUse.description, /Sponsorship, EGP 15,000 for the customer Dr Mona at Ahmed H Pharmacy, submitted 1 Oct 2026/);
  assert.match(marketingUse.description, /campaign it came from/, "an order raised FROM that campaign says so");
  assert.doesNotMatch(marketingUse.description, /\.\.\.|…/, "never an ellipsis");

  const orderUse = describeDirectOrderUse({
    id: "do-1",
    status: "approved",
    salesMonth: "2026-10",
    submittedAt: "2026-10-12T09:00:00Z",
    salesValue: 8200.5,
    extraDeals: ["Ivyronc at 25% bonus, above the normal 20% bonus"],
    pharmacyName: "Ahmed H Pharmacy",
    linkedAsCampaign: false,
  });
  assert.equal(orderUse.reference, "Direct order of 12 Oct 2026");
  assert.match(orderUse.description, /^Ivyronc at 25% bonus, above the normal 20% bonus, EGP 8,200\.5 to Ahmed H Pharmacy/);
  assert.doesNotMatch(orderUse.description, /campaign it came from/);
  const normalOrderUse = describeDirectOrderUse({
    id: "do-2",
    status: "approved",
    salesMonth: null,
    submittedAt: null,
    salesValue: null,
    extraDeals: [],
    pharmacyName: "X",
    linkedAsCampaign: false,
  });
  assert.equal(normalOrderUse.reference, "Direct order");

  // ── The flag: null when nothing crosses, one line per other record, both directions ─────────────
  const extra = ["Ivyronc at 25% bonus, above the normal 20% bonus"];
  assert.equal(
    buildSamePharmacyCrossUseFlag({ viewing: "direct_order", requesterName: "Osama", uses: [], thisOrderExtraDeals: extra }),
    null,
    "no flag at all when the pharmacy was not used in the other module — the render gate",
  );
  assert.equal(
    buildSamePharmacyCrossUseFlag({ viewing: "direct_order", requesterName: "Osama", uses: [marketingUse] }),
    null,
    "a direct order at its normal deal is never flagged, however the pharmacy was used",
  );
  const onOrder = buildSamePharmacyCrossUseFlag({
    viewing: "direct_order",
    requesterName: "Osama",
    uses: [marketingUse, marketingUse],
    thisOrderExtraDeals: extra,
  });
  assert.ok(onOrder);
  assert.equal(onOrder.uses.length, 1, "the same request reached by two links is listed once");
  assert.equal(onOrder.headline, "Same pharmacy, same person, extra deal: Osama also used Ahmed H Pharmacy in a marketing request");
  assert.match(onOrder.explanation, /^This order's deal is above the normal level: Ivyronc at 25% bonus/, "the window names the extra line");
  assert.match(onOrder.explanation, /CEO/, "the CEO is named — the owner said 'especially the CEO'");
  assert.match(onOrder.explanation, /not blocked/, "flag only — the approvers still decide");

  const onRequest = buildSamePharmacyCrossUseFlag({
    viewing: "marketing_request",
    requesterName: null,
    uses: [orderUse, { ...orderUse, id: "do-3" }, normalOrderUse],
  });
  assert.ok(onRequest);
  assert.equal(onRequest.uses.length, 2, "a direct order at its normal deal is dropped from a marketing request's flag");
  assert.equal(onRequest.headline, "Same pharmacy, same person, extra deal: The requester also used Ahmed H Pharmacy in 2 direct orders");
  assert.match(onRequest.explanation, /Ivyronc above 20% bonus, Lacto Advanced above 15% discount, Guamusin above 10% bonus/);
  assert.equal(
    buildSamePharmacyCrossUseFlag({ viewing: "marketing_request", requesterName: null, uses: [normalOrderUse] }),
    null,
    "only normal-deal orders → no flag on the marketing request",
  );

  // ── Wired into BOTH approval windows, every viewer ──────────────────────────────────────────────
  const directOrderService = code("src/lib/direct-orders/service.ts");
  assert.match(directOrderService, /loadSamePharmacyFlagForDirectOrder\(\{/, "the direct-order approval detail reads the flag");
  assert.match(
    directOrderService,
    /loadSamePharmacyFlagForDirectOrder\(\{[^}]*\blines: items,/,
    "with the order's own lines, so the extra-deal test sees them",
  );
  assert.match(directOrderService, /\s samePharmacyMarketingRequests,\s/, "and returns it on the detail");
  const marketingService = code("src/lib/marketing-requests/service.ts");
  assert.match(marketingService, /loadSamePharmacyFlagForMarketingRequest\(\{/, "the marketing decision summary reads the flag");
  assert.match(marketingService, /\s samePharmacyDirectOrders,\s/, "and returns it on the summary");

  for (const [path, prop] of [
    ["src/components/approvals-hub/direct-order-request-detail.tsx", "samePharmacyMarketingRequests"],
    ["src/components/marketing-requests/marketing-request-approver-detail.tsx", "detail.samePharmacyDirectOrders"],
    ["src/components/employee-portal/marketing-request-decision-confirmation.tsx", "summary.samePharmacyDirectOrders"],
  ] as const) {
    const source = code(path);
    assert.ok(
      source.includes("<SamePharmacyCrossUseNotice") && source.includes(`flag={${prop}}`),
      `${path} renders the same-pharmacy notice`,
    );
  }

  // Never breaks the window: both loaders catch, log and answer no flag.
  const loader = code("src/lib/direct-orders/same-pharmacy-cross-use-loader.ts");
  assert.equal((loader.match(/\} catch \(error\) \{\s+logError\(/g) ?? []).length, 2, "both loaders catch, log and answer no flag");
  // Pairwise code match, never two crossed .in() lists.
  assert.match(loader, /\.eq\("distributor_code", distributorCode\)\s+\.eq\("customer_code", customerCode\)/);
  // A normal direct order reads nothing: the extra-deal test runs before the first read.
  const directOrderLoader = loader.slice(loader.indexOf("loadSamePharmacyFlagForDirectOrder"));
  const extraTestAt = directOrderLoader.indexOf("extraDealsOnOrder(params.lines)");
  assert.ok(
    extraTestAt >= 0 && extraTestAt < directOrderLoader.indexOf("getSupabaseAdmin()"),
    "the order's own extra-deal test comes before any database read",
  );
  // A marketing request judges each order by its LINES, never only the order row.
  assert.match(loader, /from\("direct_order_request_items"\)/, "the marketing side reads the order lines");
}

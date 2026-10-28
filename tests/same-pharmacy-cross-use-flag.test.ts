import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildSamePharmacyCrossUseFlag,
  crossUseDay,
  describeDirectOrderUse,
  describeMarketingRequestUse,
  isLiveDirectOrderForCrossUse,
  isLiveMarketingRequestForCrossUse,
  isSameRequester,
} from "../src/lib/direct-orders/same-pharmacy-cross-use.ts";
import { stripComments } from "./support/comment-strip.ts";

// Same pharmacy, same person, BOTH modules (owner, 2026-10-28): a direct order already carries its
// own bonus or discount and a marketing request is extra money on top, so when the SAME requester
// used the SAME pharmacy in both, every approver of either — the CEO included — sees a flag. Flagged,
// never blocked. Measured on production that day: 20 such pairs, 11 orders and 7 requests, 5 people.

/** Code only, so an explaining comment can never satisfy a wiring pin. */
function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
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
    productName: "Lacto Advanced",
    salesValue: 8200.5,
    dealType: "bonus",
    bonus: 10,
    discountPct: null,
    pharmacyName: "Ahmed H Pharmacy",
    linkedAsCampaign: false,
  });
  assert.equal(orderUse.reference, "Direct order of 12 Oct 2026");
  assert.match(orderUse.description, /Lacto Advanced, 10 bonus units, EGP 8,200\.5 to Ahmed H Pharmacy/);
  assert.doesNotMatch(orderUse.description, /campaign it came from/);
  const discountUse = describeDirectOrderUse({
    id: "do-2",
    status: "approved",
    salesMonth: null,
    submittedAt: null,
    productName: null,
    salesValue: null,
    dealType: "discount",
    bonus: null,
    discountPct: 12.5,
    pharmacyName: "X",
    linkedAsCampaign: false,
  });
  assert.match(discountUse.description, /12\.5% discount/);
  assert.equal(discountUse.reference, "Direct order");

  // ── The flag: null when nothing crosses, one line per other record, both directions ─────────────
  assert.equal(
    buildSamePharmacyCrossUseFlag({ viewing: "direct_order", requesterName: "Osama", uses: [] }),
    null,
    "no flag at all when the pharmacy was not used in the other module — the render gate",
  );
  const onOrder = buildSamePharmacyCrossUseFlag({ viewing: "direct_order", requesterName: "Osama", uses: [marketingUse, marketingUse] });
  assert.ok(onOrder);
  assert.equal(onOrder.uses.length, 1, "the same request reached by two links is listed once");
  assert.equal(onOrder.headline, "Same pharmacy, same person: Osama also used Ahmed H Pharmacy in a marketing request");
  assert.match(onOrder.explanation, /CEO/, "the CEO is named — the owner said 'especially the CEO'");
  assert.match(onOrder.explanation, /not blocked/, "flag only — the approvers still decide");

  const onRequest = buildSamePharmacyCrossUseFlag({
    viewing: "marketing_request",
    requesterName: null,
    uses: [orderUse, { ...orderUse, id: "do-3" }],
  });
  assert.ok(onRequest);
  assert.equal(onRequest.headline, "Same pharmacy, same person: The requester also used Ahmed H Pharmacy in 2 direct orders");

  // ── Wired into BOTH approval windows, every viewer ──────────────────────────────────────────────
  const directOrderService = code("src/lib/direct-orders/service.ts");
  assert.match(directOrderService, /loadSamePharmacyFlagForDirectOrder\(\{/, "the direct-order approval detail reads the flag");
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
}

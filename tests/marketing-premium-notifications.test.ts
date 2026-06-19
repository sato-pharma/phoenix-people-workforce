import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildMarketingEmailCard } from "@/lib/marketing-requests/service";
import type { MarketingRequest, MarketingRequestProduct } from "@/lib/marketing-requests/types";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

function fakeRequest(): MarketingRequest {
  return {
    estimatedCost: 3000,
    expectedRoiValue: 10000,
    payDate: "2026-07-01",
    requiredRoiValue: 30000,
    roiDurationMonths: 1,
  } as unknown as MarketingRequest;
}

function fakeProduct(name: string, quantity: number, value: number): MarketingRequestProduct {
  return {
    expectedValue: value,
    forecastQuantity: quantity,
    productNameSnapshot: name,
  } as unknown as MarketingRequestProduct;
}

/**
 * The premium marketing notification email: a pre-rendered HTML card injected through the
 * {{planTable}} raw-HTML token. The email sanitizer (src/lib/email/email-safety.ts) DROPS
 * `div`, `border-radius`, `box-shadow` and `margin`, so the card MUST be table-based with a
 * whitelisted style vocabulary, and any user text (the return reason) MUST be HTML-escaped.
 */
export async function runMarketingPremiumNotificationTests() {
  const card = buildMarketingEmailCard({
    currentStepName: "Marketing Review",
    noteHeading: "Returned",
    products: [fakeProduct("Pediacare Drops 15ml", 120, 1800), fakeProduct("Pedia Syrup 100ml", 60, 900)],
    request: fakeRequest(),
    returnedByName: "Ali Mohamed Ali",
    returnNote: "Reduce the quantity and attach the pharmacy display photo.",
  });

  // ── Rich content the bare email never had ──
  assert.match(card.html, /Pediacare Drops 15ml/, "products table must list the products");
  assert.match(card.html, /EGP 1,800/, "product value rendered");
  assert.match(card.html, /EGP 3,000/, "estimated cost tile rendered");
  assert.match(card.html, /EGP 30,000/, "required ROI tile rendered");
  assert.match(card.html, /Required ROI · 1 mo/, "required ROI is labelled with the duration");
  assert.match(card.html, /Returned by Ali Mohamed Ali · reason/, "return callout names the decider");
  assert.match(card.html, /Reduce the quantity and attach the pharmacy display photo\./, "return reason text shown");
  assert.match(card.html, /Currently with:/, "current step surfaced");

  // ── Email-sanitizer safety: table-based, no dropped constructs ──
  assert.match(card.html, /<table/i, "the card must be table-based");
  assert.doesNotMatch(card.html, /<div/i, "no <div> — the email sanitizer discards it");
  assert.doesNotMatch(card.html, /border-radius|box-shadow|margin:|display:/i, "avoid styles the sanitizer strips");

  // ── User text is HTML-escaped (no raw injection through the raw-HTML token) ──
  const injected = buildMarketingEmailCard({
    products: [],
    request: fakeRequest(),
    returnNote: "<script>alert(1)</script>",
  });
  assert.doesNotMatch(injected.html, /<script>/i, "return note must be HTML-escaped");
  assert.match(injected.html, /&lt;script&gt;/, "escaped form present");

  // Heading defaults to "Returned" and switches for rejection.
  assert.match(injected.html, /Returned · reason/, "note heading defaults to Returned");

  // ── Plain-text projection ──
  assert.match(card.text, /Pediacare Drops 15ml/);
  assert.match(card.text, /Estimated cost: EGP 3,000/);
  assert.match(card.text, /reason: Reduce the quantity/);

  // ── Source-pinned wiring so a refactor can't silently regress the feature ──
  const service = source("src/lib/marketing-requests/service.ts");
  assert.match(service, /planTableHtml: emailCard\.html/, "marketing email must pass the card via planTableHtml");
  assert.match(service, /planTableText: emailCard\.text/, "marketing email must pass the plain-text card");
  assert.match(service, /returnNote: comment/, "the decision flow must forward the return reason to the notification");

  const templates = source("src/lib/email-templates/service.ts");
  assert.match(
    templates,
    /marketing_request:[\s\S]{0,160}\{\{planTable\}\}/,
    "the marketing_request email template body must render {{planTable}}",
  );

  // ── Review view carries the full request context (no click-through to decide) ──
  assert.match(service, /export type MarketingDecisionProductLine/, "decision summary must expose product lines");
  assert.match(service, /requiredRoiValue: request\.requiredRoiValue/, "decision summary must include the required ROI");
  const decisionView = source("src/components/employee-portal/marketing-request-decision-confirmation.tsx");
  assert.match(decisionView, /summary\.products\.map/, "the review view must render the products");
  assert.match(decisionView, /Approval progress/, "the review view must show the approval chain");

  // ── Returned-for-edit banner surfaces who returned it and why ──
  const drafts = source("src/components/employee-portal/marketing-request-drafts.tsx");
  assert.match(drafts, /resubmitReturnReason/, "returned-for-edit banner must surface the return reason");
  assert.match(drafts, /returnReason \?\? returnedStep\?\.decisionNote/, "banner must read the returned step's note");
}

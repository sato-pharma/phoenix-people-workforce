import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildMarketingEmailContext } from "@/lib/marketing-requests/service";
import type { MarketingRequest, MarketingRequestProduct } from "@/lib/marketing-requests/types";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

function fakeRequest(): MarketingRequest {
  return {
    estimatedCost: 3000,
    expectedRoiValue: 10000,
    payDate: "2026-07-01",
    requestCode: "MKT-REQ-TEST",
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
 * The marketing email is now FULLY EDITABLE in /admin/email-templates: the premium layout lives in
 * the marketing_request template body using tokens, and the code only supplies the VALUES via the
 * `templateContext` passthrough. `productsTable` + `returnCallout` are pre-rendered HTML blocks (the
 * only parts that can't be hand-typed) — table-based + HTML-escaped, since the email sanitizer drops
 * `div`/`border-radius`/`margin`.
 */
export async function runMarketingPremiumNotificationTests() {
  const ctx = buildMarketingEmailContext({
    currentStepName: "Marketing Review",
    customerName: "El Ezaby — Nasr City",
    noteHeading: "Returned",
    products: [fakeProduct("Pediacare Drops 15ml", 120, 1800), fakeProduct("Pedia Syrup 100ml", 60, 900)],
    request: fakeRequest(),
    returnedByName: "Ali Mohamed Ali",
    returnNote: "Reduce the quantity and attach the pharmacy display photo.",
  });

  // ── Scalar token values (filled per request, arranged/labelled in the admin template) ──
  assert.equal(ctx.estimatedCost, "EGP 3,000");
  assert.equal(ctx.requiredRoi, "EGP 30,000");
  assert.equal(ctx.payDate, "2026-07-01");
  assert.equal(ctx.customerName, "El Ezaby — Nasr City");
  assert.equal(ctx.currentStep, "Marketing Review");
  assert.equal(ctx.requestCode, "MKT-REQ-TEST");
  assert.match(String(ctx.roiWindow), /.+/);

  // ── productsTable raw-HTML block: table-based, no div, with text projection ──
  assert.match(String(ctx.productsTable), /Pediacare Drops 15ml/);
  assert.match(String(ctx.productsTable), /EGP 1,800/);
  assert.match(String(ctx.productsTable), /<table/i);
  assert.doesNotMatch(String(ctx.productsTable), /<div/i);
  assert.match(String(ctx.productsTableText), /Pediacare Drops 15ml/);

  // ── returnCallout raw-HTML block: leads with heading + decider, reason HTML-escaped ──
  assert.match(String(ctx.returnCallout), /Returned by Ali Mohamed Ali · reason/);
  assert.match(String(ctx.returnCallout), /Reduce the quantity/);
  assert.doesNotMatch(String(ctx.returnCallout), /<div/i);
  assert.match(String(ctx.returnCalloutText), /reason: Reduce the quantity/);

  // Empty blocks when there's nothing to show (so the template renders cleanly).
  const empty = buildMarketingEmailContext({ products: [], request: fakeRequest() });
  assert.equal(empty.productsTable, "");
  assert.equal(empty.returnCallout, "");
  assert.equal(empty.customerName, "—");

  // XSS — the return note is HTML-escaped before going into the raw block.
  const injected = buildMarketingEmailContext({
    products: [],
    request: fakeRequest(),
    returnNote: "<script>alert(1)</script>",
  });
  assert.doesNotMatch(String(injected.returnCallout), /<script>/i);
  assert.match(String(injected.returnCallout), /&lt;script&gt;/);

  // ── Engine: tokens registered + the two raw-HTML blocks ──
  const templates = source("src/lib/email-templates/service.ts");
  assert.match(templates, /"productsTable"/, "productsTable must be a registered placeholder");
  assert.match(templates, /"estimatedCost"/, "estimatedCost must be a registered placeholder");
  const htmlBlockTokensLine = templates.match(/const htmlBlockTokens: ReadonlySet<string> = new Set\(\[([^\]]+)\]\);/)?.[1] ?? "";
  for (const token of ["planTable", "productsTable", "returnCallout", "scoreTable"]) {
    assert.ok(htmlBlockTokensLine.includes(`"${token}"`), `${token} must be a raw-HTML block token`);
  }
  assert.match(templates, /\{\{productsTable\}\}/, "marketing_request body must render {{productsTable}}");
  assert.match(templates, /\{\{estimatedCost\}\}/, "marketing_request body must render {{estimatedCost}}");

  // ── Passthrough wiring: both marketing emails fill the template via templateContext ──
  const service = source("src/lib/marketing-requests/service.ts");
  const wiring = service.match(/templateContext: (emailContext|submittedContext)/g) ?? [];
  assert.equal(wiring.length, 2, "both the workflow and submitted emails must pass templateContext");
  assert.match(service, /returnNote: comment/, "the decision flow must forward the return reason");
  const email = source("src/lib/notifications/email.ts");
  assert.match(
    email,
    /\.\.\.\(input\.templateContext \?\? \{\}\)/,
    "email.ts must merge the caller templateContext into the render context",
  );

  // ── Review view + returned-for-edit banner still in place ──
  assert.match(service, /export type MarketingDecisionProductLine/, "decision summary must expose product lines");
  const decisionView = source("src/components/employee-portal/marketing-request-decision-confirmation.tsx");
  assert.match(decisionView, /summary\.products\.map/, "the review view must render the products");
  const drafts = source("src/components/employee-portal/marketing-request-drafts.tsx");
  assert.match(drafts, /resubmitReturnReason/, "returned-for-edit banner must surface the return reason");
}

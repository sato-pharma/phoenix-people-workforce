import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  summariseCustomerHistory,
  type MarketingCustomerHistoryEntry,
} from "@/lib/marketing-requests/approver-detail";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

function entry(partial: Partial<MarketingCustomerHistoryEntry>): MarketingCustomerHistoryEntry {
  return {
    actualSalesValue: null,
    estimatedCost: 0,
    payDate: null,
    requestCode: "MKT-REQ-X",
    roiStatus: null,
    status: "approved",
    ...partial,
  };
}

/**
 * The approver's "what has this customer already cost us" panel.
 *
 * Three states arrive here looking identical — no rows — and mean opposite things:
 *   1. this customer has never had a marketing request  (a clean slate)
 *   2. earlier requests exist but nobody has calculated their return yet  (unmeasured)
 *   3. the lookup failed  (unknown)
 *
 * Rendering any of them as `EGP 0` tells the CEO the campaign returned nothing, which is a
 * materially worse claim than "we have not measured it". This is the repo's most-repeated defect
 * class — missing data rendering as absence or zero — so it is pinned rather than trusted.
 */
export function runMarketingApproverCustomerHistoryTests() {
  // ── 1. Clean slate: the customer has never been marketed to ────────────────────────────────
  const fresh = summariseCustomerHistory([]);
  assert.equal(fresh.isFirstRequest, true, "no earlier requests is a first request, and says so");
  assert.equal(fresh.available, true, "a clean slate is a known fact, not a failed lookup");
  assert.equal(fresh.priorSpend, 0, "nothing was ever spent — a true zero, not a placeholder");
  assert.equal(
    fresh.priorRealisedSales,
    null,
    "there is no campaign whose return could have been measured, so realised sales is null not 0",
  );

  // ── 2. Earlier spend exists, but no ROI has ever been calculated ───────────────────────────
  const unmeasured = summariseCustomerHistory([
    entry({ estimatedCost: 5000, requestCode: "MKT-REQ-A" }),
    entry({ estimatedCost: 2500, requestCode: "MKT-REQ-B" }),
  ]);
  assert.equal(unmeasured.isFirstRequest, false, "earlier requests exist, so this is not a first request");
  assert.equal(unmeasured.priorSpend, 7500, "prior spend totals every earlier request");
  assert.equal(
    unmeasured.priorRealisedSales,
    null,
    "NOT 0 — showing zero here says the campaigns returned nothing, when nothing was ever measured",
  );

  // ── 3. Partially measured: only the measured ones are totalled ─────────────────────────────
  const partial = summariseCustomerHistory([
    entry({ actualSalesValue: 12000, estimatedCost: 5000, requestCode: "MKT-REQ-A" }),
    entry({ estimatedCost: 2500, requestCode: "MKT-REQ-B" }),
    entry({ actualSalesValue: 3000, estimatedCost: 1000, requestCode: "MKT-REQ-C" }),
  ]);
  assert.equal(partial.priorSpend, 8500, "spend counts every earlier request, measured or not");
  assert.equal(
    partial.priorRealisedSales,
    15000,
    "realised sales totals only the requests that actually have a calculated return",
  );
  assert.equal(
    partial.entries.filter((row) => row.actualSalesValue === null).length,
    1,
    "the unmeasured request stays visibly unmeasured in the per-row list",
  );

  // ── 4. A genuine measured zero is preserved — it is a real finding, not missing data ───────
  const measuredZero = summariseCustomerHistory([
    entry({ actualSalesValue: 0, estimatedCost: 4000, requestCode: "MKT-REQ-D" }),
  ]);
  assert.equal(
    measuredZero.priorRealisedSales,
    0,
    "a request measured at zero return keeps its zero — that is a real result, not absent data",
  );

  // ── Wiring: the UI must distinguish all three states, and never invent the photo ───────────
  const panel = source("src/components/marketing-requests/marketing-request-approver-detail.tsx");
  assert.match(
    panel,
    /could not be loaded — treat this as unknown, not as zero/,
    "a failed history lookup is stated as unknown, never rendered as a clean slate",
  );
  assert.match(
    panel,
    /First marketing request ever raised for this customer/,
    "a genuine clean slate is stated in words",
  );
  assert.match(
    panel,
    /Never measured/,
    "an unmeasured return is labelled, not shown as a currency zero",
  );
  // marketing_evidence_files is empty and no bucket holds these captures, so the image genuinely
  // does not exist. The panel must not imply otherwise.
  assert.match(
    panel,
    /filename only, the image is not stored/,
    "the evidence photo is a filename with no stored image — the UI must say so rather than imply proof exists",
  );

  const service = source("src/lib/marketing-requests/approver-detail.ts");
  assert.match(
    service,
    /getMarketingRequestDecisionSummary\(requestId, "approve", access\)/,
    "detail composes the authorized summary rather than re-implementing its access check",
  );
  assert.match(
    source("app/api/marketing-requests/[id]/approver-detail/route.ts"),
    /getMarketingRequestApproverDetail/,
    "the route delegates to the service",
  );
}

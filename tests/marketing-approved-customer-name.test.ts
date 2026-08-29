import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildMarketingApprovedRequestRows } from "../src/lib/marketing-requests/service.ts";
import type { MarketingCustomer, MarketingRequest } from "../src/lib/marketing-requests/types.ts";

/**
 * The finance table must never label a request with a raw customer UUID.
 *
 * Found by opening the page as a Finance Manager on 2026-08-30: one of his four approved rows
 * read `b254483b-1bba-4c4e-818c-b44d58b23001` instead of "Hossam bosraty". The customer existed
 * and had a display name — it had simply been DEACTIVATED after its request was approved, so it
 * fell out of the workspace's customer list, which is filtered `active.is.null,active.eq.true`.
 *
 * That filter is correct for the create form and wrong for this table, so the loader now resolves
 * the leftovers by id. Both halves are pinned here: the builder must never emit an id, and the
 * loader must keep feeding it the merged list.
 */
export function runMarketingApprovedCustomerNameTests() {
  const customerId = "b254483b-1bba-4c4e-818c-b44d58b23001";
  const request = {
    customerId,
    estimatedCost: 11200,
    id: "REQ-UUID-1",
    notes: null,
    payDate: "2026-08-22",
    requestCode: "MKT-REQ-UUID-1",
    requesterHrId: "B-94",
    status: "active",
  } as unknown as MarketingRequest;

  // ── The headline: an unresolvable customer is described in words, never as an id ───────────────
  const orphaned = buildMarketingApprovedRequestRows({
    customers: [],
    employeeRows: [],
    financeRequirements: [],
    requests: [request],
  });
  assert.equal(orphaned.length, 1);
  assert.notEqual(
    orphaned[0].customerName,
    customerId,
    "the finance table must never fall back to printing the raw customer id",
  );
  assert.ok(
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orphaned[0].customerName),
    "the customer cell must never render a bare UUID in any form",
  );
  assert.equal(orphaned[0].customerName, "Unknown customer");

  // ── A DEACTIVATED customer still gets its name: the builder does not filter on `active`, which
  //    is why resolving it in the loader is enough to fix the screen. ─────────────────────────────
  const retired = buildMarketingApprovedRequestRows({
    customers: [{ active: false, displayName: "Hossam bosraty", id: customerId } as unknown as MarketingCustomer],
    employeeRows: [],
    financeRequirements: [],
    requests: [request],
  });
  assert.equal(
    retired[0].customerName,
    "Hossam bosraty",
    "a customer deactivated after approval keeps its name on the finance table",
  );

  // ── The loader half. Without this the builder above is handed the active-only picker list again
  //    and the UUID returns, with every assertion above still green. ──────────────────────────────
  const service = readFileSync("src/lib/marketing-requests/service.ts", "utf8");
  assert.ok(
    service.includes("customers: approvedRowCustomers,"),
    "the workspace loader must pass the merged customer list to the approved-rows builder",
  );
  // Pinned as the whole declaration, not as a bare identifier: a first attempt asserted only that
  // the NAME appeared somewhere in the file, which stayed green when the block was renamed away
  // because the name survived at its other use sites. A blind assertion is worse than no assertion.
  assert.ok(
    service.includes("const approvedRowCustomers = approvedOnlyCustomerIds.length > 0"),
    "the merged list must still be built by fetching the leftover approved-request customers by id",
  );
  assert.ok(
    !service.includes("customerName: customer?.displayName ?? request.customerId"),
    "the id fallback must not come back",
  );
}

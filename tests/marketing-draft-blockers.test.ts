import assert from "node:assert/strict";

import { marketingDraftBlockers } from "../src/lib/marketing-requests/draft-blockers.ts";

// The list that both disables the portal's Save button and names the reason beside it. It exists
// because the button used to be driven by a bare boolean: a District Sales Manager filled the
// whole form on 2026-08-19 and could not submit, because her customer's only target pharmacy
// carried a distributor code the reference database cannot find. That pharmacy is ticked by
// default and the justification the gate wants was three screens above the button, so the button
// simply greyed out and said nothing. The request never reached the server, so there was no error
// row and no log line either.
//
// What these assertions pin is therefore not "the rules" — they were already enforced — but that
// every rule states itself, and states itself in the order the requester will meet it scrolling.

const complete = {
  customerId: "cust-1",
  estimatedCost: 4000,
  hasProductWithQuantity: true,
  otherRequestType: "",
  requestDate: "2026-08-19",
  requestTypeId: "2",
  requiresDescription: false,
  roiDurationMonths: "3",
  unverifiedCodesMissingReason: 0,
};

export function runMarketingDraftBlockersTests() {
  assert.deepEqual(
    marketingDraftBlockers(complete),
    [],
    "a complete form reports nothing missing — an empty list is what enables Save, so a spurious entry here would freeze a valid request",
  );

  // The gate that actually fired in production.
  assert.deepEqual(
    marketingDraftBlockers({ ...complete, unverifiedCodesMissingReason: 1 }),
    ["Explain the unrecognised pharmacy code"],
    "an unrecognised pharmacy code with no written reason names itself — this is the blocker that left a real DSM stuck with a dead button and no message",
  );

  assert.deepEqual(
    marketingDraftBlockers({ ...complete, unverifiedCodesMissingReason: 3 }),
    ["Explain 3 unrecognised pharmacy codes"],
    "the count is carried, because the reason is per pharmacy and clearing one of three leaves Save still refusing",
  );

  // Field order, not evaluation order: the form renders customer above Target Pharmacies above
  // request type, and the UI shows only the first entry, so a mis-ordered list would send the
  // requester scrolling to the wrong field.
  assert.deepEqual(
    marketingDraftBlockers({
      ...complete,
      customerId: "",
      requestTypeId: "",
      unverifiedCodesMissingReason: 2,
    }),
    [
      "Select a customer",
      "Explain 2 unrecognised pharmacy codes",
      "Select a request type",
    ],
    "blockers come back in top-to-bottom form order, because only the first is spelled out on screen",
  );

  assert.deepEqual(
    marketingDraftBlockers({ ...complete, estimatedCost: 0 }),
    ["Enter an estimated cost"],
    "a zero cost blocks: the required-ROI multiple is computed from it, so a zero would make every request trivially pass its own ROI test",
  );

  assert.deepEqual(
    marketingDraftBlockers({ ...complete, estimatedCost: Number.NaN }),
    ["Enter an estimated cost"],
    "an unparsable cost blocks too — the form feeds this through fieldNumber, and NaN must fail closed rather than slip past a `> 0` written the other way round",
  );

  assert.deepEqual(
    marketingDraftBlockers({ ...complete, hasProductWithQuantity: false }),
    ["Add a product and quantity"],
    "a request with no forecast units can never be credited a sale, so it is refused before it is saved",
  );

  assert.deepEqual(
    marketingDraftBlockers({
      ...complete,
      otherRequestType: "   ",
      requiresDescription: true,
    }),
    ["Describe the request type"],
    "whitespace is not a description — the API applies the same trim, and a form that accepted this would be refused server-side",
  );

  assert.deepEqual(
    marketingDraftBlockers({ ...complete, requiresDescription: true, otherRequestType: "Doctor meeting" }),
    [],
    "a described 'Other' request clears the gate — the description is only demanded by request types that carry requires_description",
  );

  assert.deepEqual(
    marketingDraftBlockers({ ...complete, requestDate: "", roiDurationMonths: "" }),
    ["Enter a request date", "Enter an ROI duration"],
    "both date fields report independently, so clearing one never hides the other",
  );
}

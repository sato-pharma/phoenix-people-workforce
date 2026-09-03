import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { normalizeMarketingRequestDraftInput } from "../src/lib/marketing-requests/service.ts";

// `marketing_requests.customer_contact_id` existed from the day the table did and NOTHING ever
// wrote it — all 29 Phoenix requests held null, measured on production 2026-09-03. The service
// accepted, validated and persisted the field the whole time; the DRAFT FORM simply had no way to
// offer a contact, so nothing upstream ever sent one.
//
// The cost was not a blank column. src/lib/crm/contact-trade.ts had to make the CRM link at
// CUSTOMER level instead, which fans a request out to every linked contact of its customer — two
// contacts at one clinic both take credit for a request that concerned one of them.
//
// This test pins the whole chain, because any single link going quiet restores the old silence
// with no error anywhere: the picker would just be empty, and every request would save with null.

const SERVICE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/marketing-requests/service.ts", import.meta.url)),
  "utf8",
);

const FORM_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/components/employee-portal/marketing-request-drafts.tsx", import.meta.url)),
  "utf8",
);

const DIRECT_ORDER_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/direct-orders/service.ts", import.meta.url)),
  "utf8",
);

export function runMarketingRequestContactLinkTests() {
  // 1. The contact survives normalization, trimmed. This is the only leg with real behaviour to
  // call rather than source to read, and it is the leg that was never broken — kept so a future
  // change to cleanText/normalize cannot quietly drop the field on its way to the insert.
  const normalized = normalizeMarketingRequestDraftInput({
    customerContactId: "  contact-77  ",
    customerId: "cus-1",
    estimatedCost: 100,
    pharmacies: [],
    products: [{ productId: 1, quantity: 5 }],
    requestDate: "2026-09-01",
    requestTypeId: 3,
    roiDurationMonths: 3,
  } as never);
  assert.equal(
    normalized.customerContactId,
    "contact-77",
    "normalizeMarketingRequestDraftInput must carry customerContactId through to the insert",
  );

  // 2. "No specific contact" must normalize to null, not "". An empty string would be looked up as
  // an id, find nothing, and fail a save for a field the requester deliberately left blank.
  const blank = normalizeMarketingRequestDraftInput({
    customerContactId: "",
    customerId: "cus-1",
    estimatedCost: 100,
    pharmacies: [],
    products: [{ productId: 1, quantity: 5 }],
    requestDate: "2026-09-01",
    requestTypeId: 3,
    roiDurationMonths: 3,
  } as never);
  assert.equal(blank.customerContactId, null, "an unset contact must normalize to null, never an empty string");

  // 3. The workspace must actually READ the contacts. Without this query contactsByCustomer is
  // always {}, the picker is always empty, and every request saves with a null contact again —
  // which is precisely the state this work exists to end, and it raises no error at all.
  assert.match(
    SERVICE_SOURCE,
    /\.from\("marketing_customer_contacts"\)\s*\n\s*\.select\("id, customer_id, contact_name, crm_code, mobile_number"\)/,
    "the cached draft reference loader must select the customers' contacts",
  );
  assert.match(
    SERVICE_SOURCE,
    /contactsByCustomer,/,
    "getMarketingRequestDraftWorkspace must return contactsByCustomer",
  );

  // 4. The form must SEND it. The service has accepted this field all along; the send is the leg
  // that was missing, so it is the one most worth pinning.
  assert.match(
    FORM_SOURCE,
    /customerContactId: customerContactId \|\| null,/,
    "the draft payload must send customerContactId",
  );

  // 5. The sent value must be derived from the CURRENT customer's options, never the raw choice.
  // Switching customer after picking a contact would otherwise send a contact belonging to the
  // previous one, which the server refuses — the requester sees a save fail on a field they never
  // touched, and the message names a contact rather than the customer they just changed.
  assert.match(
    FORM_SOURCE,
    /contactOptions\.some\(\(option\) => option\.id === customerContactChoice\)/,
    "the form must derive the submitted contact from the selected customer's own contacts",
  );

  // 6. A reversal must mirror the marketing link. The reversal insert already carries a comment
  // about deal_type silently defaulting and mislabelling every list, report and export — this is
  // the same trap on the field this work populates. Without it the original counts against the
  // campaign's ROI while its reversal counts against nothing, so reversing never nets to zero.
  assert.match(
    DIRECT_ORDER_SOURCE,
    /marketing_request_id: original\.marketingRequestId,/,
    "a direct-order reversal must carry the original's marketing_request_id",
  );
}

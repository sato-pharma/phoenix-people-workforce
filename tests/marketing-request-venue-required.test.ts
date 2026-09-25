import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { marketingDraftBlockers } from "../src/lib/marketing-requests/draft-blockers.ts";
import { stripComments } from "./support/comment-strip.ts";

// A marketing request must name at least one target venue.
//
// This is the money half of AGENTS.md §4.1: a venue is what carries the GPS fix, the live picture
// and the registered distributor code, so a request with no venue has no identity to validate and
// no code for attribution to match a sale against. It is not a lighter request — it is one that
// can never be measured and was never checked.
//
// Production, 2026-09-06: MKT-REQ-20260831-F060E9FF reached `pending_approval` carrying 2,500 EGP
// and zero rows in `marketing_request_pharmacies`. The path is exact and it is not misuse. Its
// customer's only pharmacy held distributor code 1536256, which the reference database cannot
// find; the unverified-code gate demands a written justification for such a code, and the form
// offers unticking the pharmacy as the alternative. Unticking the ONLY pharmacy emptied the
// request. The form warned in amber and Save stayed live, because the blocker list had no entry
// for it and neither write path counted the rows before inserting them.
//
// Pinned in three places because that is how many had to be wrong at once: the blocker list that
// drives Save, the create path, and the resubmit path. Resubmit is the one that reads as already
// covered and was not — it deletes and re-inserts the whole target list, so it writes a draft as
// much as create does, yet it ran neither this check nor the validated-customer check.

const SERVICE = "src/lib/marketing-requests/service.ts";
const PORTAL = "src/components/employee-portal/marketing-request-drafts.tsx";

function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

/**
 * Slice one exported function by NAME rather than by a byte window. A fixed offset would
 * false-fail the moment anything above it in a 427KB file moves, which is the failure mode that
 * makes source-pinned tests get deleted instead of fixed.
 */
function exportedFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in ${SERVICE} — it was renamed or removed`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

const complete = {
  customerId: "cust-1",
  estimatedCost: 4000,
  hasProductWithQuantity: true,
  otherRequestType: "",
  requestDate: "2026-08-31",
  requestTypeId: "2",
  requiresDescription: false,
  roiDurationMonths: "3",
  selectedPharmacyCount: 1,
  unverifiedCodesMissingReason: 0,
};

export function runMarketingRequestVenueRequiredTests() {
  // The exact production shape: everything else filled, every pharmacy unticked.
  assert.deepEqual(
    marketingDraftBlockers({ ...complete, selectedPharmacyCount: 0 }),
    ["Select a target pharmacy"],
    "an empty target list must disable Save and name itself — this is the state MKT-REQ-20260831-F060E9FF was saved in",
  );

  assert.deepEqual(
    marketingDraftBlockers(complete),
    [],
    "one ticked pharmacy clears the gate — over-tightening here would freeze every valid request, which is its own outage",
  );

  // Order matters: the requester is sent to the first reason named. With nothing selected there is
  // nothing to justify, so a code-reason message would point at a box no longer on screen.
  assert.deepEqual(
    marketingDraftBlockers({ ...complete, selectedPharmacyCount: 0, unverifiedCodesMissingReason: 2 }),
    ["Select a target pharmacy", "Explain 2 unrecognised pharmacy codes"],
    "the venue blocker is named before the code-justification blocker, because unticking is what empties the list",
  );

  assert.deepEqual(
    marketingDraftBlockers({ ...complete, customerId: "", selectedPharmacyCount: 0 }),
    ["Select a customer", "Select a target pharmacy"],
    "customer still comes first — the pharmacy list is derived from the customer, so choosing one is the earlier fix",
  );

  const service = code(SERVICE);
  const portal = code(PORTAL);

  // The form's guard is only a hint: the portal posts a raw body, so the refusal has to be on the
  // server or a crafted request walks straight past a disabled button.
  assert.match(
    service,
    /marketing_request_has_no_venue/,
    "the refusal must carry a stable error code so the portal can explain it rather than showing a bare 400",
  );

  for (const name of ["createMarketingRequestDraft", "resubmitReturnedMarketingRequest"] as const) {
    const body = exportedFunctionBody(service, name);

    assert.match(
      body,
      /assertMarketingRequestNamesAVenue\(prepared\.pharmacyRows\.length\)/,
      `${name} must count the prepared target rows before writing — counting the payload instead would miss rows dropped in preparation`,
    );
    assert.match(
      body,
      /await assertMarketingCustomerHasValidatedVenue\(supabase, normalized\.customerId\)/,
      `${name} must re-check that the customer still holds a validated venue link — a returned request can outlive the customer it names`,
    );
  }

  // The resubmit refusal has to precede the delete, or an empty edited set strips the targets off
  // a request that already had them and leaves it worse than it started.
  const resubmit = exportedFunctionBody(service, "resubmitReturnedMarketingRequest");
  assert.ok(
    resubmit.indexOf("assertMarketingRequestNamesAVenue")
      < resubmit.indexOf('.from("marketing_request_pharmacies").delete()'),
    "resubmit must refuse an empty target list BEFORE deleting the existing targets, never after",
  );

  assert.match(
    portal,
    /selectedPharmacyCount:\s*selectedPharmacyIds\.length/,
    "the portal must feed the ticked count into the blocker list, or Save never consults this gate at all",
  );
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeMarketingValidationInput } from "@/lib/marketing-requests/service";
import {
  MARKETING_CUSTOMER_TYPES,
  MARKETING_GOVERNORATE_HOLD_PREFIX,
  MARKETING_MANUAL_HOLD_MARKER,
} from "@/lib/marketing-requests/types";
import type {
  MarketingValidationCustomerInput,
  MarketingValidationPharmacyEntry,
} from "@/lib/marketing-requests/types";

/**
 * "Complete the customer already on record" — the path that empties the pending queue instead of
 * duplicating it.
 *
 * The defect this locks: `createMarketingValidationRecord` only ever INSERTED, minting a fresh
 * `MKT-HCP-…` every time. A rep who owned a customer with missing evidence therefore had no way to
 * supply it — walking to the shop and capturing it properly created a SECOND customer beside the
 * first, and the original stayed pending for ever. A production audit on 2026-08-21 found 39 such
 * customers (all imported by the 2026-07-02 backfill, all with a real owner and real CRM visits),
 * five duplicate pharmacies the workaround had left behind, and the same doctor recorded under two
 * spellings.
 *
 * The write path itself talks to live Supabase, so the guarantees that live in it are source-locked
 * here in the same style as marketing-bulk-import-atomicity.test.ts. What is genuinely executable —
 * the normalizer — is asserted for real.
 */

const timestamp = "2026-08-21T09:00:00.000Z";
const jpegDataUrl = `data:image/jpeg;base64,${Buffer.from("stamped-jpeg").toString("base64")}`;

function source(path: string) {
  return readFileSync(path, "utf8");
}

function customerPayload(
  overrides: Partial<MarketingValidationCustomerInput> = {},
): MarketingValidationCustomerInput {
  return {
    capturedAccuracyMeters: 11,
    capturedAddress: "30.050000, 31.230000",
    capturedAt: timestamp,
    capturedLatitude: 30.05,
    capturedLongitude: 31.23,
    customerType: "clinic",
    displayName: "Dr Tamer Hassouna",
    evidenceHasTimestamp: true,
    evidencePhotoCapturedAt: timestamp,
    evidencePhotoDataUrl: jpegDataUrl,
    evidencePhotoName: "customer-sign.jpg",
    extractedAreaName: "Nasr City",
    extractedGovernorateName: "Cairo",
    regionName: "Cairo",
    ...overrides,
  };
}

function pharmacyPayload(name: string, code: string): MarketingValidationPharmacyEntry {
  return {
    capturedAccuracyMeters: 9,
    capturedAddress: "30.051000, 31.231000",
    capturedAt: timestamp,
    capturedLatitude: 30.051,
    capturedLongitude: 31.231,
    displayName: name,
    evidenceHasTimestamp: true,
    evidencePhotoCapturedAt: timestamp,
    evidencePhotoDataUrl: jpegDataUrl,
    evidencePhotoName: "pharmacy-sign.jpg",
    extractedAreaName: "Nasr City",
    extractedGovernorateName: "Cairo",
    regionName: "Cairo",
    vendorCodes: [{ distributorId: 1, distributorPharmacyCode: code }],
  };
}

export function runMarketingCompleteExistingCustomerTests() {
  // --- the normalizer, executed for real --------------------------------------------------------

  // The id survives normalization. If it were dropped here the server would silently fall back to
  // minting a new customer — the exact behaviour this feature exists to remove — and the rep would
  // see a success message for a duplicate.
  const completing = normalizeMarketingValidationInput({
    customers: [
      {
        ...customerPayload({ existingCustomerId: "  cust-39  " }),
        pharmacies: [pharmacyPayload("El Ezaby Nasr City", "PH-1")],
      },
    ],
  });
  assert.equal(
    completing.customers[0].existingCustomerId,
    "cust-39",
    "existingCustomerId must survive normalization, trimmed",
  );

  // Absent on the ordinary path, and null rather than undefined so the write site can branch on a
  // single check.
  const minting = normalizeMarketingValidationInput({
    customers: [
      { ...customerPayload(), pharmacies: [pharmacyPayload("El Ezaby Nasr City", "PH-1")] },
    ],
  });
  assert.equal(
    minting.customers[0].existingCustomerId,
    null,
    "a submission that names no existing customer must normalize to null, not undefined",
  );

  // The capture rules are untouched by this path: completing a customer still demands the same
  // proof creating one does. A filename with no image behind it is refused outright — the rule
  // added 2026-08-04, after three records claimed evidence on a string.
  assert.throws(
    () =>
      normalizeMarketingValidationInput({
        customers: [
          {
            ...customerPayload({ evidencePhotoDataUrl: null, existingCustomerId: "cust-39" }),
            pharmacies: [pharmacyPayload("El Ezaby Nasr City", "PH-1")],
          },
        ],
      }),
    /has a live capture photo name but no photo/i,
    "completing a customer must not be a way to claim evidence on a filename alone",
  );

  // A capture with neither photo nor GPS still normalizes — that is the legitimate partial path —
  // but it lands short of `complete`, so the sweep below cannot promote anything from it.
  const withoutEvidence = normalizeMarketingValidationInput({
    customers: [
      {
        ...customerPayload({
          capturedAt: null,
          capturedLatitude: null,
          capturedLongitude: null,
          evidenceHasTimestamp: false,
          evidencePhotoCapturedAt: null,
          evidencePhotoDataUrl: null,
          evidencePhotoName: null,
          existingCustomerId: "cust-39",
        }),
        pharmacies: [pharmacyPayload("El Ezaby Nasr City", "PH-1")],
      },
    ],
  });
  assert.notEqual(
    withoutEvidence.customers[0].evidenceStatus,
    "complete",
    "an empty capture must never reach complete, whichever path it arrives on",
  );

  // Two entries pointing at the SAME existing customer. The duplicate-name check cannot catch this
  // — the two entries may be spelled differently, which is precisely how production ended up with
  // "تامر حسنى طاحون" and "تامر حسني طاحون" — and the second update would overwrite the first
  // capture's evidence with no trace that two were ever sent.
  assert.throws(
    () =>
      normalizeMarketingValidationInput({
        customers: [
          {
            ...customerPayload({ displayName: "Dr Tamer Hassouna", existingCustomerId: "cust-39" }),
            pharmacies: [pharmacyPayload("El Ezaby Nasr City", "PH-1")],
          },
          {
            ...customerPayload({ displayName: "Dr Tamer Hasouna", existingCustomerId: "cust-39" }),
            pharmacies: [pharmacyPayload("Seif Nasr City", "PH-2")],
          },
        ],
      }),
    /completes a customer that another entry in this submission already completes/i,
    "two entries completing one customer must be refused before anything is written",
  );

  // Different existing customers in one submission stay legal — a rep may capture several stops.
  assert.equal(
    normalizeMarketingValidationInput({
      customers: [
        {
          ...customerPayload({ displayName: "Dr Tamer", existingCustomerId: "cust-39" }),
          pharmacies: [pharmacyPayload("El Ezaby Nasr City", "PH-1")],
        },
        {
          ...customerPayload({ displayName: "Dr Ahmed", existingCustomerId: "cust-40" }),
          pharmacies: [pharmacyPayload("Seif Nasr City", "PH-2")],
        },
      ],
    }).customers.length,
    2,
    "completing two different customers in one submission must remain allowed",
  );

  // --- every type the database allows must survive the write path -------------------------------
  //
  // Proved on staging 2026-08-21 against the deployed revision e1141ab1: completing a real doctor
  // customer was REJECTED with "Customer type is required.", while the identical submission sent as
  // "clinic" passed all seven guarantees. `normalizeCustomerType` was checking a hand-written copy
  // of the type list that omitted "doctor" — even though the DB constraint
  // `marketing_customers_type_check` allows it, the declared union allowed it, and
  // `classifyCustomerType` in roi-sheet-writer.ts DEFAULTS to it, so the module minted rows it then
  // refused to accept back.
  //
  // The rep has no way round it: `startCompletingCustomer` seeds the form with the stored type and
  // the field is locked (asserted below), so a doctor customer could only ever submit "doctor".
  // Production held 130 active doctor customers of 160 — 59 of the 65 who could use Capture
  // Evidence at all, and 115 of the 126 pending links behind them.
  for (const customerType of MARKETING_CUSTOMER_TYPES) {
    assert.equal(
      normalizeMarketingValidationInput({
        customers: [
          {
            ...customerPayload({ customerType, existingCustomerId: "cust-39" }),
            pharmacies: [pharmacyPayload("El Ezaby Nasr City", "PH-1")],
          },
        ],
      }).customers[0].customerType,
      customerType,
      `${customerType} is allowed by marketing_customers_type_check, so the write path must accept it`,
    );
  }

  // Pinned separately so the loop above cannot be satisfied by SHRINKING the list it iterates.
  assert.ok(
    MARKETING_CUSTOMER_TYPES.includes("doctor"),
    "doctor is the majority of active marketing customers — dropping it re-breaks Capture Evidence for all of them",
  );

  // --- the write path, source-locked ------------------------------------------------------------
  const service = source("src/lib/marketing-requests/service.ts");

  // The guard must READ the shared list. A literal list here is what drifted from the union in the
  // first place, and it drifted silently because nothing compared the two.
  assert.match(
    service,
    /if \(!MARKETING_CUSTOMER_TYPES\.includes\(type\)\)/,
    "the customer-type guard must check the shared list, never a copy that can drift from the schema",
  );

  // The branch itself: an existing customer is UPDATED, never inserted.
  assert.match(
    service,
    /\.from\("marketing_customers"\)\s*\.update\(\{ \.\.\.capturedColumns, updated_at: new Date\(\)\.toISOString\(\) \}\)/,
    "completing a customer must UPDATE marketing_customers, not insert a second row",
  );

  // Identity is not rewritten. `capturedColumns` is the whole update payload, and none of these
  // may appear in it — re-labelling a customer would break its tie to the ROI history that already
  // points at it, which is the reason completing is preferable to re-creating in the first place.
  const capturedColumnsBlock = /const capturedColumns = \{[\s\S]*?\n    \};/.exec(service);
  assert.ok(capturedColumnsBlock, "the capturedColumns literal must be findable");
  for (const identityColumn of [
    "customer_code",
    "display_name",
    "customer_type",
    "normalized_name",
    "owner_hr_id",
    "manager_hr_id",
    "area_id",
    "line_id",
  ]) {
    assert.doesNotMatch(
      capturedColumnsBlock[0],
      new RegExp(`\\b${identityColumn}:`),
      `${identityColumn} is identity — completing a customer must never rewrite it`,
    );
  }

  // Evidence already on record is proof, and proof is never overwritten by a later capture. Guarded
  // twice: once at preload for a clear message, once in the UPDATE's own predicate so a concurrent
  // completion loses cleanly instead of clobbering the capture that got there first.
  assert.match(
    service,
    /row\.evidence_status === "complete"[\s\S]{0,320}customer_already_evidenced/,
    "a customer that already has complete evidence must be refused at preload",
  );
  assert.match(
    service,
    /\.neq\("evidence_status", "complete"\)/,
    "the customer UPDATE must repeat the precondition so a concurrent completion cannot overwrite it",
  );

  // The completed customer must NOT join the rollback set — unwinding that list deletes rows, and
  // this row existed long before the submission arrived.
  assert.doesNotMatch(
    service,
    /customerIds\.push\(existingCustomerRow/,
    "a completed customer must never be added to the delete-on-failure list",
  );
  // It is undone by RESTORING the columns instead, or a failed photo upload would leave the
  // customer claiming evidence_status 'complete' with no photo behind it.
  assert.match(
    service,
    /for \(const undo of completedCustomerUndo\)[\s\S]{0,900}evidence_status: undo\.before\.evidence_status/,
    "a failed submission must restore a completed customer's previous capture columns",
  );

  // Re-attaching the shop the customer is ALREADY linked to. The unique index is on
  // (customer_id, distributor_code_id), so a plain insert is a straight unique violation reaching
  // the rep as an opaque 500 at the end of a field visit.
  assert.match(
    service,
    /existingLinksByCustomerAndCode/,
    "existing links must be preloaded so a re-attached pharmacy updates rather than collides",
  );
  // Resolved by branching, not by upsert: a blind upsert would revive a retired link and overwrite
  // a rejection. Both are human decisions.
  assert.doesNotMatch(
    service,
    /onConflict: "customer_id,distributor_code_id"/,
    "the link write must branch explicitly, never blind-upsert over a human decision",
  );
  assert.match(service, /link_already_rejected/, "a rejected link must be refused, not silently rewritten");
  assert.match(service, /link_retired/, "a retired link must be refused, not silently revived");

  // The sweep — without it the whole feature is decorative. The LINK row is the gate the request
  // dropdown filters on, and every link's status was frozen from the evidence that existed when it
  // was written, which for these rows was none.
  assert.match(
    service,
    /async function refreshLinksAfterCustomerCompletion/,
    "completing a customer must re-decide the links it already carried",
  );
  assert.match(
    service,
    /refreshLinksAfterCustomerCompletion\(\{[\s\S]{0,260}customerId: customer\.id/,
    "the sweep must actually be called from the completing path",
  );
  // Promotion only: `rejected` is a human verdict and the validated statuses are already better
  // than anything computed here.
  assert.match(
    service,
    /\.eq\("validation_status", "pending"\)\s*\.neq\("active", false\)/,
    "the sweep must consider only active, pending links",
  );
  // The pharmacy half still has to hold up — a customer's new photo is not evidence about a shop
  // that was never photographed.
  assert.match(
    service,
    /pharmacyEvidenceStatus,\s*\}\),\s*\}\);\s*if \(nextStatus === "pending"\) continue;/,
    "the sweep must re-run the full evidence rule and leave a link pending when the shop fails it",
  );
  // A hold placed by a person is never lifted by a machine.
  assert.match(
    service,
    /existingNotes\.includes\(MARKETING_MANUAL_HOLD_MARKER\)[\s\S]{0,600}continue;/,
    "a manually held link must be skipped by the sweep, never auto-released",
  );

  // The two markers must stay distinct. The workspace renders the governorate one as "Code location
  // mismatch"; reusing it for the owner's 2026-08-21 hold would mislabel 39 rows as a geography
  // contradiction they do not have.
  assert.notEqual(
    MARKETING_MANUAL_HOLD_MARKER,
    MARKETING_GOVERNORATE_HOLD_PREFIX,
    "the manual-hold marker must not collide with the governorate-hold prefix",
  );
  assert.equal(
    MARKETING_GOVERNORATE_HOLD_PREFIX.includes(MARKETING_MANUAL_HOLD_MARKER),
    false,
    "a governorate hold must not be mistaken for a manual one",
  );

  // --- the workspace, source-locked -------------------------------------------------------------
  const workspace = source("src/components/employee-portal/marketing-validation-workspace.tsx");

  assert.match(
    workspace,
    /function startCompletingCustomer/,
    "the Not Usable Yet tab must offer a way to capture the customer already on record",
  );
  assert.match(
    workspace,
    /existingCustomerId: customer\.existingCustomerId \|\| null/,
    "the payload must carry the id, or the server falls back to minting a duplicate",
  );
  // Identity is shown but locked: the server updates the capture columns alone, so an editable name
  // the save would ignore is worse than no field at all.
  assert.match(
    workspace,
    /disabled=\{Boolean\(customer\.existingCustomerId\)\}/,
    "name and type must be locked while completing a customer already on record",
  );
  // Offering the button on a customer whose own evidence is already complete would only earn a
  // server rejection — that block is on the pharmacy side.
  assert.match(
    workspace,
    /customer\.evidenceStatus !== "complete" \?/,
    "the action must only appear where the customer's own evidence is what is missing",
  );
  // The owner's standing UI rule: never truncate with an ellipsis, never let text wrap.
  assert.match(
    workspace,
    /whitespace-nowrap[^"]*"\s*\n\s*onClick=\{\(\) => startCompletingCustomer/,
    "the action label must not wrap",
  );
}

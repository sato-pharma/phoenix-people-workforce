import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeMarketingValidationInput } from "@/lib/marketing-requests/service";
import type {
  MarketingValidationCustomerInput,
  MarketingValidationPharmacyEntry,
} from "@/lib/marketing-requests/types";

/**
 * "Complete the shop already on record" — the venue twin of
 * marketing-complete-existing-customer.test.ts.
 *
 * The defect this locks: the capture columns on `marketing_pharmacies` were writable ONLY by the
 * INSERT that created the row. The reuse branch wrote the LINK and returned, and every other write
 * to the table touched something else — the merge sets `active: false`, the ROI sheet upserts name
 * columns, the territory rule moves `area_id`. So a venue first recorded without proof stayed
 * `evidence_status = 'pending'` for the rest of its life, whoever stood in front of it afterwards,
 * and every customer attached to it stayed parked on "Not Usable Yet" with no route out.
 *
 * Found 2026-08-23 in production: three venues (مستشفى فيكتوريا, نشأت زكري, الشعب), all owned by a
 * head-office Product Manager, none with a single link from a field rep, carrying four doctors
 * between them. Re-capturing the DOCTORS was impossible — they go home — and re-capturing the SHOP
 * was impossible because no code path could accept it.
 *
 * The write path itself talks to live Supabase, so the guarantees that live in it are source-locked
 * here in the same style as the customer test beside it. What is genuinely executable — the
 * normalizer — is asserted for real.
 */

const timestamp = "2026-08-23T09:00:00.000Z";
const jpegDataUrl = `data:image/jpeg;base64,${Buffer.from("stamped-jpeg").toString("base64")}`;

function source(path: string) {
  return readFileSync(path, "utf8");
}

function customerPayload(
  overrides: Partial<MarketingValidationCustomerInput> = {},
): MarketingValidationCustomerInput {
  return {
    capturedAccuracyMeters: 11,
    capturedAddress: "31.200000, 29.920000",
    capturedAt: timestamp,
    capturedLatitude: 31.2,
    capturedLongitude: 29.92,
    customerType: "clinic",
    displayName: "Dr Ramzy Riad",
    evidenceHasTimestamp: true,
    evidencePhotoCapturedAt: timestamp,
    evidencePhotoDataUrl: jpegDataUrl,
    evidencePhotoName: "customer-sign.jpg",
    extractedAreaName: "Alex East",
    extractedGovernorateName: "Alexandria",
    regionName: "Alex East, Alexandria",
    ...overrides,
  };
}

/** The My Pharmacies path as it has always been: an id and nothing else. */
function attachOnly(existingPharmacyId: string): MarketingValidationPharmacyEntry {
  return { existingPharmacyId };
}

/** The new path: an id PLUS the proof the rep took standing in front of that shop. */
function attachWithCapture(
  existingPharmacyId: string,
  overrides: Partial<MarketingValidationPharmacyEntry> = {},
): MarketingValidationPharmacyEntry {
  return {
    capturedAccuracyMeters: 8,
    capturedAddress: "31.201000, 29.921000",
    capturedAt: timestamp,
    capturedLatitude: 31.201,
    capturedLongitude: 29.921,
    evidenceHasTimestamp: true,
    evidencePhotoCapturedAt: timestamp,
    evidencePhotoDataUrl: jpegDataUrl,
    evidencePhotoName: "victoria-hospital-sign.jpg",
    existingPharmacyId,
    extractedAreaName: "Alex East",
    extractedGovernorateName: "Alexandria",
    regionName: "Alex East, Alexandria",
    ...overrides,
  } as MarketingValidationPharmacyEntry;
}

function normalizeOne(pharmacy: MarketingValidationPharmacyEntry) {
  return normalizeMarketingValidationInput({
    customers: [{ ...customerPayload(), pharmacies: [pharmacy] }],
  }).customers[0].pharmacies[0];
}

export function runMarketingCompleteExistingVenueTests() {
  // --- the normalizer, executed for real --------------------------------------------------------

  // The headline. Before this the reuse branch discarded everything but the id, so a capture taken
  // in front of the shop could not even reach the write path to be considered.
  const completing = normalizeOne(attachWithCapture("  pha-victoria  "));
  assert.equal(
    completing.evidenceStatus,
    "complete",
    "a reused pharmacy must carry the capture the rep took in front of it, not be reduced to its id",
  );
  assert.equal(completing.existingPharmacyId, "pha-victoria", "the id must survive normalization, trimmed");
  assert.equal(completing.capturedLatitude, 31.201, "the captured coordinate must survive normalization");
  assert.equal(completing.capturedLongitude, 29.921, "the captured coordinate must survive normalization");
  assert.equal(
    completing.evidencePhotoDataUrl,
    jpegDataUrl,
    "the photo BYTES must survive — a filename with no image behind it has never been proof here",
  );

  // The other half of the guarantee: attaching a shop without capturing it behaves exactly as it
  // always has. This is what keeps the change from becoming a new requirement on every attach.
  const attaching = normalizeOne(attachOnly("pha-victoria"));
  assert.equal(
    attaching.evidenceStatus,
    "missing",
    "attaching a shop without capturing it must stay exactly as it was — evidence missing",
  );
  assert.equal(
    attaching.validationStatus,
    "pending",
    "attaching a shop without capturing it must still normalize to pending",
  );
  assert.equal(attaching.capturedLatitude, null, "an attach-only entry carries no coordinate");
  assert.equal(attaching.evidencePhotoDataUrl, null, "an attach-only entry carries no photo");

  // A capture that is short of proof must not claim to be proof. The server only writes a venue's
  // evidence when this says "complete", so this is the gate that decides whether the row moves.
  const partial = normalizeOne(
    attachWithCapture("pha-victoria", {
      evidenceHasTimestamp: false,
      evidencePhotoCapturedAt: null,
      evidencePhotoDataUrl: null,
      evidencePhotoName: null,
    } as Partial<MarketingValidationPharmacyEntry>),
  );
  assert.equal(
    partial.evidenceStatus,
    "pending",
    "a pin with no live photo is a part-captured shop and must never read as complete",
  );

  // IDENTITY is still never accepted on this path. Supplying a shop's missing evidence must not be
  // able to rename it, re-code it or change what kind of venue it is — that is the whole reason the
  // reuse path exists, and it is a separate question from evidence.
  assert.equal(completing.displayName, "", "a reused pharmacy must never carry a name from the client");
  assert.equal(completing.normalizedName, "", "a reused pharmacy must never carry a lookup key from the client");
  assert.deepEqual(completing.vendorCodes, [], "a reused pharmacy must never carry vendor codes from the client");

  // The same photo rule the capture path has enforced since 2026-08-04: a filename with no image
  // behind it is refused outright rather than stored as proof.
  assert.throws(
    () =>
      normalizeOne(
        attachWithCapture("pha-victoria", {
          evidencePhotoDataUrl: null,
        } as Partial<MarketingValidationPharmacyEntry>),
      ),
    /photo/i,
    "a photo NAME with no image behind it must be refused on the reuse path too",
  );

  // --- the write path, source-locked ------------------------------------------------------------

  const service = source("src/lib/marketing-requests/service.ts");

  const updateBlock = /const pharmacyEvidenceUpdate = await supabase[\s\S]*?\.maybeSingle\(\);/
    .exec(service);
  assert.ok(updateBlock, "the venue evidence UPDATE must be findable");

  // Evidence already on record is proof, and proof is never overwritten by a later capture.
  assert.match(
    service,
    /if \(storedRow\.evidence_status === "complete"\) return storedRow;/,
    "a venue that already has complete evidence must be left alone",
  );
  assert.match(
    updateBlock[0],
    /\.neq\("evidence_status", "complete"\)/,
    "the venue UPDATE must repeat the precondition so a concurrent completion cannot overwrite it",
  );
  // And only a COMPLETE capture is worth the write: a venue row is shared by every customer in the
  // area, so swapping one rep's partial capture for another's improves nothing.
  assert.match(
    service,
    /if \(normalizedPharmacy\.evidenceStatus !== "complete"\) return storedRow;/,
    "a partial capture must never be written over a venue's stored evidence",
  );

  // The verdict columns are a HUMAN's decision about this shop — including a Super Admin's desk
  // validation. A rep supplying a missing photo is evidence, not an appeal against that verdict.
  for (const verdictColumn of [
    "validation_status",
    "validated_by_hr_id",
    "validated_at",
    "validation_notes",
  ]) {
    assert.doesNotMatch(
      updateBlock[0],
      new RegExp(`\\b${verdictColumn}:`),
      `${verdictColumn} is a human verdict — completing a venue's evidence must never rewrite it`,
    );
  }
  // Nor identity, nor placement.
  for (const identityColumn of [
    "area_id",
    "display_name",
    "line_id",
    "manager_hr_id",
    "normalized_name",
    "owner_hr_id",
    "pharmacy_code",
    "venue_type",
  ]) {
    assert.doesNotMatch(
      updateBlock[0],
      new RegExp(`\\b${identityColumn}:`),
      `${identityColumn} is identity — completing a venue's evidence must never rewrite it`,
    );
  }

  // The trap this repo has paid for before: an OPTIONAL column written unconditionally is a SILENT
  // ERASE. The descriptors can all come back empty from a fix that is otherwise complete, so they
  // are omitted rather than nulled.
  assert.match(
    updateBlock[0],
    /\.\.\.definedColumns\(\{[\s\S]*?extracted_governorate_name:/,
    "the optional location descriptors must be omitted when absent, never written as null",
  );

  // A completed venue must NOT join the rollback set — unwinding that list DELETES rows, and this
  // row existed long before the submission arrived.
  assert.doesNotMatch(
    service,
    /pharmacyIds\.push\(storedRow/,
    "a completed venue must never be added to the delete-on-failure list",
  );
  assert.match(
    service,
    /for \(const undo of completedPharmacyUndo\)[\s\S]{0,900}evidence_status: undo\.before\.evidence_status/,
    "a failed submission must restore a completed venue's previous capture columns",
  );

  // Losing the race is a success for the shop, not a failure for this rep: unlike the customer
  // path, a venue that someone else completed mid-save must not blow up the submission.
  assert.match(
    service,
    /if \(!pharmacyEvidenceUpdate\.data\) return storedRow;/,
    "losing the completion race must fall back to the stored row, never throw",
  );

  // The sweep — without it the whole feature is decorative. The LINK row is the gate the request
  // dropdown filters on, and every link on these venues was stamped from the evidence that existed
  // when it was written, which for these rows was none.
  assert.match(
    service,
    /async function refreshLinksAfterPharmacyCompletion/,
    "completing a venue must re-decide the links it already carried",
  );
  assert.match(
    service,
    /await refreshLinksAfterPharmacyCompletion\(\{[\s\S]{0,200}pharmacyRow: completedRow/,
    "the venue sweep must actually be called from the completing path",
  );
  // Keyed on the pharmacy, and each link's customer half read from that link's own customer.
  assert.match(
    service,
    /\.eq\("pharmacy_id", pharmacyRow\.id\)\s*\.eq\("validation_status", "pending"\)\s*\.neq\("active", false\)/,
    "the venue sweep must consider only active, pending links on that pharmacy",
  );
  assert.match(
    service,
    /customerEvidenceStatus: \(customerRow\.evidence_status \?\? "missing"\)/,
    "each link's customer half must come from that link's own customer, not from this submission",
  );

  // --- the form ---------------------------------------------------------------------------------

  const workspace = source("src/components/employee-portal/marketing-validation-workspace.tsx");

  // Offered, never demanded. If this became a requirement, attaching a shop — the ordinary case,
  // and the reason the tab exists — would start failing for reps nowhere near it.
  assert.doesNotMatch(
    workspace,
    /source === "existing"[\s\S]{0,400}return `Capture/,
    "capturing an attached shop must stay optional — the system flags, it does not refuse",
  );
  // Sent only when it could change something, so an ordinary attach still sends the id alone.
  assert.match(
    workspace,
    /existingPharmacyId: pharmacy\.existingPharmacyId,\s*\.\.\.\(hasCompleteCapture\(pharmacy\.capture\)/,
    "the form must send a capture for an attached shop only when that capture is complete",
  );
  // Never offered at a desk: a point chosen from map search is not field proof, which is exactly
  // why these rows are short in the first place.
  assert.match(
    workspace,
    /if \(isDeskMode \|\| !selectedId\) return null;/,
    "desk mode must never be offered the chance to complete a venue's field evidence",
  );
}

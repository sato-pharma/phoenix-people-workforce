import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canViewDirectOrderEvidenceAiNote } from "../src/lib/direct-orders/validation-visibility.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Pharmacy evidence on the approval window itself (2026-08-08 restyle).
//
// The photo/GPS/AI sign-check used to live ONLY on the Super-Admin-only Validation Desk, invisible
// to every approver deciding the order it belongs to. It now rides on DirectOrderApprovalDetail
// (getDirectOrderApprovalDetail, service.ts) via getDirectOrderPharmacyValidationForRequest — a
// deliberately UNGATED read, because the caller already proved the viewer may see this specific
// request. This file pins the two things that would otherwise silently drift back to how it was:
//
//   1. the requester must never see the AI's note on their OWN evidence (owner rule, 2026-08-08 —
//      they see the photo they took, not an adjudicator's reading of it), and
//   2. the new read path must stay UNGATED — a reflexive "add the desk's own guard for safety"
//      edit would refuse every approver again, quietly, with no test to catch it.
// ─────────────────────────────────────────────────────────────────────────────

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

export function runDirectOrderEvidenceVisibilityTests() {
  // ── canViewDirectOrderEvidenceAiNote, executed ───────────────────────────────────────────
  assert.equal(
    canViewDirectOrderEvidenceAiNote("B-154", { requesterHrId: "B-154" }),
    false,
    "the requester must never see the AI note on their own evidence — they already know what they photographed",
  );
  // HR ids differ in case and formatting across the app; the check must survive that, the same as
  // canCaptureDirectOrderValidation's own case test right above it in this file.
  assert.equal(
    canViewDirectOrderEvidenceAiNote("b-154", { requesterHrId: "B-154" }),
    false,
    "case must not be a loophole — a lower-cased viewer id is still the same requester",
  );
  assert.equal(
    canViewDirectOrderEvidenceAiNote("B-999", { requesterHrId: "B-154" }),
    true,
    "an approver reading someone else's request must still see the note",
  );
  assert.equal(
    canViewDirectOrderEvidenceAiNote("", { requesterHrId: "B-154" }),
    false,
    "an unknown viewer must fail closed, never default to showing the note",
  );
  assert.equal(
    canViewDirectOrderEvidenceAiNote(null, { requesterHrId: "B-154" }),
    false,
    "a null viewer must fail closed the same way an empty one does",
  );

  // ── The read path stays UNGATED ──────────────────────────────────────────────────────────
  // assertValidationDeskAccess is correct for listDirectOrderPharmacyValidations (the Super Admin's
  // "every pending claim" desk) and WRONG here — the caller already proved narrower access via
  // canViewDirectOrderRequest. Reusing the desk's gate would refuse every ordinary approver again.
  const pharmacyValidation = read("../src/lib/direct-orders/pharmacy-validation.ts");
  const fnStart = pharmacyValidation.indexOf("export async function getDirectOrderPharmacyValidationForRequest(");
  assert.ok(fnStart > 0, "getDirectOrderPharmacyValidationForRequest must exist");
  const fnEnd = pharmacyValidation.indexOf("\nexport ", fnStart + 1);
  const fnBody = pharmacyValidation.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.doesNotMatch(
    fnBody,
    /assertValidationDeskAccess/,
    "getDirectOrderPharmacyValidationForRequest must stay ungated — the desk's Super-Admin-only " +
      "guard would silently refuse every ordinary approver this function exists to serve",
  );

  // ── service.ts actually wires the strip, not just calls both functions ──────────────────────
  const service = read("../src/lib/direct-orders/service.ts");
  const detailStart = service.indexOf("export async function getDirectOrderApprovalDetail(");
  assert.ok(detailStart > 0, "getDirectOrderApprovalDetail must exist");
  const detailNextExport = service.indexOf("\nexport async function getDirectOrderReport", detailStart);
  const detailBody = service.slice(detailStart, detailNextExport === -1 ? detailStart + 4000 : detailNextExport);
  assert.match(
    detailBody,
    /getDirectOrderPharmacyValidationForRequest\(/,
    "the approval detail must fetch the request's own pharmacy evidence",
  );
  assert.match(
    detailBody,
    /canViewDirectOrderEvidenceAiNote\(/,
    "the approval detail must consult the AI-note visibility predicate, not just show the evidence unconditionally",
  );
  assert.match(
    detailBody,
    /evidenceCheck:\s*null/,
    "the predicate's result must actually be USED to null out evidenceCheck — calling the predicate " +
      "without acting on it would read as gated while showing the note to everyone regardless",
  );

  // ── Both approval screens share ONE evidence renderer ────────────────────────────────────
  // This module has been burned by exactly this drift before (see validation-visibility.ts's own
  // header comment on canCaptureDirectOrderValidation: a capture only the admin route rendered,
  // because the portal route — the one most requesters actually reach — had its own copy that
  // fell behind). Reusing EvidenceReading in both screens is what stops that happening a second
  // time for the reading itself.
  const adminDetail = read("../src/components/approvals-hub/direct-order-request-detail.tsx");
  const portalDetail = read("../src/components/employee-portal/direct-order-portal-detail.tsx");
  for (const [label, source] of [
    ["the admin approval window", adminDetail],
    ["the portal approval window", portalDetail],
  ] as const) {
    assert.match(
      source,
      /from "@\/components\/direct-orders\/evidence-reading"/,
      `${label} must render the evidence reading via the shared EvidenceReading component, not a local reimplementation`,
    );
    assert.match(
      source,
      /<EvidenceReading\b/,
      `${label} must actually use EvidenceReading, not just import it`,
    );
  }
}

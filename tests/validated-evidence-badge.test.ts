import assert from "node:assert/strict";

import { buildValidationBadge } from "@/lib/validation/validation-badge";
import { resolveMarketingCustomerValidationBadge } from "@/lib/marketing-requests/customer-validation-badge";
import { resolveDirectOrderPharmacyValidationBadge } from "@/lib/direct-orders/pharmacy-validation-badge";
import type { DirectOrderPharmacy } from "@/lib/direct-orders/types";
import type { DirectOrderValidationRow } from "@/lib/direct-orders/pharmacy-validation";

/**
 * The "already validated · by whom · when" stamp shown on the two approver windows (owner ask,
 * 2026-09-22). The one rule this whole feature turns on: a NAME appears only when a HUMAN looked.
 *
 * The two systems reach "validated" different ways — a direct-order pharmacy through the held/desk
 * lane or the distributor catalogue; a marketing customer through the desk, a link approval, or the
 * automatic evidence-gate. In every AUTOMATIC case the row may still carry the hr id of the rep who
 * CAPTURED the evidence, and printing that as "validated by <that rep>" would fabricate an
 * independent check that never happened. This is pinned because it is a claim a manager reads and
 * acts on, and getting it wrong is worse than showing nothing.
 */
export function runValidatedEvidenceBadgeTests() {
  // ── buildValidationBadge: the shared gate ──────────────────────────────────────────────────
  assert.equal(
    buildValidationBadge({ validated: false, isHuman: true, byName: "Mona Adel", atIso: "2026-09-01T09:00:00Z" }),
    null,
    "a venue that is not validated shows no stamp at all",
  );

  const human = buildValidationBadge({
    validated: true,
    isHuman: true,
    byName: "Mona Adel",
    atIso: "2026-09-01T09:00:00Z",
    method: "desk",
  });
  assert.ok(human, "a validated venue returns a badge");
  assert.equal(human?.byName, "Mona Adel", "a human validator's name is kept");
  assert.equal(human?.isHuman, true);

  const system = buildValidationBadge({
    validated: true,
    isHuman: false,
    // A name is deliberately supplied here — the capturing owner — and must be DROPPED, because no
    // human adjudicated it. This assertion is the whole point of the feature.
    byName: "Mona Adel",
    atIso: "2026-09-01T09:00:00Z",
  });
  assert.ok(system, "a system-validated venue still shows a stamp");
  assert.equal(system?.byName, null, "the system case NEVER shows a name, even when a row carries one");
  assert.equal(system?.isHuman, false);

  // ── Marketing customer ─────────────────────────────────────────────────────────────────────
  assert.equal(
    resolveMarketingCustomerValidationBadge({
      status: "pending",
      validatedByName: "Mona Adel",
      validatedAt: null,
      capturedAt: "2026-09-01T09:00:00Z",
    }),
    null,
    "a pending customer is not validated — no stamp",
  );
  assert.equal(
    resolveMarketingCustomerValidationBadge({
      status: "rejected",
      validatedByName: null,
      validatedAt: null,
      capturedAt: null,
    }),
    null,
    "a rejected customer is not validated — no stamp",
  );

  const sfe = resolveMarketingCustomerValidationBadge({
    status: "sfe_validated",
    validatedByName: "Mona Adel",
    validatedAt: "2026-09-02T07:30:00Z",
    capturedAt: "2026-08-15T05:00:00Z",
  });
  assert.equal(sfe?.isHuman, true, "a desk validation is a human decision");
  assert.equal(sfe?.byName, "Mona Adel", "the desk validator is named");
  assert.equal(sfe?.atIso, "2026-09-02T07:30:00Z", "the decision time wins over the capture time");
  assert.equal(sfe?.method, "desk");

  const adminApproved = resolveMarketingCustomerValidationBadge({
    status: "admin_approved",
    validatedByName: "Omar Gawish",
    validatedAt: "2026-09-03T10:00:00Z",
    capturedAt: null,
  });
  assert.equal(adminApproved?.isHuman, true);
  assert.equal(adminApproved?.method, "approved on a link");

  const auto = resolveMarketingCustomerValidationBadge({
    status: "system_validated",
    validatedByName: "Mona Adel",
    validatedAt: null,
    capturedAt: "2026-08-15T05:00:00Z",
  });
  assert.equal(auto?.isHuman, false, "system_validated means no human looked");
  assert.equal(auto?.byName, null, "so the capturing rep is never shown as the validator");
  assert.equal(auto?.atIso, "2026-08-15T05:00:00Z", "the honest 'when' falls back to the capture moment");

  // ── Direct-order pharmacy ──────────────────────────────────────────────────────────────────
  const nameOf = (hr: string): string | null => (hr === "B-9" ? "Mona Adel" : null);
  const pharmacy = (over: Partial<DirectOrderPharmacy>): DirectOrderPharmacy =>
    ({
      verificationStatus: "verified",
      verifiedByHrId: null,
      verifiedAt: null,
      entrySource: "manual",
      ...over,
    }) as DirectOrderPharmacy;
  const evidence = (over: Partial<DirectOrderValidationRow>): DirectOrderValidationRow =>
    ({
      status: "approved_new",
      decidedByHrId: "B-9",
      decidedAt: "2026-09-04T08:00:00Z",
      validationRoute: "field",
      ...over,
    }) as DirectOrderValidationRow;

  assert.equal(
    resolveDirectOrderPharmacyValidationBadge(pharmacy({ verificationStatus: "pending_review" }), null, nameOf),
    null,
    "a pharmacy still under review is exactly what the order's approver is confirming — no stamp",
  );

  const decided = resolveDirectOrderPharmacyValidationBadge(
    pharmacy({ verificationStatus: "verified" }),
    evidence({ status: "approved_new", validationRoute: "invoice" }),
    nameOf,
  );
  assert.equal(decided?.isHuman, true, "a desk decision on the held lane is a human validation");
  assert.equal(decided?.byName, "Mona Adel", "the decider is named");
  assert.equal(decided?.method, "distributor invoice", "the invoice route is labelled honestly");

  // Production reality (verified 2026-09-22 against live data): EVERY catalogue pharmacy carries a
  // real `verified_by_hr_id` — the operator who bulk-accepted the distributor catalogue (A-2 on 63
  // of them), NOT an independent reviewer of this venue. The stamp must still read "by the system",
  // never that operator's name, or it fabricates a check that never happened. This is the assertion
  // an earlier `verifiedByHrId: null` fixture missed while the resolver went the other way.
  const catalogue = resolveDirectOrderPharmacyValidationBadge(
    pharmacy({ entrySource: "catalogue", verifiedByHrId: "B-9" }),
    null,
    nameOf,
  );
  assert.equal(catalogue?.isHuman, false, "a catalogue pharmacy is a system recognition, even with a verifier id on file");
  assert.equal(catalogue?.byName, null, "the catalogue bulk-accept operator is NEVER shown as the validator");
  assert.equal(catalogue?.method, "distributor catalogue");

  const handVerified = resolveDirectOrderPharmacyValidationBadge(
    pharmacy({ entrySource: "manual", verifiedByHrId: "B-9", verifiedAt: "2026-09-05T09:00:00Z" }),
    null,
    nameOf,
  );
  assert.equal(handVerified?.isHuman, true, "a hand-verified pharmacy names its verifier");
  assert.equal(handVerified?.byName, "Mona Adel");
}

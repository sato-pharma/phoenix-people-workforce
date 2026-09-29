import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canCaptureDirectOrderValidation } from "../src/lib/direct-orders/validation-visibility.ts";
import type { DirectOrderApprovalDetail } from "../src/lib/direct-orders/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The validation capture must be reachable by the people who need it (spec A2).
//
// It was not. `PharmacyValidationCapture` was rendered only by the ADMIN detail route, while every
// Medical Rep and District Manager is redirected INTO the portal route — which had no capture. So
// the only escape hatch out of the held lane existed in the codebase and could not be opened by
// anyone it was built for.
//
// Nothing failed. No error, no red test, no exception. The symptom was silence: on 2026-08-05 there
// were 11 held direct orders worth 509,736 EGP and ZERO validation requests against them, which
// reads like "the reps ignored it" when the truth was "the reps never saw a button".
//
// Two guards below: the predicate is correct, and BOTH routes actually render the component.
// ─────────────────────────────────────────────────────────────────────────────

function detail(overrides: {
  requesterHrId?: string;
  status?: string;
  verificationStatus?: string;
  withPharmacy?: boolean;
} = {}): DirectOrderApprovalDetail {
  const withPharmacy = overrides.withPharmacy !== false;
  return {
    request: {
      id: "req-1",
      requesterHrId: overrides.requesterHrId ?? "B-12",
      status: overrides.status ?? "held",
    },
    pharmacy: withPharmacy
      ? { id: "ph-1", pharmacyName: "Test", verificationStatus: overrides.verificationStatus ?? "pending_review" }
      : null,
  } as unknown as DirectOrderApprovalDetail;
}

export function runDirectOrderValidationCaptureReachableTests() {
  // ── THE HEADLINE: both routes must render the capture ────────────────────────────────────
  // If either of these fires, one class of user has lost the only door out of the held lane —
  // silently, because a missing button raises no error.
  const routes = [
    ["app/(admin)/admin/direct-orders/[id]/page.tsx", "admin"],
    ["app/employee-portals/direct-orders/[id]/page.tsx", "employee portal"],
  ] as const;

  for (const [route, label] of routes) {
    const source = readFileSync(new URL(`../${route}`, import.meta.url), "utf8");
    assert.match(
      source,
      /<PharmacyValidationCapture/,
      `THE ${label.toUpperCase()} ROUTE NO LONGER OFFERS THE VALIDATION CAPTURE: a held order there has no way to submit evidence, so its only remaining exit is the 14-day expiry. (${route})`,
    );
    assert.match(
      source,
      /canCaptureDirectOrderValidation\(/,
      `${route} must gate the capture with the SHARED predicate — an inline copy is how the two routes diverged in the first place`,
    );
  }

  // ── The predicate itself ─────────────────────────────────────────────────────────────────
  assert.equal(
    canCaptureDirectOrderValidation("B-12", detail()),
    true,
    "the requester of a held order on an unconfirmed pharmacy must be offered the capture",
  );

  // Only the requester. An approver's photo would be of a place they never stood, and the GPS check
  // runs against the CAPTURER's area — evidence that looks like proof but is not.
  assert.equal(
    canCaptureDirectOrderValidation("B-99", detail()),
    false,
    "an approver reading the same page must NOT be offered the capture",
  );

  // HR ids differ in case and formatting across the app; the check must survive that.
  assert.equal(
    canCaptureDirectOrderValidation("b-12", detail({ requesterHrId: "B-12" })),
    true,
    "HR id comparison must be canonical, not literal — otherwise casing alone hides the button",
  );

  // 🔴 REVERSED 2026-09-29 on the owner's ruling: "let the rep capture a venue whenever it is still
  // pending_review". This block used to assert the OPPOSITE — that a `pending_approval` order could
  // not be captured against — so the test was pinning the defect in place.
  //
  // What it cost: a System Admin releasing a hold moves the order out of `held` AND writes
  // `admin_released` on the VENUE, which makes `decideDirectOrderHold` rule 3 refuse to hold any
  // future order on it. The release therefore closed the venue's only capture door permanently and
  // silently. On DOP-000135 the owner released at 16:47 and asked for a live capture at 16:52, and
  // the rep had no way to give him one.
  //
  // The order's status now decides NOTHING here. The venue's does.
  for (const status of ["held", "pending_approval", "returned", "approved", "cancelled", "expired"]) {
    assert.equal(
      canCaptureDirectOrderValidation("B-12", detail({ status })),
      true,
      `a venue still pending_review must be capturable whatever the order is doing (${status})`,
    );
  }
  assert.equal(
    canCaptureDirectOrderValidation("B-12", detail({ verificationStatus: "verified" })),
    false,
    "a confirmed pharmacy needs no further evidence",
  );
  assert.equal(
    canCaptureDirectOrderValidation("B-12", detail({ verificationStatus: "rejected" })),
    false,
    "a venue examined and found not to be real is not waiting for evidence either",
  );

  // Fail closed on missing data rather than rendering a capture with nothing to attach to.
  assert.equal(canCaptureDirectOrderValidation("B-12", detail({ withPharmacy: false })), false);
  assert.equal(canCaptureDirectOrderValidation("B-12", null), false);
  assert.equal(canCaptureDirectOrderValidation("", detail()), false, "an unknown viewer must never be the requester");
  assert.equal(canCaptureDirectOrderValidation(null, detail()), false);

  // ── The gate must also exist SERVER-SIDE ─────────────────────────────────────────────────
  // The predicate above only decides whether a button renders. `direct_orders:create` admits every
  // rep in the company, so without an ownership check on the service any of them could POST a
  // storefront photo for a pharmacy in someone else's territory. A hidden button is UX, not access
  // control — this repo's rule is that the server is the boundary.
  const serviceSource = readFileSync(
    new URL("../src/lib/direct-orders/pharmacy-validation.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    serviceSource,
    /You can only submit evidence for your own direct order\./,
    "SERVER-SIDE OWNERSHIP CHECK GONE: requestDirectOrderPharmacyValidation must refuse a linked request the caller did not raise — assertPermission alone admits every rep in the company",
  );
  assert.match(
    serviceSource,
    /canonicalHrIdKey\(String\(\(linked as/,
    "the ownership comparison must be canonical, not a literal string compare — HR id casing differs across the app",
  );

  // ── The gate that REPLACED the order-status one (owner, 2026-09-29) ──────────────────────
  // The server now asks the question his ruling names — is this VENUE still waiting for somebody to
  // stand in front of it — and reads it from the table rather than trusting the screen.
  assert.match(
    serviceSource,
    /\.from\("direct_order_pharmacies"\)\s*\.select\("verification_status"\)/,
    "SERVER-SIDE VENUE GATE GONE: the capture must read the venue's own status, not infer it from a hidden button",
  );
  assert.match(serviceSource, /if \(venueStatus !== "pending_review"\)/);
  assert.match(serviceSource, /This venue is already validated/);

  // The FIELD route must no longer be refused for the order's status. Only the invoice lane keeps
  // that rule, because its five-slot bargain is filed against the held order the decision revives.
  assert.match(
    serviceSource,
    /if \(isInvoiceRoute && linkedRequestStatus !== "held"\)/,
    "the held-order refusal must be scoped to the INVOICE route — a bare status check re-closes the door his ruling opened",
  );
  assert.ok(
    !/\n  {4}if \(linkedRequestStatus !== "held"\) \{/.test(serviceSource),
    "the unconditional held-order refusal must be gone",
  );

  // The registry is asserted only where it still describes reality: it models ORDER transitions and
  // declares this one `held -> held`. Widening its `from` while leaving `to: held` would make the
  // audit surface claim a returned order becomes held — a fabricated transition, worse than none.
  assert.match(
    serviceSource,
    /if \(linkedRequestStatus === "held"\) \{\s*await assertDirectOrderWorkflowTransition\(/,
    "the workflow-registry assertion must be scoped to the held case, not fed a status the registry does not model",
  );
}

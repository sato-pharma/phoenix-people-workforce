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

  // Only while it is actually stuck.
  assert.equal(
    canCaptureDirectOrderValidation("B-12", detail({ status: "pending_approval" })),
    false,
    "an order already in the approval chain has nothing to validate",
  );
  assert.equal(
    canCaptureDirectOrderValidation("B-12", detail({ verificationStatus: "verified" })),
    false,
    "a confirmed pharmacy needs no further evidence",
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
}

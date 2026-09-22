import assert from "node:assert/strict";

import type { PhoenixRole } from "../src/lib/auth/permissions.ts";
import {
  canCancelMarketingRequest,
  isMarketingRequestCancellable,
  marketingCancellableStatuses,
  viewerMayCancelMarketingRequests,
} from "../src/lib/marketing-requests/cancel.ts";

/**
 * The Case File cancel control, added 2026-09-22 so the owner never again has to set `cancelled` by
 * hand-written SQL (the way `MKT-REQ-20260825-AADD59CE` was cancelled).
 *
 * These pin the two pure predicates that BOTH the drawn button (`buildViewer`) and the write
 * (`cancelMarketingRequest`) read, so the affordance and the enforcement can never drift:
 *   * only a Super Admin may cancel — no scope bypass, because calling off a request a human raised
 *     must never be automated;
 *   * only a live, non-terminal request may be cancelled — a draft (never entered the chain) and any
 *     already-terminal status (rejected / closed / archived / cancelled) are refused.
 */
export function runMarketingCancelRequestTests() {
  // ── Super Admin only ───────────────────────────────────────────────────────────────────────────
  assert.equal(viewerMayCancelMarketingRequests("Super Admin"), true);
  for (const role of ["CEO", "National Sales Manager", "Employee"] as PhoenixRole[]) {
    assert.equal(
      viewerMayCancelMarketingRequests(role),
      false,
      `${role} must not be able to cancel a marketing request`,
    );
  }

  // ── Which statuses may be cancelled ──────────────────────────────────────────────────────────────
  for (const status of [
    "pending_validation",
    "pending_approval",
    "returned",
    "approved",
    "active",
    "roi_tracking",
    "finance_hold",
  ]) {
    assert.equal(isMarketingRequestCancellable(status), true, `${status} should be cancellable`);
  }
  for (const status of ["draft", "rejected", "closed", "archived", "cancelled"]) {
    assert.equal(isMarketingRequestCancellable(status), false, `${status} must NOT be cancellable`);
  }
  // Never assume a future thirteenth status is cancellable.
  assert.equal(isMarketingRequestCancellable("some_future_status"), false);
  // Tolerates casing/whitespace the way the DB-backed callers see it.
  assert.equal(isMarketingRequestCancellable("  Approved  "), true);
  assert.equal(isMarketingRequestCancellable(null), false);
  assert.equal(isMarketingRequestCancellable(undefined), false);

  // The set and the predicate are the same rule.
  assert.ok(marketingCancellableStatuses.has("approved"));
  assert.ok(!marketingCancellableStatuses.has("closed"));

  // ── Both halves must hold for the affordance ─────────────────────────────────────────────────────
  assert.equal(canCancelMarketingRequest({ role: "Super Admin", status: "approved" }), true);
  // Right role, terminal status → no.
  assert.equal(canCancelMarketingRequest({ role: "Super Admin", status: "closed" }), false);
  // Cancellable status, wrong role → no.
  assert.equal(canCancelMarketingRequest({ role: "CEO", status: "approved" }), false);
}

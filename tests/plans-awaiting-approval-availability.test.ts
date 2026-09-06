import assert from "node:assert/strict";
import { resolvePlansAwaitingApproval } from "../src/lib/employee-portal/home-snapshot.ts";

// The employee-portal home snapshot used to fold a FAILED plans-awaiting-approval lookup into the
// same shape a genuine zero produces: `plansAwaitingManagerApproval: null`, with no signal that the
// zero downstream dashboards then compute (`plansAwaitingManagerApproval ?? 0`) came from a broken
// query rather than an empty inbox. A manager was told "0 plans awaiting your approval" — a
// positive claim, not a neutral one — or, on dashboards gated purely on `totalPending > 0`, shown
// nothing at all. resolvePlansAwaitingApproval() is the fix: it turns the settled promise result
// into both the count AND a `plansCountAvailable` flag the dashboards must check before trusting
// that count, mirroring the existing `pendingCountsAvailable` mechanism for vacation/excuse counts.
export function runPlansAwaitingApprovalAvailabilityTests() {
  // HEADLINE: a rejected lookup must report itself as unavailable, and must never resolve to a
  // number — reverting resolvePlansAwaitingApproval to the old behaviour (treat every settled
  // result as available, defaulting the count to null/0 on rejection) fails this assertion first.
  const rejected = resolvePlansAwaitingApproval(
    { status: "rejected", reason: new Error("countPlanAwaiting boom") },
    { hrId: "b-10", role: "District Manager" },
  );
  assert.equal(
    rejected.plansCountAvailable,
    false,
    "a rejected plans lookup must report plansCountAvailable: false — a manager cannot tell a failed query from an empty inbox by the count alone",
  );
  assert.equal(
    rejected.plansAwaitingManagerApproval,
    null,
    "a rejected plans lookup must never resolve to a numeric count — a bare 0 reads as a positive claim that nothing is awaiting approval",
  );

  // A genuine zero (the query ran fine and found nothing) must stay a real, available zero — the
  // fix must not turn every zero into "unavailable".
  const genuineZero = resolvePlansAwaitingApproval(
    { status: "fulfilled", value: { count: 0 } },
    { hrId: "b-10", role: "District Manager" },
  );
  assert.equal(genuineZero.plansCountAvailable, true, "a fulfilled lookup is available even when the count it found is genuinely zero");
  assert.equal(genuineZero.plansAwaitingManagerApproval, 0, "a genuine zero must still read as 0, not be swallowed into null");

  // A real, positive count still comes through unchanged.
  const real = resolvePlansAwaitingApproval(
    { status: "fulfilled", value: { count: 4 } },
    { hrId: "b-10", role: "National Sales Manager" },
  );
  assert.equal(real.plansCountAvailable, true, "a fulfilled lookup with a real count is available");
  assert.equal(real.plansAwaitingManagerApproval, 4, "the real count must pass through unchanged");

  // getPortalHomeSnapshot resolves the underlying promise to null for anyone the plans card does
  // not apply to (medical reps, or a caller with no hrId — see the `!isMr && hrId` gate). That is a
  // real "not applicable", not a failure, so it must stay available with a null count.
  const notApplicable = resolvePlansAwaitingApproval(
    { status: "fulfilled", value: null },
    { hrId: "", role: "Medical Rep" },
  );
  assert.equal(notApplicable.plansCountAvailable, true, "a resolved-to-null (not-a-manager) result is available, not a failure");
  assert.equal(notApplicable.plansAwaitingManagerApproval, null, "a non-manager caller has no plan count to show");
}

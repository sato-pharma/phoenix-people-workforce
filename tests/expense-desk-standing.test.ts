/**
 * Expense Approvals, rebuilt 2026-11-23 — WHERE A TRIP STANDS, pinned.
 *
 * The page it replaces answered this with one boolean, so "Approved" held three different things:
 * a claim accepted but held out of payroll, one waiting for the next payroll, and one a payroll had
 * already taken (230 "Approved" on production that day: 5 held, 98 already in a payroll). Every
 * tile, lane and row now reads `readTripStanding`, and the five tiles are counted by one function.
 *
 *   1. The five states, each from the columns it is read from.
 *   2. July and August 2026 were paid before the paid stamp existed: an unstamped row with one of
 *      those payout months is IN a payroll, and says the stamp was not kept.
 *   3. A status nobody listed is shown as waiting, never hidden.
 *   4. The tiles: a rejected trip is counted and never summed; every state has its own words.
 */
import assert from "node:assert/strict";

import {
  countTripStandings,
  LAST_UNSTAMPED_PAYOUT,
  paidBeforeStampsWereKept,
  readTripStanding,
  TRIP_STANDING_LABEL,
  TRIP_STANDING_MEANING,
  TRIP_STANDINGS,
  tripStanding,
} from "@/lib/outstation/approvals/standing";

export function runExpenseDeskStandingTests() {
  // 1. The five states.
  const none = { hasPayrollRow: false, payrollStamped: false };
  assert.equal(tripStanding({ ...none, status: "submitted" }), "waiting");
  assert.equal(tripStanding({ ...none, status: "needs_review" }), "waiting");
  assert.equal(tripStanding({ ...none, status: "rejected_by_admin" }), "rejected");
  assert.equal(tripStanding({ ...none, status: "accepted_by_admin" }), "approved_held", "accepted with no payroll row is HELD, not approved-and-paid");
  assert.equal(
    tripStanding({ hasPayrollRow: true, payoutMonth: 11, payoutYear: 2026, payrollStamped: false, status: "accepted_by_system" }),
    "approved_queued",
  );
  assert.equal(
    tripStanding({ hasPayrollRow: true, payoutMonth: 11, payoutYear: 2026, payrollStamped: true, status: "approved" }),
    "in_payroll",
  );
  // A rejected claim stays rejected even when a payroll row was left under it.
  assert.equal(tripStanding({ hasPayrollRow: true, payrollStamped: true, status: "rejected_by_admin" }), "rejected");
  // A waiting claim with a pending payroll row under it is still waiting: the row decides nothing.
  assert.equal(tripStanding({ hasPayrollRow: true, payoutMonth: 11, payoutYear: 2026, payrollStamped: false, status: "submitted" }), "waiting");

  // 2. Paid before the stamp was kept.
  assert.deepEqual(LAST_UNSTAMPED_PAYOUT, { month: 8, year: 2026 });
  assert.equal(paidBeforeStampsWereKept(8, 2026), true);
  assert.equal(paidBeforeStampsWereKept(7, 2026), true);
  assert.equal(paidBeforeStampsWereKept(9, 2026), false);
  assert.equal(paidBeforeStampsWereKept(null, null), false, "no payout period is never read as an old one");
  assert.deepEqual(
    readTripStanding({ hasPayrollRow: true, payoutMonth: 8, payoutYear: 2026, payrollStamped: false, status: "accepted_by_admin" }),
    { stampKept: false, standing: "in_payroll" },
    "an August 2026 trip with no stamp was paid; it must not read as waiting for the next payroll",
  );
  assert.deepEqual(
    readTripStanding({ hasPayrollRow: true, payoutMonth: 9, payoutYear: 2026, payrollStamped: false, status: "accepted_by_admin" }),
    { stampKept: true, standing: "approved_queued" },
  );

  // 3. An unlisted status is visible.
  assert.equal(tripStanding({ ...none, status: "something_new" }), "waiting");
  assert.equal(tripStanding({ ...none, status: null }), "waiting");

  // 4. The tiles.
  const tiles = countTripStandings([
    { payable: 100.1, standing: "waiting" },
    { payable: 200.2, standing: "waiting" },
    { payable: 50, standing: "approved_held" },
    { payable: 70, standing: "approved_queued" },
    { payable: 30, standing: "in_payroll" },
    { payable: 999, standing: "rejected" },
    { payable: Number.NaN, standing: "in_payroll" },
  ]);
  assert.deepEqual(tiles.waiting, { count: 2, value: 300.3 });
  assert.deepEqual(tiles.approved_held, { count: 1, value: 50 });
  assert.deepEqual(tiles.approved_queued, { count: 1, value: 70 });
  assert.deepEqual(tiles.in_payroll, { count: 2, value: 30 }, "a figure that is not a number is counted, never summed");
  assert.deepEqual(tiles.rejected, { count: 1, value: 0 }, "a rejected trip pays nothing, so it adds nothing");

  // One vocabulary: every state has its own label and its own sentence, and none says plain "Approved".
  assert.equal(TRIP_STANDINGS.length, 5);
  const labels = TRIP_STANDINGS.map((key) => TRIP_STANDING_LABEL[key]);
  assert.equal(new Set(labels).size, 5);
  assert.ok(!labels.includes("Approved"), "a bare 'Approved' is the word that hid three states");
  assert.deepEqual(labels, ["Waiting", "Approved · held", "Approved · next payroll", "In payroll", "Rejected"]);
  for (const key of TRIP_STANDINGS) assert.ok(TRIP_STANDING_MEANING[key].length > 10);
}

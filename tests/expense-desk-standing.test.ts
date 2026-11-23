/**
 * Expense Approvals, rebuilt 2026-11-23 — WHERE A TRIP STANDS, pinned.
 *
 * The page it replaces answered this with one boolean, so "Approved" held three different things:
 * a claim accepted but held out of payroll, one waiting for the next payroll, and one a payroll had
 * already taken (230 "Approved" on production that day: 5 held, 98 already in a payroll). Every
 * tile, lane and row now reads `readTripStanding`, and the six tiles are counted by one function.
 *
 *   1. The six states, each from the columns it is read from.
 *   2. July and August 2026 were paid before the paid stamp existed: an unstamped row with one of
 *      those payout months is IN a payroll, and says the stamp was not kept.
 *   3. A status nobody listed is shown as waiting, never hidden.
 *   4. The tiles: a rejected trip is counted and never summed; every state has its own words.
 *   5. 🔴 A trip whose payout month's payroll ALREADY RAN is not "next payroll" (23 Nov 2026: 12
 *      approved trips of September and October, about 3,869 EGP, read "Approved · next payroll"
 *      while both payrolls had run and no later run looks back at an earlier payout month).
 */
import assert from "node:assert/strict";

import {
  awaitsAPayroll,
  countTripStandings,
  LAST_UNSTAMPED_PAYOUT,
  newestPayout,
  paidBeforeStampsWereKept,
  payrollAlreadyRan,
  readTripStanding,
  TRIP_STANDING_LABEL,
  TRIP_STANDING_MEANING,
  TRIP_STANDINGS,
  tripStanding,
} from "@/lib/outstation/approvals/standing";

export function runExpenseDeskStandingTests() {
  // 1. The states read from the row alone.
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
  assert.equal(TRIP_STANDINGS.length, 6);
  const labels = TRIP_STANDINGS.map((key) => TRIP_STANDING_LABEL[key]);
  assert.equal(new Set(labels).size, 6);
  assert.ok(!labels.includes("Approved"), "a bare 'Approved' is the word that hid three states");
  assert.deepEqual(labels, ["Waiting", "Approved · held", "Approved · next payroll", "Approved · payroll already ran", "In payroll", "Rejected"]);
  for (const key of TRIP_STANDINGS) assert.ok(TRIP_STANDING_MEANING[key].length > 10);

  // 5. 🔴 The payroll of its payout month already ran.
  const october = { month: 10, year: 2026 };
  const approvedRow = { hasPayrollRow: true, payrollStamped: false, status: "accepted_by_admin" };
  assert.equal(
    tripStanding({ ...approvedRow, lastPaidPayout: october, payoutMonth: 9, payoutYear: 2026 }),
    "approved_missed",
    "HEADLINE: an approved September trip with no paid mark, once October's payroll has run, is NOT waiting for the next payroll",
  );
  assert.equal(tripStanding({ ...approvedRow, lastPaidPayout: october, payoutMonth: 10, payoutYear: 2026 }), "approved_missed", "the newest paid month itself has run too");
  assert.equal(tripStanding({ ...approvedRow, lastPaidPayout: october, payoutMonth: 11, payoutYear: 2026 }), "approved_queued", "a month no payroll has paid yet is still next payroll");
  assert.equal(tripStanding({ ...approvedRow, lastPaidPayout: { month: 12, year: 2026 }, payoutMonth: 1, payoutYear: 2027 }), "approved_queued", "the year is compared before the month");
  assert.equal(tripStanding({ ...approvedRow, lastPaidPayout: { month: 1, year: 2027 }, payoutMonth: 12, payoutYear: 2026 }), "approved_missed");
  assert.equal(tripStanding({ ...approvedRow, payoutMonth: 9, payoutYear: 2026 }), "approved_queued", "with the newest paid month not read, the state is never claimed");
  assert.equal(tripStanding({ ...approvedRow, lastPaidPayout: null, payoutMonth: 9, payoutYear: 2026 }), "approved_queued");
  // The states above it in the order still win: a stamp is paid, August is paid without one, no row is held.
  assert.equal(tripStanding({ ...approvedRow, lastPaidPayout: october, payoutMonth: 9, payoutYear: 2026, payrollStamped: true }), "in_payroll");
  assert.deepEqual(readTripStanding({ ...approvedRow, lastPaidPayout: october, payoutMonth: 8, payoutYear: 2026 }), { stampKept: false, standing: "in_payroll" });
  assert.equal(tripStanding({ hasPayrollRow: false, lastPaidPayout: october, payrollStamped: false, status: "accepted_by_admin" }), "approved_held");
  assert.equal(tripStanding({ ...approvedRow, lastPaidPayout: october, payoutMonth: 9, payoutYear: 2026, status: "submitted" }), "waiting");
  assert.equal(tripStanding({ ...approvedRow, lastPaidPayout: october, payoutMonth: 9, payoutYear: 2026, status: "rejected_by_admin" }), "rejected");

  assert.equal(payrollAlreadyRan(9, 2026, october), true);
  assert.equal(payrollAlreadyRan(11, 2026, october), false);
  assert.equal(payrollAlreadyRan(null, null, october), false, "a row with no payout month is never called missed");
  assert.equal(payrollAlreadyRan(9, 2026, null), false);

  // The newest paid month is the newest among the stamped rows it is given; an empty month is skipped.
  assert.deepEqual(newestPayout([{ payout_month: 9, payout_year: 2026 }, { payout_month: 10, payout_year: 2026 }, { payout_month: 12, payout_year: 2025 }]), october);
  assert.deepEqual(newestPayout([{ payout_month: null, payout_year: null }, { payout_month: "10", payout_year: "2026" }]), october, "numbers that arrive as text are read");
  assert.equal(newestPayout([]), null);
  assert.equal(newestPayout([{ payout_month: 13, payout_year: 2026 }]), null, "a month that is not a month names nothing");

  // Queued and missed are the two states whose payroll row no payroll has taken (the amount resend reads this).
  assert.deepEqual(TRIP_STANDINGS.filter(awaitsAPayroll), ["approved_queued", "approved_missed"]);

  // A missed trip has its own tile and is summed like any approved one.
  const withMissed = countTripStandings([
    { payable: 70, standing: "approved_queued" },
    { payable: 331.2, standing: "approved_missed" },
    { payable: 259.2, standing: "approved_missed" },
  ]);
  assert.deepEqual(withMissed.approved_missed, { count: 2, value: 590.4 }, "HEADLINE: missed trips are counted in their own tile");
  assert.deepEqual(withMissed.approved_queued, { count: 1, value: 70 }, "and never inside 'next payroll'");
  assert.ok(/has already run/.test(TRIP_STANDING_MEANING.approved_missed) && /Expenses step/.test(TRIP_STANDING_MEANING.approved_missed), "its sentence says the payroll ran and names the screen to check");
  // 🔴 It never promises the trip IS on that screen's list: the list leaves out a person held in the
  // month's run and a trip the published figure covered (late-expenses.ts). On 23 Nov 2026, 11 of the
  // 12 such trips belonged to one held person, and "it is listed" sent the reader to a list without them.
  assert.ok(!/\bis listed\b|\bare listed\b/.test(TRIP_STANDING_MEANING.approved_missed), "HEADLINE: the sentence never says the trip is listed on the Expenses step");
  assert.ok(/may have been paid another way/.test(TRIP_STANDING_MEANING.approved_missed), "HEADLINE: it says the trip may already have been paid another way");
  assert.ok(!/No later payroll/.test(TRIP_STANDING_MEANING.approved_missed), "and makes no promise about later payrolls: the carry switch can change that");
  assert.ok(!/unpaid|not paid\b/i.test(TRIP_STANDING_MEANING.approved_missed.replace("not marked paid", "")), "and never calls it unpaid: unstamped is not unpaid");
}

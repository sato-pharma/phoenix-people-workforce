import assert from "node:assert/strict";

import {
  DECLINE_OFFER_WINDOW_DAYS,
  daysSinceHire,
  isDeclineOfferEligible,
} from "../src/lib/resignations/decline-offer-eligibility.ts";

function daysAgo(days: number, from = "2026-09-11"): string {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function runDeclineOfferEligibilityTests() {
  const today = "2026-09-11";

  assert.equal(DECLINE_OFFER_WINDOW_DAYS, 30, "the owner-confirmed window is exactly 30 days");

  // Hired today (0 days) -> eligible.
  assert.equal(
    isDeclineOfferEligible({ employmentStatus: "active", hireDate: today }, today),
    true,
    "an employee hired today must be eligible",
  );

  // Exactly 30 days -> still eligible (the window is inclusive).
  assert.equal(
    isDeclineOfferEligible({ employmentStatus: "active", hireDate: daysAgo(30, today) }, today),
    true,
    "exactly 30 days since hire must still be eligible",
  );

  // 31 days -> the required negative/failure-path test. The window has passed; only the
  // standard resignation/termination workflow may be used from here.
  assert.equal(
    isDeclineOfferEligible({ employmentStatus: "active", hireDate: daysAgo(31, today) }, today),
    false,
    "31 days since hire must be rejected — past the owner-approved 30-day window",
  );

  // on_leave counts as active for this purpose, same as everywhere else in the directory
  // (activeLifecycleStatuses in employee-directory.ts).
  assert.equal(
    isDeclineOfferEligible({ employmentStatus: "on_leave", hireDate: daysAgo(5, today) }, today),
    true,
    "on_leave must be treated the same as active",
  );

  // Already-terminal statuses can never re-enter this shortcut.
  for (const status of ["resigned", "terminated", "inactive", "declined_offer"]) {
    assert.equal(
      isDeclineOfferEligible({ employmentStatus: status, hireDate: daysAgo(1, today) }, today),
      false,
      `an employee already in status "${status}" must not be eligible`,
    );
  }

  // Missing hire date -> not eligible (never derive a window from an absent anchor).
  assert.equal(
    isDeclineOfferEligible({ employmentStatus: "active", hireDate: null }, today),
    false,
    "a missing hire date must not be eligible",
  );

  // A future hire date (clock skew / bad data) resolves to a negative day count and must
  // not be treated as eligible by an accidental sign flip.
  assert.equal(
    isDeclineOfferEligible({ employmentStatus: "active", hireDate: daysAgo(-2, today) }, today),
    false,
    "a hire date in the future must not be eligible",
  );

  assert.equal(daysSinceHire(null, today), null, "daysSinceHire must return null for a missing hire date");
  assert.equal(daysSinceHire(daysAgo(10, today), today), 10, "daysSinceHire must count whole calendar days, date-only");
}

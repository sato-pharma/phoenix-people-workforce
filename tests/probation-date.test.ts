import assert from "node:assert/strict";

import {
  PROBATION_TOTAL_DAYS,
  currentProbationDay,
  isWithinProbationWindow,
  probationDaysRemaining,
  probationEndDate,
  probationMilestoneDate,
  probationStartDate,
} from "../src/lib/probation/date.ts";
import { probationEndDateFromHire } from "../src/lib/lifecycle-risk/metrics.ts";

export function runProbationDateTests() {
  // Canonical rule: hire + 90 days (NOT +3 calendar months).
  assert.equal(PROBATION_TOTAL_DAYS, 90);
  assert.equal(probationEndDate("2026-01-01"), "2026-04-01", "Jan 1 + 90d = Apr 1 (non-leap span)");

  // A "+3 months" formula would give 2026-04-01 here too — but diverges at month-ends.
  // Month-end hire: +90 days is purely additive and must NOT clamp like calendar-month math.
  assert.equal(
    probationEndDate("2026-01-31"),
    "2026-05-01",
    "Jan 31 + 90d = May 1 (a +3-month rule would wrongly give Apr 30)",
  );

  // February / short-month start.
  assert.equal(probationEndDate("2026-02-15"), "2026-05-16", "Feb 15 + 90d = May 16 (2026 non-leap)");

  // Leap year: 2028-02-29 exists; 90 days from Jan 1 2028 crosses Feb 29.
  assert.equal(probationEndDate("2028-01-01"), "2028-03-31", "leap-year Jan 1 + 90d = Mar 31 (Feb has 29)");
  assert.equal(probationEndDate("2028-02-29"), "2028-05-29", "leap-day hire + 90d = May 29");

  // Year boundary crossing.
  assert.equal(probationEndDate("2025-11-15"), "2026-02-13", "Nov 15 + 90d crosses into next year");

  // Timezone robustness: an ISO datetime with a Z suffix must resolve by its date part only,
  // never shifting a day due to local-time parsing.
  assert.equal(
    probationEndDate("2026-01-01T23:30:00Z"),
    probationEndDate("2026-01-01"),
    "datetime input resolves by date-part only (no tz day-shift)",
  );

  // Null / corrected-hire-date safety.
  assert.equal(probationEndDate(null), null, "null hire date -> null end date");
  assert.equal(probationEndDate(undefined), null, "undefined hire date -> null end date");
  assert.equal(probationEndDate(""), null, "empty hire date -> null end date");

  // Explicit probation start overrides hire date.
  assert.equal(probationStartDate("2026-01-01", "2026-01-05"), "2026-01-05");
  assert.equal(probationEndDate("2026-01-01", "2026-01-05"), "2026-04-05", "explicit start + 90d");

  // Single-source guarantee: the lifecycle-risk helper must agree with the canonical helper
  // for every sampled hire date, so the two formulas can never silently drift apart.
  for (const hire of ["2026-01-01", "2026-01-31", "2026-02-28", "2028-02-29", "2025-12-15"]) {
    assert.equal(
      probationEndDate(hire),
      probationEndDateFromHire(hire),
      `date formula agreement for ${hire}`,
    );
  }

  // currentProbationDay: day 1 = hire date; increments by elapsed days.
  assert.equal(currentProbationDay("2026-01-01", new Date(2026, 0, 1)), 1, "hire day = day 1");
  assert.equal(currentProbationDay("2026-01-01", new Date(2026, 0, 31)), 31, "30 days later = day 31");
  assert.equal(currentProbationDay(null, new Date(2026, 0, 1)), null, "no hire date -> null day");

  // Days remaining + window membership.
  assert.equal(probationDaysRemaining("2026-01-01", new Date(2026, 0, 1)), 90, "day 1: 90 remaining");
  assert.equal(probationDaysRemaining("2026-01-01", new Date(2026, 3, 1)), 0, "end date: 0 remaining");
  assert.equal(isWithinProbationWindow("2026-01-01", new Date(2026, 1, 1)), true, "mid-window is within");
  assert.equal(isWithinProbationWindow("2026-01-01", new Date(2026, 5, 1)), false, "past window is not within");

  // Milestone dates (fixed schedule, kept by policy).
  assert.equal(probationMilestoneDate("2026-01-01", 30), "2026-01-31", "day-30 milestone date");
  assert.equal(probationMilestoneDate("2026-01-01", 60), "2026-03-02", "day-60 milestone date");
  assert.equal(probationMilestoneDate("2026-01-01", 75), "2026-03-17", "day-75 milestone date");

  // Cairo/UTC day-boundary regression: every reference-date default above resolves via the
  // server's own clock unless explicitly overridden — this previously meant server-local/UTC
  // midnight, not Cairo's. Cairo is ahead of UTC (EEST=+3 late Apr-late Oct, EET=+2 otherwise),
  // so for a few hours after Cairo's local midnight, the UTC clock is still on the previous
  // calendar day. These instants straddle that exact boundary in both seasons.
  const eestBeforeCairoMidnight = new Date("2026-07-24T20:59:00Z"); // Cairo 23:59 Jul 24 (EEST)
  const eestAfterCairoMidnight = new Date("2026-07-24T21:00:00Z"); // Cairo 00:00 Jul 25 (EEST)
  assert.equal(currentProbationDay("2026-07-01", eestBeforeCairoMidnight), 24, "20:59 UTC (EEST): Cairo still Jul 24 -> probation day 24");
  assert.equal(currentProbationDay("2026-07-01", eestAfterCairoMidnight), 25, "21:00 UTC (EEST): Cairo already Jul 25 -> probation day 25");
  // hireDate 2026-04-26 + 90 days = 2026-07-25, landing exactly on this boundary.
  assert.equal(probationDaysRemaining("2026-04-26", eestBeforeCairoMidnight), 1, "20:59 UTC (EEST): 1 day remaining per Cairo");
  assert.equal(probationDaysRemaining("2026-04-26", eestAfterCairoMidnight), 0, "21:00 UTC (EEST): due today per Cairo");
  assert.equal(isWithinProbationWindow("2026-04-26", eestBeforeCairoMidnight), true, "still within window per Cairo (1 day left)");
  assert.equal(isWithinProbationWindow("2026-04-26", eestAfterCairoMidnight), false, "window already ended per Cairo (0 days left)");

  const eetBeforeCairoMidnight = new Date("2026-01-15T21:59:00Z"); // Cairo 23:59 Jan 15 (EET)
  const eetAfterCairoMidnight = new Date("2026-01-15T22:00:00Z"); // Cairo 00:00 Jan 16 (EET)
  assert.equal(currentProbationDay("2026-01-01", eetBeforeCairoMidnight), 15, "21:59 UTC (EET): Cairo still Jan 15 -> probation day 15");
  assert.equal(currentProbationDay("2026-01-01", eetAfterCairoMidnight), 16, "22:00 UTC (EET): Cairo already Jan 16 -> probation day 16");
  // hireDate 2025-10-18 + 90 days = 2026-01-16, landing exactly on this boundary.
  assert.equal(probationDaysRemaining("2025-10-18", eetBeforeCairoMidnight), 1, "21:59 UTC (EET): 1 day remaining per Cairo");
  assert.equal(probationDaysRemaining("2025-10-18", eetAfterCairoMidnight), 0, "22:00 UTC (EET): due today per Cairo");
}

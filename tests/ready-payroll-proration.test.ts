import assert from "node:assert/strict";

import {
  calculateBaseLifecycleProrationDeduction,
  calculateBaseProrationDeduction,
  payrollDaysInMonth,
  prorationEffectiveEndDay,
  prorationEndDay,
  readyLifecycleComment,
  resolveReadyLifecycleSettlement,
} from "../src/lib/payroll/ready-proration.ts";

/**
 * Behavioural cover for Ready-Payroll partial-month proration.
 *
 * The rule (owner-confirmed): the daily rate is always
 * `Base Salary ÷ actual calendar days in the month`, and an employee present
 * for the whole calendar month is deducted nothing.
 *
 * The bug this exists to stop: the arithmetic hardcoded a 30-day month, so the
 * "worked the whole month" guard (`endDay >= 30`) could never be true in a 28-
 * or 29-day February. A leaver dated 28 Feb who worked every single day was
 * deducted 666.67 EGP of a 10,000 EGP base. It survived because the only guard
 * was a source-regex assertion that matched the buggy literal and declared the
 * fixed-30 month correct.
 */
export function runReadyPayrollProrationTests() {
  // ── The headline regression: a full February must cost nothing ──────────────
  assert.equal(
    calculateBaseLifecycleProrationDeduction(10_000, null, "2026-02-28", 2, 2026),
    0,
    "A leaver whose last working day is the final day of a 28-day February worked the whole month and must be deducted nothing.",
  );

  assert.equal(
    calculateBaseLifecycleProrationDeduction(10_000, null, "2024-02-29", 2, 2024),
    0,
    "A leap-year February must also settle to zero on the 29th.",
  );

  // Every month length, joiner and leaver at the boundary, must settle to zero.
  for (const [month, year, lastDay] of [
    [1, 2026, "2026-01-31"],
    [2, 2026, "2026-02-28"],
    [2, 2024, "2024-02-29"],
    [4, 2026, "2026-04-30"],
    [6, 2026, "2026-06-30"],
    [12, 2026, "2026-12-31"],
  ] as Array<[number, number, string]>) {
    assert.equal(
      calculateBaseLifecycleProrationDeduction(10_000, null, lastDay, month, year),
      0,
      `Leaving on the last calendar day of ${year}-${month} is a full month and must deduct nothing.`,
    );
    assert.equal(
      calculateBaseProrationDeduction(10_000, `${lastDay.slice(0, 8)}01`, month, year),
      0,
      `Being hired on day 1 of ${year}-${month} is a full month and must deduct nothing.`,
    );
  }

  // ── The daily rate must follow the real month length ────────────────────────
  assert.equal(payrollDaysInMonth(2, 2026), 28, "February 2026 has 28 days.");
  assert.equal(payrollDaysInMonth(2, 2024), 29, "February 2024 is a leap year.");
  assert.equal(payrollDaysInMonth(4, 2026), 30, "April has 30 days.");
  assert.equal(payrollDaysInMonth(12, 2026), 31, "December has 31 days.");

  // Half a 28-day February: worked 1-14, so 14 unworked days at 10000/28 = 357.14/day.
  assert.equal(
    calculateBaseLifecycleProrationDeduction(10_000, null, "2026-02-14", 2, 2026),
    5_000,
    "Leaving mid-February must charge the unworked half at the February day rate (10000/28), not the 30-day rate.",
  );

  // A 31-day month must use /31, not /30 — the old code's other blind spot.
  assert.equal(
    calculateBaseLifecycleProrationDeduction(3_100, null, "2026-12-30", 12, 2026),
    100,
    "One unworked day in a 31-day month costs exactly one 31st of base.",
  );

  // ── prorationEndDay must clamp to the real month, not to 30 ─────────────────
  assert.equal(
    prorationEndDay("2026-02-28", 2, 2026),
    28,
    "The last working day of February is day 28.",
  );
  assert.equal(
    prorationEndDay("2026-12-31", 12, 2026),
    31,
    "December's 31st must not be clamped down to 30 — clamping it silently charged a day.",
  );
  assert.equal(
    prorationEndDay(null, 2, 2026),
    28,
    "With no last working date the employee is present to the real end of the month.",
  );

  // ── Joiners ────────────────────────────────────────────────────────────────
  // Hired 15 Feb 2026: paid 15-28 = 14 days, so 14 unworked days are deducted.
  assert.equal(
    calculateBaseProrationDeduction(10_000, "2026-02-15", 2, 2026),
    5_000,
    "A mid-February joiner must be charged the unworked days at the February day rate.",
  );

  assert.equal(
    calculateBaseProrationDeduction(10_000, "2026-03-10", 2, 2026),
    0,
    "A hire date outside the payroll month must not prorate at all.",
  );

  // ── Combined joiner+leaver inside one month ────────────────────────────────
  // Hired 2026-02-05, left 2026-02-24: 20 days paid, 8 unworked at 10000/28.
  assert.equal(
    calculateBaseLifecycleProrationDeduction(10_000, "2026-02-05", "2026-02-24", 2, 2026),
    2_857.14,
    "A joiner-and-leaver inside one February must be charged both unworked ends at the February day rate.",
  );

  // ── Degenerate inputs must never produce a negative or NaN charge ──────────
  assert.equal(
    calculateBaseLifecycleProrationDeduction(0, null, "2026-02-10", 2, 2026),
    0,
    "A zero base salary must not produce a charge.",
  );
  assert.ok(
    Number.isFinite(calculateBaseLifecycleProrationDeduction(10_000, null, "not-a-date", 2, 2026)),
    "An unparseable last working date must not produce NaN.",
  );

  // ── Resignation Rule 1: the >25th branch ───────────────────────────────────
  // Owner rule: last working day ≤25th → base prorated, NO ECOL, NO Fuel.
  //             last working day >25th → base IN FULL, ECOL and Fuel IN FULL.
  //
  // The Ready sheet had never implemented the second half. It zeroed both allowances for
  // EVERY leaver and prorated the base regardless of date, so a rep resigning on the 28th
  // of a 31-day month lost 3,000 ECOL + 500 Fuel outright AND was docked ~16% of base.
  // Three separate losses on one row, none of them policy.
  const base = 30_000;
  const ecol = 3_000;
  const fuel = 500;
  const settle = (
    lastWorkingDate: string | null,
    hireDate: string | null,
    month: number,
    year: number,
    isResignation = true,
  ) =>
    resolveReadyLifecycleSettlement({
      baseSalary: base,
      extraCostOfLiving: ecol,
      fuelAllowance: fuel,
      hireDate,
      isResignation,
      lastWorkingDate,
      month,
      year,
    });

  // Leaver on the 28th of a 31-day month — the headline case.
  const late = settle("2026-07-28", null, 7, 2026);
  assert.equal(late.branch, "leaver_after_25", "the 28th is after the 25th");
  assert.equal(
    late.baseProrationDeduction,
    0,
    "a leaver after the 25th is paid base IN FULL — the sheet used to dock 2,903.23 of a 30,000 base",
  );
  assert.equal(
    late.extraCostOfLiving,
    ecol,
    "…and keeps ALL of the extra cost of living — the sheet used to zero it, losing 3,000 EGP",
  );
  assert.equal(
    late.fuelAllowance,
    fuel,
    "…and ALL of the fuel allowance — the sheet used to zero it, losing a further 500 EGP",
  );

  // The boundary itself: the 25th is NOT "after the 25th".
  const onBoundary = settle("2026-07-25", null, 7, 2026);
  assert.equal(onBoundary.branch, "leaver_on_or_before_25", "the 25th falls in the prorated branch");
  assert.equal(
    onBoundary.baseProrationDeduction,
    5_806.45,
    "a leaver on the 25th of a 31-day month is charged the 6 unworked days at 30000/31",
  );
  assert.equal(onBoundary.extraCostOfLiving, 0, "no ECOL on or before the 25th");
  assert.equal(onBoundary.fuelAllowance, 0, "no fuel on or before the 25th");

  const justAfter = settle("2026-07-26", null, 7, 2026);
  assert.equal(justAfter.branch, "leaver_after_25", "the 26th crosses into the full-pay branch");
  assert.equal(justAfter.baseProrationDeduction, 0, "one day past the boundary flips base to full pay");

  // February: the >25th rule and the real month length must both hold at once.
  const feb = settle("2026-02-26", null, 2, 2026);
  assert.equal(feb.branch, "leaver_after_25", "26 Feb is after the 25th even in a 28-day month");
  assert.equal(feb.baseProrationDeduction, 0, "and is paid in full");
  assert.equal(feb.extraCostOfLiving, ecol, "with ECOL in full");

  // A full-month February leaver stays at zero — the bug #1931 fixed must not regress.
  const febFullMonth = settle("2026-02-28", null, 2, 2026);
  assert.equal(
    febFullMonth.baseProrationDeduction,
    0,
    "a 28 Feb leaver who worked every day is deducted nothing (the fixed-30 bug)",
  );

  // ── The >25th waiver applies to the LEAVING end only ───────────────────────
  // Hired 10 July, left 28 July: "base in full" must not pay for the 9 days before the
  // hire date. Charged 9 unworked days at 30000/31 = 8,709.68.
  const hiredAndLeft = settle("2026-07-28", "2026-07-10", 7, 2026);
  assert.equal(hiredAndLeft.branch, "leaver_after_25", "still the after-25 branch");
  assert.equal(
    hiredAndLeft.baseProrationDeduction,
    8_709.68,
    "someone HIRED this month and leaving after the 25th must still pay for the days before their hire date — " +
      "'base in full' waives the leaving end, it does not gift a month that was never worked",
  );
  assert.equal(hiredAndLeft.extraCostOfLiving, ecol, "the late-leaver allowance rule still applies");

  // ── Resignation ONLY: a termination/deactivation gets NO >25th generosity ───
  // Owner ruling 2026-08-14: Rule 1's full-pay waiver is for genuine resignations.
  // A dismissed (terminated) or deactivated (inactive) leaver keeps NEITHER allowance
  // and has base prorated to the ACTUAL last working day — never waived to month end,
  // even past the 25th. The canonical automated engine likewise counts only
  // employee_resignations rows as leavers, so gating here keeps the two engines aligned.
  const dismissedLate = settle("2026-07-28", null, 7, 2026, false);
  assert.equal(
    dismissedLate.branch,
    "leaver_non_resignation",
    "a non-resignation leaver after the 25th is NOT the full-pay branch",
  );
  assert.equal(
    dismissedLate.baseProrationDeduction,
    2_903.23,
    "a dismissal on the 28th of a 31-day month is charged the 3 unworked days at 30000/31 — the >25th waiver does not apply",
  );
  assert.equal(dismissedLate.extraCostOfLiving, 0, "a dismissal keeps NO extra cost of living");
  assert.equal(dismissedLate.fuelAllowance, 0, "and NO fuel allowance");
  assert.equal(
    dismissedLate.effectiveEndDay,
    28,
    "and is charged to the ACTUAL last working day — waiving it to month end is exactly the silent full-month overpayment the gate stops",
  );

  // The identical date treated as a genuine resignation DOES get the waiver — proving the
  // FLAG, not the date, moves the money. Break the gate and this divergence collapses.
  const resignedLate = settle("2026-07-28", null, 7, 2026, true);
  assert.equal(resignedLate.branch, "leaver_after_25", "the identical date as a resignation IS the full-pay branch");
  assert.equal(resignedLate.baseProrationDeduction, 0, "…and pays base in full");
  assert.notEqual(
    dismissedLate.baseProrationDeduction,
    resignedLate.baseProrationDeduction,
    "resignation vs dismissal on the SAME late date must produce different base pay — the whole point of the gate",
  );

  // On or before the 25th, dismissal and resignation prorate base identically (both zero
  // allowances), so the gate only changes the >25th tail and never underpays an early exit.
  const dismissedEarly = settle("2026-07-20", null, 7, 2026, false);
  assert.equal(dismissedEarly.branch, "leaver_non_resignation", "still the non-resignation branch");
  assert.equal(
    dismissedEarly.baseProrationDeduction,
    settle("2026-07-20", null, 7, 2026, true).baseProrationDeduction,
    "on or before the 25th, dismissal and resignation prorate base identically — the gate only changes the >25th tail",
  );
  assert.equal(dismissedEarly.extraCostOfLiving, 0, "no ECOL");
  assert.equal(dismissedEarly.fuelAllowance, 0, "no fuel");
  assert.match(
    String(readyLifecycleComment(dismissedLate)),
    /not a resignation/i,
    "a dismissal row's comment must not claim to be a resignation",
  );

  // ── Joiner: owner decision 2026-08-09 — ECOL and Fuel stay FULL ────────────
  // computeJoinerPay halves them after the 15th; the Ready sheet deliberately does not,
  // because adopting it would REDUCE a real person's pay. Pinned so it is not "fixed".
  const lateJoiner = settle(null, "2026-07-20", 7, 2026);
  assert.equal(lateJoiner.branch, "joiner", "a hire inside the month is a joiner row");
  assert.equal(
    lateJoiner.extraCostOfLiving,
    ecol,
    "a joiner keeps FULL extra cost of living — the owner declined the post-15th halving on this sheet",
  );
  assert.equal(lateJoiner.fuelAllowance, fuel, "and FULL fuel allowance, for the same reason");
  assert.equal(
    lateJoiner.baseProrationDeduction,
    18_387.1,
    "…while base is still prorated from the hire date on the month's real calendar days",
  );

  // ── An ordinary full-month row is untouched ───────────────────────────────
  const ordinary = settle(null, null, 7, 2026);
  assert.equal(ordinary.branch, "none", "no hire and no leaving date inside the month");
  assert.equal(ordinary.baseProrationDeduction, 0, "and nothing is deducted");
  assert.equal(ordinary.extraCostOfLiving, ecol, "allowances pass through untouched");
  assert.equal(ordinary.fuelAllowance, fuel, "both of them");

  // ── The stored value and the Excel formula must interpolate ONE number ─────
  // The workbook recalculates client-side, so if the formula's end day disagreed with the
  // one that produced the stored figure, the downloaded sheet would silently restate it.
  assert.equal(
    prorationEffectiveEndDay("2026-07-28", 7, 2026),
    31,
    "a leaver after the 25th is charged as worked-to-month-end, which is what 'base in full' means in day terms",
  );
  assert.equal(
    prorationEffectiveEndDay("2026-07-20", 7, 2026),
    20,
    "a leaver on or before the 25th is still charged to their real last working day",
  );
  assert.equal(
    prorationEffectiveEndDay("2026-02-26", 2, 2026),
    28,
    "and the waived end day is the REAL month length, never a fixed 30",
  );

  // ── The comment must be derived from the branch that moved the money ───────
  assert.match(
    String(readyLifecycleComment(late)),
    /paid in full/i,
    "a >25th row must not carry the old 'cost of living and fuel are zero' sentence — it shipped the wrong rule into the workbook as policy",
  );
  assert.match(
    String(readyLifecycleComment(onBoundary)),
    /no cost of living/i,
    "a ≤25th row must say the allowances are withheld",
  );
  assert.equal(readyLifecycleComment(ordinary), null, "an ordinary row has no lifecycle sentence to add");
}

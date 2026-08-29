import assert from "node:assert/strict";

import {
  calculateBaseLifecycleProrationDeduction,
  calculateNetJoinerProrationDeduction,
  payrollDaysInMonth,
  prorationEffectiveEndDay,
  prorationEndDay,
  readyLifecycleComment,
  resolveReadyLifecycleSettlement,
} from "../src/lib/payroll/ready-proration.ts";

/**
 * Behavioural cover for Ready-Payroll partial-month proration.
 *
 * TWO rules, one per lifecycle branch, both owner-confirmed:
 *   JOINER — daily rate is `Net Salary ÷ actual calendar days`, Net being
 *            Base + ECOL + Fuel (owner instruction 2026-08-29).
 *   LEAVER — daily rate stays `Base Salary ÷ actual calendar days`, with
 *            Resignation Rule 1 governing the allowances.
 * Either way, an employee present for the whole calendar month is deducted
 * nothing. The tests below assert the two rates stay DIFFERENT: collapsing them
 * into one would silently rewrite whichever rule lost.
 *
 * The bug this exists to stop: the arithmetic hardcoded a 30-day month, so the
 * "worked the whole month" guard (`endDay >= 30`) could never be true in a 28-
 * or 29-day February. A leaver dated 28 Feb who worked every single day was
 * deducted 666.67 EGP of a 10,000 EGP base. It survived because the only guard
 * was a source-regex assertion that matched the buggy literal and declared the
 * fixed-30 month correct.
 */

/**
 * Money to the piastre. The assertions below reconstruct a take-home figure as
 * `base + ECOL + fuel - deduction`, and IEEE-754 leaves a tail on that
 * subtraction (33,500 - 20,532.26 lands on 12,967.740000000002). The payroll
 * sheet shows two decimals, so compare at two decimals — an unrounded compare
 * fails on the arithmetic rather than on the rule being tested.
 */
const money = (value: number) => Math.round(value * 100) / 100;

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
      calculateNetJoinerProrationDeduction(10_000, 2_000, 500, `${lastDay.slice(0, 8)}01`, month, year),
      0,
      `Being hired on day 1 of ${year}-${month} is a full month and must deduct nothing — allowances included.`,
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

  // ── Joiners: the rate is NET, not base ─────────────────────────────────────
  // Owner instruction 2026-08-29. Hired 15 Feb 2026 on 10,000 + 2,000 + 500:
  // Net 12,500, paid 15-28 = 14 of 28 days, so exactly half of NET is deducted.
  assert.equal(
    calculateNetJoinerProrationDeduction(10_000, 2_000, 500, "2026-02-15", 2, 2026),
    6_250,
    "A mid-February joiner is charged the unworked days against NET — half of 12,500, not half of the 10,000 base.",
  );

  // The same row under the RETIRED base-only rule deducted 5,000. Pinning the
  // gap keeps a future session from quietly reverting to the old rate: these two
  // numbers must never be equal again.
  assert.notEqual(
    calculateNetJoinerProrationDeduction(10_000, 2_000, 500, "2026-02-15", 2, 2026),
    5_000,
    "the joiner deduction must NOT fall back to the base-only figure — that is the rule the owner replaced",
  );

  // Allowances of zero collapse the two rules onto the same number, which is the
  // only case where they may agree.
  assert.equal(
    calculateNetJoinerProrationDeduction(10_000, 0, 0, "2026-02-15", 2, 2026),
    5_000,
    "with no allowances there is nothing extra to prorate, so net and base proration coincide",
  );

  assert.equal(
    calculateNetJoinerProrationDeduction(10_000, 2_000, 500, "2026-03-10", 2, 2026),
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
    late.prorationDeduction,
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
    onBoundary.prorationDeduction,
    5_806.45,
    "a leaver on the 25th of a 31-day month is charged the 6 unworked days at 30000/31",
  );
  assert.equal(onBoundary.extraCostOfLiving, 0, "no ECOL on or before the 25th");
  assert.equal(onBoundary.fuelAllowance, 0, "no fuel on or before the 25th");

  const justAfter = settle("2026-07-26", null, 7, 2026);
  assert.equal(justAfter.branch, "leaver_after_25", "the 26th crosses into the full-pay branch");
  assert.equal(justAfter.prorationDeduction, 0, "one day past the boundary flips base to full pay");

  // February: the >25th rule and the real month length must both hold at once.
  const feb = settle("2026-02-26", null, 2, 2026);
  assert.equal(feb.branch, "leaver_after_25", "26 Feb is after the 25th even in a 28-day month");
  assert.equal(feb.prorationDeduction, 0, "and is paid in full");
  assert.equal(feb.extraCostOfLiving, ecol, "with ECOL in full");

  // A full-month February leaver stays at zero — the bug #1931 fixed must not regress.
  const febFullMonth = settle("2026-02-28", null, 2, 2026);
  assert.equal(
    febFullMonth.prorationDeduction,
    0,
    "a 28 Feb leaver who worked every day is deducted nothing (the fixed-30 bug)",
  );

  // ── The >25th waiver applies to the LEAVING end only ───────────────────────
  // Hired 10 July, left 28 July: "base in full" must not pay for the 9 days before the
  // hire date. Charged 9 unworked days at 30000/31 = 8,709.68.
  const hiredAndLeft = settle("2026-07-28", "2026-07-10", 7, 2026);
  assert.equal(hiredAndLeft.branch, "leaver_after_25", "still the after-25 branch");
  assert.equal(
    hiredAndLeft.prorationDeduction,
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
    dismissedLate.prorationDeduction,
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
  assert.equal(resignedLate.prorationDeduction, 0, "…and pays base in full");
  assert.notEqual(
    dismissedLate.prorationDeduction,
    resignedLate.prorationDeduction,
    "resignation vs dismissal on the SAME late date must produce different base pay — the whole point of the gate",
  );

  // On or before the 25th, dismissal and resignation prorate base identically (both zero
  // allowances), so the gate only changes the >25th tail and never underpays an early exit.
  const dismissedEarly = settle("2026-07-20", null, 7, 2026, false);
  assert.equal(dismissedEarly.branch, "leaver_non_resignation", "still the non-resignation branch");
  assert.equal(
    dismissedEarly.prorationDeduction,
    settle("2026-07-20", null, 7, 2026, true).prorationDeduction,
    "on or before the 25th, dismissal and resignation prorate base identically — the gate only changes the >25th tail",
  );
  assert.equal(dismissedEarly.extraCostOfLiving, 0, "no ECOL");
  assert.equal(dismissedEarly.fuelAllowance, 0, "no fuel");
  assert.match(
    String(readyLifecycleComment(dismissedLate)),
    /not a resignation/i,
    "a dismissal row's comment must not claim to be a resignation",
  );

  // ── Joiner: the whole NET is prorated (owner instruction 2026-08-29) ───────
  // Hired 20 July on 30,000 + 3,000 + 500 = 33,500 net: 12 of 31 days worked, so
  // 19 unworked days of NET are deducted — 33,500 x 19/31 = 20,532.26.
  const lateJoiner = settle(null, "2026-07-20", 7, 2026);
  assert.equal(lateJoiner.branch, "joiner", "a hire inside the month is a joiner row");
  assert.equal(
    lateJoiner.prorationDeduction,
    20_532.26,
    "a joiner is charged the unworked days against NET (base + ECOL + fuel), not against base alone",
  );

  // The allowance COLUMNS still show the full contractual figures. That is not the
  // old "allowances paid in full" rule surviving — the proration is carried entirely
  // by the deduction line, so what the employee is actually PAID is the net share.
  // Asserting the resulting month salary is what distinguishes the two.
  assert.equal(
    lateJoiner.extraCostOfLiving,
    ecol,
    "the ECOL column keeps its contractual monthly figure — the proration lives in the deduction line",
  );
  assert.equal(lateJoiner.fuelAllowance, fuel, "and so does the fuel column");
  assert.equal(
    money(base + ecol + fuel - lateJoiner.prorationDeduction),
    12_967.74,
    "…so the row actually PAYS net x days worked / days in month: 33,500 x 12/31",
  );

  // ── The headline case the owner priced by hand ─────────────────────────────
  // Yasmine El Safoury, hired 24 Aug 2026: base 16,000 + ECOL 1,500 + fuel 500.
  // His arithmetic was 18,000 / 31 x 8 = 4,645.16, and this is the rule that
  // produces it. The two RETIRED rules paid 5,129.03 and 6,129.03 respectively.
  const augustHire = resolveReadyLifecycleSettlement({
    baseSalary: 16_000,
    extraCostOfLiving: 1_500,
    fuelAllowance: 500,
    hireDate: "2026-08-24",
    isResignation: false,
    lastWorkingDate: null,
    month: 8,
    year: 2026,
  });
  assert.equal(augustHire.branch, "joiner", "a 24 August hire is a joiner row in August");
  assert.equal(
    augustHire.prorationDeduction,
    13_354.84,
    "23 unworked days of an 18,000 net in a 31-day month",
  );
  assert.equal(
    money(16_000 + 1_500 + 500 - augustHire.prorationDeduction),
    4_645.16,
    "a 24 August hire on 18,000 net is paid 18,000 / 31 x 8 = 4,645.16 — the owner's own figure",
  );

  // ── An ordinary full-month row is untouched ───────────────────────────────
  const ordinary = settle(null, null, 7, 2026);
  assert.equal(ordinary.branch, "none", "no hire and no leaving date inside the month");
  assert.equal(ordinary.prorationDeduction, 0, "and nothing is deducted");
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
  assert.match(
    String(readyLifecycleComment(lateJoiner)),
    /net salary/i,
    "a joiner row's comment must say NET is prorated — this sentence ships inside the workbook and is read as the policy",
  );
  assert.doesNotMatch(
    String(readyLifecycleComment(lateJoiner)),
    /paid in full/i,
    "…and must no longer claim the allowances are paid in full, which is precisely the rule the owner replaced",
  );
  assert.equal(readyLifecycleComment(ordinary), null, "an ordinary row has no lifecycle sentence to add");
}

import assert from "node:assert/strict";

import { STEP_DEFINITIONS, stepFieldsTotal } from "../src/lib/automated-payroll/step-definitions.ts";
import { computeJoinerPay } from "../src/lib/payroll/copilot/proration.ts";

/**
 * Guards the net figures on the New hires step.
 *
 * A joiner's card used to show only what he is paid THIS month, so there was
 * nothing on screen to check that figure against — the reviewer had to trust the
 * proration. The owner asked for the full month beside it (2026-08-29), which
 * makes the arithmetic verifiable at a glance: Full Month Net / calendar days x
 * Days Worked = what he is paid this month.
 *
 * Later the same day he asked for the paid figure to be a LIVE total of the
 * three boxes he edits, and for the old server-computed "This Month Net" column
 * to be removed. This test now pins both halves of that shape:
 *
 *  1. "Full Month Net" is present, currency-formatted, and reuses the SAME
 *     context key every other step uses for a full month's net. One name per
 *     number, or recommend.ts, the xlsx template and the grid drift apart.
 *  2. The retired "This Month Net" / "Net (month)" context column STAYS retired.
 *     It was a context value — computed once on the server, never recomputed as
 *     HR types — so it froze at the loaded figure and stopped agreeing with the
 *     boxes the moment one was edited. Two lines showing the same quantity, one
 *     of them silently stale, is worse than one line that is always right.
 *  3. The two figures still RECONCILE: full / calendar-days x days worked is
 *     what the card's live total shows. If that ever stops holding, showing the
 *     full month stops being a check and becomes a second number that disagrees.
 */
export function runAutomatedPayrollNewHireNetColumnsTests() {
  const definition = STEP_DEFINITIONS.p1_new_hires;
  const byKey = new Map(definition.contextColumns.map((column) => [column.key, column]));

  // ---- 1. the full-month column, saying which month it means -----------------

  const fullMonth = byKey.get("Net Salary");
  assert.ok(fullMonth, "New hires must show the FULL month's net — it is what makes the proration checkable");
  assert.equal(
    fullMonth.label,
    "Full Month Net",
    "the full-month column must SAY it is the full month — an unqualified 'Net' label is what made this screen unreadable",
  );
  assert.equal(fullMonth.money, true, "a salary on a payroll screen must be currency-formatted, not stringified raw");

  // Every other step that shows a full month's net calls it "Net Salary". The
  // New hires step must not invent a second key for the same quantity.
  const fullMonthKeyUsedElsewhere = Object.values(STEP_DEFINITIONS).some(
    (step) => step.key !== "p1_new_hires" && step.contextColumns.some((column) => column.key === "Net Salary"),
  );
  assert.ok(
    fullMonthKeyUsedElsewhere,
    "'Net Salary' is the established context key for a full month's net — if that changed, this step must follow it, not fork",
  );

  // ---- 2. the retired stale column stays retired ----------------------------

  assert.equal(
    byKey.get("Net (month)"),
    undefined,
    "the 'This Month Net' context column was removed on the owner's instruction — a context value cannot follow an edit, " +
      "so it would sit beside the live total showing a different number the moment anyone typed",
  );
  for (const column of definition.contextColumns) {
    assert.notEqual(
      column.label,
      "This Month Net",
      "the retired label must not reappear under another key — the problem was the stale VALUE, not the wording",
    );
    assert.notEqual(
      column.label,
      "Net (month)",
      "the original label is ambiguous too: it reads as both 'his monthly salary' and 'what he gets this month'",
    );
  }

  // Exactly one line on the card may claim to be this month's pay, and it is the
  // live one. Anything else is a second source of truth for the same money.
  assert.equal(
    definition.fieldsTotal?.label,
    "Total (month)",
    "with the context column gone, the live total is the ONLY figure showing what a joiner is paid this month",
  );

  // ---- 3. the full month and the paid total reconcile -----------------------

  // Base / ECoL / Fuel of a real August joiner, plus hire days spanning the
  // retired 15th/16th cliff and both month ends.
  const baseSalary = 16_000;
  const extraCostOfLiving = 1_500;
  const fuelAllowance = 500;
  const fullMonthNet = baseSalary + extraCostOfLiving + fuelAllowance;
  const daysInAugust = 31;

  for (const hireDay of [1, 2, 8, 15, 16, 24, 30, 31]) {
    const joiner = computeJoinerPay({
      baseSalary,
      extraCostOfLiving,
      fuelAllowance,
      hireDate: `2026-08-${String(hireDay).padStart(2, "0")}`,
      period: { month: 8, year: 2026 },
    });
    assert.ok(joiner, `hire day ${hireDay} must produce joiner pay`);

    // Read through the SAME helper the card and the xlsx use, so this reconciles
    // what is actually on screen rather than a parallel sum written here.
    const shownThisMonth = stepFieldsTotal(definition, {
      baseForMonth: joiner.baseForMonth,
      ecolPaid: joiner.ecolPaid,
      fuelPaid: joiner.fuelPaid,
    });
    const impliedByFullMonth = (fullMonthNet / daysInAugust) * joiner.daysWorked;

    // Within two piastres: the engine rounds each of the three components
    // separately (so a row's parts always add up to its own total), while the
    // full-month check above rounds once. That gap is by design and tiny — but
    // it must never grow into a difference a reader would notice.
    assert.ok(
      Math.abs(shownThisMonth - impliedByFullMonth) <= 0.02,
      `hire day ${hireDay}: the two figures must reconcile — card shows ${shownThisMonth.toFixed(2)} but ` +
        `${fullMonthNet} / ${daysInAugust} x ${joiner.daysWorked} = ${impliedByFullMonth.toFixed(2)}`,
    );
  }

  // The whole point of showing the full month: it must never equal a part month.
  const partMonth = computeJoinerPay({
    baseSalary,
    extraCostOfLiving,
    fuelAllowance,
    hireDate: "2026-08-24",
    period: { month: 8, year: 2026 },
  });
  assert.ok(partMonth);
  assert.ok(
    partMonth.baseForMonth + partMonth.ecolPaid + partMonth.fuelPaid < fullMonthNet,
    "a mid-month joiner's month must be less than his full month, or the two figures are showing the same thing twice",
  );
}

import assert from "node:assert/strict";

import { STEP_DEFINITIONS } from "../src/lib/automated-payroll/step-definitions.ts";
import { computeJoinerPay } from "../src/lib/payroll/copilot/proration.ts";

/**
 * Guards the two net columns on the New hires step (owner request 2026-08-29:
 * "show me the full month's net salary AND this month's net salary").
 *
 * A joiner's card used to show only what he is paid THIS month, so there was
 * nothing on screen to check that figure against — the reviewer had to trust the
 * proration. Showing the full month beside it makes the arithmetic verifiable at
 * a glance, which is only true while three things hold:
 *
 *  1. BOTH columns are present, and their labels say WHICH month each one means.
 *     The old label was the bare "Net (month)", which reads equally well as "his
 *     monthly salary" and as "what he gets this month" — precisely the ambiguity
 *     this step existed to create.
 *  2. The full-month column reuses the SAME context key the other steps already
 *     use for a full month's net. One name per number, or recommend.ts, the xlsx
 *     template and the grid drift apart silently.
 *  3. The two figures actually RECONCILE: full / calendar-days x days worked is
 *     this month's figure. If that ever stops holding, showing them side by side
 *     stops being a check and starts being two numbers that disagree on screen.
 */
export function runAutomatedPayrollNewHireNetColumnsTests() {
  const definition = STEP_DEFINITIONS.p1_new_hires;
  const byKey = new Map(definition.contextColumns.map((column) => [column.key, column]));

  // ---- 1. both columns exist, money-formatted, and say which month they mean --

  const fullMonth = byKey.get("Net Salary");
  const thisMonth = byKey.get("Net (month)");

  assert.ok(fullMonth, "New hires must show the FULL month's net — the owner asked for it beside the prorated figure");
  assert.ok(thisMonth, "New hires must still show THIS month's prorated net");

  assert.equal(
    fullMonth.label,
    "Full Month Net",
    "the full-month column must SAY it is the full month — an unqualified 'Net' label is what made this screen unreadable",
  );
  assert.equal(
    thisMonth.label,
    "This Month Net",
    "the prorated column must SAY it is this month — an unqualified 'Net' label is what made this screen unreadable",
  );

  assert.equal(fullMonth.money, true, "a salary on a payroll screen must be currency-formatted, not stringified raw");
  assert.equal(thisMonth.money, true, "a salary on a payroll screen must be currency-formatted, not stringified raw");

  assert.notEqual(
    fullMonth.label,
    thisMonth.label,
    "two net columns with the same label is worse than one column — the reader cannot tell which is which",
  );
  for (const column of [fullMonth, thisMonth]) {
    assert.notEqual(
      column.label,
      "Net (month)",
      "the retired label is ambiguous: it reads as both 'his monthly salary' and 'what he gets this month'",
    );
  }

  // ---- 2. one name per number ------------------------------------------------

  // Every other step that shows a full month's net calls it "Net Salary". The
  // New hires step must not invent a second key for the same quantity.
  const fullMonthKeyUsedElsewhere = Object.values(STEP_DEFINITIONS).some(
    (step) => step.key !== "p1_new_hires" && step.contextColumns.some((column) => column.key === "Net Salary"),
  );
  assert.ok(
    fullMonthKeyUsedElsewhere,
    "'Net Salary' is the established context key for a full month's net — if that changed, this step must follow it, not fork",
  );

  // ---- 3. the two figures reconcile -----------------------------------------

  // Base / ECoL / Fuel of a real August joiner (Yasmine El Safoury, HR-009),
  // plus hire days spanning the retired 15th/16th cliff and both month ends.
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

    const shownThisMonth = joiner.baseForMonth + joiner.ecolPaid + joiner.fuelPaid;
    const impliedByFullMonth = (fullMonthNet / daysInAugust) * joiner.daysWorked;

    // Within two piastres: the engine rounds each of the three components
    // separately (so a row's parts always add up to its own total), while the
    // full-month check above rounds once. That gap is by design and tiny — but
    // it must never grow into a difference a reader would notice.
    assert.ok(
      Math.abs(shownThisMonth - impliedByFullMonth) <= 0.02,
      `hire day ${hireDay}: the two columns must reconcile — screen shows ${shownThisMonth.toFixed(2)} but ` +
        `${fullMonthNet} / ${daysInAugust} x ${joiner.daysWorked} = ${impliedByFullMonth.toFixed(2)}`,
    );
  }

  // The whole point of showing both: a full month must never equal a part month.
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
    "a mid-month joiner's month must be less than his full month, or the two columns are showing the same thing twice",
  );
}

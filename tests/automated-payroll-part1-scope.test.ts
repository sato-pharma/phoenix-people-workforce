import assert from "node:assert/strict";

import { isAfterPeriod, isSettledInPart1 } from "../src/lib/automated-payroll/recommend.ts";
import { normalizePayrollPaymentMode } from "../src/lib/payroll/policy.ts";
import { PART1_STEP_KEYS, PART2_STEP_KEYS, type StepRow } from "../src/lib/automated-payroll/types.ts";
import { STEP_DEFINITIONS, STEP_ORDER } from "../src/lib/automated-payroll/step-definitions.ts";
import {
  enteredOnThisStepAmount,
  hasDoubleDeductionConflict,
  settledElsewhereAmount,
} from "../src/lib/automated-payroll/conflicts.ts";

/**
 * Guards the Part 1 / Part 2 split rule (owner-decided 2026-07-25).
 *
 * CRM and unpaid vacation are deductible in two different places: the Part 1
 * manual tabs (p1_crm / p1_unpaid_vacation) and the Part 2 auto steps (p2_crm /
 * p2_vacation). They write to DIFFERENT draft columns (p1od_crm_value vs crm) and
 * assemble.ts sums BOTH into the deduction total — so if the same employee ever
 * appears in both populations, they get deducted twice for the same days (or, once
 * their Second Part clamps to 0, the excess is silently stranded in
 * overpaidResidual, which nothing carries forward).
 *
 * `isSettledInPart1` is the one predicate that keeps the two populations disjoint,
 * used in both directions. These tests pin that behaviour so a future edit to one
 * call site without the other fails here instead of in a live payroll run.
 */
export function runAutomatedPayrollPart1ScopeTests() {
  const leaver = { lifecycle: "leaver" as const };
  const joiner = { lifecycle: "joiner" as const };
  const regular = { lifecycle: "regular" as const };
  const onePart = { paymentMode: "one_part" as const };
  const twoParts = { paymentMode: "two_parts" as const };

  // ---- leavers are always settled in Part 1, whatever their payment mode -----
  // They are gone before Part 2 runs; the Resignations step computes their CRM +
  // unpaid vacation instead.
  assert.equal(isSettledInPart1(leaver, twoParts), true);
  assert.equal(isSettledInPart1(leaver, onePart), true);
  assert.equal(isSettledInPart1(leaver, undefined), true);

  // ---- one-part employees are settled in Part 1 regardless of lifecycle ------
  // A Part-2 deduction cannot land for them: they have no meaningful Second Part
  // to net it against.
  assert.equal(isSettledInPart1(regular, onePart), true);
  assert.equal(isSettledInPart1(joiner, onePart), true);

  // ---- continuing two-part employees are NOT settled in Part 1 --------------
  // They keep the automatic Part 2 CRM / Vacation treatment.
  assert.equal(isSettledInPart1(regular, twoParts), false);
  assert.equal(isSettledInPart1(joiner, twoParts), false);

  // ---- a missing salary source must NOT drag a continuing employee into Part 1
  // (paymentMode is only "one_part" when explicitly set; the module's own
  // normalizer defaults everything else to two_parts, and 19 production
  // employees currently carry a null payment_mode).
  assert.equal(isSettledInPart1(regular, undefined), false);
  assert.equal(isSettledInPart1(regular, { paymentMode: normalizePayrollPaymentMode(null) }), false);
  assert.equal(isSettledInPart1(regular, { paymentMode: normalizePayrollPaymentMode("") }), false);

  // ---- the four Part 1 manual deduction tabs all exist and sit in Part 1 -----
  // (each is scoped by isSettledInPart1 inside recommend.ts)
  const part1ManualTabs = ["p1_crm", "p1_unpaid_vacation", "p1_no_record", "p1_other_deductions"] as const;
  for (const key of part1ManualTabs) {
    assert.equal(STEP_DEFINITIONS[key].phase, "part1", `${key} must be a Part 1 step`);
    assert.equal(PART1_STEP_KEYS.includes(key), true, `${key} missing from PART1_STEP_KEYS`);
  }

  // ---- each category lives in exactly ONE tab, so no single tab can write two
  // categories that another tab also writes -----------------------------------
  const fieldOwners = new Map<string, string>();
  for (const key of part1ManualTabs) {
    for (const field of STEP_DEFINITIONS[key].fields) {
      assert.equal(
        fieldOwners.has(field.key),
        false,
        `field ${field.key} appears in both ${fieldOwners.get(field.key)} and ${key}`,
      );
      fieldOwners.set(field.key, key);
    }
  }
  // CRM / Vacation / No-Record are single-category tabs; Loan+Other carries two.
  assert.equal(STEP_DEFINITIONS.p1_crm.fields.length, 3);
  assert.equal(STEP_DEFINITIONS.p1_unpaid_vacation.fields.length, 3);
  assert.equal(STEP_DEFINITIONS.p1_no_record.fields.length, 3);
  assert.equal(STEP_DEFINITIONS.p1_other_deductions.fields.length, 6);

  // ---- the Part 2 twins still exist and stay in Part 2 ----------------------
  for (const key of ["p2_crm", "p2_vacation"] as const) {
    assert.equal(STEP_DEFINITIONS[key].phase, "part2", `${key} must be a Part 2 step`);
    assert.equal(PART2_STEP_KEYS.includes(key), true, `${key} missing from PART2_STEP_KEYS`);
  }

  // ---- STEP_ORDER stays in sync with the phase key lists -------------------
  assert.deepEqual(STEP_ORDER, [...PART1_STEP_KEYS, ...PART2_STEP_KEYS]);

  // ---- double-deduction WARNING wiring (owner decision 2026-07-25: warn, don't
  // block). Leavers keep their auto-computed CRM + unpaid vacation on the
  // Resignations step (columns `crm` / `unpaidVacations`) AND appear in these two
  // manual tabs (columns `p1od*`). assemble.ts sums both, so the wizard must warn
  // when a row carries a value in both places. ------------------------------
  for (const key of ["p1_crm", "p1_unpaid_vacation"] as const) {
    const definition = STEP_DEFINITIONS[key];
    assert.equal(
      definition.conflictContextKey,
      "Settled in Resignations",
      `${key} must declare the double-deduction warning key`,
    );
    // The key MUST name a real context column — a typo here silently disables the
    // warning (the lookup just yields undefined and every row looks clean).
    assert.equal(
      definition.contextColumns.some((column) => column.key === definition.conflictContextKey),
      true,
      `${key}.conflictContextKey does not match any of its contextColumns`,
    );
  }

  // ---- the other two Part 1 tabs have no counterpart anywhere else, so they
  // must NOT claim a conflict key (a false warning is its own kind of noise) --
  for (const key of ["p1_no_record", "p1_other_deductions"] as const) {
    assert.equal(
      STEP_DEFINITIONS[key].conflictContextKey,
      undefined,
      `${key} has no deduction twin and must not declare a conflict key`,
    );
  }

  // ---- the warning rule itself, exercised on a REAL production shape: leaver
  // B-176 carries 2,903 EGP of CRM already settled on the Resignations step
  // (verified live against the July 2026 run on 2026-07-25) -------------------
  const crmStep = STEP_DEFINITIONS.p1_crm;
  const leaverRow = (crmValue: number): StepRow => ({
    hrId: "B-176",
    fullName: "Eman Essam Arafa Attia Mohamed",
    jobTitle: null,
    line: null,
    context: { "Hire Date": "", "Base Salary": 8709, "Settled in Resignations": 2903 },
    values: { p1odCrmDays: 0, p1odCrmValue: crmValue },
    recommended: { p1odCrmDays: 0, p1odCrmValue: 0 },
    reasons: { p1odCrmReason: "" },
    reason: null,
    onHold: false,
    lifecycle: "leaver",
  });

  // Untouched (the default) — informational only, no warning.
  assert.equal(hasDoubleDeductionConflict(crmStep, leaverRow(0)), false);
  assert.equal(settledElsewhereAmount(crmStep, leaverRow(0)), 2903);
  assert.equal(enteredOnThisStepAmount(crmStep, leaverRow(0)), 0);

  // HR types a value on top of the already-settled amount → warn.
  assert.equal(hasDoubleDeductionConflict(crmStep, leaverRow(500)), true);
  assert.equal(enteredOnThisStepAmount(crmStep, leaverRow(500)), 500);

  // A negative entry REDUCES the deduction rather than stacking a second one, so it
  // deliberately does not warn (the guard is about adding on top, not any edit).
  assert.equal(hasDoubleDeductionConflict(crmStep, leaverRow(-100)), false);

  // ---- an employee with nothing settled elsewhere never warns, however much
  // they have entered here (e.g. every one-part employee) --------------------
  const onePartRow: StepRow = {
    ...leaverRow(4000),
    hrId: "A-12",
    lifecycle: "regular",
    context: { "Hire Date": "", "Base Salary": 13000, "Settled in Resignations": 0 },
  };
  assert.equal(settledElsewhereAmount(crmStep, onePartRow), 0);
  assert.equal(hasDoubleDeductionConflict(crmStep, onePartRow), false);

  // ---- a step with no conflict key never warns, whatever its context holds --
  const noRecordStep = STEP_DEFINITIONS.p1_no_record;
  assert.equal(settledElsewhereAmount(noRecordStep, leaverRow(500)), 0);
  assert.equal(hasDoubleDeductionConflict(noRecordStep, leaverRow(500)), false);

  // ---- "Resignation Date" column, so a leaver showing up in a Part 1 manual
  // tab is legible (owner request 2026-07-25) ---------------------------------
  for (const key of part1ManualTabs) {
    assert.equal(
      STEP_DEFINITIONS[key].contextColumns.some((column) => column.key === "Resignation Date"),
      true,
      `${key} must show the Resignation Date context column`,
    );
  }

  // ---- Resignations' CRM Days auto-calculates its Value (same formula the leaver's
  // own system-recommended crm figure already uses) — safe to auto-calc. Unpaid
  // Vacation Days deliberately does NOT: that figure is a composite (balance-aware
  // Phoenix amount + a separate CRM-leave amount), not a flat day rate, so
  // auto-calculating it from a single day count would be mathematically wrong. -----
  const resignationsStep = STEP_DEFINITIONS.p1_resignations;
  const crmDaysField = resignationsStep.fields.find((field) => field.key === "resignationCrmDays");
  assert.equal(crmDaysField?.kind, "days");
  assert.equal(crmDaysField?.autoCalcMoneyKey, "crm");
  assert.equal(
    resignationsStep.fields.some((field) => field.kind === "days" && field.autoCalcMoneyKey === "unpaidVacations"),
    false,
    "Unpaid Vacation must never auto-calculate from a day count — see comment above",
  );
  assert.equal(
    resignationsStep.contextColumns.some((column) => column.key === "Unpaid Vacation Days"),
    true,
    "Unpaid Vacation Days stays a read-only context column, not an editable field",
  );

  // ---- notice-period employees must not vanish from earlier months (owner-confirmed
  // real bug, 2026-07-25 — B-157 Sameh Ahmed Ezzat Mohamed Hussien: employment_status
  // already "resigned" but last_working_date=2026-08-31, a full month after the July
  // run being processed). isAfterPeriod is the one predicate that tells "already
  // departed before this period" apart from "departing later, still owed this
  // period's pay" — resolvePayrollPopulationAndSources uses it alongside
  // isPayrollIneligibleEmployee so a terminal status alone can never wrongly exclude
  // someone still actively working through a future exit. -----------------------
  const july = { month: 7, year: 2026 };
  // Sameh's real shape: still active through August, for the July run.
  assert.equal(isAfterPeriod("2026-08-31", july), true);
  // An employee who already left in an EARLIER month must stay excluded.
  assert.equal(isAfterPeriod("2026-06-30", july), false);
  // A leaver exiting THIS SAME month is handled by the leaver path, not this one —
  // isAfterPeriod itself must say false so isPayrollIneligibleEmployee still applies
  // (that employee is included via isLeaver instead, never via this predicate).
  assert.equal(isAfterPeriod("2026-07-31", july), false);
  // Across a year boundary: exiting January next year is still "after" December.
  assert.equal(isAfterPeriod("2027-01-15", { month: 12, year: 2026 }), true);
  // No date at all (still actively employed, no resignation on file) — never "after."
  assert.equal(isAfterPeriod(null, july), false);
}

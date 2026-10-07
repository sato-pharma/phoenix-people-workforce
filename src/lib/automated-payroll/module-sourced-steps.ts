import { stepDefinition } from "./step-definitions.ts";
import { PART1_STEP_KEYS, type StepKey } from "./types.ts";

// Browser-safe on purpose: the wizard imports this, so nothing here may reach the database client.
// module-drift.ts re-exports MODULE_SOURCED_STEP_KEYS for the server side.

/**
 * The steps whose figures come from the Deductions module.
 *
 * Exactly the ones that call `loadConfirmedDeductions` in recommend.ts. Every other step proposes
 * from the employee master or from the run itself, and neither can change behind the run's back in
 * the way this check exists to catch.
 */
export const MODULE_SOURCED_STEP_KEYS: readonly StepKey[] = [
  "p1_fingerprint",
  "p1_crm",
  "p1_resignation_crm",
  "p1_unpaid_vacation",
  "p1_other_deductions",
  "p2_vacation",
  "p2_crm",
  "p2_manual_deductions",
];

/**
 * The Part 1 steps the Deductions module feeds that are NOT confirmed — read while the run is in
 * Part 2, so every one of them was confirmed once and has been re-opened since.
 *
 * OWNER DECISION, 2026-10-07: Part 2 may not be confirmed while one of these is open. A deduction
 * decision made after Part 1 was confirmed re-opens the step that carries it and CLEARS that
 * employee's frozen figure (deduction-resync.ts); assemble.ts reads a cleared figure as 0.00, so
 * confirming Part 2 then would pay the month without that deduction. Part 2's own gate counted only
 * the Part 2 steps, and `getModuleDrift` reads only confirmed steps, so neither could see it. On the
 * live September 2026 run, "Fingerprint deductions" and "Unpaid Vacation" were both re-opened this way
 * the morning the owner was working through Part 2.
 *
 * The remedy is to confirm the named step again, and the wizard keeps exactly these steps open for
 * that while the run is in Part 2 (`stepOpenDuringPart2`). Part 2 is the whole month minus the frozen
 * first instalment, so for anyone paid in two parts the re-confirmed figure lands in Part 2. For anyone
 * whose whole month was frozen into Part 1 (one-part pay, most leavers) Part 2 cannot go below zero, so
 * the deduction becomes an overpayment that Part 2's overpaid gate asks HR to accept and carries
 * forward (split.ts) — the message says so. Never "Unconfirm Part 1", which re-freezes the first
 * instalment the bank already paid and loses the deduction.
 */
export function reopenedPart1DeductionSteps(
  states: ReadonlyArray<{ stepKey: StepKey; status: string }>,
): StepKey[] {
  const confirmed = new Set(states.filter((state) => state.status === "confirmed").map((state) => state.stepKey));
  return MODULE_SOURCED_STEP_KEYS.filter((stepKey) => PART1_STEP_KEYS.includes(stepKey) && !confirmed.has(stepKey));
}

/**
 * Whether the wizard lets HR save and confirm a Part 1 step while the run is in Part 2: only a step
 * `reopenedPart1DeductionSteps` names, so the block Part 2 raises always has a button that clears it.
 * Every other Part 1 step stays locked once Part 1 is confirmed.
 */
export function stepOpenDuringPart2(
  stepKey: StepKey,
  states: ReadonlyArray<{ stepKey: StepKey; status: string }>,
): boolean {
  return reopenedPart1DeductionSteps(states).includes(stepKey);
}

/** The Part 2 confirm's refusal while a Part 1 deduction step is open again. */
export function describeReopenedPart1Block(stepKeys: readonly StepKey[]): string {
  const titles = stepKeys.map((stepKey) => `"${stepDefinition(stepKey).title}"`);
  const named = titles.length > 1 ? `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}` : titles[0];
  const many = stepKeys.length > 1;
  return (
    `${named} ${many ? "are" : "is"} open again in Part 1 — a deduction decision since Part 1 was confirmed ` +
    `re-opened ${many ? "them" : "it"}, and until ${many ? "they are" : "it is"} confirmed again this sheet leaves ` +
    `that deduction out. Open ${many ? "each one" : "it"} in Part 1 and confirm it again (it stays editable while ` +
    "Part 2 is open), then confirm Part 2. Anyone whose whole month was paid in Part 1 will then show as " +
    "overpaid by that deduction, and Part 2 asks you to accept it before it confirms."
  );
}

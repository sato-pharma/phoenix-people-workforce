import { stepDefinition } from "./step-definitions.ts";
import { PART1_STEP_KEYS, type StepKey } from "./types.ts";

// Browser-safe on purpose: the wizard imports this, so nothing here may reach the database client.
// module-drift.ts re-exports MODULE_SOURCED_STEP_KEYS and isUnbackedCharge for the server side.

/**
 * A charge with NO approved deduction behind a piastre of it: the Deductions module proposed 0.00
 * when the step was confirmed and proposes 0.00 now, yet the run is charging real money.
 *
 * Both sides of the drift comparison being equal is exactly what hid this until 2026-10-09 — see
 * the long note at the comparison in module-drift.ts for the 3,331.00 EGP it cost on the live
 * September 2026 run. Lives here, and takes the three figures structurally rather than a
 * `ModuleDriftRow`, so the wizard can ask the same question without importing the server file.
 */
export function isUnbackedCharge(row: {
  proposedAtConfirm: number;
  proposedNow: number;
  charged: number;
}): boolean {
  return row.proposedNow === 0 && row.proposedAtConfirm === 0 && row.charged > 0;
}

/** A step field's own spec, or undefined for a key no step column declares. */
function fieldSpec(stepKey: StepKey, field: string) {
  return stepDefinition(stepKey).fields.find((spec) => spec.key === field);
}

/**
 * Whether the drift check may compare this field at all.
 *
 * 🔴 A `notPersisted` FIELD HAS NO COLUMN ON THE DRAFT ROW, SO IT CHARGES NOTHING — and comparing
 * it reports money that does not exist. `charged` reads the draft, finds no column, and is 0.00 for
 * ever, while the recommendation is a real number; the row then looks like a figure the module moved
 * and nobody chose, which is exactly what blocks the Part 2 confirm.
 *
 * It is worse than a stray row, because all five such fields are DISPLAY COMPLEMENTS of the money
 * beside them — `p1odCrmWorkingDays` is `days in month − chargeable days`, `resigCrmWorkingDays` is
 * `days worked − non-working days`. The "drift" is therefore LARGEST when nothing at all is wrong:
 * an employee with no CRM deduction proposes 30 working days, charges nothing, and blocks the month.
 *
 * Measured on the live September 2026 run, 2026-10-09: all 11 rows blocking the Part 2 confirm were
 * working-days fields — Magdy El Senosey (AI-0008), Reham Elwiy (OF-0004), Ahmed Abdallah (B-58),
 * Ayman El Salhy (B-96), Mohamed Elawadi (B-115) and six more, every one of them "set to 0.00 and
 * the Deductions module now says 30.00", with 0.00 of money among them. Each was absent from the
 * step's snapshot (`p1_crm` was confirmed on 24 September carrying 15 people, and the one-part
 * population grew afterwards), so the working-days complement compared 0 against 30 — and no
 * re-confirm could ever settle it, because the field has no column to write the 30 into.
 *
 * An unrecognised key is still compared — the conservative direction, and no recommendation emits
 * one today.
 */
export function isDriftComparableField(stepKey: StepKey, field: string): boolean {
  return fieldSpec(stepKey, field)?.notPersisted !== true;
}

/** The steps that ADD money rather than charge it. Among the module-sourced steps, only Additions. */
const MONEY_ADDING_STEP_KEYS: readonly StepKey[] = ["p2_additions"];

/**
 * Whether an UNBACKED CHARGE can exist on this field — a charge with no approved deduction behind
 * it, which only means something where the field is a charge and a deduction is what fills it.
 *
 * 🔴 MONEY ONLY. The day counts beside the money are inputs, not charges, and several are recommended
 * as a hard-coded 0 whatever the module says (`p1odVacationDays`, `p1odLoanDays`, `p1odOtherDays`).
 * A day count HR typed therefore read as "2.00 with no approved deduction behind it", which inside a
 * sentence about money reads as 2 EGP. The money field beside it carries the charge and is the one
 * worth reporting.
 *
 * 🔴 AND NEVER ON ADDITIONS, WHICH PAY MONEY RATHER THAN CHARGE IT. No approved deduction could ever
 * stand behind an Incentive, a Bonus or Overtime, so the question has no answer there and the finding
 * is noise written in deduction wording. `overtime` is recommended as a literal 0 for everybody
 * (`recommendAdditions` in recommend.ts), so EVERY overtime HR enters tripped it.
 *
 * Measured on the live September 2026 run, 2026-10-09: all 5 unbacked rows were Additions — 65,947.00
 * of money being PAID, reported as charges with no deduction behind them. Ali Elsayed (A-12)
 * 60,000.00 Incentive; Hanan Hassan (AI-0012) 2,133.00 Overtime; Khaled elkamry (B-170) 1,548.00
 * Other additions; Adel Srour (CN-0006) 1,266.00 Overtime; Aya Salam (B-7) 1,000.00 Overtime.
 *
 * Additions stay in `MODULE_SOURCED_STEP_KEYS` regardless: a dispute refund the Dispute Center gives
 * back can still go stale, and that drift must still block (owner, 2026-10-09).
 */
export function canBeUnbackedCharge(stepKey: StepKey, field: string): boolean {
  if (MONEY_ADDING_STEP_KEYS.includes(stepKey)) return false;
  return fieldSpec(stepKey, field)?.kind === "money";
}

/**
 * The steps whose figures come from a module OUTSIDE the run — the ones that can change behind the
 * run's back, which is the whole reason the drift check exists.
 *
 * Exactly the steps that call `loadConfirmedDeductions` or `loadDisputeRefunds` in recommend.ts.
 * Every other step proposes from the employee master or from the run itself.
 *
 * 🔴 `p2_additions` IS ONE OF THEM (owner, 2026-10-09 — a deduction a reopened dispute gives back
 * after its month was already paid lands in Additions → Other additions). Its feeder is the Dispute
 * Center rather than Deductions, and leaving it off this list made that refund unpayable in the
 * commonest order of work: `confirmStep` persists EVERY visible row, so the first Additions confirm
 * wrote `other_additions = 0.00` for the whole population, `pick` in recommend.ts then preferred
 * that saved zero over the feeder for ever, and a refund recommended afterwards could never appear
 * on the step, in the drift report or in the Part 2 gate — the money was owed and nothing could pay
 * it. On this list the confirm records what the feeder proposed at the time, so a zero nobody chose
 * is told apart from a figure HR typed: the refund swaps back in (`takeCurrentModuleFigures`), the
 * Part 2 confirm refuses while confirming would pay the month without it, and a save no longer
 * stamps an untouched 0.00 as somebody's own figure (saved-figures.ts).
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
  "p2_additions",
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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  additionsCandidatesFromStepRows,
  assertAdditionsReasonsPresent,
  normalizeAdditionsReason,
} from "../src/lib/automated-payroll/additions-reason.ts";
import { stepDefinition } from "../src/lib/automated-payroll/step-definitions.ts";
import { summarizeStep } from "../src/lib/automated-payroll/run-service.ts";
import type { StepRow } from "../src/lib/automated-payroll/types.ts";

/**
 * MONEY ADDED TO A PAYSLIP SAYS WHY, AND THE RECORD OF IT NAMES EVERY FIELD.
 *
 * FINDING 23. Additions is the only step in the wizard that ADDS money, and the only one with no
 * feeder behind it. Every other money step is pre-filled from somewhere a reader can go and check:
 * the Deductions module, the expense workflow, the CRM, the vacation ledger. Incentive, bonus and
 * overtime are typed. They were typed into a grid with no source, no reason, no upper limit and no
 * breakdown, and a 50,000 EGP bonus against one employee was accepted by the grid, by the route and
 * by the pre-flight validator, and reached the payslip.
 *
 * THE AUDIT TRAIL DID NOT CATCH IT EITHER, which is the half worth understanding. `summarizeStep`
 * totalled the FIRST field it found — Incentive on this step — so bonus and overtime left no trace
 * in any audit entry at all. Measured on the August run: the audit recorded an incentive total of
 * 5,442 across 120 employees while the same rows carried 2,258.00 of bonus and 1,000.00 of overtime
 * that no audit row mentioned. The step that adds money was the least auditable one in the wizard.
 *
 * WHAT IS DELIBERATELY NOT HERE: a cap. The audit asked for an upper limit too, and a limit is a
 * number only the owner can give. Refusing a payment over a threshold invented here would block a
 * legitimate one on a figure nobody agreed.
 */

function row(over: Partial<StepRow> & { hrId: string }): StepRow {
  return {
    values: {},
    recommended: {},
    context: {},
    ...over,
  } as StepRow;
}

export async function runAutomatedPayrollAdditionsRecordTests() {
  // ---- HEADLINE: a paid addition with no reason is refused -------------------------------------
  assert.throws(
    () =>
      assertAdditionsReasonsPresent([
        { hrId: "B-9", fullName: "Paid Person", total: 50_000, reason: null },
      ]),
    /Validation:[\s\S]*reason/,
    "money added to a payslip with nothing recording who asked for it must not confirm — this is " +
      "the one step with no feeder, so the reason is the only explanation that will ever exist",
  );

  const failure = (() => {
    try {
      assertAdditionsReasonsPresent([
        { hrId: "B-9", fullName: "Paid Person", total: 50_000, reason: null },
      ]);
      return null;
    } catch (error) {
      return error as Error;
    }
  })();
  assert.ok(failure);
  assert.match(failure.message, /B-9 \(Paid Person\): 50000\.00/, "it names the person AND the amount");

  // ---- Zero is not an addition, which is most of the sheet ---------------------------------------
  assert.doesNotThrow(() =>
    assertAdditionsReasonsPresent([{ hrId: "B-1", total: 0, reason: null }]),
  );
  assert.doesNotThrow(() =>
    assertAdditionsReasonsPresent([{ hrId: "B-2", total: 1200, reason: "Q3 incentive, agreed with the NSM" }]),
  );
  assert.throws(
    () => assertAdditionsReasonsPresent([{ hrId: "B-3", total: 500, reason: "   " }]),
    /Validation:/,
    "whitespace is not a reason — a blank that looks filled in is worse than an empty one",
  );

  assert.equal(normalizeAdditionsReason("  spaced  "), "spaced");
  assert.equal(normalizeAdditionsReason("   "), null);
  assert.equal(normalizeAdditionsReason(undefined), null);

  // ---- The total is all three fields, not just the first -----------------------------------------
  const candidates = additionsCandidatesFromStepRows([
    { hrId: "B-4", values: { incentive: 0, bonus: 2258, overtime: 1000 }, reason: null },
    { hrId: "B-5", values: { incentive: 5442, bonus: 0, overtime: 0 }, reason: "monthly incentive" },
    { hrId: "B-6", values: { incentive: 900, bonus: 0, overtime: 0 }, reason: null, readOnly: true },
  ]);
  assert.equal(candidates.length, 2, "a read-only row is never written, so it cannot block the step");
  assert.equal(
    candidates[0]?.total,
    3258,
    "bonus and overtime count towards the rule — judging on incentive alone is the exact blindness " +
      "that let 3,258 EGP reach August's payslips unrecorded",
  );
  assert.throws(
    () => assertAdditionsReasonsPresent(candidates),
    /B-4/,
    "so a row carrying only bonus and overtime is caught",
  );

  // ---- THE AUDIT RECORD NAMES EVERY FIELD --------------------------------------------------------
  // Asserted on what summarizeStep RETURNS, not on how it is written.
  const summary = summarizeStep("p2_additions", [
    row({ hrId: "B-4", values: { incentive: 0, bonus: 2258, overtime: 1000 } }),
    row({ hrId: "B-5", values: { incentive: 5442, bonus: 0, overtime: 0 } }),
  ]);
  assert.deepEqual(
    summary.fieldTotals,
    { incentive: 5442, bonus: 2258, overtime: 1000 },
    "every field the step writes must be in the audit row — the old summary recorded the 5,442 and " +
      "silently dropped the 3,258 beside it",
  );
  assert.equal(summary.employees, 2);
  assert.equal(summary.primaryField, "incentive", "the old keys keep their old meaning");
  assert.equal(summary.total, 5442, "so nothing reading an older audit row has to change its mind");

  // A hold step keeps its own shape.
  const holds = summarizeStep("p2_holds", [row({ hrId: "B-7", onHold: true }), row({ hrId: "B-8" })]);
  assert.deepEqual(holds, { employees: 2, held: 1 }, "the hold summary is unchanged");

  // ---- The step actually offers a reason box ------------------------------------------------------
  assert.equal(
    stepDefinition("p2_additions").hasReason,
    true,
    "the reason column is driven by the step definition — it feeds the grid, the xlsx template and " +
      "the xlsx parser, so without this the rule would refuse a confirm HR had no way to satisfy",
  );

  // ---- Wiring: the reason reaches its own column and the rule runs at confirm ----------------------
  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  assert.match(
    runService,
    /stepKey === "p2_additions" && edit\.reason !== undefined\)\s*\{\s*patch\.additionsReason = edit\.reason;/,
    "an addition's reason must land in its OWN column — sharing manual_reason would let a " +
      "deduction's reason read as an addition's, with nothing able to tell them apart",
  );
  assert.match(
    runService,
    /if \(stepKey === "p2_additions"\) \{\s*assertAdditionsReasonsPresent\(additionsCandidatesFromStepRows\(rows\)\);/,
    "and the rule must run at confirm, which is what locks the step",
  );

  // The column has to exist to be written to.
  const migration = readFileSync(
    "supabase/migrations/20260912030000_automated_payroll_additions_reason.sql",
    "utf8",
  );
  assert.match(migration, /add column if not exists additions_reason text/, "the column ships with it");

  const draftStore = readFileSync("src/lib/automated-payroll/draft-store.ts", "utf8");
  assert.match(draftStore, /additionsReason: \(row\.additions_reason/, "read back out");
  assert.match(draftStore, /db\.additions_reason = patch\.additionsReason/, "and written in");
}

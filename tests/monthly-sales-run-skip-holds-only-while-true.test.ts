import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  reconcileStepPatch,
  skipsContradictedByBatches,
  type MonthlySalesStep,
  type StepStatus,
} from "../src/lib/sales/monthly-sales-run.ts";
import { normalizeCodeKey } from "../src/lib/sales/normalizer/resolvers.ts";

/**
 * A SKIP HOLDS ONLY WHILE IT IS TRUE.
 *
 * SoS audit, confirmed high: "Skipped distributors count as done for the lock and can never be
 * un-skipped". Re-opening the wizard reconciled every step against the period's validated batches
 * EXCEPT a skipped one: `if (batch && status !== "skipped" && ...)`. Skip Pharma Overseas because its
 * file is not ready, upload and validate that file the next day, and its rows are in the closing
 * while the run still says "skipped" with no batch, forever. The Skip button is also offered on a
 * step that already has a validated file, and writing the skip dropped the batch from the step while
 * the batch's rows stayed in the closing. Either way the run log disagreed with the database, and the
 * lock could freeze it like that.
 *
 * A TRUE skip still counts as done for the lock and the figure: not every distributor uploads every
 * month (owner rule), and a skip with a reason is how the operator records it.
 *
 * Measured on production 2026-09-18: 3 runs (2026-04, 2026-05, 2026-07), 53 steps, 0 ever skipped,
 * no month locked. Nothing is wrong in the data today, so the fix is code only.
 */

const RUN_SRC = readFileSync(new URL("../src/lib/sales/monthly-sales-run.ts", import.meta.url), "utf8");

function step(distributorCode: string, distributorName: string, stepStatus: StepStatus): MonthlySalesStep {
  return {
    distributorCode,
    distributorName,
    stepStatus,
    skipReason: stepStatus === "skipped" ? "file not ready yet" : null,
    batchId: null,
    weight: 0,
    ordering: 0,
    batch: null,
  };
}

function sliceFunction(name: string): string {
  const start = RUN_SRC.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `expected ${name} in monthly-sales-run.ts`);
  const next = RUN_SRC.indexOf("\nexport ", start + 1);
  return RUN_SRC.slice(start, next === -1 ? undefined : next);
}

export function runMonthlySalesRunSkipHoldsOnlyWhileTrueTests() {
  // HEADLINE — Pharma Overseas was skipped, then its file was validated. Re-opening the wizard must
  // bring the step up to date: confirmed, carrying that batch, with the stale reason cleared.
  assert.deepEqual(
    reconcileStepPatch("skipped", null, { id: "batch-ps-2026-05" }),
    { step_status: "confirmed", batch_id: "batch-ps-2026-05", skip_reason: null },
    "a skipped step whose distributor now has a validated file must be confirmed with that file on the " +
      "next load — otherwise the run says the distributor is missing while its rows are in the closing, forever",
  );

  // A true skip stays a skip.
  assert.equal(reconcileStepPatch("skipped", null, undefined), null, "a skip with no validated file behind it is left alone");

  // The rest of the reconcile is unchanged.
  assert.deepEqual(reconcileStepPatch("pending", null, { id: "b1" }), {
    step_status: "confirmed",
    batch_id: "b1",
    skip_reason: null,
  });
  assert.equal(reconcileStepPatch("confirmed", "b1", { id: "b1" }), null, "a step already on its batch is not rewritten");
  assert.deepEqual(
    reconcileStepPatch("confirmed", "old", { id: "b2" }),
    { step_status: "confirmed", batch_id: "b2", skip_reason: null },
    "a re-uploaded file moves the step onto the new batch",
  );
  assert.deepEqual(
    reconcileStepPatch("confirmed", null, undefined),
    { step_status: "pending", batch_id: null },
    "a confirmed step whose batch was deleted goes back to pending, even though the FK already nulled batch_id",
  );

  // The re-entry loop uses it for every step, and only on a batch list it actually read.
  const startOrGetRun = sliceFunction("startOrGetRun");
  assert.ok(startOrGetRun.includes("if (validatedBatches.ok) {"), "the reconcile must stay gated on a successful read");
  assert.ok(startOrGetRun.includes("const patch = reconcileStepPatch("), "the re-entry loop must reconcile through reconcileStepPatch");
  assert.ok(!startOrGetRun.includes('status !== "skipped"'), "the re-entry loop must not pass over a skipped step");

  // The lock sees a skip its data has since contradicted, matching codes the way the module does.
  const validatedByCode = new Map([
    [normalizeCodeKey("ps"), { id: "batch-ps" }],
    [normalizeCodeKey("RM"), { id: "batch-rm" }],
  ]);
  const contradicted = skipsContradictedByBatches(
    [step("PS", "overseas", "skipped"), step("EG", "EGD", "skipped"), step("RM", "ramco", "confirmed")],
    validatedByCode,
  );
  assert.deepEqual(
    contradicted.map((s) => s.distributorName),
    ["overseas"],
    "only a SKIPPED step whose distributor has a validated file is contradicted; EGD, with no file, is a true skip",
  );

  const lockPeriod = sliceFunction("lockPeriod");
  assert.ok(
    lockPeriod.includes("skipsContradictedByBatches(run.steps, validatedByCode)"),
    "lockPeriod must refuse while a skipped step's file is in the closing",
  );
  assert.ok(
    lockPeriod.indexOf("skipsContradictedByBatches") < lockPeriod.indexOf('.from("monthly_sales_period_lock")'),
    "the check must run before the lock is written",
  );
  // A true skip still lets the month lock (owner rule: not every distributor uploads every month).
  assert.ok(lockPeriod.includes('s.stepStatus !== "confirmed" && s.stepStatus !== "skipped"'));

  // A skip can never be written over a validated file: the step would drop its batch while the rows
  // stay in the closing.
  const skipStep = sliceFunction("skipStep");
  assert.ok(skipStep.includes('"skip_contradicted"'), "skipStep must refuse a distributor whose file is validated");
  assert.ok(
    skipStep.indexOf("readValidatedBatchesOrThrow") < skipStep.indexOf("return updateStep("),
    "skipStep must read the period's validated files before it writes the skip",
  );

  // When the files cannot be read, neither a skip nor a lock goes ahead on a guess.
  assert.ok(RUN_SRC.includes('"batches_unavailable"'));
}

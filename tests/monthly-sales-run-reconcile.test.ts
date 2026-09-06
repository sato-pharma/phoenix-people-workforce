import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Monthly Sales run reconciliation, three defects that compounded on re-entry.
 *
 * `loadValidatedBatchesByCode` returned an EMPTY MAP when its query failed, and the reconcile loop
 * reads "this distributor has no batch" as "the batch was deleted — un-confirm the step". So one
 * transient error un-confirmed every confirmed distributor in the month and nulled every batch link,
 * silently, on the next wizard open.
 *
 * The branch that was supposed to catch a genuinely deleted batch could never fire: it required
 * `step.batch_id` to be truthy, but `monthly_sales_run_step_batch_id_fkey` is ON DELETE SET NULL
 * (verified on production), so deleting a batch had already nulled it. The branch was unreachable
 * for its real purpose and reachable only for the harmful one.
 *
 * And `updateStep` matched the distributor code case-sensitively while every other comparison in the
 * module normalises it, then never checked whether a row was hit — so a confirm or skip against a
 * differently-cased code updated nothing and returned the run with HTTP 200.
 */

const SRC = readFileSync(new URL("../src/lib/sales/monthly-sales-run.ts", import.meta.url), "utf8");

export function runMonthlySalesRunReconcileTests() {
  // 1. A failed read must be distinguishable from an empty period.
  assert.ok(
    SRC.includes("Promise<ValidatedBatches>"),
    "loadValidatedBatchesByCode must return a result that can say the read FAILED, not a bare Map",
  );
  assert.ok(
    SRC.includes("return { ok: false }"),
    "a failed batch query must report failure rather than an empty map that reads as 'no batches'",
  );

  // 2. Reconciliation must not run at all on a failed read — this is the destructive half.
  assert.ok(
    SRC.includes("if (validatedBatches.ok) {"),
    "the reconcile loop must be gated on having actually read the batch list",
  );

  // 3. The deleted-batch reset must be reachable. The FK is ON DELETE SET NULL, so requiring
  //    step.batch_id to be truthy is precisely what made it dead code.
  assert.ok(
    !SRC.includes("!batch && step.batch_id && status === \"confirmed\""),
    "the reset branch must not require step.batch_id — the FK has already nulled it, making it unreachable",
  );
  assert.ok(
    SRC.includes("} else if (!batch && status === \"confirmed\") {"),
    "a confirmed step whose batch no longer exists must reset, whether or not batch_id survived",
  );

  // 4. A step update must never be a silent no-op wearing a 200.
  assert.ok(
    SRC.includes("{ count: \"exact\" }"),
    "the step update must ask how many rows it changed",
  );
  assert.ok(
    SRC.includes("if (count === 0)"),
    "a zero-row update must raise, not return the run as though the change took",
  );

  // 5. The code must be resolved the way the rest of the module compares codes.
  assert.ok(
    SRC.includes("normalizeCodeKey(code) === wanted"),
    "updateStep must resolve the stored distributor code case-insensitively, like every other comparison here",
  );
  assert.ok(
    !SRC.includes(".eq(\"distributor_code\", distributorCode);"),
    "updateStep must not match the caller's raw, possibly differently-cased code directly",
  );
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  assertHoldReasonsPresent,
  holdCandidatesFromStepRows,
  resolveHoldReason,
} from "../src/lib/automated-payroll/hold-reason.ts";

/**
 * Confirming a hold step is the THIRD way a hold reaches `hold_reason`, and it
 * was the unguarded one.
 *
 * `saveStep` covers the two paths a hold is edited by — the inline grid and the
 * xlsx re-upload — and refuses a held row with no reason. `confirmStep` writes
 * too: it persists every row the step is showing, and `stepRowToPatch` carries
 * `onHold` and `reason` straight onto the draft row. So a hold nobody touched
 * this session was re-saved with an empty reason and the step locked, because
 * nothing counted as an "edit".
 *
 * That is the click that matters most. It is the last one before publish, and
 * `publishToPayslips` filters `!onHold` — a held row writes no salary_record and
 * no payslip, so once the run is published the reason is not merely missing, it
 * is unrecoverable. On 2026-09-06 the OPEN August 2026 run carried 13 held rows
 * and 13 blank reasons; 2 of them (B-156, B-3) are explained by July's rows and
 * are filled by carry-forward, and 11 have nothing anywhere to inherit.
 *
 * These pin the rule itself and, separately, the WIRING — that both persisting
 * paths actually call it. The rule being correct while a write path forgets to
 * call it is exactly the shape of the defect this file exists to catch.
 */

/**
 * One top-level declaration's source, sliced from its signature to the next
 * top-level `export`.
 *
 * Deliberately NOT a fixed byte window: those false-fail whenever the file
 * shifts, which is how a source-pinning test turns into noise and then gets
 * deleted. The slice is bounded by a positive control below — an unbounded one
 * would match the whole file and pass for the wrong reason.
 */
function declarationSource(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found in run-service.ts — the anchor moved, not the rule`);
  const end = source.indexOf("\nexport ", start + signature.length);
  return source.slice(start, end === -1 ? source.length : end);
}

export function runPayrollHoldConfirmStepReasonTests() {
  // ---- the rule, on the rows a confirmation is about to persist -----------
  // The headline: confirming a step that holds somebody with no reason is
  // refused, and "Validation:" is what jsonError turns into a 400.
  assert.throws(
    () =>
      assertHoldReasonsPresent(
        holdCandidatesFromStepRows([
          { hrId: "B-144", fullName: "Ahmed Fathy", onHold: true, reason: null },
          { hrId: "B-90", fullName: "Nour Hassan", onHold: false, reason: null },
        ]),
      ),
    /Validation:.*B-144 \(Ahmed Fathy\)/,
    "confirming a hold step with a reasonless hold is refused, naming who needs one",
  );

  assert.doesNotThrow(
    () =>
      assertHoldReasonsPresent(
        holdCandidatesFromStepRows([
          { hrId: "B-144", fullName: "Ahmed Fathy", onHold: true, reason: "Settled in cash, owner ruling 2026-08-28" },
          { hrId: "B-90", fullName: "Nour Hassan", onHold: false, reason: null },
        ]),
      ),
    "a hold step whose every hold carries a reason confirms normally",
  );

  // A continuation must confirm without retyping: recommendHolds resolves
  // carry-forward into row.reason before confirmStep ever sees the row, so the
  // two of August's thirteen that July explains are not a blocker.
  const carried = resolveHoldReason({
    onHold: true,
    storedReason: null,
    prior: { hrId: "B-156", reason: "Not paid through this system at all", month: 7, year: 2026 },
    priorMonthLabel: "July 2026",
  });
  assert.equal(carried.carriedForward, true, "precondition: this row's reason really is the inherited one");
  assert.doesNotThrow(
    () =>
      assertHoldReasonsPresent(
        holdCandidatesFromStepRows([{ hrId: "B-156", fullName: "Sara Samir", onHold: true, reason: carried.reason }]),
      ),
    "a hold explained by last month confirms without retyping — carry-forward satisfies the rule",
  );

  // ---- holdCandidatesFromStepRows: it must mirror what confirmStep writes --
  // confirmStep persists `rows.filter((row) => !row.readOnly)`. An informational
  // row is rendered and never written, so blocking a confirmation over one would
  // hold the step open for a reason no draft row would ever store.
  assert.deepEqual(
    holdCandidatesFromStepRows([
      { hrId: "B-77", fullName: "Omar Adel", onHold: true, reason: null, readOnly: true },
    ]),
    [],
    "a read-only row is excluded — confirmStep never persists it, so it cannot block the confirm",
  );

  assert.deepEqual(
    holdCandidatesFromStepRows([{ hrId: "B-144" }]),
    [{ hrId: "B-144", fullName: null, onHold: false, reason: null }],
    "an absent onHold defaults to NOT held — the rule is about holds, never about every row",
  );

  // ---- the wiring: both persisting paths call the rule --------------------
  // The rule being right is worth nothing if a write path does not call it,
  // which is the defect this file was written for.
  const runService = readFileSync(
    path.join(process.cwd(), "src", "lib", "automated-payroll", "run-service.ts"),
    "utf8",
  );

  const confirmStepSource = declarationSource(runService, "export async function confirmStep(");
  const saveStepSource = declarationSource(runService, "export async function saveStep(");

  // Positive control on the slicer itself: if the bound failed and either slice
  // ran to the end of the file, the two assertions below would pass no matter
  // what confirmStep and saveStep actually contain.
  assert.equal(
    confirmStepSource.includes("export async function saveStep("),
    false,
    "the confirmStep slice is bounded — an unbounded one would match anything and certify nothing",
  );
  assert.equal(
    saveStepSource.includes("export async function confirmStep("),
    false,
    "the saveStep slice is bounded too, for the same reason",
  );

  assert.match(
    confirmStepSource,
    /assertHoldReasonsPresent\(/,
    "confirmStep must enforce the hold reason — it persists onHold and reason straight onto the draft row, and it is the last write before publish drops the held rows",
  );
  assert.match(
    saveStepSource,
    /assertHoldReasonsPresent\(/,
    "saveStep must keep enforcing it — the inline grid and the xlsx re-upload both land here",
  );
}

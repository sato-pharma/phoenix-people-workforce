import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * A CRM VACATION BACKFILL BATCH MUST BE IDENTIFIABLE AND REVERSIBLE ON ITS OWN.
 *
 * `scripts/import-crm-vacation-backfill.ts` stamps `[CRM_BACKFILL_<date>]` into the notes of every
 * approved leave request it creates, and that stamp is the only handle on a batch afterwards: the
 * rows carry no run id, no job id and no batch table. Its own comment says it exists "so the whole
 * batch is identifiable and exactly reversible".
 *
 * THE DEFECT. The date was a hardcoded constant, `CRM_BACKFILL_2026-08-03`. The script ran twice —
 * 2026-08-03 and 2026-08-24 — so the second run's rows carry the FIRST run's date, and
 * `notes like '[CRM_BACKFILL_2026-08-03]%'` matches 260 rows spanning both batches. Reversing one
 * without the other is impossible, which is exactly what the marker was supposed to make possible.
 * A third run would have folded a third batch into the same bucket.
 *
 * THE FIX. `--marker <YYYY-MM-DD>` is required and validated. There is deliberately NO default:
 * a default would be silently accepted, and a batch marker nobody chose is the defect above. These
 * are source pins because the script is a one-off ops entry point with no importable surface — it
 * reads `process.argv` and runs at module scope — so there is nothing to call. Comments are
 * stripped, so this file's own account of the old constant cannot satisfy a match.
 */

function executableSource(): string {
  return stripComments(readFileSync("scripts/import-crm-vacation-backfill.ts", "utf8"));
}

export function runCrmVacationBackfillMarkerTests() {
  const code = executableSource();

  // ---- HEADLINE: the batch date is never a literal in the code -------------------------------
  assert.equal(
    /CRM_BACKFILL_\d{4}-\d{2}-\d{2}/.test(code),
    false,
    "the batch marker's DATE must never be hardcoded: two runs sharing one stamp cannot be told "
      + "apart, and 260 production rows from the 2026-08-03 and 2026-08-24 runs already carry the "
      + "same marker for that reason",
  );

  // ---- It comes from the command line, and it is REQUIRED ------------------------------------
  assert.ok(
    code.includes('readArg("--marker")'),
    "the batch marker must be read from --marker so each run stamps its own date",
  );
  assert.ok(
    /if\s*\(!markerDate\s*\|\|\s*!MARKER_PATTERN\.test\(markerDate\)\)/.test(code),
    "a missing OR malformed --marker must be refused before any row is read — an unvalidated marker "
      + "stamps a batch with something nobody chose",
  );
  assert.ok(
    code.includes("throw new Error("),
    "the refusal must throw rather than fall back to a default date",
  );

  // ---- No default may creep back in ----------------------------------------------------------
  assert.equal(
    /readArg\("--marker"\)\s*\?\?/.test(code) || /readArg\("--marker"\)\s*\|\|/.test(code),
    false,
    "--marker must have no fallback: a defaulted batch marker is indistinguishable from a chosen "
      + "one, which is precisely how the two existing batches became inseparable",
  );

  // ---- The stamp is still built from it, and still written into the notes ---------------------
  assert.ok(
    code.includes("const BATCH_MARKER = `CRM_BACKFILL_${markerDate}`"),
    "the stamp must be composed from the validated flag",
  );
  assert.ok(
    code.includes("[${BATCH_MARKER}]"),
    "every created row's notes must still carry the stamp — it is the only handle on the batch",
  );

  // ---- The row generator exists and reuses the rules rather than restating them ---------------
  // The input list used to be produced by hand outside the repository, which is why the working-day
  // rules behind the August batch cannot be re-read anywhere and why no September list existed.
  const builder = stripComments(readFileSync("scripts/build-crm-vacation-target-rows.ts", "utf8"));
  for (const reused of [
    "buildFieldWorkforceCompliancePreviewFromVisitsReport",
    "fieldWorkforceDeductionDayWeight",
    "isActiveLifecycleStatus",
  ]) {
    assert.ok(
      builder.includes(reused),
      `the target-row builder must reuse ${reused} rather than restate its rule — the CRM leave `
        + "detection, the Thursday half-day weight and the weekly-off policy each have exactly one home",
    );
  }
  assert.ok(
    builder.includes("holidayCalendarReachable") && builder.includes("throw new Error("),
    "the builder must refuse when the Egypt holiday calendar cannot be read: an unconfirmed holiday "
      + "would be imported as an ordinary leave day and taken off someone's balance (owner, 2026-09-16)",
  );

  console.log("  CRM vacation backfill marker: 10 assertions passed");
}

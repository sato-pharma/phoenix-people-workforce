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
 * THE DEFECT. The date was a hardcoded constant, and editing it before each run was a step someone
 * had to remember.
 *
 * 🔴 CORRECTED 2026-10-01. This note first said the two August runs shared one marker and could not
 * be separated. Measured on production the same day, that was WRONG: the batches are cleanly
 * disjoint — `[CRM_BACKFILL_2026-08-03]` 260 rows / 62 people, `[CRM_BACKFILL_2026-08-24]` 208 rows
 * / 66 people, `[CRM_BACKFILL_2026-10-01]` 61 rows / 31 people. The constant WAS edited before the
 * second run, so both August batches are reversible on their own.
 *
 * The defect that remains is that it was left reading `2026-08-03` in the committed file afterwards
 * — a stale value that looks deliberate. The September run would have inherited it and folded its
 * rows into a batch from two months earlier, silently. A required flag cannot be forgotten.
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
    "the batch marker's DATE must never be hardcoded: editing it before each run is a step someone "
      + "has to remember, and it was last left reading 2026-08-03, so the September run would have "
      + "folded its rows into a batch from two months earlier",
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
      + "one - a stale constant that happens to be correct for one run is not correct for the next",
  );

  // ---- TWO BATCHES CAN RUN ON ONE DAY, so the date alone cannot be the whole marker ----------
  // Found by this flag's own first use: the September 2026 import took [CRM_BACKFILL_2026-10-01]
  // and the August tail was authorised the same day. A date-only marker would have put 61 September
  // rows and 12 August rows in one bucket - the inseparability the flag exists to prevent,
  // reintroduced by the fix for it. An optional suffix separates same-day batches.
  const patternLine = code.match(/const MARKER_PATTERN = (\/.*\/);/);
  assert.ok(patternLine, "MARKER_PATTERN must stay a literal regex in the executable source");
  const pattern = new RegExp(patternLine![1].slice(1, -1));
  assert.ok(pattern.test("2026-10-01"), "a plain run date must still be accepted - one batch a day is the normal case");
  assert.ok(
    pattern.test("2026-10-01-aug"),
    "a suffixed marker must be accepted, or a second batch on the same day cannot be told from the first",
  );
  for (const bad of ["october", "2026-10-01-", "2026-10-01-AUG", "2026-1-1"]) {
    assert.equal(pattern.test(bad), false, `a malformed marker must be refused, got through: ${bad}`);
  }

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

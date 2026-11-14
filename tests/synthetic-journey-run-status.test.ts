import assert from "node:assert/strict";

import {
  computeOverallStatus,
  isSkippedOnPurpose,
  skippedOnPurposeNote,
  type JourneyStatusInput,
} from "../src/lib/synthetic-journeys/overall-status.ts";
import { declaredSkipReason } from "./synthetic/helpers/skip-reason.ts";

/**
 * The word a smoke run is filed under on the Synthetic Journeys page.
 *
 * Owner, 14 November 2026: a run where every check passes reads healthy. One check — the Outstation
 * Expenses export — skips itself every hour, on purpose, and until this rule that one skip made all
 * 936 clean runs since 9 September 2026 read warning. Amber is kept for a skip nobody chose.
 */

const EXPORT_REASON =
  "Downloading the export records that an administrator exported expenses, so an hourly run would record 24 exports a day that nobody made.";

const passed: JourneyStatusInput = { status: "passed" };
const failed: JourneyStatusInput = { status: "failed" };
const skippedOnPurpose: JourneyStatusInput = { status: "skipped", skipReason: EXPORT_REASON };
const skippedWithNoReason: JourneyStatusInput = { status: "skipped" };

/** The hourly production run as it stands: 14 checks pass and the export skips itself. */
const CLEAN_HOURLY_RUN: JourneyStatusInput[] = [...Array.from({ length: 14 }, () => passed), skippedOnPurpose];

export function runSyntheticJourneyRunStatusTests() {
  // ── The decision. Every check that ran passed, and the one that did not said why.
  assert.equal(
    computeOverallStatus(CLEAN_HOURLY_RUN),
    "healthy",
    "14 passed and the export skipped on purpose is a clean run — reading it as a warning made amber mean 'everything passed'",
  );
  assert.equal(computeOverallStatus([passed, passed]), "healthy", "a run with nothing skipped is healthy, as it always was");

  // ── Amber is kept for a skip nobody chose.
  assert.equal(
    computeOverallStatus([passed, skippedWithNoReason]),
    "warning",
    "a check skipped with no reason did not choose to be skipped — something stopped it running, and the run must not read healthy",
  );
  assert.equal(
    computeOverallStatus([...CLEAN_HOURLY_RUN, skippedWithNoReason]),
    "warning",
    "one unexplained skip is a warning however many deliberate ones sit beside it",
  );
  assert.equal(
    computeOverallStatus([passed, { status: "skipped", skipReason: "   " }]),
    "warning",
    "a blank reason is no reason",
  );
  assert.equal(
    computeOverallStatus([passed, { status: "skipped", skipReason: null }]),
    "warning",
    "a missing reason read back from storage is no reason",
  );

  // ── A deliberate skip never hides a failure, and never stands in for a check that passed.
  assert.equal(computeOverallStatus([passed, failed, skippedOnPurpose]), "failed", "a failed check outranks everything");
  assert.equal(
    computeOverallStatus([skippedOnPurpose]),
    "warning",
    "a run in which nothing passed checked nothing, and must not read healthy on the strength of a skip",
  );
  assert.equal(computeOverallStatus([]), "no_data", "an empty report is no data, not a verdict");

  // ── Only a skipped check can be skipped on purpose.
  assert.equal(isSkippedOnPurpose(skippedOnPurpose), true);
  assert.equal(isSkippedOnPurpose(skippedWithNoReason), false);
  assert.equal(
    isSkippedOnPurpose({ status: "failed", skipReason: EXPORT_REASON }),
    false,
    "a reason on a check that failed does not excuse it",
  );

  // ── Where the reason comes from: the sentence the check itself gave when it skipped.
  assert.equal(
    declaredSkipReason([{ type: "skip", description: EXPORT_REASON }]),
    EXPORT_REASON,
    "test.skip(condition, reason) leaves a skip annotation carrying the reason",
  );
  assert.equal(
    declaredSkipReason([{ type: "skip" }]),
    undefined,
    "a skip with no sentence gives no reason — that is the skip the run is marked down for",
  );
  assert.equal(declaredSkipReason([]), undefined, "a check that never ran because the sign-in step failed leaves no annotation at all");
  assert.equal(
    declaredSkipReason([{ type: "slow", description: "takes a while" }, { type: "issue", description: "PR 171" }]),
    undefined,
    "only a skip annotation explains a skip",
  );
  assert.equal(
    declaredSkipReason([{ type: "skip", description: "  " }, { type: "skip", description: ` ${EXPORT_REASON} ` }]),
    EXPORT_REASON,
    "a blank description is passed over and the reason is trimmed",
  );

  // ── What the page prints under the skipped check is a whole sentence a person can read.
  const note = skippedOnPurposeNote(EXPORT_REASON);
  assert.equal(note, `Skipped on purpose: ${EXPORT_REASON}`);
  assert.ok(note.endsWith("."), "the note ends as a sentence");
  assert.ok(!note.includes("…") && !note.includes("..."), "the note never trails off with an ellipsis");
}

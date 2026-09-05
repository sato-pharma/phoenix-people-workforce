import assert from "node:assert/strict";

import {
  emptyWorkQueueCounts,
  screeningWorkQueueDescriptions,
  screeningWorkQueueEmptyLabels,
  screeningWorkQueueLabels,
  screeningWorkQueues,
  workQueuesFor,
} from "../src/lib/recruitment/screening-queues.ts";
import type { WorkQueueInput } from "../src/lib/recruitment/screening-queues.ts";

/**
 * A document that is not a CV gets its own pile, and is not counted as first review.
 *
 * ── WHAT PHASE 2.2 ACTUALLY FOUND ───────────────────────────────────────────────────────────────
 *
 * The phase was planned as "auto-FILE non-starters", against three categories. Measured on
 * production 2026-09-05, all three were already answered or empty:
 *
 *   * stated non-Egyptian — 23, and every one already carries the `not_egyptian` RED FLAG, which
 *     already keeps them out of New, Recommended and Duplicates and already gives them a pile.
 *   * no CV file — ONE candidate in a pool of 582.
 *   * exact duplicate on the locked identity keys — ZERO groups on national ID and zero on email.
 *     The locked rule in candidate-matching.ts cannot fire because almost nobody has a national ID,
 *     which is Phase 2.3's problem and not something a classifier can invent.
 *
 * The one real category was adjacent: 20 documents the reader judged NOT to be a CV. Everything
 * about them was already right — the `no_cv` band sorts them last, the row wears a "Not a CV" pill,
 * the CV pane says so — except that they were still counted in "New CVs". First review read 20 too
 * high, and a screener working that pile still had to open each one to discover it was a certificate.
 *
 * ── AND NOTHING IS FILED ────────────────────────────────────────────────────────────────────────
 *
 * A document that is not a CV does not mean a person who is not a candidate. A WhatsApp applicant
 * photographing a certificate is the commonest shape here, and their real CV may arrive by another
 * route; moving them off the pool would hide a live applicant in order to tidy a queue. The owner's
 * rule is auto-FILE only, never auto-reject — this goes one step further and writes nothing at all,
 * because a pile answers the same question without touching a row.
 */
export function runRecruitmentNotACvPileTests() {
  const base: WorkQueueInput = {
    answeredAt: null,
    band: "field_force",
    duplicateCount: 1,
    interviewToday: false,
    redFlagged: false,
    sentToManagerAt: null,
    status: "new",
    unsavedFindings: 0,
  };

  // ── 1 · A REAL CV IS UNAFFECTED ───────────────────────────────────────────────────────────────

  assert.ok(workQueuesFor(base).includes("new"), "a real CV awaiting review is still first review");
  assert.ok(
    !workQueuesFor(base).includes("not_a_cv"),
    "and is not in the not-a-CV pile",
  );

  // ── 2 · A NON-CV LEAVES FIRST REVIEW AND GETS ITS OWN ADDRESS ─────────────────────────────────

  const notACv = { ...base, band: "no_cv" } as WorkQueueInput;
  assert.ok(
    !workQueuesFor(notACv).includes("new"),
    "a certificate must NOT be counted as a CV awaiting first review — that is the 20-row " +
      "overstatement this change removes",
  );
  assert.ok(workQueuesFor(notACv).includes("not_a_cv"), "it goes to its own pile instead");
  assert.ok(
    workQueuesFor(notACv).includes("all"),
    "and stays in Everyone — nothing is hidden, which is the difference between a pile and a filing",
  );
  assert.ok(
    !workQueuesFor(notACv).includes("recommended"),
    "no_cv was already outside Recommended, and stays there",
  );

  // THE PILE IS NOT CONDITIONED ON STATUS. A certificate that somebody already rejected is still a
  // certificate; keying this on `status === "new"` would empty the pile the moment anyone acted and
  // lose the very rows it exists to group.
  assert.ok(
    workQueuesFor({ ...notACv, status: "rejected" }).includes("not_a_cv"),
    "a decided non-CV is still a non-CV",
  );

  // ── 3 · IT IS A PILE, NOT A FILING ────────────────────────────────────────────────────────────
  //
  // Deliberately checked as behaviour rather than as source: the pile must never become a reason to
  // drop a candidate out of the pool, because a person whose attachment was a certificate may still
  // be a live applicant whose CV arrives another way.
  assert.ok(
    workQueuesFor(notACv).length >= 2,
    "a non-CV belongs to its pile AND to Everyone — it is never routed to exactly one place, which " +
      "is what filing would look like",
  );

  // ── 4 · THE VOCABULARY IS COMPLETE, CHECKED AT RUNTIME ────────────────────────────────────────
  //
  // An exhaustive Record does NOT gate the build here — `ignoreBuildErrors` lets a missing key
  // compile, build and deploy, and the rail would then render `undefined` as a heading.

  assert.ok(screeningWorkQueues.includes("not_a_cv"), "the pile is registered");
  const counts = emptyWorkQueueCounts();
  for (const queue of screeningWorkQueues) {
    assert.ok(screeningWorkQueueLabels[queue]?.length > 0, `${queue} needs a rail heading`);
    assert.ok(screeningWorkQueueDescriptions[queue]?.length > 0, `${queue} needs a description`);
    assert.ok(screeningWorkQueueEmptyLabels[queue]?.length > 0, `${queue} needs its own empty sentence`);
    assert.equal(counts[queue], 0, `${queue} must be present in an empty tally`);
  }
}

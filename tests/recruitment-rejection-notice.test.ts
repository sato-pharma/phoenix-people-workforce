import assert from "node:assert/strict";

import {
  BATCH_ACTOR_PREFIX,
  isBatchActor,
  planRejectionNotice,
  planRejectionNotices,
  type RejectionCandidate,
} from "../src/lib/recruitment/rejection-notice.ts";

/**
 * Who is owed a rejection notice — and the 59 people who are not.
 *
 * ── THE MISTAKE THIS FILE EXISTS TO PREVENT ─────────────────────────────────────────────────────
 *
 * "97 candidates are rejected and have never been told" is true, and is the wrong recipient list.
 * Measured on production 2026-09-05:
 *
 *   * 59 were rejected by a BATCH — actor `ops:non-egyptian-reject-20260828`, no decision
 *     timestamp, every one with a non-Egyptian phone number. Nobody read their CV.
 *   * 20 arrived on WhatsApp and are in a live screening conversation.
 *   * 18 were read and decided by a person — 17 by B-10, one by HR-010.
 *
 * Emailing the first group would tell 59 mass-mailers that their message reached a real recruiter,
 * invite replies, and read worse than silence. A rejection notice is a courtesy owed to somebody who
 * was CONSIDERED; sending one where no human looked makes a claim about our process that is untrue.
 *
 * The recipient list for this phase was very nearly 77. It is 18.
 */
export function runRecruitmentRejectionNoticeTests() {
  const base: RejectionCandidate = {
    email: "someone@example.com",
    id: "c1",
    phone: "01005005847",
    source: "email",
    status: "rejected",
    statusChangedAt: "2026-08-30T09:00:00.000Z",
    decidedByActor: "b-10",
    whatsapp: null,
  };

  // ── 1 · A PERSON DECIDED, SO A NOTICE IS OWED ─────────────────────────────────────────────────

  const owed = planRejectionNotice(base);
  assert.equal(owed.owed, true, "a human-decided rejection with an address is owed a notice");
  assert.equal(owed.owed && owed.channel, "email", "and it goes by email for an email applicant");
  assert.equal(owed.owed && owed.to, "someone@example.com", "to the address they applied from");

  // ── 2 · A BATCH IS NOT A DECISION ─────────────────────────────────────────────────────────────
  //
  // The single most important assertion here. 59 real people sit behind it.

  const batch = planRejectionNotice({
    ...base,
    decidedByActor: "ops:non-egyptian-reject-20260828",
  });
  assert.equal(batch.owed, false, "a batch-rejected candidate is NOT owed a notice");
  assert.equal(
    !batch.owed && batch.reason,
    "decided_by_a_batch",
    "and the reason says so, because 'skipped' with no reason is how a rule like this gets removed " +
      "by somebody who cannot see why it was there",
  );

  // A DATED batch is still a batch. Checked in this order deliberately: production's batch rows have
  // no timestamp today, so a future batch that happens to stamp one must not slip through.
  const datedBatch = planRejectionNotice({
    ...base,
    statusChangedAt: "2026-08-28T12:00:00.000Z",
    decidedByActor: "ops:some-future-sweep-20270101",
  });
  assert.equal(datedBatch.owed, false, "a dated batch is still a batch");
  assert.equal(!datedBatch.owed && datedBatch.reason, "decided_by_a_batch", "for the same reason");

  // The PREFIX is the contract, not the exact string — the next batch will have a different name,
  // and matching the whole value would silently start writing to its candidates.
  assert.equal(BATCH_ACTOR_PREFIX, "ops:", "the marker is a prefix");
  assert.ok(isBatchActor("ops:anything-at-all"), "any ops: actor is a batch");
  assert.ok(isBatchActor("OPS:UPPERCASED"), "and case must not smuggle one past");
  assert.ok(!isBatchActor("B-10"), "a real HR id is not a batch");
  assert.ok(!isBatchActor(null), "and neither is nothing");

  // ── 3 · AN UNDATED DECISION IS NOT SENDABLE ───────────────────────────────────────────────────

  const undated = planRejectionNotice({ ...base, statusChangedAt: null });
  assert.equal(undated.owed, false, "a rejection nobody dated cannot be written about honestly");
  assert.equal(!undated.owed && undated.reason, "no_decision_date", "and says which gate stopped it");

  // A DATE WITH NOBODY BEHIND IT. Production holds exactly one such row. It is not a batch and not
  // undated, so without its own gate it would be posted a letter asserting that a person reviewed
  // them — when the record does not say who.
  const unattributed = planRejectionNotice({ ...base, decidedByActor: null });
  assert.equal(unattributed.owed, false, "a decision with no named decider is not sendable");
  assert.equal(
    !unattributed.owed && unattributed.reason,
    "no_named_decider",
    "and it is told apart from a batch and from an undated row, because the three need different fixes",
  );

  // ── 4 · THE CHANNEL FOLLOWS THE SOURCE ────────────────────────────────────────────────────────
  //
  // A WhatsApp applicant personally turned down is owed the same courtesy, on the channel where the
  // rest of their conversation happened. Excluding them entirely is the easy mistake in the other
  // direction: silence for the people we spoke to most.

  const whatsapp = planRejectionNotice({
    ...base,
    email: "them@example.com",
    source: "whatsapp",
    whatsapp: "01005005847",
  });
  assert.equal(whatsapp.owed, true, "a WhatsApp applicant is owed one too");
  assert.equal(
    whatsapp.owed && whatsapp.channel,
    "whatsapp",
    "on WhatsApp — emailing them opens a second thread for a conversation already running",
  );
  assert.equal(whatsapp.owed && whatsapp.to, "01005005847", "to the number they wrote from");

  // ── 5 · UNREACHABLE IS ITS OWN ANSWER ─────────────────────────────────────────────────────────

  const noAddress = planRejectionNotice({ ...base, email: null });
  assert.equal(noAddress.owed, false, "no address, no send");
  assert.equal(!noAddress.owed && noAddress.reason, "no_way_to_reach_them", "and it is not confused with a batch");

  const junkEmail = planRejectionNotice({ ...base, email: "not an address" });
  assert.equal(junkEmail.owed, false, "an address with no @ is not an address");

  // BOTH numbers must be unusable. The rule falls back from `whatsapp` to `phone` on purpose, and
  // the first draft of this assertion left a good `phone` in place — so it passed for the wrong
  // reason and would have gone on passing if the fallback were deleted.
  const shortNumber = planRejectionNotice({ ...base, phone: null, source: "whatsapp", whatsapp: "0100" });
  assert.equal(shortNumber.owed, false, "a number too short to dial is not a number");
  const fellBackToPhone = planRejectionNotice({ ...base, source: "whatsapp", whatsapp: "0100" });
  assert.equal(
    fellBackToPhone.owed,
    true,
    "and when only the whatsapp field is unusable it falls back to the phone — a WhatsApp applicant " +
      "whose number we hold in the other column is still reachable",
  );

  // Formatting must never decide reachability — production stores +20, 0020, spaces and dashes.
  for (const number of ["+20 122 40 39 533", "00201023232472", "011-0236-6499"]) {
    const formatted = planRejectionNotice({ ...base, source: "whatsapp", whatsapp: number });
    assert.equal(formatted.owed, true, `${number} is reachable — punctuation is not a decision`);
  }

  // ── 6 · ANYTHING NOT REJECTED IS NOT IN SCOPE ─────────────────────────────────────────────────
  //
  // 520 candidates sit at `new`. They have heard nothing either, and that is an ACKNOWLEDGEMENT
  // question, not a rejection one — sending them a rejection would invent a decision nobody made.
  for (const status of ["new", "shortlisted", "sent_to_manager", "hired"]) {
    const other = planRejectionNotice({ ...base, status });
    assert.equal(other.owed, false, `${status} is not a rejection`);
    assert.equal(!other.owed && other.reason, "not_rejected", "and the reason is exactly that");
  }

  // ── 7 · THE WHOLE POOL, SPLIT ─────────────────────────────────────────────────────────────────
  //
  // Shaped like production: a human-decided email applicant, a human-decided WhatsApp applicant, and
  // a batch. The batch must land in `skipped`, never merely be absent from `owed` — a caller that
  // iterates the wrong list must still not reach them.

  const { owed: owedAll, skipped } = planRejectionNotices([
    base,
    { ...base, id: "c2", source: "whatsapp", whatsapp: "01013624545" },
    { ...base, decidedByActor: "ops:non-egyptian-reject-20260828", id: "c3", statusChangedAt: null },
  ]);
  assert.deepEqual(owedAll.map((plan) => plan.candidateId), ["c1", "c2"], "two are owed");
  assert.deepEqual(skipped.map((plan) => plan.candidateId), ["c3"], "and the batch is explicitly skipped");
  assert.equal(owedAll.length + skipped.length, 3, "every candidate lands in exactly one list");
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * The intake worker races a WhatsApp applicant's own conversation: `applyPendingClassification` and
 * `applyPendingExtraAnswers` catch the answers given BEFORE the CV worker created the candidate row,
 * and backfill them the moment the candidate appears.
 *
 * RE-PINNED 2026-10-20, at the owner's instruction that an applicant's answers are saved AS GIVEN and
 * an unfinished conversation's answers are recovered. Until then both functions read only COMPLETED
 * conversations (`completed_at IS NOT NULL`): a partial snapshot written here was never re-synced —
 * nothing wrote the region, area, experience or salary the applicant went on to give — so freezing
 * one was worse than writing nothing (24 candidates in that state on 2026-09-11). Every answer is now
 * written onto the candidate as it lands (whatsapp-answer-sync.ts), so that reason is gone, and the
 * completed-only filter had become the defect: the first answers of every applicant whose CV beat
 * their taps reached nothing but the session table.
 *
 * What is pinned instead:
 *
 *   1. Neither query filters on `completed_at` any more — an open conversation is read.
 *   2. Neither trusts the phone number alone: the conversation applied is the one whose SAFE link
 *      (whatsapp-session-link.ts — the bot's own link, the CV that opened it, a sender with one person)
 *      is this very candidate. A forwarder's number never hands one applicant's answers to another.
 *   3. THE applied_at DEFECT. `applyPendingClassification` stamps `applied_at`, and the intake worker
 *      calls `applyPendingExtraAnswers` straight after it — which read `applied_at IS NULL`, so it found
 *      nothing and every extra answer given before the CV was processed was lost. Both now also take
 *      the conversation already applied to THIS candidate.
 *   4. An in-progress conversation is linked, not stamped done: `applied_at` is written only for a
 *      finished one, so `applied_at` keeps meaning "the finished answers were applied".
 */
export function runWhatsAppPendingBackfillCompletedOnlyTests() {
  const classifySource = stripComments(
    readFileSync(new URL("../src/lib/recruitment/inbound/whatsapp-classify-session.ts", import.meta.url), "utf8"),
  );
  const extraSource = stripComments(
    readFileSync(new URL("../src/lib/recruitment/inbound/whatsapp-screening-questions-session.ts", import.meta.url), "utf8"),
  );
  const workerSource = stripComments(
    readFileSync(new URL("../src/lib/recruitment/inbound/intake-worker.ts", import.meta.url), "utf8"),
  );

  const body = (source: string, name: string): string => {
    const start = source.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, `${name} is still exported`);
    const next = source.indexOf("\nexport ", start + 1);
    return source.slice(start, next < 0 ? undefined : next);
  };
  const classifyBackfill = body(classifySource, "applyPendingClassification");
  const extraBackfill = body(extraSource, "applyPendingExtraAnswers");

  // ── 1. An open conversation is read ────────────────────────────────────────────────────────────
  for (const [name, fn] of [
    ["applyPendingClassification", classifyBackfill],
    ["applyPendingExtraAnswers", extraBackfill],
  ] as const) {
    assert.equal(
      /completed_at",\s*"is",\s*null/.test(fn),
      false,
      `${name} filters on completed_at again, so an applicant still mid-conversation when their CV lands has their first answers stranded in the session table`,
    );

    // ── 3. The conversation already applied to this candidate is taken too ───────────────────────
    assert.ok(
      /\.or\(`applied_at\.is\.null,applied_candidate_id\.eq\.\$\{input\.candidateId\}`\)/.test(fn),
      `${name} reads only applied_at IS NULL again — applyPendingClassification stamps applied_at first, so the extra answers find nothing and are lost`,
    );

    // ── 2. The safe link decides, never the number alone ──────────────────────────────────────────
    assert.ok(/linkSessionsToCandidates\(sessions\)/.test(fn), `${name} no longer asks the safe links whose conversation this is`);
    assert.ok(
      /links\.get\(row\.id\) === input\.candidateId/.test(fn),
      `${name} applies a conversation whose safe link is not this candidate — a forwarder's applicant's answers would land on someone else`,
    );
  }

  // ── 4. Linked, not stamped done, while it is still open ─────────────────────────────────────────
  assert.ok(
    /writeClassification\(input\.candidateId, session, \{ finished: Boolean\(session\.completed_at\) \}\)/.test(classifyBackfill),
    "an in-progress conversation must not be stamped applied_at — that column means the FINISHED answers were applied",
  );
  assert.ok(
    /options\.finished\s*\n?\s*\?\s*\{ applied_at: nowIso, applied_candidate_id: candidateId, updated_at: nowIso \}\s*\n?\s*:\s*\{ applied_candidate_id: candidateId \}/.test(
      classifySource,
    ),
    "writeClassification stamps applied_at only for a finished conversation, and links an open one",
  );

  // ── The extra answers are merged key by key, never written as a whole map ───────────────────────
  assert.equal(
    /update\(\{\s*screening_extra_answers:/.test(extraSource),
    false,
    "the extra answers are written as a whole map again, which erases an answer HR added to a question the applicant never reached",
  );
  assert.ok(/mergeExtraAnswers\(input\.candidateId,/.test(extraBackfill), "the backfill merges key by key");

  // ── The worker still calls both, classification first ───────────────────────────────────────────
  const classifyCall = workerSource.indexOf("await applyPendingClassification(");
  const extraCall = workerSource.indexOf("await applyPendingExtraAnswers(");
  assert.ok(classifyCall >= 0 && extraCall > classifyCall, "the intake worker applies the six, then the extra answers");
}

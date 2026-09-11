import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The intake worker races a WhatsApp applicant's own conversation: `applyPendingClassification`
 * and `applyPendingExtraAnswers` exist to catch a conversation that FINISHED before the CV worker
 * created the candidate row, backfilling the answers the moment the candidate appears. Both are
 * documented as acting on a "completed-but-unapplied" session — but neither query actually filtered
 * on `completed_at`, only on `applied_at IS NULL`. When the worker instead won the race — the
 * candidate appears while the applicant is still mid-conversation — the query's only remaining row
 * for that sender IS the in-progress session, and it became the answer: a snapshot of whatever was
 * answered so far (often just the role, or the role plus one or two more) froze onto the candidate,
 * `preferences_declared_at`/`applied_at` included. Nothing ever re-syncs the region, area,
 * experience, salary or extra answers the applicant goes on to give after that point, because
 * `applied_at` is now set and neither function is ever invoked again for that session.
 *
 * Production held 24 `ats_candidates` rows in exactly this state on 2026-09-11 — `preferences_
 * declared_at` set, joined session `completed_at` still null — spread across every step from
 * `background` to `salary`, confirming this is not one unlucky race but the query's normal fallback
 * behavior whenever the worker beats the conversation.
 *
 * `.not("completed_at", "is", null)` is the fix in both files: this test pins its presence in the
 * exact query it belongs to, the same source-pinning approach whatsapp-finished-sweep.test.ts uses
 * for the sibling class of "assert a Postgrest filter chain shape" that a live/fake Supabase client
 * would otherwise be needed to exercise.
 */
export function runWhatsAppPendingBackfillCompletedOnlyTests() {
  const classifySource = readFileSync(
    new URL("../src/lib/recruitment/inbound/whatsapp-classify-session.ts", import.meta.url),
    "utf8",
  );

  // ── applyPendingClassification only backfills a COMPLETED session ─────────────────────────────
  assert.ok(
    /\.is\("applied_at",\s*null\)\s*\n\s*\.not\("completed_at",\s*"is",\s*null\)\s*\n\s*\.not\("job_title_family",\s*"is",\s*null\)/.test(
      classifySource,
    ),
    "applyPendingClassification lost its completed_at guard, so a still-open session becomes its only candidate row and gets a permanent partial snapshot written onto the candidate",
  );

  // The whole point of the filter is to stop the query falling back to an in-progress row when no
  // completed one exists yet — so `completed_at` must gate the WHERE clause, not merely order the
  // results (nullsFirst ordering was the pre-fix code's only nod to it, and it still let a lone
  // in-progress row win when it was the only row for that sender).
  assert.equal(
    /order\("completed_at",\s*\{\s*ascending:\s*false,\s*nullsFirst:\s*false\s*\}\)/.test(classifySource),
    false,
    "applyPendingClassification reverted to ordering by completed_at instead of filtering on it, which still lets a lone in-progress session win when it's the only row for that sender",
  );

  const extraSource = readFileSync(
    new URL("../src/lib/recruitment/inbound/whatsapp-screening-questions-session.ts", import.meta.url),
    "utf8",
  );

  // ── applyPendingExtraAnswers — the extra-question analogue, same bug shape ─────────────────────
  // finishExtraQuestionLoop already writes the full, final extra_answers unconditionally once the
  // loop truly completes, so this backfill exists only to catch a loop that finished before the
  // candidate existed — never one still mid-question.
  assert.ok(
    /\.select\(EXTRA_SESSION_COLUMNS\)\s*\n\s*\.eq\("wa_id",\s*input\.waId\)\s*\n\s*\.is\("applied_at",\s*null\)\s*\n\s*\.not\("completed_at",\s*"is",\s*null\)/.test(
      extraSource,
    ),
    "applyPendingExtraAnswers lost its completed_at guard, so a loop still mid-question can have its partial extra_answers frozen onto the candidate the moment the CV worker creates it",
  );
}

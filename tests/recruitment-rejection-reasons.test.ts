// Pins the recruitment workspace's two closed lists — why a CV was rejected (owner, 20 Oct 2026, #24:
// "a rejection reason from a fixed list … it makes rejections countable") and what a call came to
// (#23) — against the database CHECKs that hold the same keys, plus the rule that an Undo takes the
// reason away with the rejection.
//
// Why each case matters:
//   * The words live in TypeScript and the keys are enforced in SQL. A key added on one side only is
//     a reject that the screen offers and the database refuses with a 500 — or a stored reason the
//     screen cannot name. So the lists are compared exactly, both ways.
//   * "Other" must say what: a reason nobody can read back is not countable.
//   * The status note is never cut short (the owner's no-truncation rule).
//   * A CV brought back out of Rejected — by an Undo, by hand, in a batch or by a hire — that kept
//     "Salary too high" on it would go on counting a rejection nobody made.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CANDIDATE_STATUS_NOTE_MAX_LENGTH } from "../src/lib/recruitment/candidate-status.ts";
import { rejectionStatusNote } from "../src/lib/recruitment/workspace/rejection.ts";
import {
  callResultLabels,
  callResults,
  isCallResult,
  isRejectionReason,
  rejectionReasonLabels,
  rejectionReasons,
  rejectionRefusal,
} from "../src/lib/recruitment/workspace/vocabulary.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

const MIGRATION = path.join(process.cwd(), "supabase", "migrations", "20261020010000_ats_recruitment_workspace_foundation.sql");

/** The quoted keys inside one named CHECK constraint of the migration. */
function checkKeys(sql: string, constraint: string): string[] {
  const at = sql.indexOf(`${constraint} check`);
  assert.ok(at >= 0, `the migration defines ${constraint}`);
  const open = sql.indexOf("(", at);
  let depth = 0;
  let end = open;
  for (; end < sql.length; end += 1) {
    if (sql[end] === "(") depth += 1;
    if (sql[end] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = sql.slice(open, end + 1);
  return [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

/** One top-level function's own text: from its signature to the next top-level declaration. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} exists`);
  const ends = ["\nexport ", "\nasync function ", "\nfunction "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((at) => at !== -1);
  return source.slice(start, ends.length ? Math.min(...ends) : undefined);
}

export function runRecruitmentRejectionReasonsTests() {
  // ── The vocabulary ──
  assert.equal(rejectionReasons.length, 9);
  assert.equal(new Set(rejectionReasons).size, rejectionReasons.length, "no reason twice");
  for (const reason of rejectionReasons) {
    assert.ok(rejectionReasonLabels[reason]?.trim(), `${reason} has words`);
    assert.equal(isRejectionReason(reason), true);
  }
  assert.equal(rejectionReasons[rejectionReasons.length - 1], "other", "Other is the last choice");
  assert.equal(isRejectionReason("Wrong degree"), false, "a label is not a key");
  assert.equal(isRejectionReason(null), false);
  for (const result of callResults) assert.ok(callResultLabels[result]?.trim(), `${result} has words`);
  assert.equal(isCallResult("voicemail"), false);

  // ── The refusal ──
  assert.equal(rejectionRefusal(null, null), "Choose why this CV is rejected.");
  assert.equal(rejectionRefusal("too_old", null), "Choose why this CV is rejected.", "an unknown key is refused");
  assert.equal(rejectionRefusal("other", null), "Write a short note for “Other”.");
  assert.equal(rejectionRefusal("other", "   "), "Write a short note for “Other”.", "a blank note is no note");
  assert.equal(rejectionRefusal("other", "Moved abroad"), null);
  assert.equal(rejectionRefusal("salary_too_high", null), null, "every other reason stands on its own");
  assert.equal(rejectionRefusal("salary_too_high", "x".repeat(300)), null);
  assert.equal(rejectionRefusal("salary_too_high", "x".repeat(301)), "Keep the note to 300 characters.");

  // ── The status note carries the reason in words, never cut short ──
  assert.equal(rejectionStatusNote("salary_too_high", null), "Salary too high");
  assert.equal(rejectionStatusNote("salary_too_high", "  "), "Salary too high");
  assert.equal(rejectionStatusNote("salary_too_high", "asked 30,000"), "Salary too high: asked 30,000");
  const longNote = "x".repeat(CANDIDATE_STATUS_NOTE_MAX_LENGTH - 2);
  assert.equal(rejectionStatusNote("salary_too_high", longNote), longNote, "too long together: the note alone, whole");
  for (const reason of rejectionReasons) {
    assert.ok(rejectionStatusNote(reason, "x".repeat(300)).length <= CANDIDATE_STATUS_NOTE_MAX_LENGTH);
  }

  // ── The database holds exactly the same keys ──
  const sql = stripSqlComments(readFileSync(MIGRATION, "utf8"));
  assert.deepEqual(
    checkKeys(sql, "ats_candidates_rejection_reason_check").sort(),
    [...rejectionReasons].sort(),
    "ats_candidates_rejection_reason_check lists exactly rejectionReasons",
  );
  assert.deepEqual(
    checkKeys(sql, "ats_candidate_call_results_result_check").sort(),
    [...callResults].sort(),
    "ats_candidate_call_results_result_check lists exactly callResults",
  );

  // ── Every move out of Rejected takes the reason with it: an Undo, one CV, a batch, a hire ──
  const candidates = stripComments(readFileSync(path.join(process.cwd(), "src", "lib", "recruitment", "candidates.ts"), "utf8"));
  const clear = functionBody(candidates, "async function clearRejectionReasons(");
  assert.match(clear, /rejection_reason:\s*null/, "clearRejectionReasons clears rejection_reason");
  assert.match(clear, /rejection_reason_note:\s*null/, "clearRejectionReasons clears rejection_reason_note");
  assert.match(
    functionBody(candidates, "export async function revertCandidateStatuses("),
    /clearRejectionReasons\([\s\S]*status\s*!==\s*"rejected"/,
    "an Undo clears the reason, only for a CV that leaves Rejected",
  );
  assert.match(
    functionBody(candidates, "export async function updateCandidateStatus("),
    /next\s*===\s*"rejected"\s*\?\s*\{\}\s*:\s*\{\s*rejection_reason:\s*null,\s*rejection_reason_note:\s*null\s*\}/,
    "a status change by hand clears the reason unless the CV is being rejected",
  );
  assert.match(
    functionBody(candidates, "export async function bulkUpdateCandidateStatus("),
    /next\s*!==\s*"rejected"[\s\S]*clearRejectionReasons\([\s\S]*fromStatus\s*===\s*"rejected"/,
    "a batch moved out of Rejected clears its reasons",
  );
  const offers = stripComments(readFileSync(path.join(process.cwd(), "src", "lib", "recruitment", "offer-outcome-sync.ts"), "utf8"));
  assert.match(
    functionBody(offers, "async function writeCandidateMove("),
    /to\s*===\s*"hired"\s*\?\s*\{\s*rejection_reason:\s*null,\s*rejection_reason_note:\s*null\s*\}/,
    "a hire clears an earlier rejection's reason",
  );
}

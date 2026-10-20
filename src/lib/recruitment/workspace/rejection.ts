// Recruitment workspace — the words a rejection writes into the status note. Pure, so the rule is
// pinned without a database (tests/recruitment-rejection-reasons.test.ts).
//
// The reason has its own column, which is what a report counts by. The status NOTE carries it in
// words as well, because every older screen and export prints the note and none of them know the new
// column — a rejection must still say why there.

import { CANDIDATE_STATUS_NOTE_MAX_LENGTH } from "@/lib/recruitment/candidate-status";
import { rejectionReasonLabels, type RejectionReason } from "@/lib/recruitment/workspace/vocabulary";

/**
 * "Salary too high: asked 30,000"; the label alone without a note. Never cut short (the owner's
 * no-truncation rule): a pair longer than a status note may be keeps the note alone, and
 * `rejectionRefusal` already holds the note itself inside that limit.
 */
export function rejectionStatusNote(reason: RejectionReason, note: string | null | undefined): string {
  const label = rejectionReasonLabels[reason];
  const text = String(note ?? "").trim();
  if (!text) return label;
  const joined = `${label}: ${text}`;
  return joined.length <= CANDIDATE_STATUS_NOTE_MAX_LENGTH ? joined : text;
}

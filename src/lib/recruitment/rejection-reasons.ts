// Recruitment / ATS — why a candidate was turned down, from a fixed list.
//
// WHY A LIST. The status note is free text and always has been, which is right — "asked for double
// the band" is a real reason no menu could hold. But measured against production, the free-text
// field is empty on the large majority of rejections, so "why did we reject them in July" is a
// question the archive mostly cannot answer. A one-tap standard reason costs nothing and makes the
// rejections countable; the free text stays, underneath it, for the half a list cannot express.
//
// NOTHING IS DELETED. Rejecting sets the candidate's status and writes a line into
// `ats_candidate_status_events`. It does not remove the candidate, the CV, or the history — the
// record stays readable and the decision stays reversible, which is why the red pile is a tab
// rather than a trapdoor.
//
// NO SCHEMA CHANGE. The reason is composed into the note the status route already accepts and
// stores, so this ships without a migration and every existing rejection keeps reading exactly as
// it did. `CANDIDATE_STATUS_NOTE_MAX_LENGTH` is the ceiling the column enforces, so the composer
// below respects it rather than letting the route reject a decision a recruiter has already made.

import { CANDIDATE_STATUS_NOTE_MAX_LENGTH } from "@/lib/recruitment/candidate-status";

export const rejectionReasons = [
  "experience_mismatch",
  "qualification_mismatch",
  "location_mismatch",
  "compensation_mismatch",
  "role_mismatch",
  "candidate_withdrew",
  "unreachable",
  "duplicate",
  "vacancy_closed",
  "other",
] as const;

export type RejectionReason = (typeof rejectionReasons)[number];

/**
 * The words on the button. Written as a recruiter would say them out loud, because these end up in
 * the candidate's permanent history and somebody reads them back months later.
 */
export const rejectionReasonLabels: Record<RejectionReason, string> = {
  candidate_withdrew: "Candidate withdrew",
  compensation_mismatch: "Compensation mismatch",
  duplicate: "Duplicate record",
  experience_mismatch: "Experience mismatch",
  location_mismatch: "Location mismatch",
  other: "Other",
  qualification_mismatch: "Qualification mismatch",
  role_mismatch: "Role mismatch",
  unreachable: "Could not be reached",
  vacancy_closed: "Vacancy closed",
};

export function isRejectionReason(value: unknown): value is RejectionReason {
  return typeof value === "string" && (rejectionReasons as readonly string[]).includes(value);
}

/**
 * The note a rejection is stored with — "Experience mismatch — only 4 months in the field".
 *
 * TRUNCATES RATHER THAN REFUSING. The column caps at 300 characters and the route rejects anything
 * longer, so a recruiter who typed a long explanation would otherwise lose the whole decision to a
 * validation error at the moment they pressed the button. The standard reason is kept whole and the
 * free text is cut, because the half a list can hold is the half that stays countable.
 *
 * "Other" with nothing typed returns null rather than the word "Other", which says nothing at all.
 */
export function composeRejectionNote(reason: RejectionReason, detail?: string | null): string | null {
  const typed = String(detail ?? "").trim();
  if (reason === "other") return typed.length > 0 ? typed.slice(0, CANDIDATE_STATUS_NOTE_MAX_LENGTH) : null;

  const label = rejectionReasonLabels[reason];
  if (typed.length === 0) return label;

  const joined = `${label} — ${typed}`;
  if (joined.length <= CANDIDATE_STATUS_NOTE_MAX_LENGTH) return joined;
  return joined.slice(0, CANDIDATE_STATUS_NOTE_MAX_LENGTH);
}

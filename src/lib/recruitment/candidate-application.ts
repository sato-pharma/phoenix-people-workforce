// Recruitment / ATS — one candidate's application, for the screening page's "Download application" on ANY CV.
//
// The owner, 2026-09-26: the WhatsApp Applicants' "Download application" / "Print application" buttons must
// reach EVERY CV on the screening page, not only the people who applied over WhatsApp. So the download is
// keyed by CANDIDATE here, not by WhatsApp conversation:
//
//   • Applied on WhatsApp → the exact WhatsApp application the applicants list builds (the CV as sent, then
//     the one-page sheet of every question and answer). Resolved through the same join the list uses, so the
//     two can never disagree about whose chat it is.
//   • Never applied on WhatsApp → the CV plus the old paper Job Application Form filled from the record, with
//     NO "WhatsApp questions and answers" section. The sheet already knows how to leave that section off
//     (`hasWhatsApp: false`), and every field it cannot fill stays an empty line to write on.
//
// The heavy lifting is unchanged: the same PDF builder, the same sheet, the same form. This only decides
// which application belongs to a candidate and, when there is no conversation, builds the row the sheet reads
// from the candidate's own record.

import { mapCandidate, recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import type { Candidate } from "@/lib/recruitment/types";
import type { WhatsAppApplicantRow } from "@/lib/recruitment/whatsapp-applicant-filters";
import {
  findWhatsAppApplicationSessionId,
  loadWhatsAppApplication,
  type WhatsAppApplication,
} from "@/lib/recruitment/whatsapp-applicants-loader";

/** One candidate's application, and whether it was built from a real WhatsApp conversation. */
export type CandidateApplication = { application: WhatsAppApplication; hasWhatsApp: boolean };

/**
 * The row the sheet and the form read, synthesised from a candidate who never applied on WhatsApp. It
 * carries no answers and no conversation: the sheet leaves the Q&A section off (`hasWhatsApp: false`), and
 * the form fills its personal, education, employment and skills fields from the record instead.
 */
function rowFromRecord(candidate: Candidate, appliedAt: string): WhatsAppApplicantRow {
  return {
    answers: [],
    appliedAt,
    candidateId: candidate.id,
    finished: false,
    key: candidate.id,
    name: candidate.fullName,
    region: null,
    // No conversation. The candidate route builds the file, so this id is never used to fetch one.
    sessionId: "",
    status: candidate.status,
    statusLabel: "",
    stillOpen: false,
    titleValue: "",
    typedTitle: null,
    values: {},
    waitingOn: null,
  };
}

/**
 * The application belonging to a candidate, or null when the candidate row cannot be read.
 *
 * A WhatsApp conversation, when they had one, is preferred — it is the fuller document and matches what the
 * WhatsApp Applicants list shows. Otherwise the sheet is built from the record alone.
 */
export async function loadCandidateApplication(candidateId: string): Promise<CandidateApplication | null> {
  const sessionId = await findWhatsAppApplicationSessionId(candidateId);
  if (sessionId) {
    const application = await loadWhatsAppApplication(sessionId);
    if (application) return { application, hasWhatsApp: true };
    // A conversation that resolves but cannot be loaded falls through to the record, so the button never
    // dies on a person who plainly exists.
  }

  const { data, error } = await recruitmentDb().from("ats_candidates").select("*").eq("id", candidateId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const candidate = mapCandidate(row);
  const appliedAt = textOrNull(row.created_at) ?? new Date().toISOString();

  return {
    application: {
      candidate,
      contact: { email: textOrNull(candidate.email), phone: textOrNull(candidate.phone) },
      row: rowFromRecord(candidate, appliedAt),
      titleLabel: textOrNull(candidate.appliedForJobTitle) ?? "",
    },
    hasWhatsApp: false,
  };
}
